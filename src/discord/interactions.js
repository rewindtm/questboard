'use strict';
const { parseCustomId } = require('./render');
const { STATUSES, STATUS_LABELS } = require('../domain/constants');
const { AppError, ForbiddenError, NotFoundError, ValidationError } = require('../errors');

const EPHEMERAL = 64; // MessageFlags.Ephemeral

/**
 * Gestore centrale delle interazioni. Nessun collector temporaneo: i componenti dei post
 * usano custom ID stabili (`qb:st:<taskId>`), quindi continuano a funzionare dopo un riavvio.
 * Lo stato viene cambiato con lo STESSO servizio usato dal sito (taskService.update).
 */
function createInteractionHandler({ pool, tasks, log = () => {} }) {
  async function reply(interaction, content) {
    try { await interaction.editReply({ content }); } catch (err) { log('interaction: editReply fallita', err.message); }
  }

  async function handle(interaction) {
    const isMenu = typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu();
    if (!isMenu) return false;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return false; // non e un componente Questboard

    // 1. conferma subito l'interazione (Discord richiede una risposta entro 3 secondi)
    try { await interaction.deferReply({ flags: EPHEMERAL }); } catch (err) { log('interaction: defer fallita', err.message); return true; }

    try {
      const status = interaction.values?.[0];
      if (!STATUSES.includes(status)) throw new ValidationError('Stato non valido');

      // 2. utente Discord -> utente Questboard
      const { rows: u } = await pool.query('SELECT * FROM users WHERE discord_id = $1', [String(interaction.user.id)]);
      if (!u[0]) throw new ForbiddenError('Il tuo account Discord non e registrato in Questboard.');

      // 3. il componente deve appartenere al thread del task (e al server del progetto)
      const { rows: t } = await pool.query(
        `SELECT t.id, t.project_id, t.discord_thread_id, p.discord_guild_id
           FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [parsed.taskId]);
      const task = t[0];
      if (!task || task.discord_thread_id !== String(interaction.channelId)
          || (interaction.guildId && task.discord_guild_id !== String(interaction.guildId))) {
        throw new NotFoundError('Questo post non e piu collegato a un task.');
      }

      // 4. stessa logica del sito: appartenenza al team, ruolo, transizioni, storico, outbox, Socket.IO
      const { task: updated, changed } = await tasks.update(
        { actor: u[0], source: 'discord' }, parsed.taskId, { status });
      await reply(interaction, changed
        ? `${updated.code}: stato aggiornato a **${STATUS_LABELS[updated.status]}**.`
        : `${updated.code} e gia in stato **${STATUS_LABELS[updated.status]}**.`);
    } catch (err) {
      if (err instanceof NotFoundError) {
        await reply(interaction, err.message === 'Task non trovato'
          ? 'Non fai parte del team di questo progetto.' : err.message);
      } else if (err instanceof AppError) {
        await reply(interaction, err.message);
      } else {
        log('interaction: errore imprevisto', err.stack || err.message);
        await reply(interaction, 'Si e verificato un errore. Riprova tra poco.');
      }
    }
    return true;
  }

  return { handle };
}

module.exports = { createInteractionHandler };
