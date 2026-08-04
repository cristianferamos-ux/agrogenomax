// Acceso a datos del sistema de órdenes de pago de CatastroX. Vive en la
// base `agx` (DATABASE_URL, server/db.js) -- decisión explícita: es la base
// transaccional con migraciones administradas (supabase/migrations/001...),
// separada de la base PostGIS de predios (CATASTROX_DATABASE_URL), que no
// tiene migraciones propias y es un almacén geoespacial, no transaccional.
//
// Toda función acepta un `client` opcional (conexión pg ya abierta, típico
// dentro de withCheckoutLock/withWebhookTransaction) -- si no se pasa, usa
// el pool compartido vía query(). Esto permite que el checkout y el webhook
// corran bajo una única transacción sin que cada función tenga que saber
// si está "dentro" o "fuera" de una transacción.
//
// canonical_predio_id sigue siendo la identidad del PREDIO, pero ya NO es
// llave de entitlement (Bloque 1/6/7 de esta fase: la política comercial
// permite N órdenes APPROVED para el mismo predio+paquete). La unidad
// comercial es payment_order_id; la posesión la resuelve
// recoverySessionRepository.js (sesión de recuperación multiorden), no
// ninguna función de este archivo. Las columnas recovery_token_* de la
// fase anterior quedan presentes en la tabla (migración 003, aditiva) pero
// DEPRECADAS -- este archivo ya no las lee ni las escribe.

import crypto from 'crypto';
import { getDbPool, query } from '../../db.js';
import { encryptPii, hashEmail } from './piiCrypto.js';

const TABLE = 'public.catastrox_payment_orders';
const BILLING_PROFILES_TABLE = 'public.catastrox_billing_profiles';
const WEBHOOK_EVENTS_TABLE = 'public.catastrox_payment_webhook_events';

async function run(client, text, params) {
  if (client) return client.query(text, params);
  return query(text, params);
}

export function generateOrderToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function findOrderByReference(wompiReference, client = null) {
  if (!wompiReference) return null;
  const result = await run(client, `select * from ${TABLE} where wompi_reference = $1`, [wompiReference]);
  return result.rows[0] || null;
}

export async function findOrderByToken(orderToken, client = null) {
  if (!orderToken) return null;
  const result = await run(client, `select * from ${TABLE} where order_token = $1`, [orderToken]);
  return result.rows[0] || null;
}

// CATX-DELIVERY-001: deliveryJobService.js recibe orderId (uuid interno),
// nunca order_token (público) -- el job de entrega se crea a partir de
// order.id (server/routes/catastroxPayments.js, triggerPostApprovalWorkflows).
export async function findOrderById(orderId, client = null) {
  if (!orderId) return null;
  const result = await run(client, `select * from ${TABLE} where id = $1`, [orderId]);
  return result.rows[0] || null;
}

export async function insertPendingOrder(
  {
    orderToken,
    packageId,
    canonicalPredioId,
    codigoPredialNormalized,
    customerId,
    idempotencyKey,
    routeIdOriginal = null,
    purchaseKeyOriginal = null,
    wompiReference,
    expectedAmountInCents,
    currency,
    clientIpHash = null,
    userAgentHash = null,
    expiresAt = null,
  },
  client = null,
) {
  const result = await run(
    client,
    `insert into ${TABLE}
       (order_token, package_id, canonical_predio_id, codigo_predial_normalized, customer_id,
        idempotency_key, route_id_original, purchase_key_original, wompi_reference,
        expected_amount_in_cents, currency, status, client_ip_hash, user_agent_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', $12, $13, $14)
     returning *`,
    [
      orderToken,
      packageId,
      canonicalPredioId,
      codigoPredialNormalized,
      customerId,
      idempotencyKey,
      routeIdOriginal,
      purchaseKeyOriginal,
      wompiReference,
      expectedAmountInCents,
      currency,
      clientIpHash,
      userAgentHash,
      expiresAt,
    ],
  );
  return result.rows[0];
}

/**
 * Idempotencia de doble clic (Bloque 6): busca una orden CREATED/PENDING
 * con esta idempotency_key exacta (comprador+predio+paquete+ventana
 * temporal corta, construida por el llamador). NUNCA busca por
 * predio+paquete solos -- eso sería reintroducir el "derecho global" que
 * esta fase elimina. Sin relación con `findOrderByReference` (esa es la
 * verificación real contra Wompi, esta es solo para no crear una segunda
 * orden por un reintento técnico inmediato).
 */
export async function findOrderByIdempotencyKey(idempotencyKey, client = null) {
  if (!idempotencyKey) return null;
  const result = await run(
    client,
    `select * from ${TABLE} where idempotency_key = $1 and status in ('CREATED', 'PENDING')`,
    [idempotencyKey],
  );
  return result.rows[0] || null;
}

/**
 * Instantánea de facturación de una orden (Bloque 3) -- 1:1, nunca se
 * actualiza después de creada (si el comprador corrige un dato, es una
 * compra nueva con su propia instantánea, no una edición retroactiva de
 * una factura ya emitida/en curso).
 *
 * PII endurecida (revisión de seguridad): billingName/billingEmail/city/
 * department llegan en claro desde el llamador (ya descifrados de
 * customerRepository.decryptCustomerPii() en el momento de la compra) y se
 * cifran aquí mismo antes de insertar -- esta función nunca escribe esas
 * columnas en texto plano (billing_name/billing_email/city/department
 * quedan NULL en filas nuevas; ver migración 005).
 */
export async function createBillingProfile(
  {
    paymentOrderId,
    customerType,
    billingName,
    documentType,
    documentNumberEncrypted,
    documentNumberHash,
    billingEmail,
    phoneEncrypted = null,
    addressEncrypted = null,
    city = null,
    department = null,
    countryCode,
  },
  client = null,
) {
  const billingNameEncrypted = encryptPii(billingName);
  const billingEmailEncrypted = encryptPii(billingEmail);
  // hashEmail() normaliza internamente y aplica el dominio
  // "catastrox:email:v1:" -- nunca hashPii() genérico para un correo.
  const billingEmailHash = hashEmail(billingEmail);
  const cityEncrypted = encryptPii(city);
  const departmentEncrypted = encryptPii(department);

  const result = await run(
    client,
    `insert into ${BILLING_PROFILES_TABLE}
       (payment_order_id, customer_type, billing_name_encrypted, document_type, document_number_encrypted,
        document_number_hash, billing_email_encrypted, billing_email_hash, phone_encrypted, address_encrypted,
        city_encrypted, department_encrypted, country_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      paymentOrderId,
      customerType,
      billingNameEncrypted,
      documentType,
      documentNumberEncrypted,
      documentNumberHash,
      billingEmailEncrypted,
      billingEmailHash,
      phoneEncrypted,
      addressEncrypted,
      cityEncrypted,
      departmentEncrypted,
      countryCode,
    ],
  );
  return result.rows[0];
}

export class OrderConflictError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OrderConflictError';
    this.code = code;
  }
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Transición atómica de estado. `WHERE id = $1 AND status = ANY(currentStatuses)`
 * hace que la propia sentencia SQL sea la guarda de concurrencia: si dos
 * verificaciones (retorno del navegador + webhook) llegan casi al mismo
 * tiempo, solo una de las dos sentencias UPDATE afecta una fila -- la
 * segunda devuelve 0 filas (no un error), y el llamador debe releer la
 * orden y tratarlo como ya resuelto (decideVerificationOutcome ya contempla
 * el caso ALREADY_APPROVED).
 *
 * La restricción única de wompi_transaction_id (migración 002, vigente sin
 * cambios) es la segunda barrera: si de algún modo dos filas distintas
 * intentaran aprobarse con el mismo transactionId de Wompi, Postgres
 * rechaza el segundo UPDATE con 23505 -- se traduce a OrderConflictError,
 * nunca se deja pasar. (El índice único global de "un solo APPROVED por
 * predio+paquete" de la fase anterior fue retirado en la migración 004 --
 * la política comercial permite N órdenes APPROVED para el mismo
 * predio+paquete.)
 */
export async function applyVerifiedTransaction(
  { orderId, nextStatus, wompiTransactionId, paymentMethodType = null, verificationSource, fromStatuses },
  client = null,
) {
  try {
    const result = await run(
      client,
      `update ${TABLE}
          set status = $2::public.catastrox_payment_order_status,
              wompi_transaction_id = coalesce(wompi_transaction_id, $3),
              payment_method_type = coalesce($4, payment_method_type),
              approved_at = case when $2::text = 'APPROVED' then now() else approved_at end,
              last_verified_at = now(),
              verification_source = $5::text,
              webhook_received_at = case when $5::text = 'webhook' then now() else webhook_received_at end
        where id = $1
          and status = any($6::public.catastrox_payment_order_status[])
        returning *`,
      [orderId, nextStatus, wompiTransactionId, paymentMethodType, verificationSource, fromStatuses],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new OrderConflictError(
        'La transacción o el derecho ya están asociados a otra orden.',
        'ORDER_UNIQUE_CONFLICT',
      );
    }
    throw error;
  }
}

/**
 * Ejecuta `callback(client)` dentro de una transacción con un advisory lock
 * exclusivo, serializado por `idempotencyKey` (comprador+predio+paquete+
 * ventana temporal corta -- nunca por predio+paquete solos, eso sería el
 * "derecho global" que esta fase elimina). Dos solicitudes concurrentes con
 * la MISMA idempotency_key (doble clic real) quedan en fila -- el segundo
 * ve, dentro de su propio lock, la orden ya creada por el primero y la
 * reutiliza en vez de crear una segunda. Compradores distintos (o el mismo
 * comprador en una ventana temporal distinta) nunca comparten lock -- cada
 * uno crea su propia orden libremente.
 */
export async function withCheckoutLock(idempotencyKey, callback) {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`catastrox_checkout:${idempotencyKey}`]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --- Webhook transaccional (Bloque 2) ---------------------------------
//
// Defecto corregido: la implementación anterior insertaba la huella de
// deduplicación (event_fingerprint) ANTES de confirmar que la orden
// realmente transicionó, y el handler devolvía 200 incluso si la
// transición fallaba después -- un fallo a mitad de camino perdía el
// webhook para siempre (Wompi nunca reintentaba un evento que ya
// respondió 200). Ahora dedupe + fetch a Wompi + transición de la orden +
// marcar PROCESSED ocurren en UNA sola transacción: si cualquier paso
// falla, Postgres revierte TODO (incluida la huella de deduplicación), así
// que un reintento posterior del mismo evento parte de cero, no de un
// estado a medias.

/**
 * INSERT ... ON CONFLICT DO UPDATE sobre event_fingerprint -- el propio
 * UPSERT actúa como bloqueo de fila: una segunda entrega concurrente del
 * MISMO evento espera a que esta transacción termine (COMMIT o ROLLBACK)
 * antes de poder leer/escribir la misma fila, lo que serializa entregas
 * duplicadas simultáneas sin necesitar un advisory lock aparte.
 *
 * Si la fila ya tiene status='PROCESSED', el UPSERT dej a sus valores
 * intactos (CASE) -- el llamador debe revisar `processed_at`: si ya viene
 * no-nulo, esta transacción no debe reprocesar nada (replay idempotente).
 */
export async function upsertWebhookEventForProcessing(
  { eventFingerprint, wompiTransactionId = null, wompiReference = null, eventType },
  client,
) {
  const result = await client.query(
    `insert into ${WEBHOOK_EVENTS_TABLE}
       (event_fingerprint, wompi_transaction_id, wompi_reference, event_type, status, attempt_count,
        first_received_at, last_attempt_at)
     values ($1, $2, $3, $4, 'PROCESSING', 1, now(), now())
     on conflict (event_fingerprint) do update set
       status = case
         when ${WEBHOOK_EVENTS_TABLE}.status = 'PROCESSED' then ${WEBHOOK_EVENTS_TABLE}.status
         else 'PROCESSING'
       end,
       attempt_count = case
         when ${WEBHOOK_EVENTS_TABLE}.status = 'PROCESSED' then ${WEBHOOK_EVENTS_TABLE}.attempt_count
         else ${WEBHOOK_EVENTS_TABLE}.attempt_count + 1
       end,
       last_attempt_at = case
         when ${WEBHOOK_EVENTS_TABLE}.status = 'PROCESSED' then ${WEBHOOK_EVENTS_TABLE}.last_attempt_at
         else now()
       end
     returning *`,
    [eventFingerprint, wompiTransactionId, wompiReference, eventType],
  );
  return result.rows[0];
}

export async function markWebhookEventProcessed(eventFingerprint, client) {
  await client.query(
    `update ${WEBHOOK_EVENTS_TABLE} set status = 'PROCESSED', processed_at = now() where event_fingerprint = $1`,
    [eventFingerprint],
  );
}

/**
 * Ejecuta `callback(client)` dentro de una transacción simple (sin
 * advisory lock -- el UPSERT de upsertWebhookEventForProcessing ya
 * serializa por event_fingerprint). COMMIT si `callback` resuelve,
 * ROLLBACK completo (dedupe incluida) si lanza -- ver comentario de
 * sección arriba.
 */
export async function withWebhookTransaction(callback) {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Se llama DESPUÉS de que withWebhookTransaction ya hizo ROLLBACK -- corre
 * en su propia transacción nueva e independiente, precisamente para que
 * sobreviva aunque el intento de procesamiento haya fallado. Dejar
 * constancia de FAILED (con motivo saneado, nunca el mensaje de error
 * completo) es lo que permite que un reintento posterior de Wompi para el
 * mismo evento se acepte como reintento legítimo en vez de quedar huérfano.
 */
export async function recordWebhookFailure({
  eventFingerprint,
  wompiTransactionId = null,
  wompiReference = null,
  eventType,
  errorCode,
}) {
  await query(
    `insert into ${WEBHOOK_EVENTS_TABLE}
       (event_fingerprint, wompi_transaction_id, wompi_reference, event_type, status, attempt_count,
        first_received_at, last_attempt_at, last_error_code)
     values ($1, $2, $3, $4, 'FAILED', 1, now(), now(), $5)
     on conflict (event_fingerprint) do update set
       status = 'FAILED',
       attempt_count = ${WEBHOOK_EVENTS_TABLE}.attempt_count + 1,
       last_attempt_at = now(),
       last_error_code = $5`,
    [eventFingerprint, wompiTransactionId, wompiReference, eventType, errorCode],
  );
}
