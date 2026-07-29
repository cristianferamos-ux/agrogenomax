// Entrega de entregables por correo (Bloque 8/9/10 del pedido).
//
// Alcance honesto de esta fase (documentado también en el informe final):
// no existe en este repo ningún proveedor de correo (SMTP/SES/Resend) ni
// generación server-side de PDF/KML/KMZ/SHP/DXF -- esos archivos hoy se
// construyen 100% en el navegador (src/modules/catastrox/utils/
// catastroxDeliverables.js), ya documentado como riesgo residual en la
// Fase 1 de este trabajo. Esta fase SÍ construye el modelo de datos, el
// disparo real (se crea un trabajo al aprobar cada orden) y la interfaz
// que un proveedor real implementaría después -- pero
// generateDeliverablesForOrder()/sendDeliveryEmail() fallan explícitamente
// con un código de error claro en vez de fingir éxito. Nunca se marca
// DELIVERED ni SENT sin que un proveedor real lo haya confirmado.
import { query } from '../../db.js';
import { encryptPii, hashEmail } from './piiCrypto.js';

const DELIVERY_JOBS_TABLE = 'public.catastrox_delivery_jobs';
const DELIVERABLES_TABLE = 'public.catastrox_deliverables';

export const GENERATION_NOT_IMPLEMENTED_ERROR_CODE = 'SERVER_SIDE_GENERATION_NOT_IMPLEMENTED';

/**
 * Crea el job principal de entrega de una orden -- EXACTAMENTE una fila
 * por payment_order_id (UNIQUE, migración 005). Una segunda llamada para
 * la misma orden (dos disparos concurrentes de triggerPostApprovalWorkflows,
 * un reintento futuro que vuelva a invocar esto por error) nunca crea una
 * segunda fila: el ON CONFLICT es un no-op que igual devuelve la fila ya
 * existente (RETURNING funciona en UPDATE, no en DO NOTHING puro). Los
 * reintentos reales de procesamiento actualizan esta misma fila vía
 * processDeliveryJob(jobId), nunca insertan una nueva.
 *
 * deliveryEmail se cifra aquí (nunca se escribe en texto plano en filas
 * nuevas -- delivery_email queda NULL, ver migración 005).
 */
export async function createDeliveryJobForOrder({ orderId, customerId, deliveryEmail }, client = null) {
  const runner = client || { query };
  const deliveryEmailEncrypted = encryptPii(deliveryEmail);
  // hashEmail() normaliza internamente y aplica el dominio
  // "catastrox:email:v1:" -- nunca hashPii() genérico para un correo.
  const deliveryEmailHash = hashEmail(deliveryEmail);
  const result = await runner.query(
    `insert into ${DELIVERY_JOBS_TABLE}
       (payment_order_id, customer_id, delivery_email_encrypted, delivery_email_hash, status)
     values ($1, $2, $3, $4, 'QUEUED')
     on conflict (payment_order_id) do update set status = ${DELIVERY_JOBS_TABLE}.status
     returning *`,
    [orderId, customerId, deliveryEmailEncrypted, deliveryEmailHash],
  );
  return result.rows[0];
}

async function markDeliveryJobFailed(jobId, errorCode) {
  const result = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'FAILED',
            attempt_count = attempt_count + 1,
            last_attempt_at = now(),
            last_error_code = $2,
            -- Reintento diferido -- una vez que exista un generador real,
            -- un job en trabajo periódico puede recogerlo por next_retry_at.
            next_retry_at = now() + interval '1 hour'
      where id = $1
      returning *`,
    [jobId, errorCode],
  );
  return result.rows[0] || null;
}

/**
 * Interfaz real (no un mock silencioso): en producción con un generador
 * conectado, esta función construiría cada archivo del paquete comprado y
 * los registraría en catastrox_deliverables con su storage_key/hash. Hoy
 * no hay generador -- lanza explícitamente en vez de simular archivos.
 *
 * @param {string} orderId
 * @returns {Promise<never>}
 */
export async function generateDeliverablesForOrder(orderId) {
  void orderId;
  const error = new Error('La generación de entregables en backend todavía no está implementada.');
  error.code = GENERATION_NOT_IMPLEMENTED_ERROR_CODE;
  throw error;
}

/**
 * Interfaz real para el envío del correo de entrega -- hoy sin proveedor
 * conectado, mismo criterio que generateDeliverablesForOrder().
 *
 * @param {string} jobId
 * @returns {Promise<never>}
 */
export async function sendDeliveryEmail(jobId) {
  void jobId;
  const error = new Error('El envío de entregables por correo todavía no está implementado.');
  error.code = GENERATION_NOT_IMPLEMENTED_ERROR_CODE;
  throw error;
}

/**
 * Orquesta el intento de procesamiento de un job recién creado: marca
 * GENERATING, intenta generar, y si falla (siempre, en este alcance) deja
 * el job en FAILED con el código de error -- nunca en READY/SENT/DELIVERED
 * sin que el trabajo haya ocurrido de verdad. Se llama una vez, justo
 * después de crear el job (server/routes/catastroxPayments.js, al aprobar
 * una orden) -- reintentos posteriores serían responsabilidad de un
 * trabajo periódico que lea next_retry_at (no implementado en este
 * alcance, ver informe de riesgos residuales).
 */
export async function processDeliveryJob(jobId) {
  await query(`update ${DELIVERY_JOBS_TABLE} set status = 'GENERATING', started_at = now() where id = $1`, [jobId]);

  try {
    await generateDeliverablesForOrder(jobId);
    // Nunca alcanzable en este alcance -- si algún día generateDeliverablesForOrder
    // resuelve con éxito, aquí continuaría con sendDeliveryEmail() y
    // status='READY'/'SENDING'/'SENT'. Se deja preparado, no implementado.
  } catch (error) {
    await markDeliveryJobFailed(jobId, error.code || 'DELIVERY_JOB_UNKNOWN_ERROR');
  }
}

export async function findDeliveryJobsForOrder(orderId) {
  const result = await query(`select * from ${DELIVERY_JOBS_TABLE} where payment_order_id = $1 order by created_at desc`, [
    orderId,
  ]);
  return result.rows;
}

export async function listDeliverablesForJob(jobId) {
  const result = await query(`select * from ${DELIVERABLES_TABLE} where delivery_job_id = $1`, [jobId]);
  return result.rows;
}
