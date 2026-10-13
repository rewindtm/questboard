'use strict';
const express = require('express');
const { requireAuthApi } = require('../../auth/middleware');
const { ValidationError } = require('../../errors');

const intParam = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${name} non valido`);
  return n;
};

/**
 * API JSON. Le route fanno solo: autenticazione -> parsing -> servizio condiviso.
 * Permessi, validazione, concorrenza e outbox vivono nei servizi.
 */
function apiRoutes({ services }) {
  const { tasks, projects } = services;
  const r = express.Router();
  r.use(requireAuthApi);
  const ctx = (req) => ({ actor: req.user, source: 'web' });

  // ------------------------------------------------------------ progetto
  r.get('/projects/:pid/snapshot', async (req, res) => {
    res.json(await projects.snapshot(req.user, intParam(req.params.pid)));
  });

  r.put('/projects/:pid/settings', async (req, res) => {
    await projects.updateSettings(req.user, intParam(req.params.pid), req.body);
    res.json({ ok: true });
  });

  r.post('/projects/:pid/discord/check', async (req, res) => {
    const input = {
      discord_guild_id: String(req.body.discord_guild_id || ''),
      discord_forum_id: String(req.body.discord_forum_id || ''),
      discord_tag_map: req.body.discord_tag_map || { status: {}, priority: {} },
    };
    res.json(await projects.checkDiscord(req.user, intParam(req.params.pid), input));
  });

  r.post('/projects', async (req, res) => {
    const p = await projects.create(req.user, req.body);
    res.status(201).json({ slug: p.slug });
  });

  // ------------------------------------------------------------ team
  r.post('/projects/:pid/members', async (req, res) => {
    await projects.addMember(req.user, intParam(req.params.pid), req.body);
    res.status(201).json({ ok: true });
  });
  r.patch('/projects/:pid/members/:uid', async (req, res) => {
    await projects.updateMember(req.user, intParam(req.params.pid), intParam(req.params.uid), req.body);
    res.json({ ok: true });
  });
  r.delete('/projects/:pid/members/:uid', async (req, res) => {
    await projects.removeMember(req.user, intParam(req.params.pid), intParam(req.params.uid));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ build / milestone
  r.post('/projects/:pid/builds', async (req, res) => {
    res.status(201).json(await projects.saveBuild(req.user, intParam(req.params.pid), null, req.body));
  });
  r.put('/projects/:pid/builds/:bid', async (req, res) => {
    res.json(await projects.saveBuild(req.user, intParam(req.params.pid), intParam(req.params.bid), req.body));
  });
  r.delete('/projects/:pid/builds/:bid', async (req, res) => {
    await projects.deleteBuild(req.user, intParam(req.params.pid), intParam(req.params.bid));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ task
  r.post('/projects/:pid/tasks', async (req, res) => {
    res.status(201).json({ task: await tasks.create(ctx(req), intParam(req.params.pid), req.body) });
  });
  r.get('/tasks/:id', async (req, res) => {
    res.json({ task: await tasks.get(req.user, intParam(req.params.id)) });
  });
  r.get('/tasks/:id/history', async (req, res) => {
    res.json({ events: await tasks.history(req.user, intParam(req.params.id)) });
  });
  // body: { version, changes: { ...campi } }
  r.patch('/tasks/:id', async (req, res) => {
    const version = req.body.version;
    if (!Number.isInteger(version)) throw new ValidationError('Versione del task mancante', { version: 'obbligatoria' });
    res.json(await tasks.update(ctx(req), intParam(req.params.id), req.body.changes, { expectedVersion: version }));
  });
  r.post('/tasks/:id/archive', async (req, res) => {
    res.json({ task: await tasks.setArchived(ctx(req), intParam(req.params.id), true, { expectedVersion: req.body.version ?? null }) });
  });
  r.post('/tasks/:id/restore', async (req, res) => {
    res.json({ task: await tasks.setArchived(ctx(req), intParam(req.params.id), false, { expectedVersion: req.body.version ?? null }) });
  });
  r.post('/tasks/:id/publish', async (req, res) => {
    res.json({ task: await tasks.publish(ctx(req), intParam(req.params.id)) });
  });
  r.post('/tasks/:id/retry', async (req, res) => {
    res.json({ task: await tasks.retrySync(ctx(req), intParam(req.params.id)) });
  });
  r.post('/tasks/:id/repost', async (req, res) => {
    res.json({ task: await tasks.repost(ctx(req), intParam(req.params.id)) });
  });

  return r;
}

module.exports = { apiRoutes };
