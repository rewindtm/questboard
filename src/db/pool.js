'use strict';
const { Pool, types } = require('pg');

// DATE come stringa 'YYYY-MM-DD' (niente conversioni di fuso)
types.setTypeParser(1082, (v) => v);
// BIGINT/BIGSERIAL come Number (gli id restano ben sotto 2^53)
types.setTypeParser(20, (v) => Number(v));

function createPool(connectionString) {
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000 });
}

/** Esegue fn(client) dentro una transazione; rollback in caso di errore. */
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTx };
