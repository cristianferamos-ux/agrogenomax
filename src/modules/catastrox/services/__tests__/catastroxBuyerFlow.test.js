// Pruebas de la integración frontend de comprador/OTP/checkout (fase
// actual del pedido): contratos de red exactos (createCustomer,
// verifyCustomerEmail, getMyOrders, requestCheckoutSession), la exigencia
// de identityCapability antes de intentar /checkout (R3/B6-26-ADJ-01,
// customerId ya NO es una credencial válida ni siquiera aportable por este
// cliente), la lista cerrada de campos enviados al backend, ausencia de PII
// en localStorage, y las utilidades puras de enmascarado/estado honesto.
// Fixtures exclusivamente sintéticos; fetch siempre se simula, nunca se
// contacta un backend real.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let paymentService;
let piiMasking;
let statusCopy;
let localStorageMap;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    keys: () => [...values.keys()],
    size: () => values.size,
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

before(async () => {
  vite = await createServer({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  paymentService = await vite.ssrLoadModule('/src/modules/catastrox/services/catastroxPaymentService.js');
  piiMasking = await vite.ssrLoadModule('/src/modules/catastrox/utils/piiMasking.js');
  statusCopy = await vite.ssrLoadModule('/src/modules/catastrox/utils/catastroxOrderStatusCopy.js');
});

beforeEach(() => {
  localStorageMap = createStorage();
  globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: localStorageMap,
  };
  globalThis.fetch = originalFetch;
  console.info = () => {};
  console.error = () => {};
});

after(async () => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  console.info = originalConsoleInfo;
  console.error = originalConsoleError;
  await vite?.close();
});

test('createCustomer) POST a /customers con credentials:include, devuelve verificationHandle (nunca customerId) + devOtpCode tal cual el backend', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return jsonResponse({ ok: true, verificationHandle: 'vh-opaque-1', emailVerificationRequired: true, devOtpCode: '123456' });
  };

  const result = await paymentService.createCustomer({ customerType: 'natural', email: 'a@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.verificationHandle, 'vh-opaque-1');
  assert.equal('customerId' in result, false, 'el cliente nunca debe exponer customerId, ni siquiera si el backend lo enviara');
  assert.equal(result.devOtpCode, '123456');
  assert.match(requestedUrl, /\/catastrox\/payments\/customers$/);
  assert.equal(requestedOptions.credentials, 'include');
  assert.equal(requestedOptions.method, 'POST');
});

test('createCustomer) nunca fabrica devOtpCode si el backend no lo envía (producción)', async () => {
  globalThis.fetch = async () => jsonResponse({ ok: true, verificationHandle: 'vh-opaque-2', emailVerificationRequired: true });

  const result = await paymentService.createCustomer({ customerType: 'natural' });
  assert.equal(result.devOtpCode, null);
});

test('createCustomer) error del backend -> ok:false con el code/message del backend, sin lanzar', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ ok: false, code: 'INVALID_EMAIL', message: 'El correo electrónico no tiene un formato válido.' }, { status: 400 });

  const result = await paymentService.createCustomer({ customerType: 'natural' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_EMAIL');
});

test('verifyCustomerEmail) POST a /customers/verify-email (sin path param) con credentials:include, verificationHandle+código viajan solo en el body, y devuelve identityCapability', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return jsonResponse({ ok: true, verified: true, identityCapability: 'ic-opaque-1' });
  };

  const result = await paymentService.verifyCustomerEmail({ verificationHandle: 'vh-opaque-1', code: '654321' });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.identityCapability, 'ic-opaque-1');
  assert.match(requestedUrl, /\/customers\/verify-email$/);
  assert.equal(requestedOptions.credentials, 'include');
  const sentBody = JSON.parse(requestedOptions.body);
  assert.equal(sentBody.code, '654321');
  assert.equal(sentBody.verificationHandle, 'vh-opaque-1');
  assert.equal('customerId' in sentBody, false, 'el body nunca debe aportar customerId (R3/B6-26-ADJ-01)');
});

test('verifyCustomerEmail) código incorrecto -> ok:false con el code del backend (CODE_MISMATCH)', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ ok: false, code: 'CODE_MISMATCH', message: 'El código no es válido o ya expiró.' }, { status: 400 });

  const result = await paymentService.verifyCustomerEmail({ verificationHandle: 'vh-opaque-1', code: '000000' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CODE_MISMATCH');
});

test('verifyCustomerEmail) sin verificationHandle o sin code -> no llama a la red', async () => {
  globalThis.fetch = async () => {
    throw new Error('No debe llamarse a la red sin verificationHandle/code.');
  };

  const result = await paymentService.verifyCustomerEmail({ verificationHandle: '', code: '123456' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_VERIFICATION_REQUEST');
});

test('getMyOrders) GET a /orders/mine con credentials:include, devuelve el arreglo tal cual', async () => {
  let requestedOptions = null;
  globalThis.fetch = async (url, options) => {
    requestedOptions = options;
    return jsonResponse({ ok: true, orders: [{ orderToken: 'tok-1', packageId: 'basico' }] });
  };

  const result = await paymentService.getMyOrders();
  assert.equal(result.ok, true);
  assert.equal(result.orders.length, 1);
  assert.equal(requestedOptions.credentials, 'include');
});

test('14) startPackageCheckout SIN identityCapability nunca llama a la red -- identityCapability solo existe después de verificar correo (R3/B6-26-ADJ-01)', async () => {
  globalThis.fetch = async (url) => {
    throw new Error(`No debe llamarse a la red sin identityCapability: ${url}`);
  };

  const lookup = { routeId: 'real-buyerflow-1', predio: { id: 'real-buyerflow-1', codigoPredial: '999990000000000000000000000001' } };
  const result = await paymentService.startPackageCheckout({ packageId: 'basico', lookup });
  assert.equal(result.status, 'error');
});

test('startPackageCheckout SIN purchaseAttemptId tampoco llama a la red (protección de doble clic exige un intento identificado)', async () => {
  globalThis.fetch = async (url) => {
    throw new Error(`No debe llamarse a la red sin purchaseAttemptId: ${url}`);
  };

  const lookup = { routeId: 'real-buyerflow-1b', predio: { id: 'real-buyerflow-1b', codigoPredial: '999990000000000000000000000009' } };
  const result = await paymentService.startPackageCheckout({ packageId: 'basico', lookup, identityCapability: 'ic-opaque-1' });
  assert.equal(result.status, 'error');
});

test('6/18) el body de /checkout contiene EXCLUSIVAMENTE la lista cerrada de campos -- nunca customerId, precio/monto/moneda/reference/estado/email/documento', async () => {
  let requestedBody = null;
  let requestedCredentials = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/checkout')) {
      requestedBody = JSON.parse(options.body);
      requestedCredentials = options.credentials;
      return jsonResponse({
        ok: true,
        checkout: {
          status: 'CREATED',
          publicKey: 'pub_test_x',
          amountInCents: 3990000,
          currency: 'COP',
          reference: 'CATX-BASICO-TEST',
          signature: { integrity: 'abc' },
          redirectUrl: null,
          packageId: 'basico',
          orderToken: 'tok-checkout-1',
        },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const lookup = {
    routeId: 'real-buyerflow-2',
    predio: { id: 'real-buyerflow-2', codigoPredial: '999990000000000000000000000002', canonicalPredioId: 'canon-2' },
  };
  // El request de red ya se disparó y se capturó antes de que
  // startPackageCheckout intente abrir el widget de Wompi (fuera del
  // alcance de esta prueba, que solo verifica el contrato del body
  // enviado) -- se ignora cualquier fallo posterior al abrir el widget en
  // este entorno sin DOM real.
  await paymentService
    .startPackageCheckout({
      packageId: 'basico',
      lookup,
      identityCapability: 'ic-checkout-1',
      purchaseAttemptId: '33333333-3333-4333-8333-333333333333',
    })
    .catch(() => {});

  const allowedKeys = new Set([
    'packageId',
    'identityCapability',
    'canonicalPredioId',
    'codigoPredial',
    'routeId',
    'purchaseKey',
    'purchaseAttemptId',
  ]);
  for (const key of Object.keys(requestedBody)) {
    assert.ok(allowedKeys.has(key), `campo no permitido en el body de /checkout: ${key}`);
  }
  assert.equal(requestedBody.identityCapability, 'ic-checkout-1');
  assert.equal(requestedBody.purchaseAttemptId, '33333333-3333-4333-8333-333333333333');
  assert.equal('customerId' in requestedBody, false, 'R3/B6-26-ADJ-01: customerId nunca debe viajar en el body de /checkout');
  assert.equal('amountInCents' in requestedBody, false);
  assert.equal('currency' in requestedBody, false);
  assert.equal('reference' in requestedBody, false);
  assert.equal('status' in requestedBody, false);
  assert.equal('email' in requestedBody, false);
  assert.equal('documentNumber' in requestedBody, false);
  assert.equal(requestedCredentials, 'include');
});

test('22) createCustomer/verifyCustomerEmail nunca escriben en localStorage', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/verify-email')) return jsonResponse({ ok: true, verified: true, identityCapability: 'ic-storage-1' });
    return jsonResponse({ ok: true, verificationHandle: 'vh-storage', emailVerificationRequired: true, devOtpCode: '111111' });
  };

  await paymentService.createCustomer({
    customerType: 'natural',
    email: 'storage-test@example.com',
    documentNumber: '1234567890',
  });
  await paymentService.verifyCustomerEmail({ verificationHandle: 'vh-storage', code: '111111' });

  assert.equal(localStorageMap.size(), 0, 'ningún dato de comprador/OTP/identityCapability debe persistirse en localStorage');
});

test('23/24) maskDocumentNumber/maskEmail nunca exponen el valor completo', () => {
  assert.equal(piiMasking.maskDocumentNumber('1032456789'), '******6789');
  assert.equal(piiMasking.maskDocumentNumber('123'), '***');
  assert.equal(piiMasking.maskEmail('ana.gomez@example.com'), 'an******@example.com');
  assert.equal(piiMasking.maskEmail(''), '');

  // Ninguna de las dos funciones puede devolver el valor de entrada intacto
  // para una entrada no trivial (el propósito mismo es enmascarar).
  assert.notEqual(piiMasking.maskDocumentNumber('1032456789'), '1032456789');
  assert.notEqual(piiMasking.maskEmail('ana.gomez@example.com'), 'ana.gomez@example.com');
});

test('25) getDeliveryStatusCopy nunca usa lenguaje de "enviado/entregado" para FAILED/QUEUED/GENERATING/NOT_STARTED', () => {
  const dishonestWords = /enviad|entregad/i;
  for (const status of ['FAILED', 'QUEUED', 'GENERATING', 'WAITING_FOR_PAYMENT', 'NOT_STARTED', undefined]) {
    const copy = statusCopy.getDeliveryStatusCopy(status, { paymentApproved: true });
    assert.doesNotMatch(copy.label, dishonestWords, `label de "${status}" no debe sonar a completado`);
    assert.doesNotMatch(copy.message, dishonestWords, `message de "${status}" no debe sonar a completado`);
  }
});

test('26) getInvoiceStatusCopy nunca afirma "emitida" salvo para ISSUED', () => {
  for (const status of ['NOT_REQUESTED', 'PENDING', 'FAILED', 'CANCELLED', undefined]) {
    const copy = statusCopy.getInvoiceStatusCopy(status);
    assert.notEqual(copy.label, 'Factura emitida');
  }
  assert.equal(statusCopy.getInvoiceStatusCopy('ISSUED').label, 'Factura emitida');
});

// CATX-DELIVERY-001: los 4 textos exactos pedidos para las pantallas de
// estado de entrega, mapeados desde los 6 valores reales del enum que usa
// deliveryJobService.js (QUEUED/GENERATING/READY/SENDING/SENT/FAILED).
test('27) getDeliveryStatusCopy: los 4 textos exactos pedidos por estado (PENDING/PROCESSING/SENT/FAILED)', () => {
  assert.equal(statusCopy.getDeliveryStatusCopy('QUEUED').message, 'Estamos preparando tus archivos.');
  for (const status of ['GENERATING', 'READY', 'SENDING']) {
    assert.equal(
      statusCopy.getDeliveryStatusCopy(status).message,
      'Generando tu diagnóstico predial.',
      `estado "${status}" debe colapsar al texto de PROCESSING`,
    );
  }
  assert.equal(
    statusCopy.getDeliveryStatusCopy('SENT').message,
    'Entregable enviado al correo y disponible para descarga.',
  );
  assert.equal(
    statusCopy.getDeliveryStatusCopy('FAILED').message,
    'No fue posible completar el envío. Puedes reintentar o contactar soporte.',
  );
});

test('28) getInvoiceStatusCopy: NOT_REQUESTED usa el texto exacto pedido sobre facturación pendiente de integración', () => {
  assert.equal(
    statusCopy.getInvoiceStatusCopy('NOT_REQUESTED').message,
    'Facturación electrónica pendiente de integración con el operador autorizado.',
  );
  assert.equal(
    statusCopy.getInvoiceStatusCopy(undefined).message,
    'Facturación electrónica pendiente de integración con el operador autorizado.',
  );
});
