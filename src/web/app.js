'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createSessionMiddleware, loadUser, csrf } = require('../auth/middleware');
const { createDiscordOAuth } = require('../auth/oauth');
const { AppError } = require('../errors');
const { authRoutes } = require('./routes/auth');
const { pageRoutes } = require('./routes/pages');
const { apiRoutes } = require('./routes/api');

/**
 * Costruisce l'app Express. Tutte le dipendenze sono iniettate (test: fetch finto, nessun rate limit).
 */
function createApp({ config, pool, services, gateway, deps = {} }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // Tailwind via CDN (richiesto dal progetto): unico script esterno consentito
        'script-src': ["'self'", 'https://cdn.tailwindcss.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ['https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    hsts: config.secureCookies ? undefined : false,
  }));

  // il browser chiede il favicon da solo: senza questa rotta finirebbe tra le pagine protette e diventerebbe la destinazione dopo il login
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use('/static', express.static(path.join(__dirname, '..', '..', 'public'), { maxAge: config.isProd ? '1h' : 0 }));
  // il client di socket.io e servito da socket.io stesso (/socket.io/socket.io.js)

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  const { middleware: sessionMw, store } = createSessionMiddleware({ config, pool, pruneInterval: deps.pruneSessions !== false });
  app.use(sessionMw);
  app.use(loadUser(services.users));
  app.use(csrf());
  app.locals.sessionStore = store;

  const limiter = (limit, windowMs = 60_000) => (deps.rateLimit === false
    ? (req, res, next) => next()
    : rateLimit({
      windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
      handler: (req, res, next) => next(new AppError('Troppe richieste: riprova tra poco', 429, 'rate_limited')),
    }));

  app.use((req, res, next) => {
    res.locals.config = { localAuth: config.localAuth.enabled, oauth: config.discord.oauthConfigured };
    res.locals.flash = null;
    next();
  });

  const oauth = createDiscordOAuth({ config, fetchFn: deps.fetch || fetch });
  app.use(authRoutes({ config, services, oauth, limiter }));
  app.use('/api', limiter(300), apiRoutes({ config, services, gateway }));
  app.get('/healthz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  app.use(pageRoutes({ config, services, gateway })); // richiede login: va montato dopo /api e /healthz

  // 404
  app.use((req, res, next) => next(new AppError('Pagina non trovata', 404, 'not_found')));

  // gestione errori
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const isApi = req.originalUrl.startsWith('/api') || req.get('accept')?.includes('application/json');
    const known = err instanceof AppError;
    const status = known ? err.status : (err.status && err.status < 500 ? err.status : 500);
    if (!known && status >= 500) console.error('Errore non gestito:', err.stack || err.message);
    const message = known || status < 500 ? err.message : 'Errore interno del server';
    if (isApi) {
      return res.status(status).json({ error: known ? err.code : 'error', message, ...(known ? err.extra : {}) });
    }
    res.status(status).render('error', { status, message, project: null, nav: '', pageTitle: 'Errore' });
  });

  return app;
}

module.exports = { createApp };
