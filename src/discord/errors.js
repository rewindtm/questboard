'use strict';

/**
 * Errori "di dominio" del gateway Discord. Il worker decide il comportamento in base a `discordCode`:
 *  NOT_CONFIGURED / MISSING_PERMISSIONS / INVALID_CONFIG -> errore permanente (serve intervento umano)
 *  NOT_FOUND                                              -> post/canale eliminato
 *  RATE_LIMITED                                           -> riprova dopo retryAfterMs (non conta come tentativo)
 *  TRANSIENT                                              -> riprova con backoff
 */
class DiscordError extends Error {
  constructor(discordCode, message, { retryAfterMs = null, cause } = {}) {
    super(message);
    this.name = 'DiscordError';
    this.discordCode = discordCode;
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

const MISSING_PERMS_CODES = new Set([50001, 50013, 50278, 160002]);
const NOT_FOUND_CODES = new Set([10003, 10004, 10008, 10015, 10062]);

/** Traduce un errore di discord.js in DiscordError con messaggio comprensibile. */
function mapDiscordJsError(err, what = 'operazione Discord') {
  if (err instanceof DiscordError) return err;
  const status = err?.status ?? err?.statusCode;
  const code = err?.code;
  if (status === 429 || err?.name === 'RateLimitError') {
    const ms = Math.ceil((err.retryAfter ?? err.data?.retry_after ?? 5) * (err.retryAfter > 1000 ? 1 : 1000));
    return new DiscordError('RATE_LIMITED', `Rate limit Discord durante: ${what}`, { retryAfterMs: Math.max(ms, 1000), cause: err });
  }
  if (NOT_FOUND_CODES.has(code) || status === 404) {
    return new DiscordError('NOT_FOUND', `Elemento Discord non trovato (${what}). Server, canale o post eliminato?`, { cause: err });
  }
  if (MISSING_PERMS_CODES.has(code) || status === 403) {
    return new DiscordError('MISSING_PERMISSIONS',
      `Il bot non ha i permessi necessari (${what}). Controlla i permessi del bot nel canale forum.`, { cause: err });
  }
  if (status === 400) {
    return new DiscordError('INVALID_CONFIG', `Discord ha rifiutato la richiesta (${what}): ${err.message}`, { cause: err });
  }
  return new DiscordError('TRANSIENT', `Errore temporaneo Discord (${what}): ${err?.message || err}`, { cause: err });
}

module.exports = { DiscordError, mapDiscordJsError };
