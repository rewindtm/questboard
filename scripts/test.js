'use strict';
/**
 * Esegue la suite di test. Se TEST_DATABASE_URL e impostata la usa (server PostgreSQL con
 * permesso CREATE DATABASE), altrimenti avvia un PostgreSQL embedded temporaneo.
 * Non tocca MAI DATABASE_URL.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  let pg = null;
  let url = process.env.TEST_DATABASE_URL;
  let dir = null;
  if (!url) {
    const EmbeddedPostgres = require('embedded-postgres').default;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-test-pg-'));
    const port = 54000 + Math.floor(Math.random() * 900);
    pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
    console.log(`PostgreSQL embedded temporaneo su porta ${port}`);
  }
  const args = ['--test', '--test-concurrency=1', ...(process.argv.slice(2).length ? process.argv.slice(2) : ['test/*.test.js'])];
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: url, NODE_ENV: 'test' },
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (pg) {
    await pg.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code ?? 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
