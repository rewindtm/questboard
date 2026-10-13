'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/harness');

let h; let t; let tasks;
test.before(async () => {
  h = await createHarness();
  t = await h.project('alpha', { dev: ['developer'], dev2: ['developer'], tester: ['tester', false], qa: ['tester', true] });
  tasks = h.services.tasks;
});
test.after(() => h.close());

const ctx = (u, s) => h.ctx(u, s);
async function mk(extra = {}) {
  return tasks.create(ctx(t.owner), t.project.id, { title: 'Task di prova', description: 'd', ...extra });
}

test('creazione: codice progressivo univoco per progetto, versione 1, evento "created"', async () => {
  const a = await mk(); const b = await mk();
  assert.equal(a.code, 'TASK-01'); assert.equal(b.code, 'TASK-02');
  assert.equal(a.version, 1); assert.equal(a.status, 'todo');
  const hist = await tasks.history(t.owner, a.id);
  assert.equal(hist[0].type, 'created');
  assert.equal(hist[0].source, 'web');
});

test('codici progressivi sotto concorrenza: nessun duplicato', async () => {
  const created = await Promise.all(Array.from({ length: 8 }, () => mk()));
  const codes = new Set(created.map((x) => x.code));
  assert.equal(codes.size, 8);
});

test('validazione server: titolo vuoto, priorita, data, checklist troppo lunga', async () => {
  await assert.rejects(tasks.create(ctx(t.owner), t.project.id, { title: '  ' }), { code: 'validation' });
  await assert.rejects(tasks.create(ctx(t.owner), t.project.id, { title: 'x', priority: 'urgentissima' }), { code: 'validation' });
  await assert.rejects(tasks.create(ctx(t.owner), t.project.id, { title: 'x', due_date: '2026-02-31' }), { code: 'validation' });
  await assert.rejects(tasks.create(ctx(t.owner), t.project.id, { title: 'x', checklist: Array.from({ length: 31 }, () => ({ text: 'a' })) }), { code: 'validation' });
  await assert.rejects(tasks.create(ctx(t.owner), t.project.id, { title: 'x', campo_extra: 1 }), { code: 'validation' });
});

test('assegnatario e build devono appartenere al progetto', async () => {
  const stranger = await h.user(null, 'estraneo');
  await assert.rejects(mk({ assignee_id: stranger.id }), { code: 'validation' });
  await assert.rejects(mk({ build_id: 999999 }), { code: 'validation' });
  const ok = await mk({ assignee_id: t.dev.id });
  assert.equal(ok.assignee.id, t.dev.id);
});

test('permessi di creazione: sviluppatore no, tester si (ma senza assegnatario/scadenza)', async () => {
  await assert.rejects(tasks.create(ctx(t.dev), t.project.id, { title: 'x' }), { code: 'forbidden' });
  const bug = await tasks.create(ctx(t.tester), t.project.id, { title: 'Bug trovato', category: 'Bug' });
  assert.equal(bug.author.id, t.tester.id);
  await assert.rejects(tasks.create(ctx(t.tester), t.project.id, { title: 'x', assignee_id: t.dev.id }), { code: 'forbidden' });
});

test('un utente che ha fatto login ma non e nel team non vede ne modifica nulla', async () => {
  const outsider = await h.user(null, 'outsider');
  const x = await mk();
  await assert.rejects(tasks.get(outsider, x.id), { code: 'not_found' });
  await assert.rejects(tasks.update(ctx(outsider), x.id, { title: 'hack' }), { code: 'not_found' });
  await assert.rejects(tasks.create(ctx(outsider), t.project.id, { title: 'x' }), { code: 'not_found' });
  await assert.rejects(h.services.projects.snapshot(outsider, t.project.id), { code: 'not_found' });
});

test('sviluppatore: porta i SUOI task fino a "da verificare", mai a "completato"', async () => {
  const x = await mk({ assignee_id: t.dev.id });
  let r = await tasks.changeStatus(ctx(t.dev), x.id, 'in_progress');
  assert.equal(r.task.status, 'in_progress');
  r = await tasks.changeStatus(ctx(t.dev), x.id, 'review');
  assert.equal(r.task.status, 'review');
  await assert.rejects(tasks.changeStatus(ctx(t.dev), x.id, 'done'), { code: 'forbidden' });
  // non puo toccare task di altri
  const other = await mk({ assignee_id: t.dev2.id });
  await assert.rejects(tasks.changeStatus(ctx(t.dev), other.id, 'in_progress'), { code: 'forbidden' });
  // non puo cambiare priorita/assegnatario
  await assert.rejects(tasks.update(ctx(t.dev), x.id, { priority: 'low' }), { code: 'forbidden' });
  await assert.rejects(tasks.update(ctx(t.dev), x.id, { assignee_id: t.dev2.id }), { code: 'forbidden' });
});

test('transizioni: strutturalmente non valide rifiutate (non admin), approvazione solo ad admin/tester autorizzati', async () => {
  const x = await mk({ assignee_id: t.dev.id });
  await assert.rejects(tasks.changeStatus(ctx(t.dev), x.id, 'review'), { code: 'validation' }); // todo -> review
  await tasks.changeStatus(ctx(t.dev), x.id, 'in_progress');
  await tasks.changeStatus(ctx(t.dev), x.id, 'review');
  await assert.rejects(tasks.changeStatus(ctx(t.tester), x.id, 'done'), { code: 'forbidden' }); // tester senza approvazione
  const ok = await tasks.changeStatus(ctx(t.qa), x.id, 'done');
  assert.equal(ok.task.status, 'done');
  // admin puo anche saltare
  const y = await mk();
  assert.equal((await tasks.changeStatus(ctx(t.owner), y.id, 'review')).task.status, 'review');
  // tester autorizzato non approva un task che non e in verifica
  const z = await mk();
  await assert.rejects(tasks.changeStatus(ctx(t.qa), z.id, 'done'), /./);
});

test('controllo ottimistico: versione vecchia -> 409 con record corrente, nessuna sovrascrittura', async () => {
  const x = await mk();
  await tasks.update(ctx(t.owner), x.id, { title: 'Modifica di Anna' }, { expectedVersion: 1 });
  await assert.rejects(
    tasks.update(ctx(t.owner), x.id, { title: 'Modifica di Bruno' }, { expectedVersion: 1 }),
    (e) => e.code === 'conflict' && e.extra.current.title === 'Modifica di Anna' && e.extra.current.version === 2,
  );
  assert.equal((await tasks.get(t.owner, x.id)).title, 'Modifica di Anna');
});

test('aggiornamenti concorrenti con la stessa versione: ne vince uno solo', async () => {
  const x = await mk();
  const results = await Promise.allSettled([
    tasks.update(ctx(t.owner), x.id, { title: 'A' }, { expectedVersion: 1 }),
    tasks.update(ctx(t.owner), x.id, { title: 'B' }, { expectedVersion: 1 }),
    tasks.update(ctx(t.owner), x.id, { title: 'C' }, { expectedVersion: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'conflict').length, 2);
  assert.equal((await tasks.get(t.owner, x.id)).version, 2);
});

test('storico: autore, origine, valori prima/dopo; nessun evento se nulla cambia', async () => {
  const x = await mk({ assignee_id: t.dev.id });
  await tasks.update(ctx(t.owner), x.id, { priority: 'critical', assignee_id: t.dev2.id });
  await tasks.update(ctx(t.owner), x.id, { priority: 'critical' }); // no-op
  const hist = await tasks.history(t.owner, x.id);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist[0].changes.priority, { from: 'medium', to: 'critical' });
  assert.deepEqual(hist[0].changes.assignee, { from: 'dev', to: 'dev2' });
  assert.equal(hist[0].actor.id, t.owner.id);
});

test('checklist modificabile e riepilogo nello storico', async () => {
  const x = await mk({ checklist: [{ text: 'uno' }, { text: 'due' }] });
  assert.ok(x.checklist[0].id);
  const next = x.checklist.map((i, k) => ({ ...i, done: k === 0 }));
  const { task } = await tasks.update(ctx(t.owner), x.id, { checklist: next });
  assert.equal(task.checklist[0].done, true);
  const hist = await tasks.history(t.owner, x.id);
  assert.deepEqual(hist[0].changes.checklist, { from: '0/2 completate', to: '1/2 completate' });
});

test('archiviazione: solo admin, task archiviato non modificabile, ripristino', async () => {
  const x = await mk();
  await assert.rejects(tasks.setArchived(ctx(t.dev), x.id, true), { code: 'forbidden' });
  const a = await tasks.setArchived(ctx(t.owner), x.id, true);
  assert.equal(a.archived, true);
  await assert.rejects(tasks.update(ctx(t.owner), x.id, { title: 'no' }), { code: 'validation' });
  const snap = await h.services.projects.snapshot(t.owner, t.project.id);
  assert.ok(!snap.tasks.some((k) => k.id === x.id));
  assert.equal((await tasks.setArchived(ctx(t.owner), x.id, false)).archived, false);
});

test('scrittura atomica: se l\'outbox fallisce, task, storico e outbox restano invariati', async () => {
  const x = await mk();
  await h.pool.query(`UPDATE tasks SET discord_thread_id='555', discord_message_id='555', sync_status='synced' WHERE id=$1`, [x.id]);
  await h.pool.query(`CREATE OR REPLACE FUNCTION qb_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'outbox giu'; END $$ LANGUAGE plpgsql`);
  await h.pool.query(`CREATE TRIGGER qb_fail_trg BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION qb_fail()`);
  try {
    const before = (await h.pool.query('SELECT count(*)::int n FROM task_events WHERE task_id=$1', [x.id])).rows[0].n;
    await assert.rejects(tasks.update(ctx(t.owner), x.id, { title: 'non deve salvarsi' }), /outbox giu/);
    const row = (await h.pool.query('SELECT title, version FROM tasks WHERE id=$1', [x.id])).rows[0];
    assert.equal(row.title, 'Task di prova'); assert.equal(row.version, 1);
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM task_events WHERE task_id=$1', [x.id])).rows[0].n, before);
  } finally {
    await h.pool.query('DROP TRIGGER qb_fail_trg ON outbox');
  }
});

test('modifica di un task collegato accoda UNA sola sincronizzazione (coalescing) e segna "in attesa"', async () => {
  const x = await mk({ assignee_id: t.dev.id });
  await h.pool.query(`UPDATE tasks SET discord_thread_id='777', discord_message_id='777', sync_status='synced' WHERE id=$1`, [x.id]);
  await tasks.update(ctx(t.owner), x.id, { title: 'v2' });
  await tasks.update(ctx(t.owner), x.id, { title: 'v3' });
  await tasks.update(ctx(t.owner), x.id, { priority: 'low' });
  const q = await h.pool.query(`SELECT * FROM outbox WHERE task_id=$1 AND status IN ('pending','processing')`, [x.id]);
  assert.equal(q.rowCount, 1);
  assert.equal((await tasks.get(t.owner, x.id)).discord.status, 'pending');
});

test('task non collegato a Discord: nessuna outbox, stato "none" (uso senza Discord)', async () => {
  const x = await mk();
  await tasks.update(ctx(t.owner), x.id, { title: 'senza discord' });
  assert.equal((await h.pool.query('SELECT count(*)::int n FROM outbox WHERE task_id=$1', [x.id])).rows[0].n, 0);
  assert.equal((await tasks.get(t.owner, x.id)).discord.status, 'none');
});

test('team: non si rimuove l\'ultimo admin ne chi ha task aperti', async () => {
  const p = h.services.projects;
  await assert.rejects(p.removeMember(t.owner, t.project.id, t.owner.id), { code: 'validation' });
  const x = await mk({ assignee_id: t.dev2.id });
  await assert.rejects(p.removeMember(t.owner, t.project.id, t.dev2.id), { code: 'validation' });
  await assert.rejects(p.addMember(t.dev, t.project.id, { discord_id: '123456789012345678', role: 'tester' }), { code: 'forbidden' });
  void x;
});
