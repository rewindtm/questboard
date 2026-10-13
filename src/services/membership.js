'use strict';

/**
 * Risolve il ruolo di `user` in un progetto, leggendo SEMPRE dal database
 * (mai da dati inviati dal client). Il superadmin (bootstrap da .env) e admin
 * implicito di tutti i progetti. Ritorna null se l'utente non e nel team.
 */
async function getMember(db, projectId, user) {
  if (!user) return null;
  if (user.is_superadmin) {
    return { userId: user.id, role: 'admin', canApprove: true, isSuperadmin: true };
  }
  const { rows } = await db.query(
    'SELECT role, can_approve FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, user.id],
  );
  if (!rows.length) return null;
  return { userId: user.id, role: rows[0].role, canApprove: rows[0].can_approve, isSuperadmin: false };
}

module.exports = { getMember };
