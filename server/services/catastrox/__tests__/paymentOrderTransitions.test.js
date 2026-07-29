// Lógica pura de decisión del sistema de órdenes de pago -- sin red, sin DB.
// Cubre los casos de la auditoría (informe Fase 1/10): persistencia
// sobrevive a un routeId nuevo, aislamiento predio↔predio y paquete↔paquete,
// y los estados de Wompi que nunca deben habilitar un derecho.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCheckoutAction,
  decideVerificationOutcome,
  getPackageRank,
  isActiveOrderExpired,
  normalizePackageId,
  packageSatisfies,
} from '../paymentOrderTransitions.js';

function buildOrder(overrides = {}) {
  return {
    id: 'order-1',
    package_id: 'basico',
    codigo_predial_normalized: '181500003000000130054000000000',
    wompi_reference: 'CATX-BASICO-REF-1',
    wompi_transaction_id: null,
    expected_amount_in_cents: 3990000,
    currency: 'COP',
    status: 'PENDING',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildWompiTransaction(overrides = {}) {
  return {
    id: 'txn-1',
    status: 'APPROVED',
    reference: 'CATX-BASICO-REF-1',
    amountInCents: 3990000,
    currency: 'COP',
    ...overrides,
  };
}

test('normalizePackageId acepta alias conocidos y descarta el resto', () => {
  assert.equal(normalizePackageId('BASICO'), 'basico');
  assert.equal(normalizePackageId('premium'), 'profesional');
  assert.equal(normalizePackageId('pro'), 'profesional');
  assert.equal(normalizePackageId('inventado'), 'inventado');
});

test('packageSatisfies: un paquete de rango mayor cubre uno de rango menor, nunca al revés', () => {
  assert.equal(packageSatisfies({ ownedPackageId: 'profesional', requiredPackageId: 'basico' }), true);
  assert.equal(packageSatisfies({ ownedPackageId: 'basico', requiredPackageId: 'profesional' }), false);
  assert.equal(packageSatisfies({ ownedPackageId: 'basico', requiredPackageId: 'basico' }), true);
  assert.equal(getPackageRank('paquete-inexistente'), 0);
});

test('decideCheckoutAction: nuevo routeId no importa -- un APPROVED existente para el predio+paquete es ALREADY_PAID', () => {
  const approvedOrder = buildOrder({ status: 'APPROVED', route_id_original: 'cx-un-uuid-viejo' });
  const decision = decideCheckoutAction({ activeOrder: null, approvedOrder, packageId: 'basico' });
  assert.equal(decision.action, 'ALREADY_PAID');
  assert.equal(decision.order, approvedOrder);
});

test('decideCheckoutAction: APPROVED de rango superior también cubre un paquete inferior solicitado', () => {
  const approvedOrder = buildOrder({ status: 'APPROVED', package_id: 'profesional' });
  const decision = decideCheckoutAction({ activeOrder: null, approvedOrder, packageId: 'basico' });
  assert.equal(decision.action, 'ALREADY_PAID');
});

test('decideCheckoutAction: APPROVED de rango inferior no cubre un paquete superior solicitado', () => {
  const approvedOrder = buildOrder({ status: 'APPROVED', package_id: 'basico' });
  const decision = decideCheckoutAction({ activeOrder: null, approvedOrder, packageId: 'profesional' });
  assert.equal(decision.action, 'CREATE_NEW');
});

test('decideCheckoutAction: una orden PENDING vigente del mismo predio+paquete se reutiliza', () => {
  const activeOrder = buildOrder({ status: 'PENDING' });
  const decision = decideCheckoutAction({ activeOrder, approvedOrder: null, packageId: 'basico' });
  assert.equal(decision.action, 'REUSE_PENDING');
  assert.equal(decision.order, activeOrder);
});

test('decideCheckoutAction: una orden PENDING expirada no se reutiliza -- se crea una nueva', () => {
  const expiredCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const activeOrder = buildOrder({ status: 'PENDING', created_at: expiredCreatedAt });
  const decision = decideCheckoutAction({ activeOrder, approvedOrder: null, packageId: 'basico' });
  assert.equal(decision.action, 'CREATE_NEW');
});

test('decideCheckoutAction: sin órdenes previas -- CREATE_NEW', () => {
  const decision = decideCheckoutAction({ activeOrder: null, approvedOrder: null, packageId: 'basico' });
  assert.equal(decision.action, 'CREATE_NEW');
});

test('isActiveOrderExpired: sin created_at se considera expirada (nunca se reutiliza a ciegas)', () => {
  assert.equal(isActiveOrderExpired({}), true);
});

test('decideVerificationOutcome: reference distinta -- rechazado, aislamiento entre predios/paquetes', () => {
  const order = buildOrder();
  const wompiTransaction = buildWompiTransaction({ reference: 'CATX-OTRA-REF' });
  const decision = decideVerificationOutcome({ order, wompiTransaction });
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'reference_mismatch');
});

test('decideVerificationOutcome: monto distinto -- rechazado', () => {
  const order = buildOrder();
  const wompiTransaction = buildWompiTransaction({ amountInCents: 4990000 });
  const decision = decideVerificationOutcome({ order, wompiTransaction });
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'amount_mismatch');
});

test('decideVerificationOutcome: moneda distinta -- rechazado', () => {
  const order = buildOrder();
  const wompiTransaction = buildWompiTransaction({ currency: 'USD' });
  const decision = decideVerificationOutcome({ order, wompiTransaction });
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'currency_mismatch');
});

test('decideVerificationOutcome: APPROVED con datos coincidentes -- APPROVE', () => {
  const order = buildOrder();
  const wompiTransaction = buildWompiTransaction();
  const decision = decideVerificationOutcome({ order, wompiTransaction });
  assert.equal(decision.outcome, 'APPROVE');
  assert.equal(decision.nextStatus, 'APPROVED');
});

test('decideVerificationOutcome: PENDING/PENDING_VALIDATION no habilitan', () => {
  const order = buildOrder();
  for (const status of ['PENDING', 'PENDING_VALIDATION']) {
    const decision = decideVerificationOutcome({ order, wompiTransaction: buildWompiTransaction({ status }) });
    assert.equal(decision.outcome, 'PENDING');
    assert.equal(decision.nextStatus, 'PENDING');
  }
});

test('decideVerificationOutcome: DECLINED/VOIDED/ERROR/desconocido no habilitan', () => {
  const order = buildOrder();
  const cases = [
    ['DECLINED', 'DECLINED'],
    ['VOIDED', 'VOIDED'],
    ['ALGO_RARO', 'ERROR'],
  ];
  for (const [wompiStatus, expectedNextStatus] of cases) {
    const decision = decideVerificationOutcome({ order, wompiTransaction: buildWompiTransaction({ status: wompiStatus }) });
    assert.equal(decision.outcome, 'DECLINE');
    assert.equal(decision.nextStatus, expectedNextStatus);
  }
});

test('decideVerificationOutcome: verificación repetida de la misma transacción sobre una orden ya APPROVED es idempotente', () => {
  const order = buildOrder({ status: 'APPROVED', wompi_transaction_id: 'txn-1' });
  const decision = decideVerificationOutcome({ order, wompiTransaction: buildWompiTransaction({ id: 'txn-1' }) });
  assert.equal(decision.outcome, 'ALREADY_APPROVED');
});

test('decideVerificationOutcome: otra transacción distinta no puede reaprobar una orden ya APPROVED (anti-fraude)', () => {
  const order = buildOrder({ status: 'APPROVED', wompi_transaction_id: 'txn-1' });
  const decision = decideVerificationOutcome({ order, wompiTransaction: buildWompiTransaction({ id: 'txn-OTRA' }) });
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'order_already_approved_by_other_transaction');
});

test('decideVerificationOutcome: una orden en estado terminal (DECLINED) nunca se reabre', () => {
  const order = buildOrder({ status: 'DECLINED' });
  const decision = decideVerificationOutcome({ order, wompiTransaction: buildWompiTransaction() });
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'order_in_terminal_state');
});

test('decideVerificationOutcome: sin orden -- rechazado (nunca se inventa contexto)', () => {
  const decision = decideVerificationOutcome({ order: null, wompiTransaction: buildWompiTransaction() });
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'order_not_found');
});
