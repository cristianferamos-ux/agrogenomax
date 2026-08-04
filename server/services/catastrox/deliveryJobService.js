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
import crypto from 'crypto';
import { query } from '../../db.js';
import { encryptPii, hashEmail, decryptPii } from './piiCrypto.js';
import * as paymentOrders from './paymentOrderRepository.js';
import * as customers from './customerRepository.js';
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

async function markDeliveryJobFailed(jobId, errorCode) {
  const result = await query(
    `update ${DELIVERY_JOBS_TABLE}
        set status = 'FAILED',
            attempt_count = attempt_count + 1,
            last_attempt_at = now(),
            last_error_code = $2,
            next_retry_at = now() + interval '1 hour'
      where id = $1
      returning *`,
    [jobId, errorCode],
  );
  return result.rows[0] || null;
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

  // Metadatos primero (para tener deliverable_id antes de escribir bytes),
  // storage_key se completa después de que storage.put() confirme.
  const insertResult = await query(
    `insert into ${DELIVERABLES_TABLE} (delivery_job_id, file_type, content_hash, byte_size, file_name)
     values ($1, 'pdf', $2, $3, $4)
     returning *`,
    [job.id, checksum, buffer.length, filename],
  );
  let deliverable = insertResult.rows[0];

  const storage = resolveStorageAdapter();
  const { storageKey } = await storage.put(deliverable.id, buffer, { contentType: 'application/pdf' });

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
 */
export async function processDeliveryJob(jobId) {
  const jobResult = await query(`select * from ${DELIVERY_JOBS_TABLE} where id = $1`, [jobId]);
  const job = jobResult.rows[0];
  if (!job) return null;

  // Requisito 8: nunca se envía el PDF antes de que la orden esté APPROVED.
  // Defensa en profundidad -- en la práctica este job solo se crea después
  // de una transición real a APPROVED (triggerPostApprovalWorkflows), pero
  // esta función debe seguir siendo segura si algún día se llama desde
  // otro lugar (p. ej. un reintento manual mucho después).
  const order = await paymentOrders.findOrderById(job.payment_order_id);
  if (!order || order.status !== 'APPROVED') {
    return markDeliveryJobFailed(jobId, 'ORDER_NOT_APPROVED');
  }

  try {
    const existing = await findReusableDeliverable(jobId);
    let deliverable = existing?.deliverable || null;
    let pdfBytes = existing?.bytes || null;

    if (!deliverable) {
      await query(`update ${DELIVERY_JOBS_TABLE} set status = 'GENERATING', started_at = now() where id = $1`, [jobId]);
      const generated = await generateAndStoreDeliverable({ job, order });
      deliverable = generated.deliverable;
      pdfBytes = generated.bytes;
    }

    await query(`update ${DELIVERY_JOBS_TABLE} set status = 'READY', completed_at = now() where id = $1`, [jobId]);

    if (!pdfBytes) {
      // Solo alcanzable si el deliverable existía en la fila pero sus
      // bytes ya no verifican contra content_hash (corrupción/borrado
      // externo del blob) -- nunca se envía un archivo no verificado.
      return markDeliveryJobFailed(jobId, 'DELIVERABLE_CHECKSUM_MISMATCH');
    }

    // --- Envío por correo ---
    await query(`update ${DELIVERY_JOBS_TABLE} set status = 'SENDING' where id = $1`, [jobId]);

    const customerRow = job.customer_id ? await customers.findCustomerById(job.customer_id) : null;
    const decryptedCustomer = customers.decryptCustomerPii(customerRow);
    const recipientEmail = decryptedCustomer?.email || decryptPii(job.delivery_email_encrypted);

    if (!recipientEmail) {
      return markDeliveryJobFailed(jobId, 'DELIVERY_EMAIL_UNAVAILABLE');
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
      return markDeliveryJobFailed(jobId, emailResult.errorCode || 'EMAIL_DELIVERY_FAILED');
    }

    const sentResult = await query(
      `update ${DELIVERY_JOBS_TABLE}
          set status = 'SENT',
              delivered_at = now(),
              attempt_count = attempt_count + 1,
              last_attempt_at = now(),
              last_error_code = null,
              provider_message_id = $2
        where id = $1
        returning *`,
      [jobId, emailResult.providerMessageId],
    );
    return sentResult.rows[0];
  } catch (error) {
    return markDeliveryJobFailed(jobId, error.code || GENERATION_NOT_IMPLEMENTED_ERROR_CODE);
  }
}

/**
 * Reintento explícito (POST /orders/:orderToken/delivery/retry) -- el
 * llamador HTTP ya validó ownership y que el job esté FAILED (409 si no);
 * esta función es la única responsable de la lógica de reintento en sí,
 * reutilizable también desde pruebas sin pasar por HTTP.
 */
export async function retryDeliveryJob(jobId) {
  const jobResult = await query(`select * from ${DELIVERY_JOBS_TABLE} where id = $1`, [jobId]);
  const job = jobResult.rows[0];
  if (!job) {
    throw Object.assign(new Error('Job de entrega no encontrado.'), { code: 'DELIVERY_JOB_NOT_FOUND' });
  }
  if (job.status !== 'FAILED') {
    throw Object.assign(new Error(`No se puede reintentar un job en estado ${job.status}.`), {
      code: 'DELIVERY_NOT_RETRYABLE',
    });
  }
  return processDeliveryJob(jobId);
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
