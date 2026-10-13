'use strict';
const { STATUSES, STATUS_LABELS, PRIORITY_LABELS } = require('../domain/constants');

const STATUS_COLORS = { todo: 0x94a3b8, in_progress: 0xff7a00, review: 0xa78bfa, done: 0x34d399 };
const CUSTOM_ID_PREFIX = 'qb';

/** Custom ID stabili: non dipendono da collector in memoria, quindi sopravvivono ai riavvii. */
const statusMenuId = (taskId) => `${CUSTOM_ID_PREFIX}:st:${taskId}`;
function parseCustomId(customId) {
  const m = /^qb:(st):(\d{1,18})$/.exec(String(customId || ''));
  return m ? { action: m[1], taskId: Number(m[2]) } : null;
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const REF_PREFIX = 'Questboard · ref:';

/** Estrae il riferimento stabile dal footer dell'embed (usato dalla riconciliazione). */
function extractRef(embedFooterText) {
  const t = String(embedFooterText || '');
  const i = t.indexOf(REF_PREFIX);
  return i === -1 ? null : t.slice(i + REF_PREFIX.length).trim();
}

/**
 * Costruisce il post del forum a partire dal task. Funzione pura (facile da testare).
 * @param task        riga tasks con campi join (assignee_name, build_name, ...)
 * @param opts        { appBaseUrl, projectSlug, assigneeDiscordId, tagMap }
 */
function renderPost(task, opts) {
  const { appBaseUrl, projectSlug, assigneeDiscordId = null, tagMap = {} } = opts;
  const url = `${appBaseUrl}/p/${projectSlug}/tasks/${encodeURIComponent(task.code)}`;
  const archived = !!task.archived_at;

  const checklist = Array.isArray(task.checklist) ? task.checklist : [];
  const checklistText = checklist.map((i) => `${i.done ? '☑' : '☐'} ${i.text}`).join('\n');
  const fields = [
    { name: 'Stato', value: STATUS_LABELS[task.status], inline: true },
    { name: 'Priorità', value: PRIORITY_LABELS[task.priority], inline: true },
    { name: 'Categoria', value: task.category || '—', inline: true },
    {
      name: 'Assegnatario',
      value: assigneeDiscordId ? `<@${assigneeDiscordId}>` : (task.assignee_name || 'Non assegnato'),
      inline: true,
    },
  ];
  if (task.due_date) fields.push({ name: 'Scadenza', value: task.due_date, inline: true });
  if (task.build_name) fields.push({ name: 'Build / milestone', value: task.build_name, inline: true });
  if (checklist.length) {
    const done = checklist.filter((i) => i.done).length;
    fields.push({ name: `Criteri di completamento (${done}/${checklist.length})`, value: trunc(checklistText, 1000) });
  }

  const embed = {
    title: trunc(`${archived ? '[Archiviato] ' : ''}${task.code} · ${task.title}`, 256),
    url,
    description: trunc(task.description || '*Nessuna descrizione*', 3000),
    color: STATUS_COLORS[task.status],
    fields,
    footer: { text: `${REF_PREFIX}${task.sync_ref}` },
  };

  const components = [];
  if (!archived) {
    components.push({
      type: 1,
      components: [{
        type: 3, // StringSelect
        custom_id: statusMenuId(task.id),
        placeholder: 'Cambia stato…',
        options: STATUSES.map((s) => ({ label: STATUS_LABELS[s], value: s, default: s === task.status })),
      }],
    });
  }
  components.push({
    type: 1,
    components: [{ type: 2, style: 5, label: 'Apri in Questboard', url }],
  });

  const appliedTags = [tagMap.status?.[task.status], tagMap.priority?.[task.priority]].filter(Boolean);

  return {
    threadName: trunc(`[${task.code}] ${task.title}`, 100),
    content: assigneeDiscordId ? `Assegnato a <@${assigneeDiscordId}>` : '',
    embeds: [embed],
    components,
    appliedTags,
    url,
  };
}

module.exports = { renderPost, statusMenuId, parseCustomId, extractRef, REF_PREFIX };
