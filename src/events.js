'use strict';
const { EventEmitter } = require('node:events');

/**
 * Bus in-process. Eventi:
 *  - 'task:changed'   { projectId, taskId }   (Socket.IO rilegge il task dal DB e lo invia alla room)
 *  - 'task:event'     { projectId, taskId, eventId }
 *  - 'project:changed'{ projectId }           (team / build / impostazioni)
 *  - 'member:removed' { projectId, userId }
 *  - 'outbox:nudge'   {}                      (sveglia il worker)
 */
function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  return bus;
}

module.exports = { createBus };
