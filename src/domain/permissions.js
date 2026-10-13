'use strict';
const { TRANSITIONS } = require('./constants');

/**
 * `member` = { userId, role, canApprove, isSuperadmin }
 * Il superadmin (bootstrap da .env) e amministratore implicito di ogni progetto.
 */
function isAdmin(m) { return !!m && (m.role === 'admin' || m.isSuperadmin === true); }
function canApprove(m) { return isAdmin(m) || (!!m && m.role === 'tester' && m.canApprove === true); }
function canCreateTask(m) { return isAdmin(m) || (!!m && m.role === 'tester'); }

const DEV_MOVES = new Set(['todo>in_progress', 'in_progress>todo', 'in_progress>review', 'review>in_progress']);
const APPROVER_MOVES = new Set(['review>done', 'review>in_progress', 'review>todo', 'done>in_progress']);

/** Lo stato `from -> to` e consentito a questo membro per questo task? */
function canTransition(m, task, from, to) {
  if (!m || from === to) return false;
  if (isAdmin(m)) return true;
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) return false;
  const key = `${from}>${to}`;
  if (m.role === 'developer') return task.assignee_id === m.userId && DEV_MOVES.has(key);
  if (m.role === 'tester') return canApprove(m) && APPROVER_MOVES.has(key);
  return false;
}

/** Il tester non-admin che ha aperto la segnalazione puo correggerla finche e "da fare". */
function editableFields(m, task) {
  if (isAdmin(m)) {
    return ['title', 'description', 'checklist', 'priority', 'category', 'assignee_id', 'due_date', 'build_id', 'status'];
  }
  if (m.role === 'developer' && task.assignee_id === m.userId) return ['description', 'checklist', 'status'];
  if (m.role === 'tester') {
    const fields = ['status'];
    if (task.author_id === m.userId && task.status === 'todo') fields.push('title', 'description', 'checklist', 'category');
    return fields;
  }
  return [];
}

function canManageProject(m) { return isAdmin(m); }
function canRetrySync(m) { return isAdmin(m); }

module.exports = { isAdmin, canApprove, canCreateTask, canTransition, editableFields, canManageProject, canRetrySync };
