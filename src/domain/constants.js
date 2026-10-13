'use strict';

const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const ROLES = ['admin', 'developer', 'tester'];

const STATUS_LABELS = { todo: 'Da fare', in_progress: 'In corso', review: 'Da verificare', done: 'Completato' };
const PRIORITY_LABELS = { critical: 'Critica', high: 'Alta', medium: 'Media', low: 'Bassa' };
const ROLE_LABELS = { admin: 'Game Director', developer: 'Sviluppatore', tester: 'Tester' };

/** Transizioni di stato valide (per chi non e amministratore). Gli admin possono spostare ovunque. */
const TRANSITIONS = {
  todo: ['in_progress'],
  in_progress: ['todo', 'review'],
  review: ['in_progress', 'todo', 'done'],
  done: ['in_progress'],
};

module.exports = { STATUSES, PRIORITIES, ROLES, STATUS_LABELS, PRIORITY_LABELS, ROLE_LABELS, TRANSITIONS };
