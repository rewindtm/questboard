'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, n, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function createUserService({ pool, config }) {
  let dummyHash;

  async function getById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  }

  /** Crea/aggiorna l'utente al login Discord. Il flag superadmin dipende SOLO da BOOTSTRAP_ADMIN_DISCORD_ID. */
  async function upsertDiscordUser(profile) {
    const isSuper = !!config.bootstrapAdminDiscordId && profile.id === config.bootstrapAdminDiscordId;
    const { rows } = await pool.query(
      `INSERT INTO users (discord_id, username, display_name, avatar, last_login_at, is_superadmin)
       VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (discord_id) DO UPDATE SET
         username = EXCLUDED.username, display_name = EXCLUDED.display_name,
         avatar = EXCLUDED.avatar, last_login_at = now(), is_superadmin = EXCLUDED.is_superadmin
       RETURNING *`,
      [profile.id, profile.username || null, profile.global_name || profile.username || null, profile.avatar || null, isSuper],
    );
    return rows[0];
  }

  /** Utente "segnaposto" usato quando un admin aggiunge un membro tramite Discord ID prima del suo primo login. */
  async function ensureDiscordUser(client, discordId, displayName) {
    const { rows } = await client.query(
      `INSERT INTO users (discord_id, display_name) VALUES ($1,$2)
       ON CONFLICT (discord_id) DO UPDATE SET discord_id = EXCLUDED.discord_id
       RETURNING *`,
      [discordId, displayName || null],
    );
    return rows[0];
  }

  async function createLocalUser(client, { login, displayName, password }) {
    const hash = await hashPassword(password);
    const { rows } = await client.query(
      `INSERT INTO users (local_login, display_name, password_hash) VALUES ($1,$2,$3) RETURNING *`,
      [login, displayName || login, hash],
    );
    return rows[0];
  }

  /** Login locale (solo se ENABLE_LOCAL_AUTH). Tempo di risposta simile se l'utente non esiste. */
  async function authenticateLocal(login, password) {
    if (!config.localAuth.enabled) return null;
    dummyHash ??= await hashPassword('questboard-dummy-password');
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE local_login = $1 AND password_hash IS NOT NULL', [String(login || '').trim().toLowerCase()]);
    const user = rows[0];
    const ok = await verifyPassword(String(password || ''), user ? user.password_hash : dummyHash);
    if (!user || !ok) return null;
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return user;
  }

  /** Allinea i superadmin alla configurazione (.env). Chiamato all'avvio. */
  async function ensureBootstrap() {
    const discordId = config.bootstrapAdminDiscordId || null;
    const local = config.localAuth.enabled && config.localAuth.bootstrapLogin ? config.localAuth : null;
    await pool.query(
      `UPDATE users SET is_superadmin = FALSE
        WHERE is_superadmin AND NOT (COALESCE(discord_id = $1, FALSE) OR COALESCE(local_login = $2, FALSE))`,
      [discordId, local ? local.bootstrapLogin : null],
    );
    if (discordId) {
      await pool.query(
        `INSERT INTO users (discord_id, is_superadmin) VALUES ($1, TRUE)
         ON CONFLICT (discord_id) DO UPDATE SET is_superadmin = TRUE`, [discordId]);
    }
    if (local) {
      const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE local_login = $1', [local.bootstrapLogin]);
      if (!rows[0]) {
        await pool.query(
          `INSERT INTO users (local_login, display_name, password_hash, is_superadmin) VALUES ($1,$2,$3,TRUE)`,
          [local.bootstrapLogin, local.bootstrapLogin, await hashPassword(local.bootstrapPassword)]);
      } else {
        // se la password in .env e cambiata, aggiorna l'hash
        const same = await verifyPassword(local.bootstrapPassword, rows[0].password_hash);
        await pool.query(
          `UPDATE users SET is_superadmin = TRUE, password_hash = $2 WHERE id = $1`,
          [rows[0].id, same ? rows[0].password_hash : await hashPassword(local.bootstrapPassword)]);
      }
    }
  }

  return { getById, upsertDiscordUser, ensureDiscordUser, createLocalUser, authenticateLocal, ensureBootstrap, hashPassword };
}

module.exports = { createUserService, hashPassword, verifyPassword };
