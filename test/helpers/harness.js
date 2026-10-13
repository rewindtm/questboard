'use strict';
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createPool } = require('../../src/db/pool');
const { migrate } = require('../../src/db/migrate');
const { createBus } = require('../../src/events');
const { loadConfig } = require('../../src/config');
const { createServices } = require('../../src/services');
const { createOutboxWorker } = require('../../src/outbox/worker');
const { createMockGateway } = require('./mockGateway');

function adminUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL non impostata: usa `npm test`');
  return url;
}

/** Crea un database isolato per il file di test, applica le migrazioni e costruisce i servizi. */
async function createHarness({ gatewayConfigured = true, env = {} } = {}) {
  const dbName = `qb_t_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(adminUrl());
  u.pathname = `/${dbName}`;
  const pool = createPool(u.toString());
  await migrate(pool);

  const { config } = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: u.toString(), SESSION_SECRET: 'x'.repeat(40),
    APP_BASE_URL: 'http://qb.test', DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'sec',
    BOOTSTRAP_ADMIN_DISCORD_ID: '900000000000000001', ...env,
  });
  const bus = createBus();
  const gateway = createMockGateway({ configured: gatewayConfigured });
  const services = createServices({ pool, bus, config, gateway });
  const worker = createOutboxWorker({ pool, bus, gateway, config });
  const events = [];
  for (const n of ['task:changed', 'task:event', 'project:changed', 'member:removed']) bus.on(n, (e) => events.push({ n, ...e }));

  let n = 0;
  const h = {
    pool, bus, gateway, services, worker, config, events, dbName,
    async user(discordId, name, extra = {}) {
      const id = discordId || `7${String(++n).padStart(17, '0')}`;
      const { rows } = await pool.query(
        `INSERT INTO users (discord_id, username, display_name, is_superadmin) VALUES ($1,$2,$2,$3)
         ON CONFLICT (discord_id) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING *`,
        [id, name, !!extra.superadmin]);
      return rows[0];
    },
    async project(slug, members = {}, { configureDiscord = true } = {}) {
      const owner = await h.user(null, `owner-${slug}`, { superadmin: true });
      const p = await services.projects.create(owner, { name: slug, slug, code_prefix: 'TASK' });
      if (configureDiscord) {
        await pool.query(
          `UPDATE projects SET discord_guild_id='222222222222222222', discord_forum_id='333333333333333333',
                  discord_tag_map='{"status":{},"priority":{}}' WHERE id=$1`, [p.id]);
      }
      const out = { project: p, owner };
      for (const [name, [role, canApprove]] of Object.entries(members)) {
        const user = await h.user(null, name);
        await pool.query('INSERT INTO project_members(project_id,user_id,role,can_approve) VALUES ($1,$2,$3,$4)',
          [p.id, user.id, role, !!canApprove]);
        out[name] = user;
      }
      return out;
    },
    ctx: (actor, source = 'web') => ({ actor, source }),
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.end();
    },
  };
  return h;
}

module.exports = { createHarness };
