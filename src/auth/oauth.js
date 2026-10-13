'use strict';
const { AppError } = require('../errors');

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const API = 'https://discord.com/api/v10';

/** OAuth2 Discord (authorization code). `fetchFn` e iniettabile per i test. */
function createDiscordOAuth({ config, fetchFn = fetch }) {
  function authorizeUrl(state) {
    const q = new URLSearchParams({
      client_id: config.discord.clientId,
      redirect_uri: config.discord.callbackUrl,
      response_type: 'code',
      scope: 'identify',
      state,
      prompt: 'none',
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  async function fetchProfile(code) {
    const tokenRes = await fetchFn(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.discord.callbackUrl,
      }),
    });
    if (!tokenRes.ok) throw new AppError('Autenticazione Discord non riuscita', 502, 'oauth_token');
    const { access_token: accessToken } = await tokenRes.json();
    const meRes = await fetchFn(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!meRes.ok) throw new AppError('Impossibile leggere il profilo Discord', 502, 'oauth_profile');
    const me = await meRes.json();
    if (!/^\d{15,25}$/.test(String(me.id))) throw new AppError('Profilo Discord non valido', 502, 'oauth_profile');
    return me;
  }

  return { authorizeUrl, fetchProfile };
}

module.exports = { createDiscordOAuth };
