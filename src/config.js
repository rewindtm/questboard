'use strict';
const crypto = require('node:crypto');

const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

/**
 * Legge e valida la configurazione. Non stampa mai i segreti.
 * Restituisce { config, warnings }.
 */
function loadConfig(env = process.env) {
  const warnings = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const appBaseUrl = (env.APP_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');

  let sessionSecret = env.SESSION_SECRET || '';
  if (!sessionSecret || sessionSecret.length < 32) {
    if (isProd) throw new Error('SESSION_SECRET mancante o troppo corto (minimo 32 caratteri)');
    warnings.push('SESSION_SECRET assente/corto: ne uso uno temporaneo (le sessioni non sopravvivono al riavvio).');
    sessionSecret = crypto.randomBytes(48).toString('hex');
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL non configurato (vedi .env.example)');

  const oauthConfigured = !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
  const localAuth = flag(env.ENABLE_LOCAL_AUTH);
  if (!oauthConfigured && !localAuth) {
    warnings.push('Ne il login Discord ne il login locale sono configurati: nessuno potra accedere.');
  }
  if (isProd && !/^https:/i.test(appBaseUrl)) {
    warnings.push('APP_BASE_URL non e https: i cookie di sessione non saranno "secure".');
  }

  const config = {
    nodeEnv,
    isProd,
    port: Number(env.PORT) || 3000,
    databaseUrl: env.DATABASE_URL,
    sessionSecret,
    appBaseUrl,
    secureCookies: /^https:/i.test(appBaseUrl),
    trustProxy: flag(env.TRUST_PROXY),
    discord: {
      clientId: env.DISCORD_CLIENT_ID || '',
      clientSecret: env.DISCORD_CLIENT_SECRET || '',
      callbackUrl: env.DISCORD_CALLBACK_URL || `${appBaseUrl}/auth/discord/callback`,
      botToken: env.DISCORD_BOT_TOKEN || '',
      oauthConfigured,
      botConfigured: !!env.DISCORD_BOT_TOKEN,
    },
    bootstrapAdminDiscordId: (env.BOOTSTRAP_ADMIN_DISCORD_ID || '').trim(),
    localAuth: {
      enabled: localAuth,
      bootstrapLogin: (env.BOOTSTRAP_ADMIN_LOGIN || '').trim().toLowerCase(),
      bootstrapPassword: env.BOOTSTRAP_ADMIN_PASSWORD || '',
    },
  };
  if (localAuth && config.localAuth.bootstrapLogin && config.localAuth.bootstrapPassword.length < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD deve avere almeno 12 caratteri');
  }
  if (!config.bootstrapAdminDiscordId && !(localAuth && config.localAuth.bootstrapLogin)) {
    warnings.push('Nessun amministratore di bootstrap configurato: nessuno potra creare progetti.');
  }
  return { config, warnings };
}

module.exports = { loadConfig };
