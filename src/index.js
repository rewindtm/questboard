'use strict';
require('dotenv').config({ quiet: true });
const http = require('node:http');
const { loadConfig } = require('./config');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { createBus } = require('./events');
const { createGateway } = require('./discord/gateway');
const { createServices } = require('./services');
const { createInteractionHandler } = require('./discord/interactions');
const { startBot } = require('./discord/bot');
const { createOutboxWorker } = require('./outbox/worker');
const { createApp } = require('./web/app');
const { attachSocket } = require('./realtime/socket');
const { createSessionMiddleware } = require('./auth/middleware');

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const { config, warnings } = loadConfig();
  warnings.forEach((w) => log('ATTENZIONE:', w));

  const pool = createPool(config.databaseUrl);
  // In produzione le migrazioni si applicano a mano con `npm run db:migrate`; in sviluppo partono da sole.
  try {
    if (!config.isProd) await migrate(pool, { log });
    const { rows } = await pool.query(`SELECT to_regclass('public.tasks') AS t`);
    if (!rows[0].t) throw new Error('schema mancante');
  } catch (err) {
    console.error(`Database non pronto (${err.message}). Esegui: npm run db:migrate`);
    await pool.end();
    process.exit(1);
  }

  const bus = createBus();
  const gateway = createGateway({ token: config.discord.botToken });
  const services = createServices({ pool, bus, config, gateway });
  await services.users.ensureBootstrap();

  const app = createApp({ config, pool, services, gateway });
  const httpServer = http.createServer(app);
  const { middleware: sessionMiddleware } = createSessionMiddleware({ config, pool, pruneInterval: false });
  const realtime = attachSocket({ httpServer, sessionMiddleware, bus, services, log });

  const worker = createOutboxWorker({ pool, bus, gateway, config, log });
  const handler = createInteractionHandler({ pool, tasks: services.tasks, log });

  await new Promise((resolve) => httpServer.listen(config.port, resolve));
  log(`Questboard in ascolto su ${config.appBaseUrl} (porta ${config.port})`);

  const client = await startBot({ config, gateway, handler, pool, bus, log });
  worker.start();
  log(config.discord.botConfigured ? 'Worker Discord avviato.' : 'Worker avviato (integrazione Discord non configurata: i post non verranno inviati).');

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log(`${signal}: chiusura ordinata...`);
    const force = setTimeout(() => { console.error('Chiusura forzata'); process.exit(1); }, 10000);
    force.unref();
    try {
      await worker.stop();
      await realtime.close(); // chiude anche httpServer
      if (httpServer.listening) await new Promise((r) => httpServer.close(() => r()));
      if (client) await client.destroy();
      app.locals.sessionStore?.close?.();
      await pool.end();
      log('Chiuso.');
      process.exit(0);
    } catch (err) {
      console.error('Errore in chiusura:', err.message);
      process.exit(1);
    }
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Avvio fallito:', err.message);
  process.exit(1);
});
