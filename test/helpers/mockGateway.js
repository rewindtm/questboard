'use strict';
const { DiscordError } = require('../../src/discord/errors');
const { extractRef } = require('../../src/discord/render');

/**
 * Gateway Discord finto: nessuna chiamata di rete, nessun messaggio reale.
 * Memorizza i thread in memoria e permette di iniettare errori.
 */
function createMockGateway({ configured = true } = {}) {
  const threads = new Map(); // threadId -> { name, tags, post, archived, mention }
  const calls = [];
  const failures = []; // coda di errori da lanciare alla prossima chiamata
  let seq = 1000;
  const g = {
    threads, calls, failures,
    isConfigured: () => configured,
    isReady: () => configured,
    attach() {},
    failNext(err, times = 1) { for (let i = 0; i < times; i++) failures.push(err); },
    /** Simula: Discord crea il post ma il processo termina prima di salvare gli ID. */
    crashAfterCreate: false,
    hook: null,
    _maybeFail() { if (failures.length) throw failures.shift(); },
    async validateForum(guildId, forumId, tagMap) {
      calls.push({ op: 'validateForum' });
      const tags = [{ id: '111111111111111111', name: 'Da fare' }];
      const problems = [];
      for (const grp of ['status', 'priority']) {
        for (const [k, id] of Object.entries(tagMap?.[grp] || {})) {
          if (!tags.some((t) => t.id === id)) problems.push(`Il tag assegnato a ${grp}/${k} non esiste piu nel forum.`);
        }
      }
      return { ok: problems.length === 0, problems, tags };
    },
    async findThreadByRef({ ref }) {
      calls.push({ op: 'find', ref });
      g._maybeFail();
      for (const [threadId, t] of threads) {
        if (extractRef(t.post.embeds[0].footer.text) === ref) {
          return { threadId, messageId: threadId, url: `https://discord.test/channels/g/${threadId}` };
        }
      }
      return null;
    },
    async createThread({ post, mentionDiscordId }) {
      calls.push({ op: 'create', name: post.threadName, mention: mentionDiscordId || null });
      g._maybeFail();
      await g.hook?.('create');
      const threadId = String(++seq);
      threads.set(threadId, { name: post.threadName, tags: post.appliedTags, post, archived: false });
      if (g.crashAfterCreate) {
        g.crashAfterCreate = false;
        throw new DiscordError('TRANSIENT', 'processo terminato dopo la creazione (simulato)');
      }
      return { threadId, messageId: threadId, url: `https://discord.test/channels/g/${threadId}` };
    },
    async updateThread({ threadId, post, mentionDiscordId }) {
      calls.push({ op: 'update', threadId, mention: mentionDiscordId || null, status: post.embeds[0].fields[0].value });
      g._maybeFail();
      await g.hook?.('update');
      const t = threads.get(threadId);
      if (!t) throw new DiscordError('NOT_FOUND', 'Il post Discord non esiste piu.');
      Object.assign(t, { name: post.threadName, tags: post.appliedTags, post, archived: false });
      return { ok: true };
    },
    deleteThread(threadId) { threads.delete(threadId); },
    count(op) { return calls.filter((c) => c.op === op).length; },
  };
  return g;
}

module.exports = { createMockGateway };
