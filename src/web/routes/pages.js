'use strict';
const express = require('express');
const { requireAuthPage } = require('../../auth/middleware');
const { AppError, NotFoundError } = require('../../errors');
const { isAdmin } = require('../../domain/permissions');
const { STATUSES, PRIORITIES, ROLES, STATUS_LABELS, PRIORITY_LABELS, ROLE_LABELS } = require('../../domain/constants');

/** JSON sicuro da incorporare in <script type="application/json"> (niente "</script>" o U+2028). */
const safeJson = (obj) => JSON.stringify(obj)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function pageRoutes({ config, services }) {
  const r = express.Router();
  r.use(requireAuthPage);

  r.use(async (req, res, next) => {
    res.locals.safeJson = safeJson;
    res.locals.labels = { STATUS_LABELS, PRIORITY_LABELS, ROLE_LABELS, STATUSES, PRIORITIES, ROLES };
    res.locals.myProjects = await services.projects.listForUser(req.user);
    res.locals.project = null;
    res.locals.member = null;
    res.locals.nav = '';
    next();
  });

  r.get('/', (req, res) => {
    const list = res.locals.myProjects;
    if (list.length === 1) return res.redirect(`/p/${list[0].slug}`);
    res.render('home', { pageTitle: 'Progetti', projects: list });
  });

  // ---------------------------------------------------------------- nuovo progetto
  r.get('/projects/new', (req, res) => {
    if (!req.user.is_superadmin) throw new NotFoundError('Pagina non trovata');
    res.render('project-new', { pageTitle: 'Nuovo progetto' });
  });

  // ---------------------------------------------------------------- pagine di progetto
  r.param('slug', async (req, res, next, slug) => {
    const found = await services.projects.getBySlug(req.user, slug);
    if (!found) return next(new NotFoundError('Progetto non trovato'));
    req.project = found.project;
    req.member = found.member;
    res.locals.project = services.projects.projectInfo(found.project);
    res.locals.member = found.member;
    res.locals.isAdmin = isAdmin(found.member);
    res.locals.release = await services.projects.nextRelease(found.project.id);
    next();
  });

  const requireAdminPage = (req, res, next) => (isAdmin(req.member)
    ? next() : next(new AppError('Solo gli amministratori possono accedere a questa pagina', 403, 'forbidden')));

  async function board(req, res) {
    const snapshot = await services.projects.snapshot(req.user, req.project.id);
    res.render('board', {
      pageTitle: 'Board', nav: 'board',
      boot: { ...snapshot, selectedCode: req.params.code || null, csrf: res.locals.csrfToken },
      snapshot,
    });
  }
  r.get('/p/:slug', board);
  r.get('/p/:slug/tasks/:code', board);

  r.get('/p/:slug/milestones', async (req, res) => {
    res.render('milestones', {
      pageTitle: 'Milestone', nav: 'milestones',
      builds: await services.projects.listBuilds(services.pool, req.project.id),
    });
  });

  r.get('/p/:slug/team', async (req, res) => {
    res.render('team', {
      pageTitle: 'Team', nav: 'team',
      members: await services.projects.listMembers(services.pool, req.project.id),
    });
  });

  r.get('/p/:slug/archive', async (req, res) => {
    res.render('archive', {
      pageTitle: 'Archivio', nav: 'archive',
      tasks: await services.tasks.listArchived(req.user, req.project.id),
    });
  });

  r.get('/p/:slug/settings', requireAdminPage, async (req, res) => {
    const s = await services.projects.getSettings(req.user, req.project.id);
    res.render('settings', {
      pageTitle: 'Impostazioni', nav: 'settings',
      settings: {
        name: s.name, description: s.description, categories: s.categories,
        discord_guild_id: s.discord_guild_id || '', discord_forum_id: s.discord_forum_id || '',
        discord_tag_map: s.discord_tag_map,
      },
      botConfigured: config.discord.botConfigured,
    });
  });

  return r;
}

module.exports = { pageRoutes, safeJson };
