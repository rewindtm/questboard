'use strict';
const crypto = require('node:crypto');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { AuthError, ForbiddenError } = require('../errors');

function createSessionMiddleware({ config, pool, pruneInterval = true }) {
  const store = new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false, // la tabella e creata dalla migrazione
    pruneSessionInterval: pruneInterval ? 60 * 15 : false,
  });
  const middleware = session({
    store,
    name: 'qb.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax', // necessario per il redirect di ritorno da Discord
      secure: config.secureCookies,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  });
  return { middleware, store };
}

const regenerate = (req) => new Promise((res, rej) => req.session.regenerate((e) => (e ? rej(e) : res())));
const save = (req) => new Promise((res, rej) => req.session.save((e) => (e ? rej(e) : res())));
const destroy = (req) => new Promise((res, rej) => req.session.destroy((e) => (e ? rej(e) : res())));

/** Carica req.user dalla sessione (rilegge sempre l'utente dal DB). */
function loadUser(users) {
  return async (req, res, next) => {
    try {
      req.user = null;
      if (req.session?.userId) {
        req.user = await users.getById(req.session.userId);
        if (!req.user) delete req.session.userId;
      }
      res.locals.user = req.user;
      next();
    } catch (err) { next(err); }
  };
}

/** Token CSRF per sessione; verificato su ogni metodo non sicuro (header X-CSRF-Token o campo _csrf). */
function csrf() {
  return (req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrf;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const sent = String(req.get('x-csrf-token') || req.body?._csrf || '');
    const a = Buffer.from(sent);
    const b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return next(new ForbiddenError('Token CSRF non valido: ricarica la pagina e riprova'));
    }
    next();
  };
}

const requireAuthPage = (req, res, next) => {
  if (req.user) return next();
  // ricorda la destinazione solo per vere navigazioni di pagina, non per risorse richieste dal browser
  const navigable = req.method === 'GET' && req.accepts('html') === 'html' && req.get('sec-fetch-dest') !== 'image'
    && !/^\/(auth|login|logout|api|static)(\/|\?|$)/.test(req.originalUrl);
  req.session.returnTo = navigable ? req.originalUrl : undefined;
  res.redirect('/login');
};
const requireAuthApi = (req, res, next) => (req.user ? next() : next(new AuthError()));

module.exports = { createSessionMiddleware, loadUser, csrf, requireAuthPage, requireAuthApi, regenerate, save, destroy };
