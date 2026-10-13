'use strict';

/** Colonne + join usati ovunque si legga un task (nomi leggibili per assegnatario/autore/build). */
const TASK_SELECT = `
  SELECT t.*,
         COALESCE(a.display_name, a.username, a.local_login)  AS assignee_name,
         COALESCE(au.display_name, au.username, au.local_login) AS author_name,
         b.name AS build_name
    FROM tasks t
    LEFT JOIN users a  ON a.id  = t.assignee_id
    LEFT JOIN users au ON au.id = t.author_id
    LEFT JOIN builds b ON b.id  = t.build_id`;

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

/** Rappresentazione di un task inviata ai client (nessun dato interno sensibile). */
function taskDto(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    seq: r.seq,
    code: r.code,
    title: r.title,
    description: r.description,
    checklist: r.checklist,
    priority: r.priority,
    status: r.status,
    category: r.category,
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name } : null,
    author: r.author_id ? { id: r.author_id, name: r.author_name } : null,
    due_date: r.due_date,
    build: r.build_id ? { id: r.build_id, name: r.build_name } : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    version: r.version,
    archived: !!r.archived_at,
    discord: {
      linked: !!r.discord_thread_id,
      url: r.discord_url || null,
      status: r.sync_status,
      error: r.sync_error || null,
      synced_version: r.synced_version,
    },
  };
}

function eventDto(r) {
  return {
    id: r.id,
    task_id: r.task_id,
    type: r.type,
    source: r.source,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
    changes: r.changes,
    created_at: iso(r.created_at),
  };
}

const userName = (u) => (u ? u.display_name || u.username || u.local_login || `Utente ${u.id}` : null);

module.exports = { TASK_SELECT, taskDto, eventDto, userName };
