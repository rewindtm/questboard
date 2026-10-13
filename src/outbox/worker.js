'use strict';
const { TASK_SELECT } = require('../services/dto');
const { renderPost } = require('../discord/render');
const { DiscordError } = require('../discord/errors');

const MAX_ATTEMPTS = 8;
const STALE_LOCK_MS = 2 * 60 * 1000;
const POLL_MS = 2000;

/** Backoff esponenziale: 30s, 1m, 2m, 4m ... max 15 minuti (+ jitter). */
function backoffMs(attempts) {
  const base = Math.min(30000 * 2 ** (attempts - 1), 15 * 60 * 1000);
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

function createOutboxWorker({ pool, bus, gateway, config, log = () => {} }) {
  let timer = null;
  let running = false;
  let stopping = false;
  let current = null;

  async function claim() {
    // job rimasti "processing" dopo un crash: tornano in coda
    await pool.query(
      `UPDATE outbox SET status = 'pending', locked_at = NULL
        WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond')`,
      [STALE_LOCK_MS],
    );
    const { rows } = await pool.query(
      `WITH c AS (
         SELECT id, mention_user_id AS claimed_mention FROM outbox
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
       UPDATE outbox o SET status = 'processing', locked_at = now(), mention_user_id = NULL, updated_at = now()
         FROM c WHERE o.id = c.id
       RETURNING o.*, c.claimed_mention`,
    );
    return rows[0] || null;
  }

  async function discordIdOf(userId) {
    if (!userId) return null;
    const { rows } = await pool.query('SELECT discord_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.discord_id ?? null;
  }

  async function addEvent(task, type, changes = {}) {
    const { rows } = await pool.query(
      `INSERT INTO task_events (task_id, project_id, actor_id, source, type, changes)
       VALUES ($1,$2,NULL,'system',$3,$4) RETURNING id`,
      [task.id, task.project_id, type, JSON.stringify(changes)],
    );
    bus.emit('task:event', { projectId: task.project_id, taskId: task.id, eventId: rows[0].id });
  }

  /** Esegue la sincronizzazione di un job. Lancia DiscordError in caso di problemi. */
  async function sync(job) {
    const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [job.task_id]);
    const task = rows[0];
    if (!task) return { skipped: true };
    const { rows: pr } = await pool.query('SELECT * FROM projects WHERE id = $1', [task.project_id]);
    const project = pr[0];

    // Un post eliminato non viene mai ricreato in silenzio: serve una ripubblicazione esplicita.
    if (task.sync_status === 'missing' && job.kind !== 'repost') return { skipped: true };
    if (!project.discord_guild_id || !project.discord_forum_id) {
      throw new DiscordError('INVALID_CONFIG', 'Il progetto non ha un forum Discord configurato.');
    }
    const assigneeDiscordId = await discordIdOf(task.assignee_id);
    const post = renderPost(task, {
      appBaseUrl: config.appBaseUrl, projectSlug: project.slug, assigneeDiscordId, tagMap: project.discord_tag_map,
    });
    const target = { guildId: project.discord_guild_id, forumId: project.discord_forum_id };
    const mentionDiscordId = job.claimed_mention ? await discordIdOf(job.claimed_mention) : null;

    let { discord_thread_id: threadId, discord_message_id: messageId, discord_url: url } = task;

    if (!threadId) {
      // Se un tentativo precedente era partito (publish_started_at valorizzato) ma non abbiamo gli ID,
      // il post potrebbe esistere gia su Discord: riconcilia PRIMA di crearne un altro.
      const mayExist = !!task.publish_started_at;
      await pool.query('UPDATE tasks SET publish_started_at = COALESCE(publish_started_at, now()) WHERE id = $1', [task.id]);
      let found = null;
      if (mayExist) {
        found = await gateway.findThreadByRef({ ...target, ref: task.sync_ref, code: task.code });
      }
      const ref = found || await gateway.createThread({ ...target, post, mentionDiscordId: mentionDiscordId ?? assigneeDiscordId });
      ({ threadId, messageId, url } = ref);
      await pool.query(
        `UPDATE tasks SET discord_thread_id = $2, discord_message_id = $3, discord_url = $4
          WHERE id = $1 AND discord_thread_id IS NULL`,
        [task.id, threadId, messageId, url],
      );
      await addEvent(task, found ? 'discord_linked' : 'discord_published', { thread: { from: null, to: url } });
      if (!found) return { version: task.version };
    }
    await gateway.updateThread({ threadId, messageId, post, mentionDiscordId });
    return { version: task.version };
  }

  async function finish(job, { status, error = null, delayMs = 0, countAttempt = false, syncStatus, version = null, touchTask = true }) {
    const client = await pool.connect();
    let projectId = null;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT dirty, attempts FROM outbox WHERE id = $1 FOR UPDATE', [job.id]);
      const dirty = rows[0]?.dirty;
      const attempts = (rows[0]?.attempts ?? 0) + (countAttempt ? 1 : 0);
      if (status === 'done' && dirty) {
        // il task e cambiato mentre sincronizzavo: un altro giro con l'ultima versione
        await client.query(
          `UPDATE outbox SET status='pending', dirty=FALSE, attempts=0, next_attempt_at=now(), locked_at=NULL,
                 last_error=NULL, updated_at=now() WHERE id=$1`, [job.id]);
        await client.query(`UPDATE tasks SET sync_status='pending', synced_version=COALESCE($2, synced_version) WHERE id=$1`, [job.task_id, version]);
      } else {
        await client.query(
          `UPDATE outbox SET status=$2, dirty=FALSE, attempts=$3, next_attempt_at=now() + ($4::int * interval '1 millisecond'),
                 locked_at=NULL, last_error=$5, updated_at=now() WHERE id=$1`,
          [job.id, status, attempts, delayMs, error]);
        if (touchTask) {
          await client.query(
            `UPDATE tasks SET sync_status=$2, sync_error=$3, synced_version=COALESCE($4, synced_version) WHERE id=$1`,
            [job.task_id, syncStatus, error, version]);
        }
      }
      const t = await client.query('SELECT project_id FROM tasks WHERE id = $1', [job.task_id]);
      projectId = t.rows[0]?.project_id ?? null;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (projectId) bus.emit('task:changed', { projectId, taskId: job.task_id });
  }

  async function processJob(job) {
    try {
      const res = await sync(job);
      if (res.skipped) await finish(job, { status: 'done', touchTask: false });
      else await finish(job, { status: 'done', syncStatus: 'synced', version: res.version ?? null });
    } catch (err) {
      const code = err instanceof DiscordError ? err.discordCode : 'TRANSIENT';
      const msg = err instanceof DiscordError ? err.message : `Errore imprevisto: ${err.message}`;
      if (!(err instanceof DiscordError)) log('worker: errore imprevisto', err.message);
      if (code === 'RATE_LIMITED') {
        await finish(job, { status: 'pending', error: msg, delayMs: err.retryAfterMs ?? 5000, syncStatus: 'pending' });
      } else if (code === 'NOT_FOUND') {
        const { rows } = await pool.query('SELECT id, project_id, discord_thread_id FROM tasks WHERE id = $1', [job.task_id]);
        if (rows[0]?.discord_thread_id) {
          await finish(job, {
            status: 'done', syncStatus: 'missing',
            error: 'Il post su Discord e stato eliminato. Usa "Ripubblica" per ricrearlo.',
          });
          await addEvent(rows[0], 'discord_missing');
        } else {
          await finish(job, { status: 'error', syncStatus: 'error', error: msg, countAttempt: true });
        }
      } else if (code === 'TRANSIENT') {
        const next = job.attempts + 1;
        if (next >= MAX_ATTEMPTS) {
          await finish(job, { status: 'error', syncStatus: 'error', error: `${msg} (tentativi esauriti)`, countAttempt: true });
        } else {
          await finish(job, { status: 'pending', syncStatus: 'pending', error: `${msg} - nuovo tentativo automatico`, delayMs: backoffMs(next), countAttempt: true });
        }
      } else {
        // NOT_CONFIGURED, MISSING_PERMISSIONS, INVALID_CONFIG: serve intervento umano
        await finish(job, { status: 'error', syncStatus: 'error', error: msg, countAttempt: true });
      }
    }
  }

  /** Elabora tutti i job in scadenza. Ritorna il numero di job processati. */
  async function tick() {
    if (running) return 0;
    running = true;
    let n = 0;
    try {
      while (!stopping) {
        const job = await claim();
        if (!job) break;
        current = processJob(job);
        await current;
        n += 1;
      }
    } finally {
      current = null;
      running = false;
    }
    return n;
  }

  function start() {
    stopping = false;
    bus.on('outbox:nudge', onNudge);
    timer = setInterval(() => tick().catch((e) => log('worker: tick fallito', e.message)), POLL_MS);
    timer.unref?.();
    tick().catch((e) => log('worker: tick fallito', e.message));
  }
  function onNudge() { setImmediate(() => tick().catch((e) => log('worker: tick fallito', e.message))); }

  async function stop() {
    stopping = true;
    bus.off('outbox:nudge', onNudge);
    clearInterval(timer);
    if (current) await current.catch(() => {});
    while (running) await new Promise((r) => setTimeout(r, 20));
  }

  return { start, stop, tick };
}

/** Segna un task come "post eliminato" (es. evento threadDelete del bot). */
async function markThreadMissing({ pool, bus }, threadId) {
  const { rows } = await pool.query(
    `UPDATE tasks SET sync_status = 'missing',
            sync_error = 'Il post su Discord e stato eliminato. Usa "Ripubblica" per ricrearlo.'
      WHERE discord_thread_id = $1 AND sync_status <> 'missing' RETURNING id, project_id`,
    [threadId],
  );
  for (const t of rows) {
    await pool.query(`UPDATE outbox SET status='done', locked_at=NULL WHERE task_id=$1 AND status IN ('pending')`, [t.id]);
    const ev = await pool.query(
      `INSERT INTO task_events (task_id, project_id, source, type, changes) VALUES ($1,$2,'system','discord_missing','{}') RETURNING id`,
      [t.id, t.project_id]);
    bus.emit('task:changed', { projectId: t.project_id, taskId: t.id });
    bus.emit('task:event', { projectId: t.project_id, taskId: t.id, eventId: ev.rows[0].id });
  }
  return rows.length;
}

module.exports = { createOutboxWorker, markThreadMissing, backoffMs, MAX_ATTEMPTS };
