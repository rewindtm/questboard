'use strict';
const { DiscordError, mapDiscordJsError } = require('./errors');
const { extractRef } = require('./render');

/**
 * Gateway verso Discord: l'unico modulo (insieme a bot.js) che usa discord.js.
 * Il resto dell'applicazione e i test dipendono solo da questa interfaccia:
 *   isConfigured(), isReady(), validateForum(), findThreadByRef(), createThread(), updateThread()
 *
 * Senza DISCORD_BOT_TOKEN `isConfigured()` e false e ogni chiamata fallisce con NOT_CONFIGURED:
 * non viene mai simulata una sincronizzazione riuscita.
 */
function createGateway({ token = '' } = {}) {
  let client = null;
  const gw = {
    attach(c) { client = c; },
    isConfigured: () => !!token,
    isReady: () => !!client?.isReady?.(),
  };

  function requireClient() {
    if (!token) throw new DiscordError('NOT_CONFIGURED', 'Integrazione Discord non configurata (DISCORD_BOT_TOKEN mancante).');
    if (!client?.isReady()) throw new DiscordError('TRANSIENT', 'Il bot Discord non e ancora connesso.');
    return client;
  }
  const wrap = (what, fn) => async (...args) => {
    const c = requireClient();
    try { return await fn(c, ...args); } catch (err) { throw mapDiscordJsError(err, what); }
  };

  const REQUIRED_PERMS = [
    ['ViewChannel', 'Visualizza canale'], ['SendMessages', 'Invia messaggi'],
    ['SendMessagesInThreads', 'Invia messaggi nei thread'], ['ReadMessageHistory', 'Leggi cronologia messaggi'],
    ['ManageThreads', 'Gestisci thread'], ['EmbedLinks', 'Incorpora link'],
  ];

  async function fetchForum(c, guildId, forumId) {
    const { ChannelType } = require('discord.js');
    const guild = await c.guilds.fetch(guildId).catch((e) => {
      if (e?.status === 404 || e?.code === 10004) return null;
      throw e;
    });
    if (!guild) throw new DiscordError('INVALID_CONFIG', 'Il bot non e presente nel server indicato (ID errato o bot non invitato).');
    const forum = await guild.channels.fetch(forumId).catch((e) => {
      if (e?.status === 404 || e?.code === 10003) return null;
      throw e;
    });
    if (!forum) throw new DiscordError('INVALID_CONFIG', 'Canale non trovato nel server (ID errato o il bot non lo vede).');
    if (forum.type !== ChannelType.GuildForum) throw new DiscordError('INVALID_CONFIG', 'Il canale indicato non e un forum.');
    return { guild, forum };
  }

  /** Verifica forum, permessi e mappatura tag. Non lancia per problemi di configurazione: li elenca. */
  gw.validateForum = async (guildId, forumId, tagMap = { status: {}, priority: {} }) => {
    const c = requireClient();
    const problems = [];
    let forum;
    let guild;
    try {
      ({ guild, forum } = await fetchForum(c, guildId, forumId));
    } catch (err) {
      const e = err instanceof DiscordError ? err : mapDiscordJsError(err, 'verifica del forum');
      if (e.discordCode === 'INVALID_CONFIG' || e.discordCode === 'NOT_FOUND') return { ok: false, problems: [e.message], tags: [] };
      throw e;
    }
    const me = guild.members.me ?? await guild.members.fetchMe();
    const perms = forum.permissionsFor(me);
    const missing = REQUIRED_PERMS.filter(([flag]) => !perms?.has(flag)).map(([, label]) => label);
    if (missing.length) problems.push(`Al bot mancano questi permessi nel forum: ${missing.join(', ')}.`);
    const tags = forum.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: !!t.moderated }));
    const ids = new Set(tags.map((t) => t.id));
    for (const group of ['status', 'priority']) {
      for (const [key, tagId] of Object.entries(tagMap?.[group] || {})) {
        if (!ids.has(tagId)) problems.push(`Il tag assegnato a ${group}/${key} non esiste piu nel forum.`);
      }
    }
    const { ChannelFlags } = require('discord.js');
    if (forum.flags?.has(ChannelFlags.RequireTag)) {
      const unmapped = ['todo', 'in_progress', 'review', 'done'].filter((s) => !tagMap?.status?.[s]);
      if (unmapped.length) problems.push('Il forum richiede un tag per ogni post: associa un tag a tutti e quattro gli stati.');
    }
    return { ok: problems.length === 0, problems, tags, forumName: forum.name };
  };

  /** Cerca un post gia creato per questo task (riconciliazione dopo crash). */
  gw.findThreadByRef = wrap('ricerca del post', async (c, { guildId, forumId, ref, code }) => {
    const { guild, forum } = await fetchForum(c, guildId, forumId);
    const active = await guild.channels.fetchActiveThreads();
    const archived = await forum.threads.fetchArchived({ limit: 50 }).catch(() => ({ threads: new Map() }));
    const candidates = [...active.threads.values(), ...archived.threads.values()]
      .filter((t) => t.parentId === forumId && t.name.startsWith(`[${code}]`));
    for (const thread of candidates) {
      const msg = await thread.messages.fetch(thread.id).catch(() => null);
      if (msg && extractRef(msg.embeds?.[0]?.footer?.text) === ref) {
        return { threadId: thread.id, messageId: msg.id, url: `https://discord.com/channels/${guildId}/${thread.id}` };
      }
    }
    return null;
  });

  gw.createThread = wrap('creazione del post', async (c, { guildId, forumId, post, mentionDiscordId }) => {
    const { forum } = await fetchForum(c, guildId, forumId);
    const thread = await forum.threads.create({
      name: post.threadName,
      appliedTags: post.appliedTags,
      message: {
        content: post.content || undefined,
        embeds: post.embeds,
        components: post.components,
        allowedMentions: mentionDiscordId ? { users: [mentionDiscordId] } : { parse: [] },
      },
    });
    // nei forum l'ID del messaggio iniziale coincide con l'ID del thread
    return { threadId: thread.id, messageId: thread.id, url: `https://discord.com/channels/${guildId}/${thread.id}` };
  });

  /** Aggiorna titolo, tag e messaggio iniziale. Menziona solo se `mentionDiscordId` e valorizzato. */
  gw.updateThread = wrap('aggiornamento del post', async (c, { threadId, messageId, post, mentionDiscordId }) => {
    const thread = await c.channels.fetch(threadId);
    if (!thread?.isThread?.()) throw new DiscordError('NOT_FOUND', 'Il post Discord non esiste piu.');
    if (thread.archived) await thread.setArchived(false);
    const sameTags = thread.appliedTags.length === post.appliedTags.length
      && post.appliedTags.every((t) => thread.appliedTags.includes(t));
    if (thread.name !== post.threadName || !sameTags) {
      await thread.edit({ name: post.threadName, appliedTags: post.appliedTags });
    }
    const message = await thread.messages.fetch(messageId);
    await message.edit({
      content: post.content || null,
      embeds: post.embeds,
      components: post.components,
      allowedMentions: mentionDiscordId ? { users: [mentionDiscordId] } : { parse: [] },
    });
    return { ok: true };
  });

  return gw;
}

module.exports = { createGateway };
