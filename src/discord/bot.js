'use strict';
const { markThreadMissing } = require('../outbox/worker');

/**
 * Avvia il bot (solo se DISCORD_BOT_TOKEN e configurato). Registra UN gestore centrale per le
 * interazioni e ascolta l'eliminazione dei thread per segnalare i post cancellati.
 */
async function startBot({ config, gateway, handler, pool, bus, log }) {
  if (!config.discord.botConfigured) {
    log('Bot Discord non configurato (DISCORD_BOT_TOKEN assente): integrazione disattivata.');
    return null;
  }
  const { Client, GatewayIntentBits, Events } = require('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  gateway.attach(client);

  client.on(Events.InteractionCreate, (interaction) => {
    handler.handle(interaction).catch((err) => log('bot: interazione fallita', err.message));
  });
  client.on(Events.ThreadDelete, (thread) => {
    markThreadMissing({ pool, bus }, thread.id).catch((err) => log('bot: threadDelete fallito', err.message));
  });
  client.on(Events.Error, (err) => log('bot: errore client', err.message));

  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  try {
    await client.login(config.discord.botToken);
    await ready;
    log(`Bot Discord connesso come ${client.user.tag}`);
    bus.emit('outbox:nudge', {});
  } catch (err) {
    // il pannello resta utilizzabile; i job restano in coda e vengono ritentati
    log('Login del bot Discord fallito:', err.message);
  }
  return client;
}

module.exports = { startBot };
