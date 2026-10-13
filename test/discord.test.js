'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/harness');
const { renderPost, parseCustomId, statusMenuId, extractRef } = require('../src/discord/render');
const { createInteractionHandler } = require('../src/discord/interactions');

let h; let t; let tasks;
test.before(async () => {
  h = await createHarness();
  t = await h.project('gamma', { dev: ['developer'], qa: ['tester', true], viewer: ['tester', false] });
  tasks = h.services.tasks;
});
test.after(() => h.close());

const base = {
  id: 7, code: 'TASK-07', title: 'Titolo', description: 'Desc', status: 'in_progress', priority: 'high', category: 'Gameplay',
  checklist: [{ id: 'a', text: 'uno', done: true }, { id: 'b', text: 'due', done: false }], assignee_name: 'Mauro',
  due_date: '2026-11-01', build_name: 'Build 36', sync_ref: '11111111-2222-3333-4444-555555555555', archived_at: null,
};
const opts = { appBaseUrl: 'https://qb.example.com', projectSlug: 'grimthorn', assigneeDiscordId: '123456789012345678',
  tagMap: { status: { in_progress: 'T1' }, priority: { high: 'T2' } } };

test('render: contenuti richiesti, link da APP_BASE_URL, tag, menu stato con custom id stabile', () => {
  const p = renderPost(base, opts);
  assert.equal(p.threadName, '[TASK-07] Titolo');
  assert.equal(p.url, 'https://qb.example.com/p/grimthorn/tasks/TASK-07');
  assert.equal(p.content, 'Assegnato a <@123456789012345678>');
  const e = p.embeds[0];
  const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
  assert.equal(f.Stato, 'In corso'); assert.equal(f['Priorità'], 'Alta'); assert.equal(f.Categoria, 'Gameplay');
  assert.equal(f.Scadenza, '2026-11-01'); assert.equal(f['Build / milestone'], 'Build 36');
  assert.match(f['Criteri di completamento (1/2)'], /☑ uno\n☐ due/);
  assert.deepEqual(p.appliedTags, ['T1', 'T2']);
  const menu = p.components[0].components[0];
  assert.equal(menu.custom_id, 'qb:st:7');
  assert.equal(menu.options.find((o) => o.default).value, 'in_progress');
  assert.equal(p.components[1].components[0].url, p.url);
  assert.equal(extractRef(e.footer.text), base.sync_ref);
});

test('render: titolo lungo troncato a 100, tag mancanti ignorati, archiviato senza menu', () => {
  const p = renderPost({ ...base, title: 'x'.repeat(300), archived_at: new Date() }, { ...opts, tagMap: {} });
  assert.ok(p.threadName.length <= 100);
  assert.deepEqual(p.appliedTags, []);
  assert.equal(p.components.length, 1);
  assert.match(p.embeds[0].title, /^\[Archiviato\]/);
});

test('custom id: parsing stretto', () => {
  assert.deepEqual(parseCustomId(statusMenuId(42)), { action: 'st', taskId: 42 });
  for (const bad of ['', 'qb:st:', 'qb:st:abc', 'x:st:1', 'qb:st:1:2', null]) assert.equal(parseCustomId(bad), null);
});

// ------------------------------------------------------------------ interazioni
function fakeInteraction({ user, customId, values, channelId, guildId = '222222222222222222' }) {
  const log = [];
  return {
    log, customId, values, channelId, guildId, user: { id: user.discord_id },
    isStringSelectMenu: () => true,
    deferReply: async (o) => { log.push(['defer', o]); },
    editReply: async (o) => { log.push(['edit', o.content]); },
  };
}
async function publish(extra = {}) {
  const x = await tasks.create(h.ctx(t.owner), t.project.id, { title: 'Da Discord', assignee_id: t.dev.id, ...extra });
  await tasks.publish(h.ctx(t.owner), x.id); await h.worker.tick();
  const r = (await h.pool.query('SELECT * FROM tasks WHERE id=$1', [x.id])).rows[0];
  return { x, thread: r.discord_thread_id };
}

test('Discord: lo sviluppatore assegnato cambia stato dal menu; stesso servizio del sito (storico "discord", outbox, eventi)', async () => {
  const { x, thread } = await publish();
  const handler = createInteractionHandler({ pool: h.pool, tasks });
  h.events.length = 0;
  const i = fakeInteraction({ user: t.dev, customId: statusMenuId(x.id), values: ['in_progress'], channelId: thread });
  assert.equal(await handler.handle(i), true);
  assert.equal(i.log[0][0], 'defer', 'risposta differita per prima');
  assert.equal(i.log[0][1].flags, 64);
  assert.match(i.log[1][1], /In corso/);
  const cur = await tasks.get(t.owner, x.id);
  assert.equal(cur.status, 'in_progress'); assert.equal(cur.discord.status, 'pending');
  const hist = await tasks.history(t.owner, x.id);
  assert.equal(hist[0].source, 'discord'); assert.equal(hist[0].actor.id, t.dev.id);
  assert.ok(h.events.some((e) => e.n === 'task:changed' && e.taskId === x.id), 'notifica per Socket.IO');
  await h.worker.tick();                                  // il post viene aggiornato
  assert.equal(h.gateway.threads.get(thread).post.embeds[0].fields[0].value, 'In corso');
});

test('Discord: stesse regole del sito - nessun completamento per sviluppatori/tester non autorizzati, estranei respinti', async () => {
  const { x, thread } = await publish();
  const handler = createInteractionHandler({ pool: h.pool, tasks });
  await tasks.update(h.ctx(t.owner), x.id, { status: 'review' });
  const attempt = async (user, value) => {
    const i = fakeInteraction({ user, customId: statusMenuId(x.id), values: [value], channelId: thread });
    await handler.handle(i); return i.log.at(-1)[1];
  };
  assert.match(await attempt(t.dev, 'done'), /permessi/);
  assert.match(await attempt(t.viewer, 'done'), /permessi/);
  const outsider = await h.user(null, 'estraneo');
  assert.match(await attempt(outsider, 'done'), /team/);
  const unknown = { discord_id: '999999999999999999' };
  assert.match(await attempt(unknown, 'done'), /non e registrato/);
  assert.equal((await tasks.get(t.owner, x.id)).status, 'review');
  assert.match(await attempt(t.qa, 'done'), /Completato/);
  assert.equal((await tasks.get(t.owner, x.id)).status, 'done');
});

test('Discord: componente usato fuori dal proprio thread/server o con valore falso viene rifiutato', async () => {
  const { x, thread } = await publish();
  const handler = createInteractionHandler({ pool: h.pool, tasks });
  const wrongChannel = fakeInteraction({ user: t.owner, customId: statusMenuId(x.id), values: ['done'], channelId: '1' });
  await handler.handle(wrongChannel);
  assert.match(wrongChannel.log.at(-1)[1], /non e piu collegato/);
  const wrongGuild = fakeInteraction({ user: t.owner, customId: statusMenuId(x.id), values: ['done'], channelId: thread, guildId: '5' });
  await handler.handle(wrongGuild);
  assert.match(wrongGuild.log.at(-1)[1], /non e piu collegato/);
  const forged = fakeInteraction({ user: t.owner, customId: statusMenuId(x.id), values: ['droppa-tutto'], channelId: thread });
  await handler.handle(forged);
  assert.match(forged.log.at(-1)[1], /non valido/);
  assert.equal((await tasks.get(t.owner, x.id)).status, 'todo');
});

test('Discord: i componenti funzionano dopo un "riavvio" (nuovo gestore, nessuno stato in memoria)', async () => {
  const { x, thread } = await publish();
  // simula il riavvio: nuovo servizio task + nuovo handler costruiti da zero sullo stesso DB
  const { createServices } = require('../src/services');
  const fresh = createServices({ pool: h.pool, bus: h.bus, config: h.config, gateway: h.gateway });
  const handler = createInteractionHandler({ pool: h.pool, tasks: fresh.tasks });
  const i = fakeInteraction({ user: t.owner, customId: statusMenuId(x.id), values: ['review'], channelId: thread });
  await handler.handle(i);
  assert.equal((await tasks.get(t.owner, x.id)).status, 'review');
});

test('Discord: interazioni non Questboard o non-menu vengono ignorate', async () => {
  const handler = createInteractionHandler({ pool: h.pool, tasks });
  assert.equal(await handler.handle({ isStringSelectMenu: () => false }), false);
  assert.equal(await handler.handle({ isStringSelectMenu: () => true, customId: 'altro:bot:1' }), false);
});
