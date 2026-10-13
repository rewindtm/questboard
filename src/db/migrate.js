'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/** Applica in ordine le migrazioni SQL non ancora eseguite. Ogni file gira in una transazione. */
async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    // Un solo processo alla volta (lock consultivo)
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migrazione ${file} fallita: ${err.message}`;
        throw err;
      }
      log(`migrazione applicata: ${file}`);
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const { createPool } = require('./pool');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL non configurato (vedi .env.example)');
    process.exit(1);
  }
  const pool = createPool(process.env.DATABASE_URL);
  migrate(pool, { log: (m) => console.log(m) })
    .then((a) => console.log(a.length ? `${a.length} migrazione/i applicata/e.` : 'Database gia aggiornato.'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
