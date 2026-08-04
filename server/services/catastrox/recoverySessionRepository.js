// Sesión de recuperación multiorden (Bloque 7 del pedido) -- reemplaza el
// token por-orden de la fase anterior de este mismo cambio. Una cookie ya
// no representa "el derecho a UNA compra": representa una sesión de
// navegador que puede tener enlazadas N órdenes (N compras, del mismo
// predio o de predios distintos, cada una con su propio comprador).
//
// El valor en claro del token de sesión nunca se persiste -- solo su
// sha256 (256 bits de entropía propios, mismo razonamiento que
// recoveryToken en la fase anterior: un índice único por hash es la
// comparación segura aquí, no hace falta timingSafeEqual sobre un
// resultado de consulta indexada).
import crypto from 'crypto';
import { getDbPool, query } from '../../db.js';

const SESSIONS_TABLE = 'public.catastrox_recovery_sessions';
const SESSION_ORDERS_TABLE = 'public.catastrox_recovery_session_orders';
const ORDERS_TABLE = 'public.catastrox_payment_orders';

const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 días
const PACKAGE_RANK_SQL_CASE = `case po.package_id when 'profesional' then 3 when 'plus' then 2 else 1 end`;

async function run(client, text, params) {
  if (client) return client.query(text, params);
  return query(text, params);
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export async function createRecoverySession(client = null) {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const result = await run(
    client,
    `insert into ${SESSIONS_TABLE} (session_token_hash, expires_at) values ($1, $2) returning *`,
    [tokenHash, expiresAt],
  );

  return { session: result.rows[0], token };
}

export async function findActiveSessionByTokenHash(tokenHash, client = null) {
  if (!tokenHash) return null;
  const result = await run(
    client,
    `select * from ${SESSIONS_TABLE}
      where session_token_hash = $1
        and revoked_at is null
        and expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] || null;
}

export async function touchRecoverySession(sessionId, client = null) {
  await run(client, `update ${SESSIONS_TABLE} set last_seen_at = now() where id = $1`, [sessionId]);
}

/** Revocación explícita (POST /recovery/clear) -- la sesión deja de ser
 * válida para findActiveSessionByTokenHash de inmediato, aunque el cookie
 * físico siga en el navegador de alguien (copiado antes de revocar). */
export async function revokeRecoverySession(sessionId, client = null) {
  const result = await run(
    client,
    `update ${SESSIONS_TABLE} set revoked_at = now() where id = $1 and revoked_at is null returning *`,
    [sessionId],
  );
  return result.rows[0] || null;
}

export async function linkOrderToSession(sessionId, orderId, client = null) {
  await run(
    client,
    `insert into ${SESSION_ORDERS_TABLE} (recovery_session_id, payment_order_id)
     values ($1, $2)
     on conflict (recovery_session_id, payment_order_id) do nothing`,
    [sessionId, orderId],
  );
}

/**
 * ¿Alguna orden enlazada a esta sesión, APPROVED, satisface
 * canonicalPredioId+packageId (por rango, igual que antes)? Esta consulta
 * -- sesión propia + join -- es la única vía de reconocer un pago como
 * propio del solicitante; sustituye por completo el recovery_token_hash
 * por-orden de la fase anterior (columnas deprecadas, no se leen más).
 */
export async function findApprovedOrderForSession({ sessionId, canonicalPredioId }, client = null) {
  const result = await run(
    client,
    `select po.* from ${ORDERS_TABLE} po
       join ${SESSION_ORDERS_TABLE} so on so.payment_order_id = po.id
      where so.recovery_session_id = $1
        and po.canonical_predio_id = $2
        and po.status = 'APPROVED'
      order by ${PACKAGE_RANK_SQL_CASE} desc
      limit 1`,
    [sessionId, canonicalPredioId],
  );
  return result.rows[0] || null;
}

/**
 * ¿La orden identificada por `orderToken` está enlazada a esta sesión Y
 * APPROVED? A diferencia de GET /orders/:orderToken/status (que responde a
 * cualquiera que posea el token, por diseño), esto es el gate real de
 * ownership para descarga/reintento de entrega (CATX-DELIVERY-001) -- el
 * orderToken por sí solo nunca basta, tiene que estar enlazado a ESTA
 * sesión de recuperación.
 */
export async function findApprovedOrderForSessionByToken({ sessionId, orderToken }, client = null) {
  if (!sessionId || !orderToken) return null;
  const result = await run(
    client,
    `select po.* from ${ORDERS_TABLE} po
       join ${SESSION_ORDERS_TABLE} so on so.payment_order_id = po.id
      where so.recovery_session_id = $1
        and po.order_token = $2
        and po.status = 'APPROVED'
      limit 1`,
    [sessionId, orderToken],
  );
  return result.rows[0] || null;
}

/**
 * ¿Esta sesión tiene ALGUNA orden APPROVED, sin importar el predio?
 * Usada exclusivamente para distinguir, en el gate de full-result
 * (server/routes/catastrox.js), "sin ninguna compra aprobada todavía"
 * (403 ENTITLEMENT_REQUIRED) de "sí compró algo, pero un predio distinto
 * al de este lookup" (403 PREDIO_MISMATCH) -- nunca decide acceso por sí
 * sola, solo clasifica el motivo del rechazo.
 */
export async function findAnyApprovedOrderForSession(sessionId, client = null) {
  const result = await run(
    client,
    `select po.* from ${ORDERS_TABLE} po
       join ${SESSION_ORDERS_TABLE} so on so.payment_order_id = po.id
      where so.recovery_session_id = $1
        and po.status = 'APPROVED'
      limit 1`,
    [sessionId],
  );
  return result.rows[0] || null;
}

/**
 * Órdenes CREATED/PENDING de esta sesión para el mismo predio+paquete,
 * usadas por la idempotencia de doble clic (server/routes/catastroxPayments.js)
 * como respaldo cuando no hay idempotency_key coincidente pero sí una
 * orden claramente reciente de la misma sesión.
 */
export async function findActiveOrderForSession({ sessionId, canonicalPredioId, packageId }, client = null) {
  const result = await run(
    client,
    `select po.* from ${ORDERS_TABLE} po
       join ${SESSION_ORDERS_TABLE} so on so.payment_order_id = po.id
      where so.recovery_session_id = $1
        and po.canonical_predio_id = $2
        and po.package_id = $3
        and po.status in ('CREATED', 'PENDING')
      order by po.created_at desc
      limit 1`,
    [sessionId, canonicalPredioId, packageId],
  );
  return result.rows[0] || null;
}

/**
 * Historial multiorden de esta sesión (Bloque 9 del pedido: "Mis compras en
 * este navegador"). Devuelve EXCLUSIVAMENTE campos mínimos/no sensibles --
 * nunca documento, correo, teléfono, dirección, reference completa,
 * transactionId ni ningún dato cifrado (esos viven en catastrox_customers/
 * catastrox_billing_profiles, tablas que esta consulta ni siquiera toca).
 * `delivery_status`/`invoice_status` son el job más reciente por orden
 * (LEFT JOIN LATERAL) -- una orden recién creada (sin job todavía, pago no
 * aprobado) responde null en ambos, que el llamador debe tratar como
 * "sin iniciar", nunca como "entregado"/"facturado".
 */
export async function findOrdersForSession(sessionId, client = null) {
  if (!sessionId) return [];
  const result = await run(
    client,
    `select
        po.order_token,
        po.package_id,
        po.codigo_predial_normalized,
        po.canonical_predio_id,
        po.status as payment_status,
        po.created_at,
        po.approved_at,
        dj.status as delivery_status,
        ij.status as invoice_status
      from ${ORDERS_TABLE} po
      join ${SESSION_ORDERS_TABLE} so on so.payment_order_id = po.id
      left join lateral (
        select status from public.catastrox_delivery_jobs
         where payment_order_id = po.id
         order by created_at desc
         limit 1
      ) dj on true
      left join lateral (
        select status from public.catastrox_invoice_jobs
         where payment_order_id = po.id
         order by created_at desc
         limit 1
      ) ij on true
     where so.recovery_session_id = $1
     order by po.created_at desc`,
    [sessionId],
  );
  return result.rows;
}

/**
 * Ejecuta `callback(client)` dentro de una transacción -- usada al crear
 * una orden nueva junto con su enlace de sesión, para que ambas escrituras
 * sean atómicas (nunca una orden sin enlazar por un fallo a mitad de
 * camino).
 */
export async function withRecoverySessionTransaction(callback) {
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
