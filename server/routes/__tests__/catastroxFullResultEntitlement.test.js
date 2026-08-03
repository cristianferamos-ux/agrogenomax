// Corrección de la vulnerabilidad crítica confirmada en producción:
// GET /api/catastrox/lookups/:lookupId/full-result devolvía área exacta,
// perímetro exacto y geometría completa con solo tener un lookup_id
// vigente -- sin pago, sin cookie de sesión, sin autenticación. Estas
// pruebas cubren la nueva fuente de verdad server-side (resolveFullResultAccess,
// server/routes/catastrox.js) y la resolución de canonicalPredioId en
// checkout (resolveCheckoutCanonicalPredioId, server/routes/catastroxPayments.js)
// -- ambas unitarias, con dependencias inyectadas, sin base de datos ni
// servidor HTTP real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFullResultAccess } from '../catastrox.js';
import { resolveCheckoutCanonicalPredioId } from '../catastroxPayments.js';

const CANONICAL_PREDIO_ID = '181500002000000300047000000000';
const OTHER_CANONICAL_PREDIO_ID = '180290001000000270015000000000';

function makePreview(overrides = {}) {
  return { canonicalPredioId: CANONICAL_PREDIO_ID, createdAt: Date.now(), ...overrides };
}

function makeDeps(overrides = {}) {
  return {
    getPreview: () => makePreview(),
    getSessionToken: () => 'session-token-abc',
    hashSessionToken: (token) => `hash(${token})`,
    findActiveSessionByTokenHash: async () => ({ id: 'session-1' }),
    findApprovedOrderForSession: async () => null,
    findAnyApprovedOrderForSession: async () => null,
    ...overrides,
  };
}

test('full-result: lookup inexistente/expirado -> 404 LOOKUP_NOT_FOUND', async () => {
  const access = await resolveFullResultAccess({
    lookupId: 'cx-missing',
    cookieHeader: 'catastrox_recovery_session=whatever',
    ...makeDeps({ getPreview: () => null }),
  });
  assert.deepEqual(access, { ok: false, status: 404, code: 'LOOKUP_NOT_FOUND' });
});

test('full-result: preview sin canonicalPredioId asociado -> 404 LOOKUP_NOT_FOUND', async () => {
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=whatever',
    ...makeDeps({ getPreview: () => makePreview({ canonicalPredioId: null }) }),
  });
  assert.equal(access.ok, false);
  assert.equal(access.status, 404);
  assert.equal(access.code, 'LOOKUP_NOT_FOUND');
});

test('full-result: sin cookie de sesión -> 401 SESSION_REQUIRED', async () => {
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: undefined,
    ...makeDeps({ getSessionToken: () => null }),
  });
  assert.deepEqual(access, { ok: false, status: 401, code: 'SESSION_REQUIRED' });
});

test('full-result: cookie presente pero sesión no activa (expirada/revocada) -> 401 SESSION_REQUIRED', async () => {
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=stale-token',
    ...makeDeps({ findActiveSessionByTokenHash: async () => null }),
  });
  assert.deepEqual(access, { ok: false, status: 401, code: 'SESSION_REQUIRED' });
});

test('full-result: sesión válida pero sin ninguna compra -> 403 ENTITLEMENT_REQUIRED', async () => {
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=tok',
    ...makeDeps({
      findApprovedOrderForSession: async () => null,
      findAnyApprovedOrderForSession: async () => null,
    }),
  });
  assert.deepEqual(access, { ok: false, status: 403, code: 'ENTITLEMENT_REQUIRED' });
});

test('full-result: sesión válida con orden PENDIENTE (no APPROVED) para este predio -> 403 ENTITLEMENT_REQUIRED', async () => {
  // findApprovedOrderForSession solo devuelve órdenes status='APPROVED'
  // (ver recoverySessionRepository.js) -- una orden PENDING nunca aparece
  // ahí, así que el resultado es idéntico a "sin ninguna compra" desde el
  // punto de vista de este gate.
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=tok',
    ...makeDeps({
      findApprovedOrderForSession: async () => null,
      findAnyApprovedOrderForSession: async () => null,
    }),
  });
  assert.equal(access.status, 403);
  assert.equal(access.code, 'ENTITLEMENT_REQUIRED');
});

test('full-result: sesión con compra APPROVED de OTRO predio -> 403 PREDIO_MISMATCH', async () => {
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=tok',
    ...makeDeps({
      findApprovedOrderForSession: async () => null, // nada para CANONICAL_PREDIO_ID
      findAnyApprovedOrderForSession: async () => ({
        id: 'order-1',
        canonical_predio_id: OTHER_CANONICAL_PREDIO_ID,
        package_id: 'plus',
        status: 'APPROVED',
      }),
    }),
  });
  assert.deepEqual(access, { ok: false, status: 403, code: 'PREDIO_MISMATCH' });
});

test('full-result: sesión con orden APPROVED del MISMO predio -> 200 (ok:true)', async () => {
  const order = { id: 'order-1', canonical_predio_id: CANONICAL_PREDIO_ID, package_id: 'basico', status: 'APPROVED' };
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=tok',
    ...makeDeps({ findApprovedOrderForSession: async () => order }),
  });
  assert.equal(access.ok, true);
  assert.equal(access.canonicalPredioId, CANONICAL_PREDIO_ID);
  assert.equal(access.order.id, 'order-1');
});

test('full-result: orden APPROVED del mismo predio con paquete "plus" también concede acceso (basico es el mínimo exigido)', async () => {
  const order = { id: 'order-2', canonical_predio_id: CANONICAL_PREDIO_ID, package_id: 'plus', status: 'APPROVED' };
  const access = await resolveFullResultAccess({
    lookupId: 'cx-1',
    cookieHeader: 'catastrox_recovery_session=tok',
    ...makeDeps({ findApprovedOrderForSession: async () => order }),
  });
  assert.equal(access.ok, true);
});

// ---------------------------------------------------------------------
// Checkout: resolución server-side de canonicalPredioId -- SIN FALLBACK.
// resolveCheckoutCanonicalPredioId() ya NO cae hacia body.canonicalPredioId
// ni body.codigoPredial en ningún caso -- eliminado por completo (versión
// anterior de esta corrección todavía lo permitía sin lookup vigente, lo
// que seguía dejando crear una orden para un predio no asociado a una
// consulta real). routeId es OBLIGATORIO y debe resolver a un lookup
// vigente; solo entonces se resuelve canonicalPredioId, siempre desde ahí.
// ---------------------------------------------------------------------

test('checkout: sin routeId en el body -> 400 LOOKUP_REQUIRED (ni siquiera intenta resolver el lookup)', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: '',
    body: { canonicalPredioId: CANONICAL_PREDIO_ID },
    getPreview: () => {
      throw new Error('getPreview no debe llamarse sin routeId');
    },
  });
  assert.deepEqual(result, { ok: false, status: 400, code: 'LOOKUP_REQUIRED' });
});

test('checkout: routeId presente pero solo espacios en blanco -> 400 LOOKUP_REQUIRED', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: '   ',
    body: {},
    getPreview: () => {
      throw new Error('getPreview no debe llamarse con routeId vacío');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'LOOKUP_REQUIRED');
});

test('checkout: lookup expirado (TTL de 30 min vencido, resolveLookupPreview ya lo purgó) -> 404 LOOKUP_NOT_FOUND', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-expired',
    body: {},
    getPreview: () => null, // mismo comportamiento que resolveLookupPreview tras expirar (catastrox.js)
  });
  assert.deepEqual(result, { ok: false, status: 404, code: 'LOOKUP_NOT_FOUND' });
});

test('checkout: lookup inventado (routeId que nunca existió) -> 404 LOOKUP_NOT_FOUND, nunca cae al body', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-nunca-existio',
    body: { canonicalPredioId: CANONICAL_PREDIO_ID }, // aunque el body traiga uno "válido"
    getPreview: () => null,
  });
  assert.deepEqual(result, { ok: false, status: 404, code: 'LOOKUP_NOT_FOUND' });
});

test('checkout: lookup válido pero sin canonicalPredioId asociado (registro corrupto/incompleto) -> 404 LOOKUP_NOT_FOUND', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-sin-canonical',
    body: {},
    getPreview: () => makePreview({ canonicalPredioId: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, 'LOOKUP_NOT_FOUND');
});

test('checkout: predio manipulado -- body.canonicalPredioId distinto al del lookup -> 403 PREDIO_MISMATCH', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-1',
    body: { canonicalPredioId: OTHER_CANONICAL_PREDIO_ID },
    getPreview: () => makePreview({ canonicalPredioId: CANONICAL_PREDIO_ID }),
  });
  assert.deepEqual(result, { ok: false, status: 403, code: 'PREDIO_MISMATCH' });
});

test('checkout válido: usa el canonicalPredioId resuelto por el lookup para crear la orden', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-1',
    body: {},
    getPreview: () => makePreview({ canonicalPredioId: CANONICAL_PREDIO_ID, codigoPredial: '181500...' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.canonicalPredioId, CANONICAL_PREDIO_ID);
  assert.equal(result.codigoPredial, '181500...');
});

test('checkout válido SIN canonicalPredioId en el body -> funciona igual (nunca fue obligatorio del cliente)', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-1',
    body: { packageId: 'basico', customerId: 'cust-1' }, // sin canonicalPredioId ni codigoPredial
    getPreview: () => makePreview({ canonicalPredioId: CANONICAL_PREDIO_ID }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.canonicalPredioId, CANONICAL_PREDIO_ID);
});

test('checkout: body.canonicalPredioId vacío/espacios no cuenta como "manipulado" -- se ignora sin rechazar', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-1',
    body: { canonicalPredioId: '   ' },
    getPreview: () => makePreview({ canonicalPredioId: CANONICAL_PREDIO_ID }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.canonicalPredioId, CANONICAL_PREDIO_ID);
});

test('checkout: body.canonicalPredioId IGUAL al del lookup no se rechaza (coincidencia legítima, no manipulación)', () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-1',
    body: { canonicalPredioId: CANONICAL_PREDIO_ID },
    getPreview: () => makePreview({ canonicalPredioId: CANONICAL_PREDIO_ID }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.canonicalPredioId, CANONICAL_PREDIO_ID);
});

// El precio sigue calculándose ÚNICAMENTE server-side: resolveCheckoutCanonicalPredioId()
// resuelve identidad del predio, nunca precio -- confirma que su resultado
// no expone ningún campo de monto/moneda, y que la tabla de precios real
// (server/services/catastrox/paymentOrderTransitions.js) es una constante
// congelada independiente de esta resolución, nunca leída desde el body.
test('checkout: la resolución de canonicalPredioId nunca toca ni expone precio/monto -- esa tabla es independiente y congelada', async () => {
  const result = resolveCheckoutCanonicalPredioId({
    routeId: 'cx-1',
    body: { amountInCents: 1, currency: 'COP', canonicalPredioId: CANONICAL_PREDIO_ID }, // manipulación de precio, si existiera, iría aquí
    getPreview: () => makePreview({ canonicalPredioId: CANONICAL_PREDIO_ID }),
  });
  assert.equal(result.ok, true);
  assert.equal('amountInCents' in result, false);
  assert.equal('currency' in result, false);

  const { CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS } = await import('../../services/catastrox/paymentOrderTransitions.js');
  assert.equal(Object.isFrozen(CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS), true);
  assert.equal(CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS.basico, 3990000);
});
