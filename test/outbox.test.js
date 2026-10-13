'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/harness');
const { DiscordError } = require('../src/discord/errors');

let h; let t; let tasks; let gw;
test.before(async () => {
  h = await createHarness();
  t = await h.project('beta', { dev: ['developer'] });
  tasks = h.services.tasks; gw = h.gateway;
});
test.after(() => h.close());

const ctx = (u, s) => h.ctx(u, s);
const mk = (extra = {}) => tasks.create(ctx(t.owner), t.project.id, { title: 'Post di prova', description: 'desc', assignee_id: t.dev.id, ...extra });
const row = async (id) => (await h.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
const makeDue = (id) => h.pool.query(`UPDATE outbox SET next_attempt_at = now() WHERE task_id=$1`, [id]);
const outbox = async (id) => (await h.pool.query(`SELECT * FROM outbox WHERE task_id=$1 ORDER BY id DESC`, [id])).rows;

test.beforeEach(() => { gw.calls.length = 0; gw.failures.length = 0; gw.hook = null; });

test('pubblicazione: crea UN thread, salva gli ID, menziona l\'assegnatario, stato sincronizzato', async () => {
  const x = await mk();
  assert.equal((await row(x.id)).sync_status, 'none');
  await tasks.publish(ctx(t.owner), x.id);
  assert.equal((await row(x.id)).sync_status, 'pending');
  await h.worker.tick();
  const r = await row(x.id);
  assert.equal(r.sync_status, 'synced');
  assert.ok(r.discord_thread_id && r.discord_message_id && r.discord_url);
  assert.equal(r.synced_version, r.version);
  assert.equal(gw.count('create'), 1);
  assert.match(gw.calls.find((c) => c.op === 'create').mention, /^7/);
  assert.equal(gw.threads.get(r.discord_thread_id).name, '[TASK-' + String(r.seq).padStart(2, '0') + '] Post di prova');
  // richiedere di nuovo la pubblicazione non crea un duplicato
  await tasks.publish(ctx(t.owner), x.id);
  await h.worker.tick();
  assert.equal(gw.count('create'), 1);
  assert.equal(gw.threads.size >= 1, true);
});

test('solo gli admin pubblicano/ritentano; senza forum o senza bot l\'errore e esplicito', async () => {
  const x = await mk();
  await assert.rejects(tasks.publish(ctx(t.dev), x.id), { code: 'forbidden' });
  const nf = await h.project('nodiscord', { dev: ['developer'] }, { configureDiscord: false });
  const y = await tasks.create(ctx(nf.owner), nf.project.id, { title: 'senza forum' });
  await assert.rejects(tasks.publish(ctx(nf.owner), y.id), /forum Discord configurato/);
  const h2 = await createHarness({ gatewayConfigured: false });
  try {
    const p = await h2.project('nobot');
    const z = await h2.services.tasks.create(h2.ctx(p.owner), p.project.id, { title: 'senza bot' });
    await assert.rejects(h2.services.tasks.publish(h2.ctx(p.owner), z.id), /non configurata/);
    assert.equal((await h2.pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 0); // nessuna finta sincronizzazione
  } finally { await h2.close(); }
});

test('Discord indisponibile: il task resta salvato, stato "in attesa" con backoff, poi si riallinea senza duplicati', async () => {
  const x = await mk({ title: 'Discord giu' });
  gw.failNext(new DiscordError('TRANSIENT', 'Discord e giu'), 2);
  await tasks.publish(ctx(t.owner), x.id);
  await h.worker.tick();
  let r = await row(x.id);
  assert.equal(r.sync_status, 'pending'); assert.match(r.sync_error, /Discord e giu/);
  assert.equal((await tasks.get(t.owner, x.id)).title, 'Discord giu'); // task intatto
  const [job] = await outbox(x.id);
  assert.equal(job.attempts, 1); assert.equal(job.status, 'pending');
  assert.ok(new Date(job.next_attempt_at) > new Date(Date.now() + 10_000), 'backoff nel futuro');
  assert.equal(await h.worker.tick(), 0, 'non ritenta prima della scadenza');
  await makeDue(x.id); await h.worker.tick();           // secondo fallimento
  assert.equal((await outbox(x.id))[0].attempts, 2);
  await makeDue(x.id); await h.worker.tick();           // successo
  r = await row(x.id);
  assert.equal(r.sync_status, 'synced'); assert.equal(r.sync_error, null);
  // tentativo 1: create fallita; tentativo 2: riconciliazione (find) fallita; tentativo 3: find vuota + create riuscita
  assert.equal(gw.count('create'), 2);
  assert.equal(gw.count('find'), 2);
  assert.equal([...gw.threads.values()].filter((v) => v.name.includes('Discord giu')).length, 1, 'un solo post');
});

test('crash dopo la creazione del post ma prima di salvare gli ID: riconciliazione, nessun duplicato', async () => {
  const x = await mk({ title: 'Crash test unico' });
  gw.crashAfterCreate = true;
  await tasks.publish(ctx(t.owner), x.id);
  await h.worker.tick();
  let r = await row(x.id);
  assert.equal(r.discord_thread_id, null, 'ID non salvati');
  assert.ok(r.publish_started_at);
  const before = [...gw.threads.values()].filter((v) => v.name.includes('Crash test unico')).length;
  assert.equal(before, 1, 'il post esiste su Discord');
  await makeDue(x.id); await h.worker.tick();
  r = await row(x.id);
  assert.equal(r.sync_status, 'synced'); assert.ok(r.discord_thread_id);
  assert.equal([...gw.threads.values()].filter((v) => v.name.includes('Crash test unico')).length, 1, 'ancora un solo post');
  assert.equal(gw.count('find'), 1);
  const hist = await tasks.history(t.owner, x.id);
  assert.ok(hist.some((e) => e.type === 'discord_linked'));
});

test('errori permanenti (permessi): stato "errore", nessun retry automatico, retry manuale solo admin', async () => {
  const x = await mk();
  gw.failNext(new DiscordError('MISSING_PERMISSIONS', 'Il bot non ha i permessi necessari'));
  await tasks.publish(ctx(t.owner), x.id);
  await h.worker.tick();
  let r = await row(x.id);
  assert.equal(r.sync_status, 'error'); assert.match(r.sync_error, /permessi/);
  assert.equal(await h.worker.tick(), 0);
  await assert.rejects(tasks.retrySync(ctx(t.dev), x.id), { code: 'forbidden' });
  await tasks.retrySync(ctx(t.owner), x.id);
  await h.worker.tick();
  r = await row(x.id);
  assert.equal(r.sync_status, 'synced'); assert.ok(r.discord_thread_id);
});

test('tentativi esauriti -> errore finale', async () => {
  const x = await mk();
  await tasks.publish(ctx(t.owner), x.id);
  await h.pool.query('UPDATE outbox SET attempts = 7 WHERE task_id=$1', [x.id]);
  gw.failNext(new DiscordError('TRANSIENT', 'ancora giu'));
  await h.worker.tick();
  const r = await row(x.id);
  assert.equal(r.sync_status, 'error'); assert.match(r.sync_error, /tentativi esauriti/);
});

test('rate limit: attende retryAfter senza consumare tentativi', async () => {
  const x = await mk();
  gw.failNext(new DiscordError('RATE_LIMITED', 'rate limit', { retryAfterMs: 30_000 }));
  await tasks.publish(ctx(t.owner), x.id);
  await h.worker.tick();
  const [job] = await outbox(x.id);
  assert.equal(job.attempts, 0); assert.equal(job.status, 'pending');
  const wait = new Date(job.next_attempt_at) - Date.now();
  assert.ok(wait > 20_000 && wait <= 31_000);
  assert.equal((await row(x.id)).sync_status, 'pending');
});

test('modifiche automatiche: aggiornano il post, menzione SOLO al cambio di assegnatario', async () => {
  const dev2 = await h.user(null, 'dev2');
  await h.pool.query(`INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,'developer')`, [t.project.id, dev2.id]);
  const x = await mk();
  await tasks.publish(ctx(t.owner), x.id); await h.worker.tick();
  gw.calls.length = 0;
  await tasks.update(ctx(t.owner), x.id, { title: 'Nuovo titolo', priority: 'critical' });
  await h.worker.tick();
  let up = gw.calls.find((c) => c.op === 'update');
  assert.equal(up.mention, null);
  const tid = (await row(x.id)).discord_thread_id;
  assert.match(gw.threads.get(tid).name, /Nuovo titolo/);
  await tasks.update(ctx(t.owner), x.id, { assignee_id: dev2.id });
  await h.worker.tick();
  up = gw.calls.filter((c) => c.op === 'update').pop();
  assert.equal(up.mention, dev2.discord_id);
  await tasks.update(ctx(t.owner), x.id, { description: 'altro' });
  await h.worker.tick();
  assert.equal(gw.calls.filter((c) => c.op === 'update').pop().mention, null);
});

test('modifica durante la sincronizzazione: nuovo giro con la versione piu recente, un solo job attivo', async () => {
  const x = await mk();
  await tasks.publish(ctx(t.owner), x.id); await h.worker.tick();
  let fired = false;
  gw.hook = async (op) => {
    if (op === 'update' && !fired) { fired = true; await tasks.update(ctx(t.owner), x.id, { title: 'Versione B' }); }
  };
  await tasks.update(ctx(t.owner), x.id, { title: 'Versione A' });
  await h.worker.tick();
  const r = await row(x.id);
  assert.equal(r.sync_status, 'synced');
  assert.equal(r.synced_version, r.version);
  assert.match(gw.threads.get(r.discord_thread_id).name, /Versione B/);
  assert.equal(gw.count('create'), 1);
});

test('post eliminato: segnalato, mai ricreato in silenzio; ripubblicazione esplicita solo admin', async () => {
  const x = await mk({ title: 'Da eliminare' });
  await tasks.publish(ctx(t.owner), x.id); await h.worker.tick();
  const oldThread = (await row(x.id)).discord_thread_id;
  gw.deleteThread(oldThread);
  await tasks.update(ctx(t.owner), x.id, { priority: 'high' });
  await h.worker.tick();
  let r = await row(x.id);
  assert.equal(r.sync_status, 'missing'); assert.match(r.sync_error, /eliminato/);
  const creates = gw.count('create');
  await tasks.update(ctx(t.owner), x.id, { priority: 'low' });     // ulteriori modifiche non ricreano nulla
  await h.worker.tick();
  assert.equal(gw.count('create'), creates);
  assert.equal((await row(x.id)).sync_status, 'missing');
  await assert.rejects(tasks.repost(ctx(t.dev), x.id), { code: 'forbidden' });
  await assert.rejects(tasks.publish(ctx(t.owner), x.id), /Ripubblica/);
  await tasks.repost(ctx(t.owner), x.id); await h.worker.tick();
  r = await row(x.id);
  assert.equal(r.sync_status, 'synced');
  assert.notEqual(r.discord_thread_id, oldThread);
  assert.equal(gw.count('create'), creates + 1);
});

test('thread eliminato rilevato dal bot (evento): markThreadMissing', async () => {
  const { markThreadMissing } = require('../src/outbox/worker');
  const x = await mk();
  await tasks.publish(ctx(t.owner), x.id); await h.worker.tick();
  const tid = (await row(x.id)).discord_thread_id;
  assert.equal(await markThreadMissing({ pool: h.pool, bus: h.bus }, tid), 1);
  assert.equal((await row(x.id)).sync_status, 'missing');
  assert.equal(await markThreadMissing({ pool: h.pool, bus: h.bus }, tid), 0);
});

test('job rimasto "processing" dopo un crash del processo: viene ripreso', async () => {
  const x = await mk();
  await tasks.publish(ctx(t.owner), x.id);
  await h.pool.query(`UPDATE outbox SET status='processing', locked_at = now() - interval '10 minutes' WHERE task_id=$1`, [x.id]);
  await h.worker.tick();
  assert.equal((await row(x.id)).sync_status, 'synced');
});

test('un solo job attivo per task anche con richieste concorrenti', async () => {
  const x = await mk();
  await Promise.all([1, 2, 3, 4].map(() => tasks.publish(ctx(t.owner), x.id)));
  assert.equal((await h.pool.query(`SELECT count(*)::int n FROM outbox WHERE task_id=$1 AND status IN ('pending','processing')`, [x.id])).rows[0].n, 1);
  await h.worker.tick();
  assert.equal(gw.count('create'), 1);
});
