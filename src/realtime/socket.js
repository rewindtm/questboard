'use strict';
const { Server } = require('socket.io');

const roomOf = (projectId) => `project:${projectId}`;

/**
 * Socket.IO autenticato tramite la sessione Express. Le room di progetto sono assegnate
 * SOLO dal server in base all'appartenenza al team: il project ID inviato dal client non e mai fidato.
 */
function attachSocket({ httpServer, sessionMiddleware, bus, services, log = () => {} }) {
  const io = new Server(httpServer, { serveClient: true, cors: { origin: false } });
  io.engine.use(sessionMiddleware);

  io.use(async (socket, next) => {
    try {
      const userId = socket.request.session?.userId;
      const user = userId ? await services.users.getById(userId) : null;
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    } catch (err) { next(err); }
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    try {
      for (const p of await services.projects.listForUser(user)) socket.join(roomOf(p.id));
    } catch (err) { log('socket: join room fallito', err.message); }

    // Snapshot completo (anche dopo una riconnessione): ricontrolla l'appartenenza lato server.
    socket.on('snapshot', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const projectId = Number(payload?.projectId);
        if (!Number.isInteger(projectId)) throw new Error('bad request');
        const fresh = await services.users.getById(user.id); // il ruolo potrebbe essere cambiato
        const snapshot = await services.projects.snapshot(fresh, projectId);
        socket.join(roomOf(projectId));
        ack({ ok: true, snapshot });
      } catch {
        ack({ ok: false, error: 'not_found' });
      }
    });
  });

  const onTaskChanged = async ({ projectId, taskId }) => {
    try {
      const dto = await services.tasks.loadDto(services.pool, taskId);
      if (dto) io.to(roomOf(projectId)).emit('task:updated', dto);
    } catch (err) { log('socket: task:updated fallito', err.message); }
  };
  const onTaskEvent = async ({ projectId, eventId }) => {
    try {
      const ev = await services.tasks.eventById(eventId);
      if (ev) io.to(roomOf(projectId)).emit('task:event', ev);
    } catch (err) { log('socket: task:event fallito', err.message); }
  };
  const onProjectChanged = ({ projectId }) => io.to(roomOf(projectId)).emit('project:changed', { projectId });
  const onMemberRemoved = ({ projectId, userId }) => {
    io.in(`user:${userId}`).emit('project:removed', { projectId });
    io.in(`user:${userId}`).socketsLeave(roomOf(projectId));
  };
  bus.on('task:changed', onTaskChanged);
  bus.on('task:event', onTaskEvent);
  bus.on('project:changed', onProjectChanged);
  bus.on('member:removed', onMemberRemoved);

  async function close() {
    bus.off('task:changed', onTaskChanged);
    bus.off('task:event', onTaskEvent);
    bus.off('project:changed', onProjectChanged);
    bus.off('member:removed', onMemberRemoved);
    await new Promise((resolve) => io.close(() => resolve()));
  }
  return { io, close };
}

module.exports = { attachSocket, roomOf };
