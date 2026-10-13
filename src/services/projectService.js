'use strict';
const { withTx } = require('../db/pool');
const { TASK_SELECT, taskDto } = require('./dto');
const { getMember } = require('./membership');
const perm = require('../domain/permissions');
const {
  parse, projectCreateSchema, projectSettingsSchema, memberSchema, memberUpdateSchema, buildSchema,
} = require('../domain/validation');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors');

const NAME = `COALESCE(u.display_name, u.username, u.local_login)`;

function createProjectService({ pool, bus, config, users, gateway }) {
  async function requireAdmin(db, projectId, actor) {
    const member = await getMember(db, projectId, actor);
    if (!member) throw new NotFoundError('Progetto non trovato');
    if (!perm.isAdmin(member)) throw new ForbiddenError('Solo gli amministratori possono farlo');
    return member;
  }

  async function listForUser(user) {
    const sql = user.is_superadmin
      ? `SELECT p.*, 'admin' AS role FROM projects p ORDER BY p.name`
      : `SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 ORDER BY p.name`;
    const { rows } = await pool.query(sql, user.is_superadmin ? [] : [user.id]);
    return rows;
  }

  async function getBySlug(user, slug) {
    const { rows } = await pool.query('SELECT * FROM projects WHERE slug = $1', [slug]);
    if (!rows[0]) return null;
    const member = await getMember(pool, rows[0].id, user);
    return member ? { project: rows[0], member } : null;
  }

  function projectInfo(p) {
    return {
      id: p.id, slug: p.slug, name: p.name, description: p.description, code_prefix: p.code_prefix,
      categories: p.categories,
      discord: {
        configured: !!(p.discord_guild_id && p.discord_forum_id),
        botAvailable: gateway.isConfigured(),
      },
    };
  }

  async function listMembers(db, projectId) {
    const { rows } = await db.query(
      `SELECT u.id, ${NAME} AS name, u.discord_id, u.local_login, m.role, m.can_approve
         FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 ORDER BY m.role, name`,
      [projectId],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name || `Utente ${r.id}`, role: r.role, can_approve: r.can_approve,
      discord_id: r.discord_id, local_login: r.local_login,
    }));
  }

  async function listBuilds(db, projectId) {
    const { rows } = await db.query(
      `SELECT b.*, (SELECT count(*)::int FROM tasks t WHERE t.build_id = b.id AND t.archived_at IS NULL) AS total,
              (SELECT count(*)::int FROM tasks t WHERE t.build_id = b.id AND t.archived_at IS NULL AND t.status = 'done') AS done
         FROM builds b WHERE b.project_id = $1 ORDER BY b.released, b.due_date NULLS LAST, b.id`,
      [projectId],
    );
    return rows;
  }

  /** Prossima build non rilasciata (la piu vicina per scadenza) con avanzamento. */
  async function nextRelease(projectId) {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.kind, b.due_date,
              (SELECT count(*)::int FROM tasks t WHERE t.build_id = b.id AND t.archived_at IS NULL) AS total,
              (SELECT count(*)::int FROM tasks t WHERE t.build_id = b.id AND t.archived_at IS NULL AND t.status = 'done') AS done
         FROM builds b WHERE b.project_id = $1 AND NOT b.released
        ORDER BY b.due_date NULLS LAST, b.id LIMIT 1`, [projectId]);
    return rows[0] || null;
  }

  /** Stato completo del progetto per un utente autorizzato: pagina iniziale e riallineamento dopo riconnessione. */
  async function snapshot(user, projectId) {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    const member = rows[0] && await getMember(pool, projectId, user);
    if (!member) throw new NotFoundError('Progetto non trovato');
    const [members, builds, tasks] = await Promise.all([
      listMembers(pool, projectId),
      listBuilds(pool, projectId),
      pool.query(`${TASK_SELECT} WHERE t.project_id = $1 AND t.archived_at IS NULL ORDER BY t.seq`, [projectId]),
    ]);
    return {
      project: projectInfo(rows[0]),
      me: {
        userId: user.id, role: member.role, canApprove: perm.canApprove(member), isAdmin: perm.isAdmin(member),
        canCreate: perm.canCreateTask(member),
      },
      members,
      builds: builds.map((b) => ({ id: b.id, name: b.name, kind: b.kind, due_date: b.due_date, released: b.released, total: b.total, done: b.done })),
      tasks: tasks.rows.map(taskDto),
      serverTime: new Date().toISOString(),
    };
  }

  async function create(actor, rawInput) {
    if (!actor.is_superadmin) throw new ForbiddenError('Solo l\'amministratore di bootstrap puo creare progetti');
    const input = parse(projectCreateSchema, rawInput);
    try {
      return await withTx(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO projects (slug, name, description, code_prefix, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [input.slug, input.name, input.description, input.code_prefix, actor.id]);
        await client.query(
          `INSERT INTO project_members (project_id, user_id, role, can_approve) VALUES ($1,$2,'admin',TRUE)`,
          [rows[0].id, actor.id]);
        return rows[0];
      });
    } catch (err) {
      if (err.code === '23505') throw new ValidationError('Slug gia in uso', { slug: 'Esiste gia un progetto con questo slug' });
      throw err;
    }
  }

  /** Verifica forum e tag con Discord. Ritorna { ok, problems[], forum?, tags[] }. */
  async function checkDiscord(actor, projectId, input) {
    await requireAdmin(pool, projectId, actor);
    if (!gateway.isConfigured()) {
      return { ok: false, problems: ['Integrazione Discord non configurata: manca DISCORD_BOT_TOKEN.'], tags: [] };
    }
    if (!input.discord_guild_id || !input.discord_forum_id) {
      return { ok: false, problems: ['Indica ID del server e del canale forum.'], tags: [] };
    }
    return gateway.validateForum(input.discord_guild_id, input.discord_forum_id, input.discord_tag_map);
  }

  async function updateSettings(actor, projectId, rawInput) {
    await requireAdmin(pool, projectId, actor);
    const input = parse(projectSettingsSchema, rawInput);
    if (input.discord_guild_id && input.discord_forum_id && gateway.isConfigured()) {
      let result;
      try { result = await gateway.validateForum(input.discord_guild_id, input.discord_forum_id, input.discord_tag_map); }
      catch (err) { if (err.discordCode !== 'TRANSIENT') throw err; }
      if (result && !result.ok) {
        throw new ValidationError('Configurazione Discord non valida', { discord: result.problems.join(' ') });
      }
    }
    const { rows } = await pool.query(
      `UPDATE projects SET name=$2, description=$3, categories=$4, discord_guild_id=$5, discord_forum_id=$6, discord_tag_map=$7
        WHERE id=$1 RETURNING *`,
      [projectId, input.name, input.description, input.categories, input.discord_guild_id, input.discord_forum_id,
        JSON.stringify(input.discord_tag_map)],
    );
    bus.emit('project:changed', { projectId });
    return rows[0];
  }

  async function getSettings(actor, projectId) {
    await requireAdmin(pool, projectId, actor);
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    return rows[0];
  }

  // ------------------------------------------------------------ team
  async function addMember(actor, projectId, rawInput) {
    await requireAdmin(pool, projectId, actor);
    const input = parse(memberSchema, rawInput);
    if (!input.discord_id && !input.local_login) {
      throw new ValidationError('Indica un Discord user ID oppure un login locale', { discord_id: 'Obbligatorio se non usi il login locale' });
    }
    if (input.local_login && !config.localAuth.enabled) {
      throw new ValidationError('Il login locale non e abilitato (ENABLE_LOCAL_AUTH)', { local_login: 'Login locale disabilitato' });
    }
    if (input.local_login && !input.password) {
      throw new ValidationError('Password obbligatoria per un account locale', { password: 'Almeno 12 caratteri' });
    }
    try {
      await withTx(pool, async (client) => {
        const user = input.local_login
          ? await users.createLocalUser(client, { login: input.local_login, displayName: input.display_name, password: input.password })
          : await users.ensureDiscordUser(client, input.discord_id, input.display_name);
        await client.query(
          `INSERT INTO project_members (project_id, user_id, role, can_approve) VALUES ($1,$2,$3,$4)`,
          [projectId, user.id, input.role, input.role === 'tester' && input.can_approve]);
      });
    } catch (err) {
      if (err.code === '23505') throw new ValidationError('Utente gia presente', { discord_id: 'Questo utente e gia nel team o il login esiste' });
      throw err;
    }
    bus.emit('project:changed', { projectId });
  }

  async function adminCount(db, projectId) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM project_members WHERE project_id=$1 AND role='admin'`, [projectId]);
    return rows[0].n;
  }

  async function updateMember(actor, projectId, userId, rawInput) {
    await requireAdmin(pool, projectId, actor);
    const input = parse(memberUpdateSchema, rawInput);
    await withTx(pool, async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [projectId, userId]);
      if (!rows[0]) throw new NotFoundError('Membro non trovato');
      if (rows[0].role === 'admin' && input.role !== 'admin' && (await adminCount(client, projectId)) <= 1) {
        throw new ValidationError('Deve restare almeno un amministratore');
      }
      await client.query(
        'UPDATE project_members SET role=$3, can_approve=$4 WHERE project_id=$1 AND user_id=$2',
        [projectId, userId, input.role, input.role === 'tester' && input.can_approve]);
    });
    bus.emit('project:changed', { projectId });
  }

  async function removeMember(actor, projectId, userId) {
    await requireAdmin(pool, projectId, actor);
    await withTx(pool, async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [projectId, userId]);
      if (!rows[0]) throw new NotFoundError('Membro non trovato');
      if (rows[0].role === 'admin' && (await adminCount(client, projectId)) <= 1) {
        throw new ValidationError('Deve restare almeno un amministratore');
      }
      const open = await client.query(
        `SELECT count(*)::int AS n FROM tasks WHERE project_id=$1 AND assignee_id=$2 AND status <> 'done' AND archived_at IS NULL`,
        [projectId, userId]);
      if (open.rows[0].n) {
        throw new ValidationError(`Ha ${open.rows[0].n} task aperti assegnati: riassegnali prima di rimuoverlo`);
      }
      await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
    });
    bus.emit('member:removed', { projectId, userId });
    bus.emit('project:changed', { projectId });
  }

  // ------------------------------------------------------------ build / milestone
  async function saveBuild(actor, projectId, buildId, rawInput) {
    await requireAdmin(pool, projectId, actor);
    const input = parse(buildSchema, rawInput);
    try {
      const fields = [input.name, input.kind, input.due_date, input.released];
      const { rows } = buildId
        ? await pool.query(
          `UPDATE builds SET name=$3, kind=$4, due_date=$5, released=$6 WHERE id=$2 AND project_id=$1 RETURNING *`,
          [projectId, buildId, ...fields])
        : await pool.query(
          `INSERT INTO builds (project_id, name, kind, due_date, released) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [projectId, ...fields]);
      if (!rows[0]) throw new NotFoundError('Build non trovata');
      bus.emit('project:changed', { projectId });
      return rows[0];
    } catch (err) {
      if (err.code === '23505') throw new ValidationError('Nome gia in uso', { name: 'Esiste gia una build con questo nome' });
      throw err;
    }
  }

  async function deleteBuild(actor, projectId, buildId) {
    await requireAdmin(pool, projectId, actor);
    const used = await pool.query('SELECT count(*)::int AS n FROM tasks WHERE build_id=$1', [buildId]);
    if (used.rows[0].n) throw new ValidationError(`La build ha ${used.rows[0].n} task collegati: spostali prima di eliminarla`);
    await pool.query('DELETE FROM builds WHERE id=$1 AND project_id=$2', [buildId, projectId]);
    bus.emit('project:changed', { projectId });
  }

  return {
    listForUser, getBySlug, nextRelease, snapshot, create, getSettings, updateSettings, checkDiscord,
    listMembers, addMember, updateMember, removeMember, listBuilds, saveBuild, deleteBuild, projectInfo,
  };
}

module.exports = { createProjectService };
