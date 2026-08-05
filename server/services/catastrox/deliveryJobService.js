// CATX-DELIVERY-001: generación, persistencia y envío automático del PDF
// comprado, disparados cuando una orden pasa a APPROVED.
//
// Máquina de estados de catastrox_delivery_jobs (ajuste obligatorio del
// plan aprobado -- reemplaza la versión anterior de este archivo, que
// siempre fallaba con SERVER_SIDE_GENERATION_NOT_IMPLEMENTED):
//   QUEUED -> GENERATING -> READY -> SENDING -> SENT
//                                            \-> FAILED
// SENT únicamente después de una respuesta EXITOSA confirmada del
// proveedor de correo (emailSender.sendDeliverableEmail -- delivered:true).
// Nunca se marca SENT solo porque el PDF fue generado/almacenado -- ese
// estado es READY, un paso intermedio real, no un sinónimo de "enviado".
//
// Si el proveedor de correo no está habilitado en este ambiente
// (server/services/catastrox/emailSender.js, REAL_PROVIDER_ENABLED_ENVIRONMENTS),
// el job queda FAILED con last_error_code='EMAIL_PROVIDER_DISABLED' --
// el PDF YA quedó generado y almacenado correctamente (deliverable
// persistido antes del intento de envío), la descarga sigue funcionando,
// y NUNCA se declara "enviado al correo" cuando no ocurrió de verdad.
//
// CATX-DELIVERY-OBSERVABILITY-001: cada llamada a processDeliveryJob (sea
// el disparo automático tras APPROVED o un reintento manual) es un
// "intento" con su propia fila INMUTABLE en catastrox_delivery_attempts
// (migración 008, ver deliveryAttemptRepository.js) -- nunca se sobrescribe
// ni se borra el historial de un intento anterior. Justo antes de enviar el
// correo se re-verifica sha256(pdfBytes) contra deliverable.content_hash
// (nunca confiar ciegamente en la variable en memoria) y se aborta con un
// error controlado si no coincide -- defensa en profundidad, motivada por
// un incidente real donde no había forma de reconstruir, después del
// hecho, cuántos intentos hubo ni qué falló en cada uno.
import crypto from 'crypto';
import { query } from '../../db.js';
import { encryptPii, hashEmail, decryptPii } from './piiCrypto.js';
import * as paymentOrders from './paymentOrderRepository.js';
import * as customers from './customerRepository.js';
import { startDeliveryAttempt, completeDeliveryAttempt, listAttemptsForJob } from './deliveryAttemptRepository.js';
// Reutiliza el mismo patrón de importación cruzada ruta->servicio ya
// establecido en este repo (server/routes/catastroxPayments.js importa de
// server/routes/catastrox.js) -- resolvePredioDataForDelivery es la única
// fuente de datos del predio para la generación, nunca el body/lookup_id
// del cliente.
import { resolvePredioDataForDelivery } from '../../routes/catastrox.js';
import { generateCatastroxPdfBuffer, buildCatastroxDeliverableFilename } from './pdf/catastroxPdfGenerator.js';
import { resolveStorageAdapter } from './storage/storageAdapter.js';
import { sendDeliverableEmail } from './emailSender.js';

const DELIVERY_JOBS_TABLE = 'public.catastrox_delivery_jobs';
const DELIVERABLES_TABLE = 'public.catastrox_deliverables';
const CLAIMABLE_STATUSES = Object.freeze(['QUEUED', 'FAILED']);
const ACTIVE_STATUSES = Object.freeze(['GENERATING', 'READY', 'SENDING']);
const STALE_ACTIVE_INTERVAL = "30 minutes";

// Conservada por compatibilidad -- clasificador genérico para cualquier
// fallo de generación que no tenga un código más específico (p. ej. un
// error inesperado de PDFKit). ORDER_NOT_APPROVED/PREDIO_DATA_UNAVAILABLE/
// EMAIL_PROVIDER_DISABLED son siempre preferibles cuando aplican.
export const GENERATION_NOT_IMPLEMENTED_ERROR_CODE = 'SERVER_SIDE_GENERATION_NOT_IMPLEMENTED';

const PACKAGE_LABELS = Object.freeze({ basico: 'Básico', plus: 'Plus', profesional: 'Profesional' });

function resolvePackageLabel(packageId) {
  return PACKAGE_LABELS[String(packageId || '').toLowerCase()] || packageId;
}

// No se importa buildCustomerDisplayNameForEmail de catastroxPayments.js a
// propósito -- esa ruta ya importa de este archivo (createDeliveryJobForOrder/
// processDeliveryJob); importar en la otra dirección crearía un ciclo.
// Función trivial, duplicada deliberadamente en vez de forzar una
// dependencia circular.
function resolveCustomerDisplayName(decryptedCustomer) {
  if (!decryptedCustomer) return null;
  if (decryptedCustomer.legalName) return decryptedCustomer.legalName;
  const parts = [decryptedCustomer.firstName, decryptedCustomer.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// CATX-DELIVERY-OBSERVABILITY-001 (requisito 3): logging estructurado --
// mismo patrón ya usado en emailSender.js (console.log/console.error +
// objeto plano), nunca un logger externo nuevo. Campos EXACTOS pedidos:
// order_id, order_token, delivery_job_id, deliverable_id, attempt_count,
// byte_size, checksum, provider_message_id, etapa, error_code,
// error_message, timestamp -- cualquier campo ausente para una etapa dada
// simplemente no se incluye (nunca null artificial). Nunca PII (sin email,
// sin nombre, sin geometría).
function logDeliveryEvent(stage, fields = {}) {
  const level = fields.error_code ? console.error : console.log;
  const entry = { timestamp: new Date().toISOString(), etapa: stage, ...fields };
  level('[CatastroX Delivery]', entry);
}

function isDuplicateConstraintError(error) {
  return error?.code === '23505';
}

function isActiveDeliveryStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

function resolveUnclaimedReason(job) {
  if (!job) return 'not_found';
  if (job.status === 'SENT' || job.status === 'DELIVERED') return 'already_sent';
  if (isActiveDeliveryStatus(job.status)) return 'already_processing';
  return 'not_claimable';
}

/**
 * Reclamo atomico y corto: solo una ejecucion puede mover QUEUED/FAILED (o
 * un estado activo claramente vencido) a GENERATING e incrementar
 * attempt_count. No mantiene ninguna transaccion abierta durante PDF, tiles
 * ni proveedor de correo.
 */
async function claimDeliveryJob(jobId) {
  const claimResult = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'GENERATING',
            started_at = coalesce(started_at, now()),
            attempt_count = attempt_count + 1,
            last_attempt_at = now(),
            last_error_code = null,
            next_retry_at = null
      where id = $1
        and status = any($2::public.catastrox_delivery_job_status[])
      returning *`,
    [jobId, CLAIMABLE_STATUSES],
  );
  if (claimResult.rows[0]) {
    return { claimed: true, job: claimResult.rows[0], recoveredFromStale: false };
  }

  const staleClaimResult = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'GENERATING',
            started_at = coalesce(started_at, now()),
            attempt_count = attempt_count + 1,
            last_attempt_at = now(),
            last_error_code = null,
            next_retry_at = null
      where id = $1
        and status = any($2::public.catastrox_delivery_job_status[])
        and provider_message_id is null
        and last_attempt_at < now() - $3::interval
      returning *`,
    [jobId, ACTIVE_STATUSES, STALE_ACTIVE_INTERVAL],
  );
  if (staleClaimResult.rows[0]) {
    return { claimed: true, job: staleClaimResult.rows[0], recoveredFromStale: true };
  }

  const currentResult = await query(`select * from ${DELIVERY_JOBS_TABLE} where id = $1`, [jobId]);
  const currentJob = currentResult.rows[0] || null;
  return { claimed: false, job: currentJob, reason: resolveUnclaimedReason(currentJob) };
}

async function transitionDeliveryJobToReady({ jobId, attemptNumber }) {
  const result = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'READY',
            completed_at = now()
      where id = $1
        and status = 'GENERATING'
        and attempt_count = $2
      returning *`,
    [jobId, attemptNumber],
  );
  return result.rows[0] || null;
}

async function claimEmailSending({ jobId, attemptNumber }) {
  const result = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'SENDING',
            last_attempt_at = now()
      where id = $1
        and status = 'READY'
        and attempt_count = $2
        and provider_message_id is null
      returning *`,
    [jobId, attemptNumber],
  );
  return result.rows[0] || null;
}

async function markDeliveryJobSent({ jobId, attemptNumber, providerMessageId }) {
  const result = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'SENT',
            delivered_at = now(),
            last_attempt_at = now(),
            last_resolved_error_code = case when last_error_code is not null then last_error_code else last_resolved_error_code end,
            last_resolved_error_at = case when last_error_code is not null then now() else last_resolved_error_at end,
            last_error_code = null,
            provider_message_id = $3
      where id = $1
        and status = 'SENDING'
        and attempt_count = $2
      returning *`,
    [jobId, attemptNumber, providerMessageId],
  );
  return result.rows[0] || null;
}

/**
 * Crea el job principal de entrega de una orden -- EXACTAMENTE una fila
 * por payment_order_id (UNIQUE, migración 005). Sin cambios de
 * comportamiento respecto a la versión anterior de este archivo.
 */
export async function createDeliveryJobForOrder({ orderId, customerId, deliveryEmail }, client = null) {
  const runner = client || { query };
  const deliveryEmailEncrypted = encryptPii(deliveryEmail);
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

/**
 * Reemplaza el markDeliveryJobFailed original -- ahora, además de marcar el
 * job FAILED, cierra la fila del intento en curso (catastrox_delivery_attempts)
 * con el mismo error_code/error_message, y emite el log estructurado.
 * `attemptId` puede ser null (p.ej. si processDeliveryJob falla ANTES de
 * poder insertar la fila del intento) -- en ese caso solo se marca el job.
 */
async function markDeliveryJobFailed(jobId, errorCode, {
  attemptId = null,
  errorMessage = null,
  stage = null,
  order = null,
  deliverable = null,
} = {}) {
  const result = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'FAILED',
            last_attempt_at = now(),
            last_error_code = $2,
            next_retry_at = now() + interval '1 hour'
      where id = $1
      returning *`,
    [jobId, errorCode],
  );
  const job = result.rows[0] || null;

  if (attemptId) {
    // Aunque el intento haya fallado, si el PDF ya se generó y almacenó
    // antes de la falla (p. ej. correo deshabilitado/rechazado, checksum
    // pre-envío) el historial debe conservar ESE deliverable_id -- perderlo
    // sería justo el tipo de detalle que este sprint (CATX-DELIVERY-
    // OBSERVABILITY-001) existe para dejar de perder.
    await completeDeliveryAttempt(attemptId, {
      status: 'FAILED',
      errorCode,
      errorMessage,
      deliverableId: deliverable?.id || null,
      byteSize: deliverable?.byte_size || null,
      contentHash: deliverable?.content_hash || null,
    });
  }

  logDeliveryEvent(stage || 'failed', {
    order_id: order?.id,
    order_token: order?.order_token,
    delivery_job_id: jobId,
    deliverable_id: deliverable?.id,
    attempt_count: job?.attempt_count,
    error_code: errorCode,
    error_message: errorMessage || undefined,
  });

  return job;
}

/**
 * Reutiliza el deliverable ya almacenado para este job si existe Y su
 * checksum coincide con los bytes realmente guardados (ajuste obligatorio
 * del plan aprobado, Requisito 4/5) -- nunca regenera solo porque se pidió
 * un reintento de correo. Si el archivo no existe o el checksum no
 * coincide, devuelve null (el llamador regenera desde cero).
 */
async function findReusableDeliverable(jobId) {
  const result = await query(
    `select * from ${DELIVERABLES_TABLE} where delivery_job_id = $1 order by created_at desc limit 1`,
    [jobId],
  );
  const deliverable = result.rows[0];
  if (!deliverable) return null;
  if (!deliverable.storage_key) return null;

  const storage = resolveStorageAdapter();
  const stored = await storage.get(deliverable.storage_key.replace(/^(pg|local):/, ''));
  if (!stored || !Buffer.isBuffer(stored.bytes)) return null;

  const actualChecksum = sha256Hex(stored.bytes);
  if (actualChecksum !== deliverable.content_hash) return null;

  return { deliverable, bytes: stored.bytes };
}

/**
 * Genera el PDF, lo persiste (metadatos + bytes) y devuelve el deliverable
 * + bytes. Nunca confía en datos del cliente -- canonicalPredioId/packageId
 * vienen exclusivamente de `order` (fila real de catastrox_payment_orders).
 *
 * ESTADO: `predioData` (devuelto por resolvePredioDataForDelivery) nunca
 * incluye `boundaryAnnotations` -- esa capacidad es preparatoria y
 * actualmente no está conectada al flujo real de compras ni entregas. Solo
 * se activa cuando predioData.boundaryAnnotations es suministrado
 * explícitamente (ver server/services/catastrox/pdf/catastroxPdfBoundaryAnnotations.js).
 * Su operación real requiere el sprint CATX-BOUNDARIES-001, incluyendo
 * almacenamiento persistente, servicio administrativo, propagación al
 * delivery job y auditoría de actor.
 */
async function generateAndStoreDeliverable({ job, order }) {
  const predioData = await resolvePredioDataForDelivery(order.canonical_predio_id);
  if (!predioData) {
    throw Object.assign(new Error('No fue posible resolver los datos del predio para generar el PDF.'), {
      code: 'PREDIO_DATA_UNAVAILABLE',
    });
  }

  const buffer = await generateCatastroxPdfBuffer({ predioData, packageId: order.package_id });
  const checksum = sha256Hex(buffer);
  const filename = buildCatastroxDeliverableFilename({
    codigoPredial: order.canonical_predio_id,
    packageId: order.package_id,
    deliverableType: 'pdf',
  });

  // Metadatos primero (para tener deliverable_id antes de escribir bytes).
  // La migracion 009 impone un unico PDF canonico por job; si una fila ya
  // existe, se reutiliza solo si su blob verifica contra content_hash.
  let deliverable;
  try {
    const insertResult = await query(
      `insert into ${DELIVERABLES_TABLE} (delivery_job_id, file_type, content_hash, byte_size, file_name)
       values ($1, 'pdf', $2, $3, $4)
       returning *`,
      [job.id, checksum, buffer.length, filename],
    );
    deliverable = insertResult.rows[0];
  } catch (error) {
    if (!isDuplicateConstraintError(error)) throw error;
    const reusable = await findReusableDeliverable(job.id);
    if (reusable) return reusable;
    throw Object.assign(new Error('Ya existe un entregable PDF para este job, pero no hay un blob valido reutilizable.'), {
      code: 'DELIVERABLE_ALREADY_EXISTS_UNAVAILABLE',
    });
  }

  const storage = resolveStorageAdapter();
  let storageKey;
  try {
    ({ storageKey } = await storage.put(deliverable.id, buffer, { contentType: 'application/pdf' }));
  } catch (error) {
    await query(`delete from ${DELIVERABLES_TABLE} where id = $1 and storage_key is null`, [deliverable.id]);
    throw error;
  }

  const updateResult = await query(
    `update ${DELIVERABLES_TABLE} set storage_key = $2 where id = $1 returning *`,
    [deliverable.id, storageKey],
  );
  deliverable = updateResult.rows[0];

  return { deliverable, bytes: buffer };
}

/**
 * Orquesta el ciclo completo de un job: reutiliza el deliverable si ya
 * existe y es válido; si no, genera y almacena; luego intenta el envío por
 * correo. Idempotente y seguro de llamar repetidamente (reintentos) --
 * nunca duplica el deliverable, nunca reenvía sin necesidad (el llamador
 * HTTP decide si permite el reintento, ver server/routes/catastroxPayments.js).
 *
 * CATX-DELIVERY-OBSERVABILITY-001: cada invocación es UN intento -- se
 * inserta una fila propia en catastrox_delivery_attempts al empezar
 * (attempt_number = job.attempt_count + 1, calculado ANTES de tocar el
 * contador) y se cierra esa misma fila al terminar, éxito o fallo. Nunca
 * se inserta una segunda fila para el mismo intento ni se sobrescribe la
 * de un intento anterior.
 */
export async function processDeliveryJob(jobId) {
  const claim = await claimDeliveryJob(jobId);
  if (!claim.claimed) {
    logDeliveryEvent('claim_skipped', {
      delivery_job_id: jobId,
      attempt_count: claim.job?.attempt_count,
      status: claim.job?.status,
      reason: claim.reason,
    });
    return claim.job;
  }

  const job = claim.job;
  const order = await paymentOrders.findOrderById(job.payment_order_id);
  const attemptNumber = job.attempt_count;
  let attempt;
  try {
    attempt = await startDeliveryAttempt({ deliveryJobId: jobId, attemptNumber });
  } catch (error) {
    if (!isDuplicateConstraintError(error)) {
      return markDeliveryJobFailed(jobId, error.code || 'DELIVERY_ATTEMPT_CREATE_FAILED', {
        errorMessage: error.message,
        stage: 'attempt_create',
        order,
      });
    }
    return markDeliveryJobFailed(jobId, 'DELIVERY_ATTEMPT_CONFLICT', {
      errorMessage: `Ya existe un intento registrado con attempt_number=${attemptNumber} para este job.`,
      stage: 'attempt_claim_conflict',
      order,
    });
  }

  logDeliveryEvent('attempt_started', {
    order_id: order?.id,
    order_token: order?.order_token,
    delivery_job_id: jobId,
    attempt_count: attemptNumber,
    recovered_from_stale: claim.recoveredFromStale || undefined,
  });

  // Requisito 8 del plan aprobado: nunca se envía el PDF antes de que la
  // orden esté APPROVED. Defensa en profundidad -- en la práctica este job
  // solo se crea después de una transición real a APPROVED
  // (triggerPostApprovalWorkflows), pero esta función debe seguir siendo
  // segura si algún día se llama desde otro lugar (p. ej. un reintento
  // manual mucho después).
  if (!order || order.status !== 'APPROVED') {
    return markDeliveryJobFailed(jobId, 'ORDER_NOT_APPROVED', {
      attemptId: attempt.id,
      errorMessage: 'La orden no está en estado APPROVED al momento de procesar el job de entrega.',
      stage: 'order_approval_check',
      order,
    });
  }

  // Declarado fuera del try para que el catch (unhandled_exception) también
  // pueda registrar el deliverable si la falla ocurrió DESPUÉS de generarlo
  // y almacenarlo (p. ej. una excepción durante el envío de correo) --
  // nunca perder ese dato en el historial solo porque el error fue
  // inesperado.
  let deliverable = null;
  try {
    const existing = await findReusableDeliverable(jobId);
    deliverable = existing?.deliverable || null;
    let pdfBytes = existing?.bytes || null;

    if (!deliverable) {
      const generated = await generateAndStoreDeliverable({ job, order });
      deliverable = generated.deliverable;
      pdfBytes = generated.bytes;
    }

    const readyJob = await transitionDeliveryJobToReady({ jobId, attemptNumber });
    if (!readyJob) {
      return markDeliveryJobFailed(jobId, 'DELIVERY_STATE_TRANSITION_CONFLICT', {
        attemptId: attempt.id,
        errorMessage: 'No fue posible mover el job reclamado de GENERATING a READY.',
        stage: 'ready_transition',
        order,
        deliverable,
      });
    }

    if (!pdfBytes) {
      // Solo alcanzable si el deliverable existía en la fila pero sus
      // bytes ya no verifican contra content_hash (corrupción/borrado
      // externo del blob) -- nunca se envía un archivo no verificado.
      return markDeliveryJobFailed(jobId, 'DELIVERABLE_CHECKSUM_MISMATCH', {
        attemptId: attempt.id,
        errorMessage: 'El deliverable existente no superó la verificación de checksum al releer el blob almacenado.',
        stage: 'reuse_checksum_verification',
        order,
        deliverable,
      });
    }

    // CATX-DELIVERY-OBSERVABILITY-001 (requisito 2): re-verificación
    // explícita, justo antes de enviar, de que los bytes que se van a
    // adjuntar coinciden exactamente con el checksum ya persistido para
    // este deliverable -- defensa en profundidad adicional a la que ya
    // hace findReusableDeliverable() al releer del storage. Si no
    // coincide, se aborta con un error controlado; NUNCA se envía un PDF
    // sin esta verificación.
    const preSendChecksum = sha256Hex(pdfBytes);
    if (preSendChecksum !== deliverable.content_hash) {
      return markDeliveryJobFailed(jobId, 'DELIVERABLE_CHECKSUM_MISMATCH', {
        attemptId: attempt.id,
        errorMessage: `El checksum de pdfBytes (${preSendChecksum}) no coincide con deliverable.content_hash (${deliverable.content_hash}) justo antes de enviar el correo.`,
        stage: 'pre_send_checksum_verification',
        order,
        deliverable,
      });
    }

    // --- Envío por correo ---
    const sendingJob = await claimEmailSending({ jobId, attemptNumber });
    if (!sendingJob) {
      const currentResult = await query(`select * from ${DELIVERY_JOBS_TABLE} where id = $1`, [jobId]);
      const currentJob = currentResult.rows[0] || null;
      if (currentJob?.status === 'SENT' || currentJob?.status === 'DELIVERED') return currentJob;
      return markDeliveryJobFailed(jobId, 'EMAIL_SEND_CLAIM_CONFLICT', {
        attemptId: attempt.id,
        errorMessage: 'Otra transición cambió el estado antes de reclamar SENDING; no se envía correo.',
        stage: 'email_send_claim',
        order,
        deliverable,
      });
    }

    const customerRow = job.customer_id ? await customers.findCustomerById(job.customer_id) : null;
    const decryptedCustomer = customers.decryptCustomerPii(customerRow);
    const recipientEmail = decryptedCustomer?.email || decryptPii(job.delivery_email_encrypted);

    if (!recipientEmail) {
      return markDeliveryJobFailed(jobId, 'DELIVERY_EMAIL_UNAVAILABLE', {
        attemptId: attempt.id,
        errorMessage: 'No hay un correo de entrega disponible (ni en el cliente ni en el job) para enviar el PDF.',
        stage: 'recipient_resolution',
        order,
        deliverable,
      });
    }

    const emailResult = await sendDeliverableEmail({
      to: recipientEmail,
      customerName: resolveCustomerDisplayName(decryptedCustomer),
      orderReference: order.order_token,
      packageLabel: resolvePackageLabel(order.package_id),
      predioLabel: order.canonical_predio_id,
      pdfBuffer: pdfBytes,
      pdfFilename: deliverable.file_name,
      idempotencyKey: `catastrox-deliverable-${job.id}`,
    });

    if (!emailResult.delivered) {
      return markDeliveryJobFailed(jobId, emailResult.errorCode || 'EMAIL_DELIVERY_FAILED', {
        attemptId: attempt.id,
        errorMessage: 'sendDeliverableEmail no confirmó la entrega (delivered=false).',
        stage: 'email_send',
        order,
        deliverable,
      });
    }

    const sentJob = await markDeliveryJobSent({
      jobId,
      attemptNumber,
      providerMessageId: emailResult.providerMessageId,
    });
    if (!sentJob) {
      await completeDeliveryAttempt(attempt.id, {
        status: 'FAILED',
        errorCode: 'EMAIL_SENT_STATE_CONFLICT',
        errorMessage: 'El proveedor aceptó el correo, pero no fue posible cerrar SENDING -> SENT de forma condicional.',
        deliverableId: deliverable.id,
        providerMessageId: emailResult.providerMessageId,
        byteSize: deliverable.byte_size,
        contentHash: deliverable.content_hash,
      });
      logDeliveryEvent('sent_transition', {
        order_id: order.id,
        order_token: order.order_token,
        delivery_job_id: jobId,
        deliverable_id: deliverable.id,
        attempt_count: attemptNumber,
        error_code: 'EMAIL_SENT_STATE_CONFLICT',
        error_message: 'El proveedor aceptó el correo, pero no fue posible cerrar SENDING -> SENT de forma condicional.',
      });
      const currentResult = await query(`select * from ${DELIVERY_JOBS_TABLE} where id = $1`, [jobId]);
      return currentResult.rows[0] || null;
    }

    await completeDeliveryAttempt(attempt.id, {
      status: 'SENT',
      deliverableId: deliverable.id,
      providerMessageId: emailResult.providerMessageId,
      byteSize: deliverable.byte_size,
      contentHash: deliverable.content_hash,
    });

    logDeliveryEvent('attempt_sent', {
      order_id: order.id,
      order_token: order.order_token,
      delivery_job_id: jobId,
      deliverable_id: deliverable.id,
      attempt_count: sentJob?.attempt_count,
      byte_size: deliverable.byte_size,
      checksum: deliverable.content_hash,
      provider_message_id: emailResult.providerMessageId,
    });

    return sentJob;
  } catch (error) {
    return markDeliveryJobFailed(jobId, error.code || GENERATION_NOT_IMPLEMENTED_ERROR_CODE, {
      attemptId: attempt.id,
      errorMessage: error.message,
      stage: 'unhandled_exception',
      order,
      deliverable,
    });
  }
}

/**
 * Reintento explícito (POST /orders/:orderToken/delivery/retry) -- el
 * llamador HTTP ya validó ownership y que el job esté FAILED (409 si no);
 * esta función es la única responsable de la lógica de reintento en sí,
 * reutilizable también desde pruebas sin pasar por HTTP.
 */
export async function retryDeliveryJob(jobId) {
  const job = await processDeliveryJob(jobId);
  if (!job) {
    throw Object.assign(new Error('Job de entrega no encontrado.'), { code: 'DELIVERY_JOB_NOT_FOUND' });
  }
  return job;
}

export async function findDeliveryJobsForOrder(orderId) {
  const result = await query(`select * from ${DELIVERY_JOBS_TABLE} where payment_order_id = $1 order by created_at desc`, [
    orderId,
  ]);
  return result.rows;
}

export async function findLatestDeliveryJobForOrder(orderId) {
  const result = await query(
    `select * from ${DELIVERY_JOBS_TABLE} where payment_order_id = $1 order by created_at desc limit 1`,
    [orderId],
  );
  return result.rows[0] || null;
}

export async function listDeliverablesForJob(jobId) {
  const result = await query(`select * from ${DELIVERABLES_TABLE} where delivery_job_id = $1`, [jobId]);
  return result.rows;
}

// CATX-DELIVERY-OBSERVABILITY-001: re-exportado para que llamadores (rutas,
// pruebas) puedan inspeccionar el historial completo de intentos sin
// importar deliveryAttemptRepository.js directamente -- mismo patrón que
// listDeliverablesForJob arriba.
export { listAttemptsForJob };

/**
 * Recupera los bytes del entregable más reciente de una orden, con el
 * checksum RE-VERIFICADO en este mismo momento (Requisito 5 del plan
 * aprobado: "el checksum debe... verificarse nuevamente al descargarlo") --
 * nunca sirve bytes sin confirmar que coinciden con content_hash. Usado
 * exclusivamente por el endpoint de descarga
 * (server/routes/catastroxPayments.js), que ya validó ownership por
 * sesión+orden antes de llamar aquí -- esta función nunca acepta ni
 * necesita ningún identificador que no sea el orderId ya autorizado.
 */
export async function fetchVerifiedDeliverableForOrder(orderId) {
  const jobResult = await query(
    `select id from ${DELIVERY_JOBS_TABLE} where payment_order_id = $1 order by created_at desc limit 1`,
    [orderId],
  );
  const job = jobResult.rows[0];
  if (!job) return null;

  const reusable = await findReusableDeliverable(job.id);
  if (!reusable) return null;

  return {
    bytes: reusable.bytes,
    filename: reusable.deliverable.file_name,
    contentType: 'application/pdf',
  };
}
