// Lógica de negocio pura del sistema de órdenes de pago de CatastroX --
// ninguna función de este módulo toca la red, la base de datos ni
// localStorage. Mismo estilo que evaluateWompiReturn() en
// src/modules/catastrox/services/catastroxPaymentService.js: decisiones
// deterministas, 100% testeables sin infraestructura.
//
// Esta es la única fuente de verdad de "¿está pagado?" a partir de aquí --
// el frontend deja de decidirlo localmente (ver informe de auditoría,
// Fase 1: routeId es efímero y localStorage nunca fue una fuente confiable).

export const CATASTROX_PAYMENT_PACKAGE_IDS = Object.freeze(['basico', 'plus', 'profesional']);

// Duplicado intencional (mismo valor) de src/modules/catastrox/config/catastroxPackages.js
// y del ALLOWED_PACKAGES que ya existía en server/routes/catastroxPayments.js --
// el backend nunca importa configuración de precios desde src/ (frontend);
// ese límite ya existía antes de este cambio, se mantiene.
export const CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS = Object.freeze({
  basico: 3990000,
  plus: 4990000,
  profesional: 5990000,
});

export const CATASTROX_PAYMENT_PACKAGE_RANK = Object.freeze({
  basico: 1,
  plus: 2,
  profesional: 3,
});

export function normalizePackageId(value) {
  const raw = String(value || '').trim().toLowerCase();

  const aliases = {
    basico: 'basico',
    basic: 'basico',
    plus: 'plus',
    profesional: 'profesional',
    professional: 'profesional',
    premium: 'profesional',
    pro: 'profesional',
  };

  return aliases[raw] || raw;
}

export function getPackageRank(packageId) {
  return CATASTROX_PAYMENT_PACKAGE_RANK[packageId] || 0;
}

export function packageSatisfies({ ownedPackageId, requiredPackageId }) {
  return getPackageRank(ownedPackageId) >= getPackageRank(requiredPackageId);
}

// Ventana de reutilización de una orden CREATED/PENDING antes de tratarla
// como abandonada y crear una nueva (mismo valor que PENDING_PAYMENT_MAX_AGE_MS
// ya usado del lado del frontend en catastroxPaymentService.js -- 30 minutos
// es tiempo razonable para completar un checkout Sandbox de Wompi).
export const ACTIVE_ORDER_MAX_AGE_MS = 30 * 60 * 1000;

export function isActiveOrderExpired(order, { nowMs = Date.now() } = {}) {
  if (!order?.created_at) return true;
  const createdAtMs = new Date(order.created_at).getTime();
  if (!Number.isFinite(createdAtMs)) return true;
  return nowMs - createdAtMs > ACTIVE_ORDER_MAX_AGE_MS;
}

/**
 * Decide qué debe hacer POST /checkout dado el estado ya persistido para
 * este predio+paquete -- nunca decide con datos del cliente.
 *
 * @param {{ activeOrder: object|null, approvedOrder: object|null, packageId: string, nowMs?: number }} input
 * @returns {{ action: 'ALREADY_PAID'|'REUSE_PENDING'|'CREATE_NEW', order: object|null }}
 */
export function decideCheckoutAction({ activeOrder, approvedOrder, packageId, nowMs = Date.now() }) {
  if (approvedOrder && packageSatisfies({ ownedPackageId: approvedOrder.package_id, requiredPackageId: packageId })) {
    return { action: 'ALREADY_PAID', order: approvedOrder };
  }

  if (
    activeOrder &&
    activeOrder.package_id === packageId &&
    !isActiveOrderExpired(activeOrder, { nowMs })
  ) {
    return { action: 'REUSE_PENDING', order: activeOrder };
  }

  return { action: 'CREATE_NEW', order: null };
}

function normalizeWompiStatus(rawStatus) {
  return String(rawStatus || '').trim().toUpperCase();
}

/**
 * Decide el resultado de aplicar una transacción de Wompi (ya verificada
 * server-to-server) contra una orden persistida. Nunca confía en
 * `wompiTransaction` que no haya venido de una llamada real a
 * fetchWompiTransaction() -- ni /verify ni el webhook deben invocar esta
 * función con datos crudos del cliente o del body del webhook.
 *
 * @param {{ order: object, wompiTransaction: { id, status, reference, amountInCents, currency } }} input
 * @returns {{ outcome: 'APPROVE'|'PENDING'|'DECLINE'|'REJECTED'|'ALREADY_APPROVED', nextStatus?: string, reason?: string }}
 */
export function decideVerificationOutcome({ order, wompiTransaction }) {
  if (!order) {
    return { outcome: 'REJECTED', reason: 'order_not_found' };
  }

  if (wompiTransaction.reference !== order.wompi_reference) {
    return { outcome: 'REJECTED', reason: 'reference_mismatch' };
  }

  if (Number(wompiTransaction.amountInCents) !== Number(order.expected_amount_in_cents)) {
    return { outcome: 'REJECTED', reason: 'amount_mismatch' };
  }

  if (wompiTransaction.currency !== order.currency) {
    return { outcome: 'REJECTED', reason: 'currency_mismatch' };
  }

  if (order.status === 'APPROVED') {
    // Idempotencia: la orden ya fue aprobada -- por este mismo retorno
    // reprocesado, por el webhook, o por una verificación manual repetida.
    // Solo es un no-op seguro si es exactamente la MISMA transacción de
    // Wompi; si otra transacción distinta intenta "reaprobar" esta orden,
    // es una señal de fraude/reutilización, se rechaza explícitamente.
    if (order.wompi_transaction_id && order.wompi_transaction_id !== wompiTransaction.id) {
      return { outcome: 'REJECTED', reason: 'order_already_approved_by_other_transaction' };
    }
    return { outcome: 'ALREADY_APPROVED', nextStatus: 'APPROVED' };
  }

  if (order.status !== 'CREATED' && order.status !== 'PENDING') {
    // DECLINED/VOIDED/ERROR/EXPIRED son estados terminales -- no vuelven a
    // aprobarse por una verificación posterior, ni siquiera si Wompi ahora
    // reporta APPROVED (evita que un reintento tardío reabra una orden ya
    // cerrada).
    return { outcome: 'REJECTED', reason: 'order_in_terminal_state' };
  }

  const status = normalizeWompiStatus(wompiTransaction.status);

  if (status === 'APPROVED') {
    return { outcome: 'APPROVE', nextStatus: 'APPROVED' };
  }

  if (status === 'PENDING' || status === 'PENDING_VALIDATION') {
    return { outcome: 'PENDING', nextStatus: 'PENDING' };
  }

  if (status === 'DECLINED') {
    return { outcome: 'DECLINE', nextStatus: 'DECLINED' };
  }

  if (status === 'VOIDED') {
    return { outcome: 'DECLINE', nextStatus: 'VOIDED' };
  }

  return { outcome: 'DECLINE', nextStatus: 'ERROR' };
}
