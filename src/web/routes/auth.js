'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { regenerate, save, destroy } = require('../../auth/middleware');
const { AppError } = require('../../errors');

function authRoutes({ config, services, oauth, limiter }) {
  const r = express.Router();

  const renderLogin = (res, status, flash) => res.status(status).render('login', {
    flash, pageTitle: 'Accedi', project: null, nav: '', bare: true,
  });

  r.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    renderLogin(res, 200, null);
  });

  async function loginAs(req, user) {
    const returnTo = req.session.returnTo;
    await regenerate(req); // nuovo ID di sessione dopo l'autenticazione
    req.session.userId = user.id;
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    await save(req);
    const safe = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
      && !/^\/(auth|login|logout|api|static)(\/|\?|$)/.test(returnTo);
    return safe ? returnTo : '/';
  }

  r.get('/auth/discord', limiter(20), (req, res) => {
    if (!config.discord.oauthConfigured) return renderLogin(res, 503, 'Il login con Discord non e configurato.');
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    res.redirect(oauth.authorizeUrl(state));
  });

  r.get('/auth/discord/callback', limiter(20), async (req, res) => {
    const expected = req.session.oauthState;
    delete req.session.oauthState;
    const given = String(req.query.state || '');
    const ok = expected && given.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return renderLogin(res, 400, 'Richiesta di accesso non valida o scaduta. Riprova.');
    if (req.query.error || !req.query.code) return renderLogin(res, 400, 'Accesso a Discord annullato.');
    let profile;
    try { profile = await oauth.fetchProfile(String(req.query.code)); }
    catch (err) {
      if (err instanceof AppError) return renderLogin(res, 502, err.message);
      throw err;
    }
    const user = await services.users.upsertDiscordUser(profile);
    res.redirect(await loginAs(req, user));
  });

  // un GET su /auth/local (es. ricarica dopo un errore di login) torna al form
  r.get('/auth/local', (req, res) => res.redirect('/login'));

  r.post('/auth/local', limiter(10), async (req, res) => {
    if (!config.localAuth.enabled) return renderLogin(res, 404, 'Il login locale non e abilitato.');
    const user = await services.users.authenticateLocal(req.body.login, req.body.password);
    if (!user) return renderLogin(res, 401, 'Credenziali non valide.');
    res.redirect(await loginAs(req, user));
  });

  r.post('/logout', async (req, res) => {
    await destroy(req);
    res.clearCookie('qb.sid');
    res.redirect('/login');
  });

  return r;
}

module.exports = { authRoutes };
