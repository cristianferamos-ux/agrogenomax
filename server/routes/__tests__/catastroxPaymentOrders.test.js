// Pruebas de integración del sistema de órdenes de pago de CatastroX contra
// una base de datos Postgres real (DATABASE_URL) -- exactamente la misma
// ruta de código que usa el backend real (server/routes/catastroxPayments.js
// montado sobre un servidor HTTP efímero real, no simulado). Se auto-omiten
// (test.skip a nivel de archivo) si no hay una base real alcanzable.
//
// Política comercial vigente (Bloque 1-7 de la última revisión): el mismo
// predio y el mismo paquete pueden comprarse N veces, por compradores
// distintos o el mismo -- cada compra es una orden independiente. Ya NO
// existe ALREADY_PAID global; la única deduplicación es la de doble clic
// (idempotency_key, ventana corta).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const TEST_CODIGO_A = '900000000000000000000000000001';
const TEST_CODIGO_B = '900000000000000000000000000002';

// Corrección de seguridad (checkout sin fallback inseguro): POST /checkout
// ya no acepta canonicalPredioId/codigoPredial del body -- exige un
// routeId que resuelva a un lookup vigente. Estos códigos son sintéticos
// (no existen en la base geográfica real), así que no pueden pasar por un
// POST /lookup real; en su lugar se registra un preview directamente en
// el Map en memoria de catastrox.js vía __rememberLookupPreviewForTests
// (mismo mecanismo que usaría un POST /lookup real, sin SQL). Un solo
// routeId por código, reutilizado por todas las pruebas de este archivo
// que compran ese predio -- un preview no se consume al usarse.
const TEST_ROUTE_ID_A = 'cx-test-route-a';
const TEST_ROUTE_ID_B = 'cx-test-route-b';

let dbAvailable = false;
let getConfig;
let getDbPool;
let query;
let catastroxPaymentsRouter;
let __rememberLookupPreviewForTests;

try {
  ({ getConfig } = await import('../../config/env.js'));
  ({ getDbPool, query } = await import('../../db.js'));
  getConfig();
  const pool = getDbPool();
  await pool.query('select 1');
  const tableCheck = await pool.query("select to_regclass('public.catastrox_customers') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

let rateLimiters = [];

if (dbAvailable) {
  ({ default: catastroxPaymentsRouter } = await import('../catastroxPayments.js'));
  ({ __rememberLookupPreviewForTests } = await import('../catastrox.js'));
  __rememberLookupPreviewForTests(TEST_ROUTE_ID_A, { canonicalPredioId: TEST_CODIGO_A, codigoPredial: TEST_CODIGO_A });
  __rememberLookupPreviewForTests(TEST_ROUTE_ID_B, { canonicalPredioId: TEST_CODIGO_B, codigoPredial: TEST_CODIGO_B });
  const limiterModule = await import('../../middleware/rateLimit.js');
  // Los limitadores son singletons de módulo (mismo store en memoria en
  // todo el proceso de test, ver server/middleware/__tests__/rateLimit.test.js)
  // -- este archivo hace muchas más llamadas de las que cualquier límite
  // real permitiría en 5 minutos. Se resetean antes de cada caso para
  // probar la lógica de negocio, no el rate limiting (que ya tiene su
  // propia suite dedicada).
  rateLimiters = [
    limiterModule.checkoutLimiter,
    limiterModule.customerLimiter,
    limiterModule.emailVerificationLimiter,
    limiterModule.verifyLimiter,
    limiterModule.entitlementLimiter,
    limiterModule.orderStatusLimiter,
  ];
}

function resetRateLimiters() {
  for (const limiter of rateLimiters) {
    for (const candidateKey of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      limiter.resetKey(candidateKey);
    }
  }
}

const originalFetch = globalThis.fetch;

function withWompiFetchMock(handler) {
  globalThis.fetch = async (url, options) => {
    const urlString = String(url);
    if (urlString.includes('sandbox.wompi.co')) {
      return handler(urlString, options);
    }
    return originalFetch(url, options);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// fetch() de Node no mantiene un cookie jar entre llamadas -- se simula el
// comportamiento del navegador extrayendo el valor del Set-Cookie de
// checkout y reenviándolo manualmente como header Cookie en las llamadas
// siguientes, exactamente como haría credentials:'include' en un navegador
// real.
function extractSessionCookiePair(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  const [pair] = setCookie.split(';');
  return pair || null;
}

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/catastrox/payments', catastroxPaymentsRouter);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/api/catastrox/payments`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let customerCounter = 0;

async function createVerifiedTestCustomer(baseUrl, overrides = {}) {
  customerCounter += 1;
  const email = overrides.email || `orders-test-${Date.now()}-${customerCounter}@example.com`;
  const response = await fetch(`${baseUrl}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerType: 'natural',
      firstName: 'Orders',
      lastName: 'Test',
      documentType: 'CC',
      documentNumber: `91${customerCounter}${Date.now()}`.slice(0, 15),
      email,
      emailConfirmation: email,
      phone: '3000000000',
      countryCode: 'CO',
      department: 'Caqueta',
      city: 'Florencia',
      address: 'Direccion de prueba',
      privacyConsentAccepted: true,
      termsAccepted: true,
      deliveryAuthorizationAccepted: true,
      ...overrides,
    }),
  });
  const payload = await response.json();
  await fetch(`${baseUrl}/customers/${payload.customerId}/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: payload.devOtpCode }),
  });
  return payload.customerId;
}

async function cleanupTestOrders() {
  if (!dbAvailable) return;
  const orders = await query('select id, customer_id from public.catastrox_payment_orders where canonical_predio_id = any($1)', [
    [TEST_CODIGO_A, TEST_CODIGO_B],
  ]);
  const orderIds = orders.rows.map((row) => row.id);
  const customerIds = orders.rows.map((row) => row.customer_id).filter(Boolean);

  if (orderIds.length) {
    await query('delete from public.catastrox_delivery_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_invoice_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_recovery_session_orders where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_billing_profiles where payment_order_id = any($1)', [orderIds]);
  }
  await query('delete from public.catastrox_payment_orders where canonical_predio_id = any($1)', [[TEST_CODIGO_A, TEST_CODIGO_B]]);
  if (customerIds.length) {
    await query('delete from public.catastrox_email_verifications where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customer_otp_state where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customers where id = any($1)', [customerIds]);
  }
  await query(
    `delete from public.catastrox_recovery_sessions
      where id not in (select recovery_session_id from public.catastrox_recovery_session_orders)
        and created_at > now() - interval '1 hour'`,
  );
}

test('sistema de órdenes de pago CatastroX (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestOrders();
  });

  await t.test('checkout rechaza un paquete fuera de la lista cerrada (sin necesitar customerId)', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'oro-platino', codigoPredial: TEST_CODIGO_A }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_PACKAGE');
    } finally {
      await app.close();
    }
  });

  // CORRECCIÓN DE SEGURIDAD (sin fallback): antes este caso probaba que un
  // codigoPredial mal formado en el body era rechazado (INVALID_CADASTRAL_CODE)
  // -- ya no aplica, porque el body ya NO es fuente de identidad del predio
  // en ningún caso, formato válido o no. Lo que corresponde probar ahora es
  // que la AUSENCIA de un lookup vigente (routeId) se rechaza primero,
  // incluso con un body por lo demás completo -- sin necesitar customerId,
  // exactamente el mismo espíritu de "defensa en profundidad" del caso
  // original.
  await t.test('checkout sin routeId -> 400 LOOKUP_REQUIRED (defensa en profundidad, sin necesitar customerId)', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', purchaseAttemptId: crypto.randomUUID() }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'LOOKUP_REQUIRED');
    } finally {
      await app.close();
    }
  });

  await t.test('checkout con routeId que nunca existió (lookup inventado) -> 404 LOOKUP_NOT_FOUND', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: 'cx-jamas-existio', purchaseAttemptId: crypto.randomUUID() }),
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'LOOKUP_NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  await t.test('checkout con canonicalPredioId manipulado en el body (distinto al del lookup) -> 403 PREDIO_MISMATCH', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'basico',
          routeId: TEST_ROUTE_ID_A,
          canonicalPredioId: 'valor-inventado-por-el-cliente',
          purchaseAttemptId: crypto.randomUUID(),
        }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'PREDIO_MISMATCH');
    } finally {
      await app.close();
    }
  });

  await t.test('checkout sin customerId -> 400 CUSTOMER_ID_REQUIRED', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, purchaseAttemptId: crypto.randomUUID() }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'CUSTOMER_ID_REQUIRED');
    } finally {
      await app.close();
    }
  });

  await t.test('checkout sin purchaseAttemptId, o con uno mal formado, -> 400 INVALID_PURCHASE_ATTEMPT_ID', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const missing = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', codigoPredial: TEST_CODIGO_A }),
      });
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).code, 'INVALID_PURCHASE_ATTEMPT_ID');

      const malformed = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', codigoPredial: TEST_CODIGO_A, purchaseAttemptId: 'no-es-un-uuid' }),
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).code, 'INVALID_PURCHASE_ATTEMPT_ID');
    } finally {
      await app.close();
    }
  });

  await t.test('checkout con comprador SIN correo verificado -> 403 EMAIL_NOT_VERIFIED', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      customerCounter += 1;
      const email = `unverified-${Date.now()}-${customerCounter}@example.com`;
      const customerResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerType: 'natural',
          firstName: 'Sin',
          lastName: 'Verificar',
          documentType: 'CC',
          documentNumber: `92${customerCounter}${Date.now()}`.slice(0, 15),
          email,
          emailConfirmation: email,
          phone: '3000000000',
          countryCode: 'CO',
          department: 'Caqueta',
          city: 'Florencia',
          address: 'Direccion de prueba',
          privacyConsentAccepted: true,
          termsAccepted: true,
          deliveryAuthorizationAccepted: true,
        }),
      });
      const { customerId } = await customerResponse.json();

      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'EMAIL_NOT_VERIFIED');
    } finally {
      await app.close();
    }
  });

  await t.test('checkout crea una orden CREATED con datos calculados en backend, y emite la cookie de sesión', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      const response = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'basico',
          customerId,
          routeId: TEST_ROUTE_ID_A,
          purchaseAttemptId: crypto.randomUUID(),
        }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.checkout.status, 'CREATED');
      assert.equal(payload.checkout.amountInCents, 3990000);
      assert.equal(payload.checkout.currency, 'COP');
      assert.match(payload.checkout.reference, /^CATX-BASICO-/);
      assert.ok(payload.checkout.orderToken);
      assert.equal(payload.checkout.publicKey, process.env.WOMPI_PUBLIC_KEY_TEST);
      assert.match(response.headers.get('set-cookie') || '', /HttpOnly/);
    } finally {
      await app.close();
    }
  });

  await t.test('doble clic inmediato (mismo comprador+predio+paquete) reutiliza la misma orden PENDING vía idempotencia', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      // Mismo purchaseAttemptId en ambas llamadas -- exactamente lo que el
      // frontend hace en un doble clic real (un solo purchaseAttemptId
      // generado al entrar al resumen, reutilizado mientras el intento
      // sigue en curso).
      const body = JSON.stringify({
        packageId: 'plus',
        routeId: TEST_ROUTE_ID_A,
        customerId,
        purchaseAttemptId: crypto.randomUUID(),
      });

      const first = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const firstPayload = await first.json();

      const second = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const secondPayload = await second.json();

      assert.equal(secondPayload.checkout.status, 'PENDING_REUSE');
      assert.equal(secondPayload.checkout.reference, firstPayload.checkout.reference);
      assert.equal(secondPayload.checkout.orderToken, firstPayload.checkout.orderToken);
    } finally {
      await app.close();
    }
  });

  await t.test(
    'la misma persona, mismo predio+paquete, con purchaseAttemptId DISTINTO (dos intentos explícitos, sin importar cuán seguidos) -> dos órdenes',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      try {
        const customerId = await createVerifiedTestCustomer(app.baseUrl);

        const first = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packageId: 'basico',
            routeId: TEST_ROUTE_ID_A,
            customerId,
            purchaseAttemptId: crypto.randomUUID(),
          }),
        });
        const firstPayload = await first.json();

        // Segundo intento explícito, inmediatamente después (dentro de lo
        // que antes era la ventana de 2 minutos) -- con el diseño anterior
        // esto se habría fusionado con la primera orden; ahora, al tener
        // su propio purchaseAttemptId, crea una orden nueva.
        const second = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packageId: 'basico',
            routeId: TEST_ROUTE_ID_A,
            customerId,
            purchaseAttemptId: crypto.randomUUID(),
          }),
        });
        const secondPayload = await second.json();

        assert.equal(firstPayload.checkout.status, 'CREATED');
        assert.equal(secondPayload.checkout.status, 'CREATED');
        assert.notEqual(secondPayload.checkout.orderToken, firstPayload.checkout.orderToken);
        assert.notEqual(secondPayload.checkout.reference, firstPayload.checkout.reference);
      } finally {
        await app.close();
      }
    },
  );

  await t.test('un comprador DISTINTO con el mismo purchaseAttemptId nunca comparte orden (customerId participa en la llave)', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const sharedAttemptId = crypto.randomUUID();
      const customerA = await createVerifiedTestCustomer(app.baseUrl);
      const customerB = await createVerifiedTestCustomer(app.baseUrl);

      const checkoutA = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId: customerA, purchaseAttemptId: sharedAttemptId }),
      });
      const checkoutB = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId: customerB, purchaseAttemptId: sharedAttemptId }),
      });

      const payloadA = await checkoutA.json();
      const payloadB = await checkoutB.json();
      assert.notEqual(payloadA.checkout.orderToken, payloadB.checkout.orderToken);
    } finally {
      await app.close();
    }
  });

  await t.test(
    'N compras del mismo predio+paquete: dos compradores distintos obtienen dos órdenes independientes, cada una recuperable solo por su propia sesión',
    async () => {
      const app = await startTestApp();
      try {
        const customerA = await createVerifiedTestCustomer(app.baseUrl);
        const customerB = await createVerifiedTestCustomer(app.baseUrl);

        const checkoutA = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packageId: 'basico', customerId: customerA, routeId: TEST_ROUTE_ID_B, purchaseAttemptId: crypto.randomUUID() }),
        });
        const cookieA = extractSessionCookiePair(checkoutA);
        const payloadA = await checkoutA.json();

        const checkoutB = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packageId: 'basico', customerId: customerB, routeId: TEST_ROUTE_ID_B, purchaseAttemptId: crypto.randomUUID() }),
        });
        const cookieB = extractSessionCookiePair(checkoutB);
        const payloadB = await checkoutB.json();

        // Dos órdenes de verdad, no ALREADY_PAID -- referencias y tokens
        // completamente distintos, aunque predio+paquete sean idénticos.
        assert.notEqual(payloadA.checkout.reference, payloadB.checkout.reference);
        assert.notEqual(payloadA.checkout.orderToken, payloadB.checkout.orderToken);
        assert.equal(payloadA.checkout.status, 'CREATED');
        assert.equal(payloadB.checkout.status, 'CREATED');

        // Aprueba ambas transacciones (Sandbox simulado independientemente).
        for (const [ref, txnId] of [[payloadA.checkout.reference, 'txn-n-purchase-a'], [payloadB.checkout.reference, 'txn-n-purchase-b']]) {
          withWompiFetchMock(() =>
            jsonResponse(200, {
              data: { id: txnId, status: 'APPROVED', reference: ref, amount_in_cents: 3990000, currency: 'COP' },
            }),
          );
          try {
            await fetch(`${app.baseUrl}/verify/${txnId}`);
          } finally {
            restoreFetch();
          }
        }

        // La sesión de A ve su propia orden aprobada...
        const entitlementA = await fetch(`${app.baseUrl}/entitlements/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookieA },
          body: JSON.stringify({ codigoPredial: TEST_CODIGO_B, packageId: 'basico' }),
        });
        assert.equal((await entitlementA.json()).isPaid, true);

        // ...y la sesión de B ve la SUYA -- ninguna hereda la del otro
        // comprador, aunque ambas sean del mismo predio+paquete.
        const entitlementB = await fetch(`${app.baseUrl}/entitlements/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookieB },
          body: JSON.stringify({ codigoPredial: TEST_CODIGO_B, packageId: 'basico' }),
        });
        assert.equal((await entitlementB.json()).isPaid, true);

        // Un comprador NUEVO, del mismo predio+paquete, sigue pudiendo
        // comprar -- nunca hay ALREADY_PAID global.
        const customerC = await createVerifiedTestCustomer(app.baseUrl);
        const checkoutC = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packageId: 'basico', customerId: customerC, routeId: TEST_ROUTE_ID_B, purchaseAttemptId: crypto.randomUUID() }),
        });
        const payloadC = await checkoutC.json();
        assert.equal(payloadC.checkout.status, 'CREATED');
        assert.notEqual(payloadC.checkout.reference, payloadA.checkout.reference);
        assert.notEqual(payloadC.checkout.reference, payloadB.checkout.reference);
      } finally {
        await app.close();
      }
    },
  );

  await t.test('entitlement check: sin cookie, cookie falsificada, predio ajeno y rango insuficiente responden todos isPaid:false con la misma forma', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const cookie = extractSessionCookiePair(checkoutResponse);
      const { reference } = (await checkoutResponse.json()).checkout;

      withWompiFetchMock(() =>
        jsonResponse(200, {
          data: { id: 'txn-entitlement-1', status: 'APPROVED', reference, amount_in_cents: 3990000, currency: 'COP' },
        }),
      );
      try {
        await fetch(`${app.baseUrl}/verify/txn-entitlement-1`);
      } finally {
        restoreFetch();
      }

      const noCookie = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_A, packageId: 'basico' }),
      });
      assert.equal(noCookie.status, 200);
      assert.equal((await noCookie.json()).isPaid, false);

      const withCookie = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_A, packageId: 'basico' }),
      });
      const withCookiePayload = await withCookie.json();
      assert.equal(withCookiePayload.isPaid, true);
      assert.equal('orderToken' in withCookiePayload, false);

      const otherPredio = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_B, packageId: 'basico' }),
      });
      assert.equal((await otherPredio.json()).isPaid, false);

      const higherPackage = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_A, packageId: 'profesional' }),
      });
      assert.equal((await higherPackage.json()).isPaid, false);

      const forgedCookie = `catastrox_recovery_session=${crypto.randomBytes(32).toString('base64url')}`;
      const forged = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: forgedCookie },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_A, packageId: 'basico' }),
      });
      assert.equal(forged.status, 200);
      assert.equal((await forged.json()).isPaid, false);
    } finally {
      await app.close();
    }
  });

  await t.test('orders/:orderToken/status: datos mínimos, sin PII ni reference, token inválido -> 404', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const { orderToken } = (await checkoutResponse.json()).checkout;

      const statusResponse = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(orderToken)}/status`);
      const statusPayload = await statusResponse.json();
      assert.equal(statusPayload.order.status, 'PENDING');
      assert.equal('reference' in statusPayload.order, false);
      assert.equal('transactionId' in statusPayload.order, false);
      assert.equal('customerEmail' in statusPayload.order, false);

      const invalidTokenResponse = await fetch(`${app.baseUrl}/orders/token-que-no-existe/status`);
      assert.equal(invalidTokenResponse.status, 404);
    } finally {
      await app.close();
    }
  });

  await t.test('verify rechaza si el monto reportado por Wompi no coincide con la orden', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const { reference } = (await checkoutResponse.json()).checkout;

      withWompiFetchMock(() =>
        jsonResponse(200, {
          data: { id: 'txn-monto-malo', status: 'APPROVED', reference, amount_in_cents: 1, currency: 'COP' },
        }),
      );

      let verifyPayload;
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/verify/txn-monto-malo`);
        verifyPayload = await verifyResponse.json();
      } finally {
        restoreFetch();
      }

      assert.notEqual(verifyPayload.order?.status, 'APPROVED');
    } finally {
      await app.close();
    }
  });

  await t.test('POST /recovery/clear revoca la sesión -- una cookie ya limpiada deja de reconocer el pago', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID_A, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const cookie = extractSessionCookiePair(checkoutResponse);
      const { reference } = (await checkoutResponse.json()).checkout;

      withWompiFetchMock(() =>
        jsonResponse(200, {
          data: { id: 'txn-clear-1', status: 'APPROVED', reference, amount_in_cents: 3990000, currency: 'COP' },
        }),
      );
      try {
        await fetch(`${app.baseUrl}/verify/txn-clear-1`);
      } finally {
        restoreFetch();
      }

      const beforeClear = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_A, packageId: 'basico' }),
      });
      assert.equal((await beforeClear.json()).isPaid, true);

      await fetch(`${app.baseUrl}/recovery/clear`, { method: 'POST', headers: { Cookie: cookie } });

      const afterClear = await fetch(`${app.baseUrl}/entitlements/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ codigoPredial: TEST_CODIGO_A, packageId: 'basico' }),
      });
      assert.equal((await afterClear.json()).isPaid, false, 'la sesión revocada ya no debe reconocer el pago');
    } finally {
      await app.close();
    }
  });
});
