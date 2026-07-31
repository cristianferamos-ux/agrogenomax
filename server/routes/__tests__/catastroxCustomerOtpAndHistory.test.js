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
let hashDocumentNumber;
let normalizeDocumentNumber;

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
  ({ hashDocumentNumber, normalizeDocumentNumber } = await import('../../services/catastrox/piiCrypto.js'));
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

// EMAIL_PROVIDER_002: mismo patrón que withWompiFetchMock, para las
// llamadas reales de sendVerificationEmail() a la API de Resend.
function withResendFetchMock(handler) {
  globalThis.fetch = async (url, options) => {
    const urlString = String(url);
    if (urlString.includes('api.resend.com')) {
      return handler(urlString, options);
    }
    return originalFetch(url, options);
  };
}

function withStagingResendEnv(overrides = {}) {
  const original = {
    APP_ENV: process.env.APP_ENV,
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
  process.env.APP_ENV = 'staging';
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 're_synthetic_integration_test_key';
  process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';
  Object.assign(process.env, overrides);
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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
    await query('delete from public.catastrox_customer_otp_state where customer_id = any($1)', [customerIds]);
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
    'EMAIL_PROVIDER_002: POST /customers en staging responde 503 EMAIL_DELIVERY_UNAVAILABLE cuando Resend falla, sin devOtpCode',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ message: 'invalid recipient' }), { status: 400 }));
      try {
        const created = await createCustomer(app.baseUrl);
        assert.equal('customerId' in created, false, 'un fallo de entrega no debe sugerir que el registro tuvo éxito');
        assert.equal(created.ok, false);
        assert.equal(created.code, 'EMAIL_DELIVERY_UNAVAILABLE');
        assert.equal('devOtpCode' in created, false, 'devOtpCode nunca debe aparecer en staging, ni siquiera ante un fallo');
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002: POST /customers en staging responde 200 cuando Resend entrega, sin devOtpCode, y el flujo de verificación sigue funcionando',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_integration_ok' }), { status: 200 }));
      try {
        const created = await createCustomer(app.baseUrl);
        assert.equal(created.ok, true);
        assert.ok(created.customerId);
        assert.equal(created.emailVerificationRequired, true);
        assert.equal('devOtpCode' in created, false, 'devOtpCode nunca debe aparecer en staging, ni siquiera con entrega exitosa');
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  // --- EMAIL_PROVIDER_002 (revisión de reenvío OTP) ------------------------
  // No existe un endpoint dedicado de reenvío: el frontend
  // (CatastroXPackagePage.jsx, handleResendOtp) reenvía llamando de nuevo a
  // POST /customers con los mismos datos del comprador. upsertCustomer() es
  // idempotente por hash de documento (actualiza la misma fila); cada
  // llamada genera un candidato de verificación nuevo
  // (generatePendingEmailVerification()) y, si el envío se confirma
  // entregado (o development/test), lo persiste
  // (persistEmailVerification()). Las pruebas de abajo ejercitan ese mismo
  // endpoint una segunda vez con los mismos datos de comprador para simular
  // el reenvío real.

  function buildFixedCustomerBody({ documentNumber, email }) {
    return {
      customerType: 'natural',
      firstName: 'Reenvio',
      lastName: 'Test',
      documentType: 'CC',
      documentNumber,
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
    };
  }

  async function countEmailVerifications(customerId) {
    const result = await query('select count(*)::int as n from public.catastrox_email_verifications where customer_id = $1', [
      customerId,
    ]);
    return result.rows[0].n;
  }

  // Cierre de protección backend (cooldown de 30s por comprador): las
  // pruebas de reenvío de más abajo, salvo las que prueban el cooldown en
  // sí mismo, no quieren esperar 30s reales -- retrasan artificialmente
  // last_delivered_at para simular "ya pasó el cooldown", sin tocar
  // reserved_at (que ya se libera solo, de inmediato, al terminar cada
  // request).
  async function bypassOtpCooldown(customerId) {
    await query(
      `update public.catastrox_customer_otp_state
          set last_delivered_at = now() - interval '31 seconds'
        where customer_id = $1`,
      [customerId],
    );
  }

  await t.test('EMAIL_PROVIDER_002 (reenvío): en development, ni el registro inicial ni el reenvío llaman a Resend', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    const originalAppEnv = process.env.APP_ENV;
    const captured = [];
    withResendFetchMock((_url, options) => {
      captured.push(options);
      return new Response(JSON.stringify({ id: 'msg_should_not_happen' }), { status: 200 });
    });
    counter += 1;
    const email = `resend-dev-${Date.now()}-${counter}@example.com`;
    const documentNumber = `96${counter}${Date.now()}`.slice(0, 15);
    try {
      process.env.APP_ENV = 'development';
      const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
      assert.equal('devOtpCode' in initial, true, 'development debe seguir devolviendo devOtpCode (mecanismo autorizado)');

      // El cooldown backend aplica incluso en development (requisito
      // explícito) -- se simula que ya pasaron los 30s para poder probar
      // aquí el comportamiento del reenvío en sí, no el cooldown (que tiene
      // sus propias pruebas dedicadas más abajo).
      await bypassOtpCooldown(initial.customerId);

      const resendResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
      });
      const resendPayload = await resendResponse.json();
      assert.equal(resendResponse.status, 200);
      assert.equal('devOtpCode' in resendPayload, true, 'el reenvío en development también debe devolver devOtpCode');
      assert.notEqual(resendPayload.devOtpCode, initial.devOtpCode, 'el reenvío debe generar un código nuevo, distinto del inicial');
      assert.equal(captured.length, 0, 'development nunca debe llamar a Resend, ni en el registro inicial ni en el reenvío');
    } finally {
      restoreFetch();
      process.env.APP_ENV = originalAppEnv;
      await app.close();
    }
  });

  await t.test(
    'EMAIL_PROVIDER_002 (reenvío): en staging, un reenvío exitoso llama a Resend una sola vez, crea un OTP nuevo y usa una Idempotency-Key nueva (distinta de la del envío inicial)',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      const captured = [];
      withResendFetchMock((_url, options) => {
        captured.push(options);
        return new Response(JSON.stringify({ id: `msg_resend_ok_${captured.length}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      counter += 1;
      const email = `resend-staging-ok-${Date.now()}-${counter}@example.com`;
      const documentNumber = `97${counter}${Date.now()}`.slice(0, 15);
      try {
        const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
        assert.equal(initial.ok, true);
        assert.equal(captured.length, 1, 'el registro inicial debe llamar a Resend exactamente una vez');
        assert.equal(await countEmailVerifications(initial.customerId), 1);
        await bypassOtpCooldown(initial.customerId);

        const resendResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const resendPayload = await resendResponse.json();
        assert.equal(resendResponse.status, 200);
        assert.equal('devOtpCode' in resendPayload, false, 'devOtpCode nunca debe aparecer en staging, tampoco en un reenvío exitoso');

        // "una sola operación lógica": el reenvío exitoso agrega exactamente
        // una llamada nueva a Resend (no reintenta porque no hay fallo).
        assert.equal(captured.length, 2, 'el reenvío exitoso debe agregar exactamente una llamada nueva a Resend');
        assert.equal(await countEmailVerifications(initial.customerId), 2, 'el reenvío debe crear una fila de verificación nueva');

        const firstIdempotencyKey = captured[0].headers['Idempotency-Key'];
        const secondIdempotencyKey = captured[1].headers['Idempotency-Key'];
        assert.ok(firstIdempotencyKey);
        assert.ok(secondIdempotencyKey);
        assert.notEqual(secondIdempotencyKey, firstIdempotencyKey, 'un verificationId nuevo debe producir una Idempotency-Key nueva');
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (reenvío): el reintento interno de un reenvío conserva la misma Idempotency-Key',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_initial' }), { status: 200 }));
      counter += 1;
      const email = `resend-staging-retry-${Date.now()}-${counter}@example.com`;
      const documentNumber = `98${counter}${Date.now()}`.slice(0, 15);
      try {
        const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
        assert.equal(initial.ok, true);
        await bypassOtpCooldown(initial.customerId);

        const capturedRetry = [];
        withResendFetchMock((_url, options) => {
          capturedRetry.push(options);
          // Primer intento del reenvío: 500 (reintentable). Segundo: éxito.
          if (capturedRetry.length === 1) {
            return new Response(JSON.stringify({ message: 'internal error' }), { status: 500 });
          }
          return new Response(JSON.stringify({ id: 'msg_resend_after_retry' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });

        const resendResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const resendPayload = await resendResponse.json();
        assert.equal(resendResponse.status, 200);
        assert.equal(resendPayload.ok, true);
        assert.equal(capturedRetry.length, 2, 'debe haber exactamente un reintento interno (dos llamadas HTTP)');
        assert.equal(
          capturedRetry[1].headers['Idempotency-Key'],
          capturedRetry[0].headers['Idempotency-Key'],
          'el reintento interno debe conservar la misma Idempotency-Key que el primer intento',
        );
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (reenvío): un fallo de Resend en el reenvío responde 503, no crea una fila nueva, y el código anterior (ya entregado) sigue siendo válido',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      const captured = [];
      withResendFetchMock((_url, options) => {
        captured.push(options);
        return new Response(JSON.stringify({ id: `msg_ok_${captured.length}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      counter += 1;
      const email = `resend-staging-fail-${Date.now()}-${counter}@example.com`;
      const documentNumber = `99${counter}${Date.now()}`.slice(0, 15);
      const originalConsoleInfo = console.info;
      const originalConsoleError = console.error;
      const logLines = [];
      console.info = (...args) => logLines.push(args);
      console.error = (...args) => logLines.push(args);
      try {
        const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
        assert.equal(initial.ok, true);
        assert.equal(await countEmailVerifications(initial.customerId), 1);

        // El correo enviado de verdad contiene el código -- se recupera del
        // cuerpo capturado para probar, más abajo, que sigue siendo válido
        // después del reenvío fallido (en staging nunca se devuelve
        // devOtpCode, así que esta es la única forma de conocerlo en la
        // prueba sin inventar un atajo nuevo en el backend).
        const firstBody = JSON.parse(captured[0].body);
        const originalCodeMatch = firstBody.text.match(/(\d{6})/);
        assert.ok(originalCodeMatch, 'el cuerpo de texto plano debe contener el código de 6 dígitos');
        const originalCode = originalCodeMatch[1];

        // Ahora el reenvío falla en Resend (rechazo definitivo, sin reintento).
        // Se simula que ya pasó el cooldown para poder llegar a probar el
        // fallo del proveedor en sí -- el cooldown tiene sus propias
        // pruebas dedicadas más abajo.
        await bypassOtpCooldown(initial.customerId);
        withResendFetchMock(() => new Response(JSON.stringify({ message: 'invalid recipient' }), { status: 400 }));
        const resendResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const resendPayload = await resendResponse.json();
        assert.equal(resendResponse.status, 503);
        assert.equal(resendPayload.ok, false);
        assert.equal(resendPayload.code, 'EMAIL_DELIVERY_UNAVAILABLE');
        assert.equal('devOtpCode' in resendPayload, false);
        assert.equal(
          'customerId' in resendPayload,
          false,
          'un reenvío fallido no debe sugerir éxito devolviendo customerId',
        );

        assert.equal(
          await countEmailVerifications(initial.customerId),
          1,
          'un reenvío fallido no debe dejar una fila de verificación nueva',
        );

        // El código original (realmente entregado) sigue siendo válido --
        // el fallo del reenvío no lo ensombreció ni lo invalidó.
        const verifyOriginal = await fetch(`${app.baseUrl}/customers/${initial.customerId}/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: originalCode }),
        });
        const verifyPayload = await verifyOriginal.json();
        assert.equal(verifyOriginal.status, 200);
        assert.equal(verifyPayload.verified, true, 'el código original entregado debe seguir siendo válido tras el reenvío fallido');

        const joinedLogs = JSON.stringify(logLines);
        assert.ok(!joinedLogs.includes(email), 'el correo completo nunca debe aparecer en los logs');
        assert.ok(!joinedLogs.includes(originalCode), 'el OTP nunca debe aparecer en los logs');
        assert.ok(!joinedLogs.includes(process.env.RESEND_API_KEY), 'la API key nunca debe aparecer en los logs');
      } finally {
        console.info = originalConsoleInfo;
        console.error = originalConsoleError;
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (reenvío): después de un fallo de Resend, un reintento posterior del reenvío puede tener éxito (no queda bloqueado permanentemente)',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_initial' }), { status: 200 }));
      counter += 1;
      const email = `resend-staging-recover-${Date.now()}-${counter}@example.com`;
      const documentNumber = `10${counter}${Date.now()}`.slice(0, 15);
      try {
        const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
        assert.equal(initial.ok, true);
        // Simula que ya pasó el cooldown del envío inicial -- este caso
        // prueba la recuperación tras un fallo del proveedor, no el
        // cooldown en sí. El fallo que sigue, al no entregar nada, NUNCA
        // actualiza last_delivered_at -- por eso el segundo reenvío (la
        // recuperación) no necesita otro bypass: no hay cooldown activo
        // tras un intento fallido.
        await bypassOtpCooldown(initial.customerId);

        withResendFetchMock(() => new Response(JSON.stringify({ message: 'temporarily rejected' }), { status: 400 }));
        const failedResend = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        assert.equal(failedResend.status, 503);
        assert.equal(await countEmailVerifications(initial.customerId), 1);

        withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_recovered' }), { status: 200 }));
        const secondResend = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const secondResendPayload = await secondResend.json();
        assert.equal(secondResend.status, 200, 'un reintento posterior del reenvío debe poder tener éxito');
        assert.equal(secondResendPayload.ok, true);
        assert.equal(await countEmailVerifications(initial.customerId), 2, 'el reintento exitoso sí debe crear una fila nueva');
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (reenvío): el reenvío comparte el mismo rate limit que el registro inicial (mismo customerLimiter, mismo endpoint)',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_ratelimit' }), { status: 200 }));
      counter += 1;
      const email = `resend-staging-ratelimit-${Date.now()}-${counter}@example.com`;
      const documentNumber = `11${counter}${Date.now()}`.slice(0, 15);
      try {
        const firstResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const firstRemaining = Number(firstResponse.headers.get('ratelimit-remaining'));
        await firstResponse.json();

        const secondResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const secondRemaining = Number(secondResponse.headers.get('ratelimit-remaining'));
        await secondResponse.json();

        assert.ok(Number.isFinite(firstRemaining) && Number.isFinite(secondRemaining));
        assert.equal(secondRemaining, firstRemaining - 1, 'el reenvío debe consumir el mismo contador de rate limit que el registro inicial');
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  // --- Cierre de protección backend: cooldown de 30s por comprador --------
  // El frontend ya aplica un cooldown de 30s (CatastroXOtpVerification.jsx),
  // pero POST /customers no tenía ninguna protección de backend equivalente
  // -- un cliente que llamara al endpoint directamente podía disparar
  // tantos envíos reales como el rate limit general por IP lo permitiera,
  // sin ningún límite por comprador/correo. Las pruebas de abajo ejercitan
  // reserveEmailVerificationSend()/releaseEmailVerificationSend()
  // (server/services/catastrox/customerRepository.js) a través del
  // endpoint real.

  async function lookupCustomerIdByDocument(documentNumber) {
    const documentHash = hashDocumentNumber(normalizeDocumentNumber(documentNumber));
    const result = await query('select id from public.catastrox_customers where document_number_hash = $1', [documentHash]);
    return result.rows[0]?.id ?? null;
  }

  await t.test(
    'EMAIL_PROVIDER_002 (cooldown backend): segundo request antes de 30s devuelve 429 EMAIL_VERIFICATION_COOLDOWN, con retryAfterSeconds acotado, sin llamar a Resend, sin fila nueva, y el código anterior sigue siendo válido',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      const captured = [];
      withResendFetchMock((_url, options) => {
        captured.push(options);
        return new Response(JSON.stringify({ id: 'msg_cooldown_initial' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      counter += 1;
      const email = `cooldown-basic-${Date.now()}-${counter}@example.com`;
      const documentNumber = `20${counter}${Date.now()}`.slice(0, 15);
      const originalConsoleInfo = console.info;
      const originalConsoleError = console.error;
      const logLines = [];
      console.info = (...args) => logLines.push(args);
      console.error = (...args) => logLines.push(args);
      try {
        const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
        assert.equal(initial.ok, true);
        assert.equal(captured.length, 1);

        const firstBody = JSON.parse(captured[0].body);
        const originalCodeMatch = firstBody.text.match(/(\d{6})/);
        assert.ok(originalCodeMatch);
        const originalCode = originalCodeMatch[1];

        // Segundo request inmediato, sin esperar -- debe bloquear.
        const secondResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const secondPayload = await secondResponse.json();

        assert.equal(secondResponse.status, 429);
        assert.equal(secondPayload.ok, false);
        assert.equal(secondPayload.code, 'EMAIL_VERIFICATION_COOLDOWN');
        assert.equal(typeof secondPayload.retryAfterSeconds, 'number');
        assert.ok(
          Number.isInteger(secondPayload.retryAfterSeconds) &&
            secondPayload.retryAfterSeconds >= 1 &&
            secondPayload.retryAfterSeconds <= 30,
          'retryAfterSeconds debe ser un entero acotado entre 1 y 30',
        );
        assert.equal('devOtpCode' in secondPayload, false);
        assert.equal('customerId' in secondPayload, false, 'un 429 de cooldown no debe sugerir éxito devolviendo customerId');

        assert.equal(captured.length, 1, 'el cooldown debe bloquear antes de llamar a Resend -- ninguna llamada nueva');
        assert.equal(await countEmailVerifications(initial.customerId), 1, 'el cooldown no debe dejar una fila de verificación nueva');

        const verifyOriginal = await fetch(`${app.baseUrl}/customers/${initial.customerId}/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: originalCode }),
        });
        const verifyPayload = await verifyOriginal.json();
        assert.equal(verifyOriginal.status, 200);
        assert.equal(verifyPayload.verified, true, 'el código anterior debe seguir siendo válido tras un 429 de cooldown');

        const joinedLogs = JSON.stringify(logLines);
        const joinedResponse = JSON.stringify(secondPayload);
        for (const secretValue of [email, originalCode, documentNumber, process.env.RESEND_API_KEY]) {
          assert.ok(!joinedLogs.includes(secretValue), `no debe aparecer en logs: valor protegido`);
          assert.ok(!joinedResponse.includes(secretValue), `no debe aparecer en la respuesta de 429: valor protegido`);
        }
      } finally {
        console.info = originalConsoleInfo;
        console.error = originalConsoleError;
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test('EMAIL_PROVIDER_002 (cooldown backend): pasados los 30s, permite una nueva emisión real', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    const restoreEnv = withStagingResendEnv();
    const captured = [];
    withResendFetchMock((_url, options) => {
      captured.push(options);
      return new Response(JSON.stringify({ id: `msg_elapsed_${captured.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    counter += 1;
    const email = `cooldown-elapsed-${Date.now()}-${counter}@example.com`;
    const documentNumber = `21${counter}${Date.now()}`.slice(0, 15);
    try {
      const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
      assert.equal(initial.ok, true);
      await bypassOtpCooldown(initial.customerId);

      const secondResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
      });
      const secondPayload = await secondResponse.json();
      assert.equal(secondResponse.status, 200);
      assert.equal(secondPayload.ok, true);
      assert.equal(captured.length, 2, 'tras el cooldown, la nueva emisión sí debe llamar a Resend');
      assert.equal(await countEmailVerifications(initial.customerId), 2);
    } finally {
      restoreFetch();
      restoreEnv();
      await app.close();
    }
  });

  await t.test(
    'EMAIL_PROVIDER_002 (cooldown backend): un fallo en el PRIMER intento no deja OTP persistido, y permite un reintento inmediato porque nunca activó ningún cooldown',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ message: 'rejected' }), { status: 400 }));
      counter += 1;
      const email = `cooldown-firstfail-${Date.now()}-${counter}@example.com`;
      const documentNumber = `22${counter}${Date.now()}`.slice(0, 15);
      try {
        const firstResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const firstPayload = await firstResponse.json();
        assert.equal(firstResponse.status, 503);
        assert.equal(firstPayload.code, 'EMAIL_DELIVERY_UNAVAILABLE');

        const customerId = await lookupCustomerIdByDocument(documentNumber);
        assert.ok(customerId, 'upsertCustomer debe haber creado el comprador aunque el envío fallara');
        assert.equal(await countEmailVerifications(customerId), 0, 'un fallo en el primer intento no debe dejar ningún OTP persistido');

        // Reintento inmediato -- sin bypass de cooldown: un intento fallido
        // nunca actualiza last_delivered_at, así que no hay cooldown activo.
        withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_immediate_retry' }), { status: 200 }));
        const retryResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const retryPayload = await retryResponse.json();
        assert.equal(retryResponse.status, 200, 'un reintento inmediato tras un fallo debe poder tener éxito, sin esperar');
        assert.equal(retryPayload.ok, true);
        assert.equal(await countEmailVerifications(customerId), 1);
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (cooldown backend): dos requests concurrentes para el mismo comprador producen un solo envío real; el otro recibe 429',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      let callCount = 0;
      withResendFetchMock(async () => {
        callCount += 1;
        // Retraso breve para ampliar la ventana de carrera -- si el lock de
        // reserveEmailVerificationSend() no sirviera, ambas requests
        // podrían llegar a llamar a Resend mientras la primera todavía
        // "está en vuelo".
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(JSON.stringify({ id: `msg_concurrent_${callCount}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      counter += 1;
      const email = `cooldown-concurrent-${Date.now()}-${counter}@example.com`;
      const documentNumber = `23${counter}${Date.now()}`.slice(0, 15);
      try {
        const body = JSON.stringify(buildFixedCustomerBody({ documentNumber, email }));
        const [responseA, responseB] = await Promise.all([
          fetch(`${app.baseUrl}/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
          fetch(`${app.baseUrl}/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
        ]);
        const [payloadA, payloadB] = await Promise.all([responseA.json(), responseB.json()]);

        const statuses = [responseA.status, responseB.status].sort();
        assert.deepEqual(statuses, [200, 429], 'una sola solicitud concurrente debe tener éxito; la otra debe recibir 429');

        const successPayload = responseA.status === 200 ? payloadA : payloadB;
        const blockedPayload = responseA.status === 200 ? payloadB : payloadA;
        assert.equal(successPayload.ok, true);
        assert.equal(blockedPayload.code, 'EMAIL_VERIFICATION_COOLDOWN');

        assert.equal(callCount, 1, 'debe haber exactamente una operación lógica de envío a Resend, nunca dos');

        const customerId = await lookupCustomerIdByDocument(documentNumber);
        assert.equal(await countEmailVerifications(customerId), 1, 'debe quedar exactamente una fila de verificación, no dos');
      } finally {
        restoreFetch();
        restoreEnv();
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (cooldown backend): development/test también respetan el cooldown (no depende del proveedor)',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const originalAppEnv = process.env.APP_ENV;
      counter += 1;
      const email = `cooldown-devtest-${Date.now()}-${counter}@example.com`;
      const documentNumber = `24${counter}${Date.now()}`.slice(0, 15);
      try {
        process.env.APP_ENV = 'development';
        const initial = await createCustomer(app.baseUrl, { email, emailConfirmation: email, documentNumber });
        assert.equal('devOtpCode' in initial, true);

        const secondResponse = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
        });
        const secondPayload = await secondResponse.json();
        assert.equal(secondResponse.status, 429, 'el cooldown backend debe aplicar también en development');
        assert.equal(secondPayload.code, 'EMAIL_VERIFICATION_COOLDOWN');
        assert.equal('devOtpCode' in secondPayload, false, 'un 429 de cooldown no debe incluir devOtpCode');
      } finally {
        process.env.APP_ENV = originalAppEnv;
        await app.close();
      }
    },
  );

  await t.test(
    'EMAIL_PROVIDER_002 (cooldown backend): el rate limit general por IP sigue activo de forma independiente del cooldown por comprador',
    async () => {
      resetRateLimiters();
      const app = await startTestApp();
      const restoreEnv = withStagingResendEnv();
      withResendFetchMock(() => new Response(JSON.stringify({ id: 'msg_iprate' }), { status: 200 }));
      try {
        // customerLimiter permite 15 solicitudes / 5 min por IP
        // (server/middleware/rateLimit.js) -- 15 compradores DISTINTOS
        // (documento/correo únicos, así que el cooldown por comprador nunca
        // interviene) deben pasar; la 16ª debe bloquearse por el límite
        // general de IP, con su propio código, distinto del de cooldown.
        let lastResponse;
        for (let i = 0; i < 16; i += 1) {
          counter += 1;
          const email = `cooldown-iprate-${Date.now()}-${counter}@example.com`;
          const documentNumber = `25${counter}${Date.now()}`.slice(0, 15);
          lastResponse = await fetch(`${app.baseUrl}/customers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildFixedCustomerBody({ documentNumber, email })),
          });
          if (i < 15) {
            assert.equal(lastResponse.status, 200, `la solicitud ${i + 1} (comprador distinto) no debe bloquearse por cooldown`);
            await lastResponse.json();
          }
        }
        const lastPayload = await lastResponse.json();
        assert.equal(lastResponse.status, 429, 'la solicitud 16 debe bloquearse por el rate limit general de IP');
        assert.equal(lastPayload.code, 'RATE_LIMITED_CUSTOMER', 'debe ser el código del rate limit general, no el de cooldown por comprador');
        assert.notEqual(lastPayload.code, 'EMAIL_VERIFICATION_COOLDOWN');
      } finally {
        restoreFetch();
        restoreEnv();
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
