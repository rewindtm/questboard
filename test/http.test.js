'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { createHarness } = require('./helpers/harness');
const { createApp } = require('../src/web/app');
const { createSessionMiddleware } = require('../src/auth/middleware');
const { attachSocket } = require('../src/realtime/socket');

const LOCAL_PW = 'una-password-di-test-lunga';

/** Client HTTP minimale con cookie jar e gestione CSRF. */
function makeClient(base) {
  const jar = new Map();
  let csrf = '';
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, { body, json = true, token = true, form } = {}) {
    const headers = { cookie: cookieHeader() };
    let payload;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    if (json) headers.accept = 'application/json';
    if (token && csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    const m = /name="csrf-token" content="([^"]+)"/.exec(text);
    if (m) csrf = m[1];
    let data = null;
    try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, location: res.headers.get('location'), text, data };
  }
  return { req, cookie: cookieHeader, jar, setCsrf: (t) => { csrf = t; } };
}

async function setup() {
  const h = await createHarness({
    env: {
      ENABLE_LOCAL_AUTH: '1', BOOTSTRAP_ADMIN_LOGIN: 'root', BOOTSTRAP_ADMIN_PASSWORD: LOCAL_PW,
    },
  });
  await h.services.users.ensureBootstrap();

  // finto Discord OAuth: restituisce il profilo scelto dal test
  const state = { profile: { id: '123456789012345678', username: 'esterno', global_name: 'Esterno' } };
  const fakeFetch = async (url) => {
    if (String(url).endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
    return { ok: true, json: async () => state.profile };
  };
  const app = createApp({ config: h.config, pool: h.pool, services: h.services, gateway: h.gateway, deps: { fetch: fakeFetch, rateLimit: false, pruneSessions: false } });
  const server = http.createServer(app);
  const { middleware } = createSessionMiddleware({ config: h.config, pool: h.pool, pruneInterval: false });
  const realtime = attachSocket({ httpServer: server, sessionMiddleware: middleware, bus: h.bus, services: h.services });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    h, base, state,
    async close() { await realtime.close(); await h.close(); },
  };
}

async function localLogin(base, login, password) {
  const c = makeClient(base);
  await c.req('GET', '/login', { json: false });
  const r = await c.req('POST', '/auth/local', { form: { login, password, _csrf: '' }, json: false });
  return { c, r };
}

test('autenticazione, CSRF e appartenenza al team', async (t) => {
  const s = await setup();
  t.after(() => s.close());
  const { h } = s;
  const { project } = await h.project('alpha', { dev: ['developer', false] });

  // 1. senza sessione: API 401, pagine -> redirect
  const anon = makeClient(s.base);
  assert.equal((await anon.req('GET', `/api/projects/${project.id}/snapshot`)).status, 401);
  const page = await anon.req('GET', '/p/alpha', { json: false });
  assert.equal(page.status, 302);
  assert.match(page.location, /login/);

  // 2. OAuth: state errato rifiutato
  const c = makeClient(s.base);
  await c.req('GET', '/login', { json: false });
  const start = await c.req('GET', '/auth/discord', { json: false });
  assert.equal(start.status, 302);
  const state = new URL(start.location).searchParams.get('state');
  assert.ok(state && state.length >= 32);
  const bad = await c.req('GET', '/auth/discord/callback?code=abc&state=sbagliato', { json: false });
  assert.equal(bad.status, 400);
  assert.equal((await c.req('GET', '/', { json: false })).status, 302, 'nessuna sessione dopo state errato');

  // 3. OAuth: state corretto -> login riuscito, ma senza team non si vede nulla
  const start2 = await c.req('GET', '/auth/discord', { json: false });
  const state2 = new URL(start2.location).searchParams.get('state');
  const ok = await c.req('GET', `/auth/discord/callback?code=abc&state=${state2}`, { json: false });
  assert.equal(ok.status, 302);
  assert.equal((await c.req('GET', '/p/alpha', { json: false })).status, 404, 'il solo login non da accesso al progetto');
  assert.equal((await c.req('GET', `/api/projects/${project.id}/snapshot`)).status, 404);
  assert.equal((await c.req('POST', `/api/projects/${project.id}/tasks`, { body: { title: 'x' } })).status, 404);
  // il state e monouso
  const replay = await c.req('GET', `/auth/discord/callback?code=abc&state=${state2}`, { json: false });
  assert.equal(replay.status, 400);

  // 4. login locale: credenziali errate / corrette
  assert.equal((await localLogin(s.base, 'root', 'sbagliata-sbagliata')).r.status, 401);
  const root = await localLogin(s.base, 'root', LOCAL_PW);
  assert.equal(root.r.status, 302);

  // 5. CSRF: senza token 403, con token ok
  await root.c.req('GET', `/p/alpha`, { json: false }); // legge il token dalla meta
  const noToken = await root.c.req('POST', `/api/projects/${project.id}/tasks`, { body: { title: 'Senza token' }, token: false });
  assert.equal(noToken.status, 403);
  const created = await root.c.req('POST', `/api/projects/${project.id}/tasks`, { body: { title: 'Con token', priority: 'high' } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.task.code, 'TASK-01');

  // 6. concorrenza ottimistica via HTTP
  const id = created.data.task.id;
  const okPatch = await root.c.req('PATCH', `/api/tasks/${id}`, { body: { version: 1, changes: { title: 'Nuovo' } } });
  assert.equal(okPatch.status, 200, okPatch.text);
  const stale = await root.c.req('PATCH', `/api/tasks/${id}`, { body: { version: 1, changes: { title: 'Vecchio' } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.current.title, 'Nuovo');

  // 7. validazione server-side
  const invalid = await root.c.req('POST', `/api/projects/${project.id}/tasks`, { body: { title: '' } });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.data.fields.title);

  // 8. XSS: il titolo viene escapato nel JSON incorporato
  await root.c.req('POST', `/api/projects/${project.id}/tasks`, { body: { title: '</script><img src=x onerror=alert(1)>' } });
  const html = await root.c.req('GET', '/p/alpha', { json: false });
  assert.ok(!html.text.includes('</script><img'), 'il titolo non deve chiudere lo script di boot');
});

test('un developer non puo fare cio che e riservato agli admin via HTTP', async (t) => {
  const s = await setup();
  t.after(() => s.close());
  const { h } = s;
  const { project, dev } = await h.project('beta', { dev: ['developer', false] });
  // il developer ha un login Discord: simula la sessione tramite OAuth fake
  s.state.profile = { id: dev.discord_id, username: 'dev', global_name: 'Dev' };
  const c = makeClient(s.base);
  await c.req('GET', '/login', { json: false });
  const st = new URL((await c.req('GET', '/auth/discord', { json: false })).location).searchParams.get('state');
  assert.equal((await c.req('GET', `/auth/discord/callback?code=x&state=${st}`, { json: false })).status, 302);
  await c.req('GET', '/p/beta', { json: false });
  assert.equal((await c.req('POST', `/api/projects/${project.id}/tasks`, { body: { title: 'x' } })).status, 403);
  assert.equal((await c.req('PUT', `/api/projects/${project.id}/settings`, { body: { name: 'x' } })).status, 403);
  assert.equal((await c.req('GET', '/p/beta/settings', { json: false })).status, 403);
});

test('Socket.IO: sessione obbligatoria, isolamento tra progetti, snapshot', async (t) => {
  const s = await setup();
  t.after(() => s.close());
  const { h } = s;
  const A = await h.project('sock-a', { memberA: ['developer', false] });
  const B = await h.project('sock-b', { memberB: ['developer', false] });

  const login = async (user) => {
    s.state.profile = { id: user.discord_id, username: user.display_name, global_name: user.display_name };
    const c = makeClient(s.base);
    await c.req('GET', '/login', { json: false });
    const st = new URL((await c.req('GET', '/auth/discord', { json: false })).location).searchParams.get('state');
    await c.req('GET', `/auth/discord/callback?code=x&state=${st}`, { json: false });
    return c;
  };
  const sock = (cookie) => new Promise((resolve, reject) => {
    const so = connect(s.base, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false });
    so.on('connect', () => resolve(so));
    so.on('connect_error', (e) => { so.close(); reject(e); });
  });

  // senza sessione: rifiutato
  await assert.rejects(sock(''), /unauthorized/);

  const ca = await login(A.memberA);
  const cb = await login(B.memberB);
  const sa = await sock(ca.cookie());
  const sb = await sock(cb.cookie());
  t.after(() => { sa.close(); sb.close(); });
  const gotA = []; const gotB = [];
  sa.on('task:updated', (d) => gotA.push(d.title));
  sb.on('task:updated', (d) => gotB.push(d.title));

  await h.services.tasks.create(h.ctx(A.owner), A.project.id, { title: 'Solo per A' });
  await h.services.tasks.create(h.ctx(B.owner), B.project.id, { title: 'Solo per B' });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(gotA, ['Solo per A']);
  assert.deepEqual(gotB, ['Solo per B']);

  // snapshot di un progetto altrui: negato
  const denied = await new Promise((r) => sa.emit('snapshot', { projectId: B.project.id }, r));
  assert.equal(denied.ok, false);
  const allowed = await new Promise((r) => sa.emit('snapshot', { projectId: A.project.id }, r));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.snapshot.tasks.length, 1);

  // rimozione dal team: notifica e uscita dalla room
  const removed = new Promise((r) => sa.once('project:removed', r));
  await h.services.projects.removeMember(h.ctx(A.owner).actor, A.project.id, A.memberA.id);
  assert.equal((await removed).projectId, A.project.id);
  gotA.length = 0;
  await h.services.tasks.create(h.ctx(A.owner), A.project.id, { title: 'Dopo la rimozione' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(gotA, [], 'chi e stato rimosso non riceve piu aggiornamenti');
});
