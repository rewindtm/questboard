'use strict';

/**
 * Accoda (o accorpa) una sincronizzazione Discord per un task, DENTRO la transazione chiamante.
 * Esiste al massimo una riga attiva (pending|processing) per task:
 *  - serializza le operazioni sullo stesso task
 *  - il worker rilegge sempre l'ultima versione, quindi gli aggiornamenti si accorpano
 *  - un secondo "publish" non puo creare un post duplicato
 */
async function enqueue(client, { taskId, projectId, kind, mentionUserId = null, immediate = false }) {
  // pulisce lo storico (done/error) del task: lo stato corrente e in tasks.sync_*
  await client.query(`DELETE FROM outbox WHERE task_id = $1 AND status IN ('done','error')`, [taskId]);
  await client.query(
    `INSERT INTO outbox (task_id, project_id, kind, mention_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (task_id) WHERE status IN ('pending','processing') DO UPDATE SET
       kind = CASE
                WHEN EXCLUDED.kind = 'repost' OR outbox.kind = 'repost' THEN 'repost'
                WHEN outbox.kind = 'publish' THEN 'publish'
                ELSE EXCLUDED.kind END,
       dirty = outbox.dirty OR outbox.status = 'processing',
       mention_user_id = COALESCE(EXCLUDED.mention_user_id, outbox.mention_user_id),
       next_attempt_at = CASE WHEN $5 THEN now() ELSE outbox.next_attempt_at END,
       updated_at = now()`,
    [taskId, projectId, kind, mentionUserId, immediate],
  );
  await client.query(
    `UPDATE tasks SET sync_status = 'pending', sync_error = NULL WHERE id = $1`,
    [taskId],
  );
}

module.exports = { enqueue };
