// CATX-DELIVERY-OBSERVABILITY-001: acceso a catastrox_delivery_attempts
// (migración 008) -- historial INMUTABLE de cada intento individual de
// entrega. Cada intento inserta su propia fila (startAttempt) y la
// actualiza al terminar (completeAttempt) -- nunca se inserta una segunda
// fila para el mismo intento, y nunca se borra ni se sobrescribe una fila
// de un intento anterior al iniciar uno nuevo.
import { query } from '../../db.js';

const ATTEMPTS_TABLE = 'public.catastrox_delivery_attempts';

/**
 * Inserta la fila de un nuevo intento, en estado 'RUNNING'. `attemptNumber`
 * lo calcula el llamador (processDeliveryJob) a partir de
 * job.attempt_count + 1 ANTES de que ese contador se incremente -- así el
 * historial numera los intentos en el mismo orden en que ocurrieron, sin
 * depender de una segunda consulta ni de una secuencia separada.
 */
export async function startDeliveryAttempt({ deliveryJobId, attemptNumber }) {
  const result = await query(
    `insert into ${ATTEMPTS_TABLE} (delivery_job_id, attempt_number, status, started_at)
     values ($1, $2, 'RUNNING', now())
     returning *`,
    [deliveryJobId, attemptNumber],
  );
  return result.rows[0];
}

/**
 * Cierra la fila de un intento ya iniciado -- UPDATE sobre la MISMA fila
 * (por id), nunca un INSERT nuevo. Acepta campos parciales: un intento que
 * falla antes de generar el deliverable solo tendrá status/error_code/
 * error_message; uno que llega a enviar el correo tendrá también
 * deliverable_id/byte_size/content_hash/provider_message_id.
 */
export async function completeDeliveryAttempt(attemptId, {
  status,
  errorCode = null,
  errorMessage = null,
  deliverableId = null,
  providerMessageId = null,
  byteSize = null,
  contentHash = null,
  metadata = null,
} = {}) {
  const result = await query(
    `update ${ATTEMPTS_TABLE}
        set status = $2,
            completed_at = now(),
            error_code = $3,
            error_message = $4,
            deliverable_id = coalesce($5, deliverable_id),
            provider_message_id = coalesce($6, provider_message_id),
            byte_size = coalesce($7, byte_size),
            content_hash = coalesce($8, content_hash),
            metadata = case when $9::jsonb is null then metadata else metadata || $9::jsonb end
      where id = $1
      returning *`,
    [attemptId, status, errorCode, errorMessage, deliverableId, providerMessageId, byteSize, contentHash, metadata ? JSON.stringify(metadata) : null],
  );
  return result.rows[0] || null;
}

export async function listAttemptsForJob(deliveryJobId) {
  const result = await query(
    `select * from ${ATTEMPTS_TABLE} where delivery_job_id = $1 order by attempt_number asc`,
    [deliveryJobId],
  );
  return result.rows;
}
