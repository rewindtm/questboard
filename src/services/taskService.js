'use strict';
const crypto = require('node:crypto');
const { withTx } = require('../db/pool');
const { TASK_SELECT, taskDto, eventDto } = require('./dto');
const { getMember } = require('./membership');
const { enqueue } = require('../outbox/outbox');
const perm = require('../domain/permissions');
const { TRANSITIONS } = require('../domain/constants');
const { parse, taskPatchSchema, taskCreateSchema } = require('../domain/validation');
const { ValidationError, ForbiddenError, NotFoundError, ConflictError } = require('../errors');

const COLUMNS = ['title', 'description', 'checklist', 'priority', 'status', 'category', 'assignee_id', 'due_date', 'build_id'];
const FIELD_LABELS = {
  title: 'il titolo', description: 'la descrizione', checklist: 'la checklist', priority: 'la priorita',
  status: 'lo stato', category: 'la categoria', assignee_id: "l'assegnatario", due_date: 'la scadenza', build_id: 'la build',
};

const newItemId = () => crypto.randomBytes(4).toString('hex');
function normChecklist(list) {
  const seen = new Set();
  return list.map((it) => {
    let id = it.id && !seen.has(it.id) ? it.id : newItemId();
    seen.add(id);
    return { id, text: it.text, done: !!it.done };
  });
}
function checklistSummary(list) {
  const done = list.filter((i) => i.done).length;
  return `${done}/${list.length} completate`;
}

/**
 * Servizio condiviso per tutte le operazioni sui task: lo usano sia le route web
 * sia i gestori delle interazioni Discord, cosi le regole di business esistono una volta sola.
 *
 * `ctx` = { actor: <riga users>, source: 'web' | 'discord' }
 * Il ruolo dell'attore viene sempre riletto dal database.
 */
function createTaskService({ pool, bus, gateway }) {
  const emitChange = (projectId, taskId, eventId) => {
    bus.emit('task:changed', { projectId, taskId });
    if (eventId) bus.emit('task:event', { projectId, taskId, eventId });
  };

  async function loadDto(db, taskId) {
    const { rows } = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    return rows[0] ? taskDto(rows[0]) : null;
  }

  async function lockTask(client, ctx, taskId) {
    const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
    const task = rows[0];
    if (!task) throw new NotFoundError('Task non trovato');
    const member = await getMember(client, task.project_id, ctx.actor);
    if (!member) throw new NotFoundError('Task non trovato'); // non rivela l'esistenza a chi non e nel team
    return { task, member };
  }

  async function insertEvent(client, task, ctx, type, changes) {
    const { rows } = await client.query(
      `INSERT INTO task_events (task_id, project_id, actor_id, source, type, changes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [task.id, task.project_id, ctx.actor?.id ?? null, ctx.source || 'web', type, JSON.stringify(changes)],
    );
    return rows[0].id;
  }

  // ---------------------------------------------------------------- lettura
  async function get(actor, taskId) {
    const { rows } = await pool.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    if (!rows[0]) throw new NotFoundError('Task non trovato');
    if (!(await getMember(pool, rows[0].project_id, actor))) throw new NotFoundError('Task non trovato');
    return loadDto(pool, taskId);
  }

  async function getByCode(actor, projectId, code) {
    const { rows } = await pool.query('SELECT id FROM tasks WHERE project_id = $1 AND code = $2', [projectId, code]);
    return rows[0] ? get(actor, rows[0].id) : null;
  }

  async function history(actor, taskId, limit = 50) {
    const { rows: t } = await pool.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    if (!t[0] || !(await getMember(pool, t[0].project_id, actor))) throw new NotFoundError('Task non trovato');
    const { rows } = await pool.query(
      `SELECT e.*, COALESCE(u.display_name, u.username, u.local_login) AS actor_name
         FROM task_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.task_id = $1 ORDER BY e.id DESC LIMIT $2`,
      [taskId, limit],
    );
    return rows.map(eventDto);
  }

  async function eventById(eventId) {
    const { rows } = await pool.query(
      `SELECT e.*, COALESCE(u.display_name, u.username, u.local_login) AS actor_name
         FROM task_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.id = $1`,
      [eventId],
    );
    return rows[0] ? eventDto(rows[0]) : null;
  }

  async function listArchived(actor, projectId) {
    if (!(await getMember(pool, projectId, actor))) throw new NotFoundError('Progetto non trovato');
    const { rows } = await pool.query(
      `${TASK_SELECT} WHERE t.project_id = $1 AND t.archived_at IS NOT NULL ORDER BY t.archived_at DESC LIMIT 200`,
      [projectId],
    );
    return rows.map(taskDto);
  }

  // ---------------------------------------------------------------- scrittura
  async function validateRefs(client, task, projectId, patch) {
    const names = {};
    if (patch.assignee_id) {
      const { rows } = await client.query(
        `SELECT u.id, COALESCE(u.display_name, u.username, u.local_login) AS name, u.is_superadmin,
                (SELECT 1 FROM project_members m WHERE m.project_id = $2 AND m.user_id = u.id) AS member
           FROM users u WHERE u.id = $1`,
        [patch.assignee_id, projectId],
      );
      if (!rows[0] || !rows[0].member) throw new ValidationError('Assegnatario non valido', { assignee_id: "L'utente non fa parte del team" });
      names.assignee = rows[0].name;
    }
    if (patch.build_id) {
      const { rows } = await client.query('SELECT name FROM builds WHERE id = $1 AND project_id = $2', [patch.build_id, projectId]);
      if (!rows[0]) throw new ValidationError('Build non valida', { build_id: 'Build inesistente in questo progetto' });
      names.build = rows[0].name;
    }
    if (patch.category) {
      const { rows } = await client.query('SELECT categories FROM projects WHERE id = $1', [projectId]);
      if (!rows[0].categories.includes(patch.category) && patch.category !== task?.category) {
        throw new ValidationError('Categoria non valida', { category: 'Categoria non prevista dal progetto' });
      }
    }
    return names;
  }

  async function nameOf(client, userId) {
    if (!userId) return null;
    const { rows } = await client.query(
      'SELECT COALESCE(display_name, username, local_login) AS name FROM users WHERE id = $1', [userId]);
    return rows[0]?.name ?? null;
  }
  async function buildName(client, id) {
    if (!id) return null;
    const { rows } = await client.query('SELECT name FROM builds WHERE id = $1', [id]);
    return rows[0]?.name ?? null;
  }

  /**
   * Aggiorna un task. `expectedVersion` (opzionale) abilita il controllo ottimistico:
   * se il record e cambiato risponde 409 con la versione corrente.
   * Il cambio stato dal bot Discord omette la versione e agisce sull'ultima.
   */
  async function update(ctx, taskId, rawPatch, { expectedVersion = null } = {}) {
    const patch = parse(taskPatchSchema, rawPatch);
    const keys = Object.keys(patch);
    if (!keys.length) throw new ValidationError('Nessuna modifica indicata');

    const result = await withTx(pool, async (client) => {
      const { task, member } = await lockTask(client, ctx, taskId);
      if (expectedVersion != null && Number(expectedVersion) !== task.version) {
        throw new ConflictError(await loadDto(client, taskId));
      }
      if (task.archived_at) throw new ValidationError('Il task e archiviato: ripristinalo per modificarlo');

      if (patch.checklist) patch.checklist = normChecklist(patch.checklist);
      const names = await validateRefs(client, task, task.project_id, patch);

      const updates = {};
      const changes = {};
      for (const key of keys) {
        const before = task[key];
        const after = patch[key];
        const same = key === 'checklist'
          ? JSON.stringify(before) === JSON.stringify(after)
          : (before ?? null) === (after ?? null);
        if (same) continue;
        updates[key] = after;
        if (key === 'checklist') {
          const s = [checklistSummary(before), checklistSummary(after)];
          changes.checklist = { from: s[0], to: s[1] === s[0] ? 'voci modificate' : s[1] };
        } else if (key === 'assignee_id') {
          changes.assignee = { from: await nameOf(client, before), to: names.assignee ?? null };
        } else if (key === 'build_id') {
          changes.build = { from: await buildName(client, before), to: names.build ?? null };
        } else if (key === 'description') {
          changes.description = { from: null, to: 'modificata' };
        } else {
          changes[key] = { from: before ?? null, to: after ?? null };
        }
      }
      const changedKeys = Object.keys(updates);
      if (!changedKeys.length) return { unchanged: true, dto: await loadDto(client, taskId) };

      // autorizzazioni campo per campo
      const allowed = perm.editableFields(member, task);
      for (const key of changedKeys) {
        if (!allowed.includes(key)) throw new ForbiddenError(`Non puoi modificare ${FIELD_LABELS[key]}`);
      }
      if (updates.status) {
        if (!perm.canTransition(member, task, task.status, updates.status)) {
          const structurallyValid = TRANSITIONS[task.status]?.includes(updates.status);
          if (!perm.isAdmin(member) && !structurallyValid) {
            throw new ValidationError('Transizione di stato non valida', { status: `Da ${task.status} a ${updates.status} non e previsto` });
          }
          throw new ForbiddenError('Non hai i permessi per questo cambio di stato');
        }
      }

      const sets = [];
      const vals = [];
      for (const key of changedKeys) {
        vals.push(key === 'checklist' ? JSON.stringify(updates[key]) : updates[key]);
        sets.push(`${key} = $${vals.length}${key === 'checklist' ? '::jsonb' : ''}`);
      }
      vals.push(taskId);
      await client.query(
        `UPDATE tasks SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${vals.length}`,
        vals,
      );

      const only = (k) => changedKeys.length === 1 && changedKeys[0] === k;
      const type = only('status') ? 'status' : only('checklist') ? 'checklist' : 'update';
      const eventId = await insertEvent(client, task, ctx, type, changes);

      if (task.discord_thread_id && task.sync_status !== 'missing') {
        await enqueue(client, {
          taskId, projectId: task.project_id, kind: 'update',
          mentionUserId: updates.assignee_id || null, // menzione solo se cambia l'assegnatario
        });
      }
      return { unchanged: false, dto: await loadDto(client, taskId), eventId, projectId: task.project_id };
    });

    if (!result.unchanged) {
      emitChange(result.projectId, taskId, result.eventId);
      bus.emit('outbox:nudge', {});
    }
    return { task: result.dto, changed: !result.unchanged };
  }

  const changeStatus = (ctx, taskId, status, opts) => update(ctx, taskId, { status }, opts);

  async function create(ctx, projectId, rawInput) {
    const input = parse(taskCreateSchema, rawInput);
    const result = await withTx(pool, async (client) => {
      const member = await getMember(client, projectId, ctx.actor);
      if (!member) throw new NotFoundError('Progetto non trovato');
      if (!perm.canCreateTask(member)) throw new ForbiddenError('Non puoi creare task in questo progetto');
      if (!perm.isAdmin(member) && (input.assignee_id || input.due_date || input.build_id)) {
        throw new ForbiddenError('Solo gli amministratori possono impostare assegnatario, scadenza e build');
      }
      const names = await validateRefs(client, null, projectId, input);
      const { rows: p } = await client.query(
        `UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq, code_prefix`, [projectId]);
      const seq = p[0].task_seq;
      const code = `${p[0].code_prefix}-${String(seq).padStart(2, '0')}`;
      const checklist = normChecklist(input.checklist);
      const { rows } = await client.query(
        `INSERT INTO tasks (project_id, seq, code, title, description, checklist, priority, status, category,
                            assignee_id, due_date, build_id, author_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'todo',$8,$9,$10,$11,$12) RETURNING id`,
        [projectId, seq, code, input.title, input.description, JSON.stringify(checklist), input.priority,
          input.category, input.assignee_id, input.due_date, input.build_id, ctx.actor.id],
      );
      const task = { id: rows[0].id, project_id: projectId };
      const eventId = await insertEvent(client, task, ctx, 'created', {
        title: { from: null, to: input.title },
        assignee: { from: null, to: names.assignee ?? null },
      });
      return { dto: await loadDto(client, task.id), eventId };
    });
    emitChange(projectId, result.dto.id, result.eventId);
    return result.dto;
  }

  async function setArchived(ctx, taskId, archived, { expectedVersion = null } = {}) {
    const result = await withTx(pool, async (client) => {
      const { task, member } = await lockTask(client, ctx, taskId);
      if (!perm.isAdmin(member)) throw new ForbiddenError("Solo gli amministratori possono archiviare i task");
      if (expectedVersion != null && Number(expectedVersion) !== task.version) {
        throw new ConflictError(await loadDto(client, taskId));
      }
      if (!!task.archived_at === archived) return { dto: await loadDto(client, taskId), unchanged: true };
      await client.query(
        `UPDATE tasks SET archived_at = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [taskId, archived ? new Date() : null],
      );
      const eventId = await insertEvent(client, task, ctx, archived ? 'archived' : 'restored', {});
      if (task.discord_thread_id && task.sync_status !== 'missing') {
        await enqueue(client, { taskId, projectId: task.project_id, kind: 'update' });
      }
      return { dto: await loadDto(client, taskId), eventId, projectId: task.project_id };
    });
    if (!result.unchanged) {
      emitChange(result.projectId, taskId, result.eventId);
      bus.emit('outbox:nudge', {});
    }
    return result.dto;
  }

  /**
   * Richieste esplicite di sincronizzazione (solo amministratori):
   *  - 'publish': prima pubblicazione, oppure retry dopo un errore
   *  - 'repost' : ripubblicazione esplicita di un post eliminato da Discord
   */
  async function requestSync(ctx, taskId, mode) {
    const result = await withTx(pool, async (client) => {
      const { task, member } = await lockTask(client, ctx, taskId);
      if (!perm.canRetrySync(member)) throw new ForbiddenError('Solo gli amministratori possono gestire la sincronizzazione');
      if (task.archived_at) throw new ValidationError('Il task e archiviato');
      const { rows } = await client.query(
        'SELECT discord_guild_id, discord_forum_id FROM projects WHERE id = $1', [task.project_id]);
      if (!rows[0].discord_guild_id || !rows[0].discord_forum_id) {
        throw new ValidationError('Il progetto non ha un forum Discord configurato (Impostazioni)');
      }
      if (!gateway.isConfigured()) {
        throw new ValidationError('Integrazione Discord non configurata: manca DISCORD_BOT_TOKEN');
      }
      let kind;
      if (mode === 'repost') {
        if (task.sync_status !== 'missing') throw new ValidationError('Il post Discord non risulta eliminato');
        // nuovo riferimento stabile: il vecchio post (eliminato) non va riconciliato
        await client.query(
          `UPDATE tasks SET discord_thread_id = NULL, discord_message_id = NULL, discord_url = NULL,
                  sync_ref = gen_random_uuid(), publish_started_at = NULL, synced_version = NULL WHERE id = $1`,
          [taskId]);
        kind = 'repost';
      } else {
        if (task.sync_status === 'missing') throw new ValidationError('Il post e stato eliminato: usa "Ripubblica"');
        kind = task.discord_thread_id ? 'update' : 'publish';
      }
      await enqueue(client, {
        taskId, projectId: task.project_id, kind, immediate: true,
        mentionUserId: kind === 'update' ? null : task.assignee_id,
      });
      const eventId = await insertEvent(client, task, ctx, 'sync_requested', { mode: { from: null, to: kind } });
      return { dto: await loadDto(client, taskId), eventId, projectId: task.project_id };
    });
    emitChange(result.projectId, taskId, result.eventId);
    bus.emit('outbox:nudge', {});
    return result.dto;
  }

  return {
    get, getByCode, history, eventById, listArchived, create, update, changeStatus, setArchived,
    publish: (ctx, id) => requestSync(ctx, id, 'publish'),
    retrySync: (ctx, id) => requestSync(ctx, id, 'publish'),
    repost: (ctx, id) => requestSync(ctx, id, 'repost'),
    loadDto,
  };
}

module.exports = { createTaskService, COLUMNS };
