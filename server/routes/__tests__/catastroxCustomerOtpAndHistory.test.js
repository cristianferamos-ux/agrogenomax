// Pruebas de integración (Postgres real, se auto-omiten si no hay base
// alcanzable, mismo patrón que catastroxPaymentOrders.test.js) para la
// integración frontend de comprador/OTP/historial (fase actual del pedido):
// verificación OTP incorrecta/correcta, devOtpCode nunca en producción,
// GET /orders/mine minimizado y honesto (nunca "enviado"/"facturado" sin
// que haya ocurrido de verdad), y multiorden en la misma sesión.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const TEST_CODIGO = '900000000000000000000000000099';

let dbAvailable = false;
let getDbPool;
let query;
let catastroxPaymentsRouter;

try {
  const { getConfig } = await import('../../config/env.js');
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
  const limiterModule = await import('../../middleware/rateLimit.js');
  rateLimiters = [
    limiterModule.checkoutLimiter,
    limiterModule.customerLimiter,
    limiterModule.emailVerificationLimiter,
    limiterModule.verifyLimiter,
    limiterModule.entitlementLimiter,
    limiterModule.orderStatusLimiter,
    limiterModule.myOrdersLimiter,
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

let counter = 0;

async function createCustomer(baseUrl, overrides = {}) {
  counter += 1;
  const email = overrides.email || `otp-history-${Date.now()}-${counter}@example.com`;
  const response = await fetch(`${baseUrl}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerType: 'natural',
      firstName: 'Historial',
      lastName: 'Test',
      documentType: 'CC',
      documentNumber: `93${counter}${Date.now()}`.slice(0, 15),
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
  return response.json();
}

async function cleanupTestData() {
  if (!dbAvailable) return;
  const orders = await query('select id, customer_id from public.catastrox_payment_orders where canonical_predio_id = $1', [
    TEST_CODIGO,
  ]);
  const orderIds = orders.rows.map((row) => row.id);
  const customerIds = orders.rows.map((row) => row.customer_id).filter(Boolean);

  if (orderIds.length) {
    await query('delete from public.catastrox_delivery_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_invoice_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_recovery_session_orders where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_billing_profiles where payment_order_id = any($1)', [orderIds]);
  }
  await query('delete from public.catastrox_payment_orders where canonical_predio_id = $1', [TEST_CODIGO]);
  if (customerIds.length) {
    await query('delete from public.catastrox_email_verifications where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customers where id = any($1)', [customerIds]);
  }
  await query(
    `delete from public.catastrox_recovery_sessions
      where id not in (select recovery_session_id from public.catastrox_recovery_session_orders)
        and created_at > now() - interval '1 hour'`,
  );
}

test('comprador/OTP/historial de órdenes (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestData();
  });

  await t.test('10) OTP incorrecto no verifica el correo', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const { customerId } = await createCustomer(app.baseUrl);
      const response = await fetch(`${app.baseUrl}/customers/${customerId}/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '000000' }),
      });
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'CODE_MISMATCH');
    } finally {
      await app.close();
    }
  });

  await t.test('11) OTP correcto verifica, y 9) el comprador se creó válidamente antes', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const created = await createCustomer(app.baseUrl);
      assert.ok(created.customerId, 'debe crear un customerId');
      assert.equal(created.emailVerificationRequired, true);

      const response = await fetch(`${app.baseUrl}/customers/${created.customerId}/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: created.devOtpCode }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.verified, true);
    } finally {
      await app.close();
    }
  });

  await t.test('13) devOtpCode NUNCA aparece si APP_ENV=production al momento de crear el comprador', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    const originalAppEnv = process.env.APP_ENV;
    try {
      process.env.APP_ENV = 'production';
      const created = await createCustomer(app.baseUrl);
      assert.equal('devOtpCode' in created, false, 'devOtpCode no debe existir en la respuesta cuando APP_ENV=production');
    } finally {
      process.env.APP_ENV = originalAppEnv;
      await app.close();
    }
  });

  await t.test(
    '4) fuera de development/test, sin proveedor de correo real conectado, POST /customers falla de forma controlada (nunca afirma "correo enviado")',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const originalAppEnv = process.env.APP_ENV;
      try {
        process.env.APP_ENV = 'production';
        counter += 1;
        const email = `prod-no-provider-${Date.now()}-${counter}@example.com`;
        const response = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerType: 'natural',
            firstName: 'Produccion',
            lastName: 'SinProveedor',
            documentType: 'CC',
            documentNumber: `94${counter}${Date.now()}`.slice(0, 15),
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
        const payload = await response.json();
        assert.equal(response.status, 503);
        assert.equal(payload.ok, false);
        assert.equal(payload.code, 'EMAIL_DELIVERY_UNAVAILABLE');
        assert.equal('devOtpCode' in payload, false);
        assert.equal('customerId' in payload, false, 'una respuesta de fallo no debe sugerir que el registro tuvo éxito');
      } finally {
        process.env.APP_ENV = originalAppEnv;
        await app.close();
      }
    },
  );

  await t.test(
    '9/14/15/21/25/26) GET /orders/mine: minimizado, honesto, multiorden en la misma sesión, sin PII',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      try {
        // Sin cookie -> lista vacía, nunca un error ni datos de otra sesión.
        const noCookie = await fetch(`${app.baseUrl}/orders/mine`);
        const noCookiePayload = await noCookie.json();
        assert.equal(noCookiePayload.ok, true);
        assert.deepEqual(noCookiePayload.orders, []);

        const customer = await createCustomer(app.baseUrl);
        await fetch(`${app.baseUrl}/customers/${customer.customerId}/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: customer.devOtpCode }),
        });

        // 14) customerId (ya verificado) solo se envía al checkout después de
        // la verificación -- este propio flujo de prueba respeta ese orden.
        const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          // 15) credentials:'include' es responsabilidad del navegador real;
          // aquí se simula reenviando el cookie manualmente en las llamadas
          // siguientes -- el backend en sí no distingue el transporte.
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packageId: 'basico',
            codigoPredial: TEST_CODIGO,
            customerId: customer.customerId,
            routeId: 'cx-history-1',
            purchaseAttemptId: crypto.randomUUID(),
          }),
        });
        const cookie = extractSessionCookiePair(checkoutResponse);
        const { reference, orderToken } = (await checkoutResponse.json()).checkout;

        // Antes de aprobar: pago pendiente, entrega/factura sin iniciar --
        // nunca "enviado"/"emitida" para una orden que ni siquiera se pagó.
        const beforeApproval = await fetch(`${app.baseUrl}/orders/mine`, { headers: { Cookie: cookie } });
        const beforeApprovalPayload = await beforeApproval.json();
        assert.equal(beforeApprovalPayload.orders.length, 1);
        assert.equal(beforeApprovalPayload.orders[0].paymentStatus, 'PENDING');
        assert.notEqual(beforeApprovalPayload.orders[0].deliveryStatus, 'SENT');
        assert.notEqual(beforeApprovalPayload.orders[0].deliveryStatus, 'DELIVERED');
        assert.notEqual(beforeApprovalPayload.orders[0].invoiceStatus, 'ISSUED');

        // 9) Ninguno de los campos sensibles existe en absoluto en la
        // respuesta -- ni siquiera enmascarados, porque la consulta de
        // backend nunca los selecciona.
        for (const forbiddenField of ['documento', 'document', 'correo', 'email', 'telefono', 'phone', 'direccion', 'address', 'reference', 'transactionId', 'token']) {
          assert.equal(forbiddenField in beforeApprovalPayload.orders[0], false, `no debe exponer "${forbiddenField}"`);
        }

        withWompiFetchMock(() =>
          jsonResponse(200, {
            data: { id: 'txn-history-1', status: 'APPROVED', reference, amount_in_cents: 3990000, currency: 'COP' },
          }),
        );
        try {
          await fetch(`${app.baseUrl}/verify/txn-history-1`);
        } finally {
          restoreFetch();
        }

        // 25/26) Tras aprobar: pago APPROVED, pero entrega/factura siguen
        // siendo honestos -- el único proveedor disponible en este alcance
        // (deliveryJobService/invoiceJobService) nunca simula éxito, así
        // que el estado real tras la aprobación es FAILED/NOT_REQUESTED,
        // JAMÁS "enviado"/"emitida".
        const afterApproval = await fetch(`${app.baseUrl}/orders/mine`, { headers: { Cookie: cookie } });
        const afterApprovalPayload = await afterApproval.json();
        const approvedOrder = afterApprovalPayload.orders.find((order) => order.orderToken === orderToken);
        assert.equal(approvedOrder.paymentStatus, 'APPROVED');
        assert.equal(approvedOrder.deliveryStatus, 'FAILED');
        assert.notEqual(approvedOrder.deliveryStatus, 'SENT');
        assert.notEqual(approvedOrder.deliveryStatus, 'DELIVERED');
        assert.equal(approvedOrder.invoiceStatus, 'NOT_REQUESTED');
        assert.notEqual(approvedOrder.invoiceStatus, 'ISSUED');

        // 21) Una segunda compra (mismo comprador, predio distinto para no
        // chocar con la idempotencia de doble clic) debe SUMARSE al
        // historial de la sesión, nunca reemplazar la primera.
        const secondCheckout = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            packageId: 'plus',
            codigoPredial: TEST_CODIGO,
            customerId: customer.customerId,
            routeId: 'cx-history-2',
            purchaseAttemptId: crypto.randomUUID(),
          }),
        });
        assert.equal((await secondCheckout.json()).checkout.status, 'CREATED');

        const finalHistory = await fetch(`${app.baseUrl}/orders/mine`, { headers: { Cookie: cookie } });
        const finalHistoryPayload = await finalHistory.json();
        assert.equal(finalHistoryPayload.orders.length, 2, 'la sesión debe mostrar ambas órdenes, no solo la última');
      } finally {
        await app.close();
      }
    },
  );
});
