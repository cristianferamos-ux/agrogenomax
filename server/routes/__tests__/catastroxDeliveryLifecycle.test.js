// CATX-DELIVERY-001: pruebas de integración (Postgres real, se auto-omiten
// si no hay base alcanzable, mismo criterio que catastroxPaymentWebhook.test.js)
// del ciclo completo de generación/persistencia/envío/descarga/reintento del
// PDF comprado. Cubre los escenarios obligatorios pedidos que no quedan ya
// cubiertos por catastroxPaymentWebhook.test.js (un solo job, sin duplicar
// en replay) ni por customerEmailChangeAndJobConcurrency.test.js
// (unicidad/reintento no duplica el deliverable):
//   - una orden NO aprobada nunca genera nada
//   - checksum/tamaño se persisten correctamente
//   - envío exitoso -> SENT + delivered_at
//   - error de correo -> FAILED + last_error_code
//   - reintento de FAILED incrementa attempts y puede terminar SENT
//   - reintento de SENT es idempotente (sin nuevos intentos/envíos)
//   - descarga sin sesión -> 401; de otra orden/sesión -> 403; válida -> 200 application/pdf
//   - reintento HTTP sin sesión -> 401; de otra orden -> 403
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

// P1-02/P1-03 (remediación post-auditoría): antes este predio era un código
// predial REAL (184600002000000030015000000000, MILAN/CAQUETA) -- se
// reemplaza por uno sintético de 30 dígitos, aceptado sin validaciones
// territoriales/checksum adicionales por validateCadastralCodeInput/
// normalizeCadastralCodeInput/resolveCanonicalPredioId (solo exigen 20 o 30
// dígitos numéricos). Sigue siendo resoluble por resolvePredioDataForDelivery
// porque scripts/catastrox/test/setup_integration_postgis.sql inserta una
// fila sintética para exactamente este código en catastrox_clean.predios --
// estas pruebas necesitan que la generación PDFKit realmente tenga éxito
// (para probar checksum/tamaño y el camino hasta SENT), no solo que falle de
// forma honesta, y ahora ese predio resoluble es 100% sintético/local.
const INTEGRATION_TEST_CODIGO = '999999999999999999999999999901';
const TEST_ROUTE_ID = 'cx-test-delivery-lifecycle-route';
const EVENTS_SECRET = 'events_secret_de_prueba_treinta_dos_caracteres_o_mas_1234';

let dbAvailable = false;
let query;
let catastroxPaymentsRouter;
let computeWompiEventChecksum;
let __rememberLookupPreviewForTests;
let deliveryJobService;

try {
  const { getConfig } = await import('../../config/env.js');
  const { getDbPool, query: q } = await import('../../db.js');
  query = q;
  getConfig();
  const pool = getDbPool();
  await pool.query('select 1');
  const tableCheck = await pool.query("select to_regclass('public.catastrox_deliverable_blobs') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

let rateLimiters = [];

if (dbAvailable) {
  ({ default: catastroxPaymentsRouter } = await import('../catastroxPayments.js'));
  ({ computeWompiEventChecksum } = await import('../../services/catastrox/wompiEventVerification.js'));
  ({ __rememberLookupPreviewForTests } = await import('../catastrox.js'));
  __rememberLookupPreviewForTests(TEST_ROUTE_ID, { canonicalPredioId: INTEGRATION_TEST_CODIGO, codigoPredial: INTEGRATION_TEST_CODIGO });
  deliveryJobService = await import('../../services/catastrox/deliveryJobService.js');
  const limiterModule = await import('../../middleware/rateLimit.js');
  // Los limitadores son singletons de módulo (mismo store en memoria durante
  // todo este proceso de test, ver catastroxPaymentOrders.test.js) -- este
  // archivo por sí solo ya hace más llamadas a /checkout de las que
  // checkoutLimiter permitiría en una ventana real de 5 minutos. Se
  // resetean antes de cada prueba que abre un checkout nuevo -- se prueba
  // la lógica de negocio de la entrega, no el rate limiting (que tiene su
  // propia suite dedicada en middleware/__tests__/rateLimit.test.js).
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

// CATX-PDF-PARITY-002: toda orden APPROVED en este archivo dispara
// generación real de PDF (deliveryJobService -> catastroxPdfGenerator),
// que ahora dibuja un mosaico satelital real (fetch de teselas Esri,
// server/services/catastrox/pdf/catastroxPdfMap.js). Estas pruebas deben
// seguir siendo deterministas y no depender de red/terceros -- se
// intercepta arcgisonline.com de forma PERMANENTE (activa durante todo
// este archivo, no solo dentro de withFetchMock/restoreFetch) devolviendo
// siempre la misma imagen PNG mínima válida, salvo cuando una prueba
// específica active `withMapFailureMock` para simular MAP_RENDER_FAILED.
const MOCK_TILE_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let activeExternalHandler = null; // Wompi/Resend -- opt-in por prueba (withFetchMock/restoreFetch)
let activeMapFailureHandler = null; // Esri -- opt-in por prueba (withMapFailureMock/restoreMapMock)

globalThis.fetch = async (url, options) => {
  const urlString = String(url);
  if (urlString.includes('arcgisonline.com')) {
    if (activeMapFailureHandler) return activeMapFailureHandler(urlString, options);
    return new Response(MOCK_TILE_BUFFER, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  // Solo intercepta llamadas HACIA proveedores externos (Wompi sandbox,
  // Resend) -- cualquier otra URL (en particular las llamadas que este mismo
  // archivo hace hacia app.baseUrl, el servidor Express local de prueba) debe
  // seguir usando fetch real. Sin este fallback, instalar el mock rompería la
  // propia llamada HTTP de la prueba al endpoint bajo prueba (defecto real
  // que se reprodujo y corrigió mientras se escribían estas pruebas).
  if ((urlString.includes('sandbox.wompi.co') || urlString.includes('api.resend.com')) && activeExternalHandler) {
    return activeExternalHandler(urlString, options);
  }
  return originalFetch(url, options);
};

function withFetchMock(handler) {
  activeExternalHandler = handler;
}

function restoreFetch() {
  activeExternalHandler = null;
}

function withMapFailureMock(handler) {
  activeMapFailureHandler = handler;
}

function restoreMapMock() {
  activeMapFailureHandler = null;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

function extractSessionCookiePair(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  const [pair] = setCookie.split(';');
  return pair || null;
}

let customerCounter = 0;

async function createVerifiedTestCustomer(baseUrl) {
  customerCounter += 1;
  const email = `delivery-lifecycle-${Date.now()}-${customerCounter}@example.com`;
  const response = await fetch(`${baseUrl}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerType: 'natural',
      firstName: 'Entrega',
      lastName: 'Test',
      documentType: 'CC',
      documentNumber: `91000${customerCounter}${Date.now()}`.slice(0, 15),
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
  await fetch(`${baseUrl}/customers/${payload.customerId}/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: payload.devOtpCode }),
  });
  return { customerId: payload.customerId, email };
}

function buildSignedEvent({ transactionId, reference, status = 'APPROVED', amountInCents = 3990000, timestamp = 1732550400 }) {
  const data = { transaction: { id: transactionId, status, amount_in_cents: amountInCents, reference } };
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents', 'transaction.reference'];
  const checksum = computeWompiEventChecksum({ properties, data, timestamp, secret: EVENTS_SECRET });
  return {
    event: 'transaction.updated',
    data,
    environment: 'test',
    timestamp,
    sent_at: new Date().toISOString(),
    signature: { properties, checksum },
  };
}

// Crea una orden APPROVED completa (checkout real + webhook real, mismo
// camino que un pago real recorrería) y devuelve todo lo necesario para
// manipular directamente su delivery job. `waitForTerminal` espera a que
// el procesamiento desacoplado (ajuste #8) termine antes de devolver.
async function createApprovedOrder(app, { packageId = 'basico', transactionId } = {}) {
  const { customerId, email } = await createVerifiedTestCustomer(app.baseUrl);
  const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId, routeId: TEST_ROUTE_ID, customerId, purchaseAttemptId: crypto.randomUUID() }),
  });
  const cookie = extractSessionCookiePair(checkoutResponse);
  const { reference, orderToken } = (await checkoutResponse.json()).checkout;

  const event = buildSignedEvent({ transactionId, reference });
  withFetchMock((url, options) => {
    if (url.includes('api.resend.com')) return jsonResponse(500, { message: 'no debería llamarse en dev/test' });
    return jsonResponse(200, { data: { id: transactionId, status: 'APPROVED', reference, amount_in_cents: 3990000, currency: 'COP' } });
  });
  try {
    await fetch(`${app.baseUrl}/wompi/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } finally {
    restoreFetch();
  }

  const orderRow = await query('select * from public.catastrox_payment_orders where wompi_reference = $1', [reference]);
  const order = orderRow.rows[0];

  return { order, orderToken, cookie, customerId, email };
}

async function waitForDeliveryJobTerminal(orderId, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await query('select * from public.catastrox_delivery_jobs where payment_order_id = $1', [orderId]);
    const status = result.rows[0]?.status;
    if (status === 'SENT' || status === 'FAILED') return result.rows[0];
    if (Date.now() >= deadline) return result.rows[0] || null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function cleanupOrder(order, customerId) {
  if (!dbAvailable || !order) return;
  await query('delete from public.catastrox_deliverable_blobs where deliverable_id in (select id from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = $1))', [order.id]);
  await query('delete from public.catastrox_delivery_attempts where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = $1)', [order.id]);
  await query('delete from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = $1)', [order.id]);
  await query('delete from public.catastrox_delivery_jobs where payment_order_id = $1', [order.id]);
  await query('delete from public.catastrox_invoice_jobs where payment_order_id = $1', [order.id]);
  await query('delete from public.catastrox_recovery_session_orders where payment_order_id = $1', [order.id]);
  await query('delete from public.catastrox_billing_profiles where payment_order_id = $1', [order.id]);
  await query('delete from public.catastrox_payment_orders where id = $1', [order.id]);
  if (customerId) {
    await query('delete from public.catastrox_email_verifications where customer_id = $1', [customerId]);
    await query('delete from public.catastrox_customer_otp_state where customer_id = $1', [customerId]);
    await query('delete from public.catastrox_customers where id = $1', [customerId]);
  }
}

async function hasConstraint(constraintName) {
  const result = await query(
    `select 1
       from pg_constraint
      where conname = $1
        and connamespace = 'public'::regnamespace
      limit 1`,
    [constraintName],
  );
  return result.rows.length > 0;
}

async function countBlobsForJob(jobId) {
  const result = await query(
    `select count(*)::int as count
       from public.catastrox_deliverable_blobs
      where deliverable_id in (
        select id from public.catastrox_deliverables where delivery_job_id = $1
      )`,
    [jobId],
  );
  return result.rows[0]?.count || 0;
}

async function createApprovedDeliveryJobForDirectProcessing(app, { email = 'delivery-concurrency@example.com' } = {}) {
  const { customerId } = await createVerifiedTestCustomer(app.baseUrl);
  const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID, customerId, purchaseAttemptId: crypto.randomUUID() }),
  });
  const { reference } = (await checkoutResponse.json()).checkout;
  const orderRow = await query('select * from public.catastrox_payment_orders where wompi_reference = $1', [reference]);
  const order = orderRow.rows[0];
  await query("update public.catastrox_payment_orders set status = 'APPROVED' where id = $1", [order.id]);
  order.status = 'APPROVED';
  const job = await deliveryJobService.createDeliveryJobForOrder({
    orderId: order.id,
    customerId,
    deliveryEmail: email,
  });
  return { order, customerId, job };
}

test('CATX-DELIVERY-001: ciclo de vida del delivery job (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  const originalEventsSecret = process.env.WOMPI_EVENTS_SECRET_TEST;
  process.env.WOMPI_EVENTS_SECRET_TEST = EVENTS_SECRET;

  t.after(() => {
    if (originalEventsSecret === undefined) delete process.env.WOMPI_EVENTS_SECRET_TEST;
    else process.env.WOMPI_EVENTS_SECRET_TEST = originalEventsSecret;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  // CATX-DELIVERY-OBSERVABILITY-001: sumadas, las pruebas de este archivo
  // ya superan el máximo real de checkoutLimiter (10 por 5 minutos) --
  // resetear antes de cada subprueba evita falsos 429 (mismo mecanismo que
  // catastroxPaymentOrders.test.js).
  t.beforeEach(() => resetRateLimiters());

  await t.test('1) una orden NO aprobada nunca genera un deliverable', async () => {
    const app = await startTestApp();
    let order = null;
    let customerId = null;
    try {
      const { customerId: cid } = await createVerifiedTestCustomer(app.baseUrl);
      customerId = cid;
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const { reference } = (await checkoutResponse.json()).checkout;
      const orderRow = await query('select * from public.catastrox_payment_orders where wompi_reference = $1', [reference]);
      order = orderRow.rows[0];
      // El checkout crea la orden directamente en PENDING (a la espera de
      // la confirmación de Wompi) -- esta prueba nunca dispara el webhook,
      // así que se queda ahí a propósito (nunca APPROVED).
      assert.equal(order.status, 'PENDING');

      const job = await deliveryJobService.createDeliveryJobForOrder({
        orderId: order.id,
        customerId,
        deliveryEmail: 'no-approved@example.com',
      });
      const processed = await deliveryJobService.processDeliveryJob(job.id);

      assert.equal(processed.status, 'FAILED');
      assert.equal(processed.last_error_code, 'ORDER_NOT_APPROVED');

      const deliverables = await deliveryJobService.listDeliverablesForJob(job.id);
      assert.equal(deliverables.length, 0, 'ninguna orden no aprobada debe generar un deliverable');
    } finally {
      await cleanupOrder(order, customerId);
      await app.close();
    }
  });

  await t.test('2) APPROVED + generación exitosa: checksum y tamaño se persisten, coinciden con los bytes almacenados', async () => {
    const app = await startTestApp();
    let created;
    try {
      created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-2' });
      assert.equal(created.order.status, 'APPROVED');

      const terminalJob = await waitForDeliveryJobTerminal(created.order.id);
      assert.ok(terminalJob, 'el job debe llegar a un estado terminal');
      // En dev/test el proveedor de correo real está deshabilitado --
      // FAILED/EMAIL_PROVIDER_DISABLED es el resultado honesto esperado,
      // pero el PDF ya debe haberse generado y almacenado correctamente
      // (ajuste obligatorio #3).
      assert.equal(terminalJob.status, 'FAILED');
      assert.equal(terminalJob.last_error_code, 'EMAIL_PROVIDER_DISABLED');

      const deliverables = await deliveryJobService.listDeliverablesForJob(terminalJob.id);
      assert.equal(deliverables.length, 1);
      const deliverable = deliverables[0];
      assert.ok(deliverable.byte_size > 0);
      assert.equal(deliverable.file_name, `${INTEGRATION_TEST_CODIGO}_basico.pdf`);
      assert.match(deliverable.content_hash, /^[0-9a-f]{64}$/);

      const verified = await deliveryJobService.fetchVerifiedDeliverableForOrder(created.order.id);
      assert.ok(verified, 'la descarga debe poder recuperar bytes verificados aunque el correo no se haya enviado');
      assert.equal(verified.bytes.length, deliverable.byte_size);
      assert.equal(
        crypto.createHash('sha256').update(verified.bytes).digest('hex'),
        deliverable.content_hash,
        'el checksum recalculado sobre los bytes almacenados debe coincidir con el persistido',
      );
    } finally {
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('3) envío exitoso (staging simulado) -> SENT + delivered_at, sin regenerar el PDF ya almacenado', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-3' });
      const failedJob = await waitForDeliveryJobTerminal(created.order.id);
      assert.equal(failedJob.status, 'FAILED');
      const deliverableBefore = (await deliveryJobService.listDeliverablesForJob(failedJob.id))[0];

      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      withFetchMock((url) => {
        if (url.includes('api.resend.com')) return jsonResponse(200, { id: 'msg_lifecycle_3' });
        return jsonResponse(500, { message: 'no debería llamarse en este paso' });
      });
      let sentJob;
      try {
        sentJob = await deliveryJobService.retryDeliveryJob(failedJob.id);
      } finally {
        restoreFetch();
      }

      assert.equal(sentJob.status, 'SENT');
      assert.equal(sentJob.last_error_code, null);
      assert.ok(sentJob.delivered_at, 'delivered_at (usado como sent_at) debe quedar registrado');
      assert.equal(sentJob.attempt_count, failedJob.attempt_count + 1);

      const deliverablesAfter = await deliveryJobService.listDeliverablesForJob(failedJob.id);
      assert.equal(deliverablesAfter.length, 1, 'el envío exitoso no debe generar un segundo deliverable');
      assert.equal(deliverablesAfter[0].id, deliverableBefore.id, 'debe reutilizar el mismo deliverable, no regenerarlo');
    } finally {
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('4) error de correo (staging simulado, Resend rechaza) -> FAILED + last_error_code informativo', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-4' });
      const failedJob = await waitForDeliveryJobTerminal(created.order.id);
      assert.equal(failedJob.last_error_code, 'EMAIL_PROVIDER_DISABLED');

      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      withFetchMock((url) => {
        if (url.includes('api.resend.com')) return jsonResponse(400, { message: 'dirección rechazada' });
        return jsonResponse(500, { message: 'no debería llamarse en este paso' });
      });
      let retriedJob;
      try {
        retriedJob = await deliveryJobService.retryDeliveryJob(failedJob.id);
      } finally {
        restoreFetch();
      }

      assert.equal(retriedJob.status, 'FAILED');
      assert.equal(retriedJob.last_error_code, 'EMAIL_PROVIDER_REJECTED');
      assert.equal(retriedJob.attempt_count, failedJob.attempt_count + 1);
    } finally {
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('5) reintentar un job SENT es idempotente: no crea intentos nuevos y HTTP responde OK', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-5' });
      const failedJob = await waitForDeliveryJobTerminal(created.order.id);

      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';
      withFetchMock((url) => (url.includes('api.resend.com') ? jsonResponse(200, { id: 'msg_lifecycle_5' }) : jsonResponse(500, {})));
      let sentJob;
      try {
        sentJob = await deliveryJobService.retryDeliveryJob(failedJob.id);
      } finally {
        restoreFetch();
      }
      assert.equal(sentJob.status, 'SENT');

      const attemptsBefore = await deliveryJobService.listAttemptsForJob(sentJob.id);
      const directRetry = await deliveryJobService.retryDeliveryJob(sentJob.id);
      assert.equal(directRetry.status, 'SENT');
      assert.equal((await deliveryJobService.listAttemptsForJob(sentJob.id)).length, attemptsBefore.length);

      const retryResponse = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/delivery/retry`, {
        method: 'POST',
        headers: { Cookie: created.cookie },
      });
      assert.equal(retryResponse.status, 200);
      const retryPayload = await retryResponse.json();
      assert.equal(retryPayload.ok, true);
      assert.equal(retryPayload.status, 'SENT');
      assert.equal((await deliveryJobService.listAttemptsForJob(sentJob.id)).length, attemptsBefore.length);
    } finally {
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('6) GET .../deliverable/download: 401 sin sesión, 403 de otra sesión, 200 application/pdf con sesión propia', async () => {
    const app = await startTestApp();
    let created;
    let otherCreated;
    try {
      created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-6' });
      await waitForDeliveryJobTerminal(created.order.id);

      // 401: sin cookie de sesión en absoluto.
      const noSession = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/deliverable/download`);
      assert.equal(noSession.status, 401);
      assert.equal((await noSession.json()).code, 'SESSION_REQUIRED');

      // 403: sesión válida, pero de OTRA orden (otro comprador, otra sesión de recuperación).
      otherCreated = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-6b' });
      await waitForDeliveryJobTerminal(otherCreated.order.id);
      const wrongSession = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/deliverable/download`, {
        headers: { Cookie: otherCreated.cookie },
      });
      assert.equal(wrongSession.status, 403);
      assert.equal((await wrongSession.json()).code, 'ORDER_ACCESS_DENIED');

      // 200: sesión propia -- el PDF ya está generado (aunque el correo
      // esté deshabilitado en este entorno, ajuste #3), debe poder descargarse.
      const validDownload = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/deliverable/download`, {
        headers: { Cookie: created.cookie },
      });
      assert.equal(validDownload.status, 200);
      assert.equal(validDownload.headers.get('content-type'), 'application/pdf');
      assert.match(validDownload.headers.get('content-disposition') || '', /attachment/);
      assert.equal(validDownload.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await validDownload.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    } finally {
      await cleanupOrder(created?.order, created?.customerId);
      await cleanupOrder(otherCreated?.order, otherCreated?.customerId);
      await app.close();
    }
  });

  await t.test('7) POST .../delivery/retry: 401 sin sesión, 403 de otra sesión', async () => {
    const app = await startTestApp();
    let created;
    let otherCreated;
    try {
      created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-7' });
      await waitForDeliveryJobTerminal(created.order.id);

      const noSession = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/delivery/retry`, { method: 'POST' });
      assert.equal(noSession.status, 401);
      assert.equal((await noSession.json()).code, 'SESSION_REQUIRED');

      otherCreated = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-7b' });
      await waitForDeliveryJobTerminal(otherCreated.order.id);
      const wrongSession = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/delivery/retry`, {
        method: 'POST',
        headers: { Cookie: otherCreated.cookie },
      });
      assert.equal(wrongSession.status, 403);
      assert.equal((await wrongSession.json()).code, 'ORDER_ACCESS_DENIED');
    } finally {
      await cleanupOrder(created?.order, created?.customerId);
      await cleanupOrder(otherCreated?.order, otherCreated?.customerId);
      await app.close();
    }
  });

  // CATX-PDF-PARITY-002 (ajuste obligatorio #6): si el proveedor de teselas
  // falla, el job debe abortar con MAP_RENDER_FAILED -- nunca almacenar ni
  // enviar un PDF incompleto (nunca se llega a insertar en
  // catastrox_deliverables, porque generateCatastroxPdfBuffer lanza ANTES
  // de que generateAndStoreDeliverable pueda hacer el INSERT).
  await t.test('8) el proveedor de teselas satelitales cae -> FAILED + MAP_RENDER_FAILED, sin deliverable almacenado, reintentable', async () => {
    const app = await startTestApp();
    let created;
    try {
      withMapFailureMock(() => new Response('servicio no disponible', { status: 503 }));
      try {
        created = await createApprovedOrder(app, { transactionId: 'txn-lifecycle-8' });
        const failedJob = await waitForDeliveryJobTerminal(created.order.id);
        assert.equal(failedJob.status, 'FAILED');
        assert.equal(failedJob.last_error_code, 'MAP_RENDER_FAILED');

        const deliverables = await deliveryJobService.listDeliverablesForJob(failedJob.id);
        assert.equal(deliverables.length, 0, 'un fallo de mapa nunca debe dejar un deliverable almacenado');
      } finally {
        restoreMapMock();
      }

      // Reintentable: con el proveedor "recuperado" (mock por defecto,
      // siempre 200), un reintento posterior debe poder generar y
      // almacenar el PDF con normalidad.
      const jobRow = await deliveryJobService.findLatestDeliveryJobForOrder(created.order.id);
      const retried = await deliveryJobService.retryDeliveryJob(jobRow.id);
      assert.notEqual(retried.last_error_code, 'MAP_RENDER_FAILED');
      const deliverablesAfterRetry = await deliveryJobService.listDeliverablesForJob(jobRow.id);
      assert.equal(deliverablesAfterRetry.length, 1, 'el reintento exitoso debe generar y almacenar exactamente un deliverable');
    } finally {
      restoreMapMock();
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  // CATX-DELIVERY-OBSERVABILITY-001 (requisito 9): el escenario completo
  // pedido explícitamente -- un primer intento que falla ANTES de crear
  // ningún deliverable (orden aún no aprobada), un segundo intento (tras la
  // aprobación real) que genera exactamente un deliverable, y el historial
  // en catastrox_delivery_attempts conservando AMBAS filas sin sobrescribir
  // la primera. La aprobación se fuerza por SQL directo en vez de un
  // segundo webhook a propósito: aísla la condición de carrera real
  // (job creado/procesado antes de que la orden esté APPROVED) sin
  // depender de reproducir la firma/checksum de Wompi otra vez.
  await t.test('9) primer intento falla antes del deliverable; segundo intento (ya aprobada) crea uno solo; el historial conserva ambos', async () => {
    const app = await startTestApp();
    let order = null;
    let customerId = null;
    try {
      const { customerId: cid } = await createVerifiedTestCustomer(app.baseUrl);
      customerId = cid;
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const { reference } = (await checkoutResponse.json()).checkout;
      const orderRow = await query('select * from public.catastrox_payment_orders where wompi_reference = $1', [reference]);
      order = orderRow.rows[0];
      assert.equal(order.status, 'PENDING');

      const job = await deliveryJobService.createDeliveryJobForOrder({
        orderId: order.id,
        customerId,
        deliveryEmail: 'no-approved-yet@example.com',
      });

      // --- Primer intento: la orden todavía no está APPROVED. ---
      const firstAttemptJob = await deliveryJobService.processDeliveryJob(job.id);
      assert.equal(firstAttemptJob.status, 'FAILED');
      assert.equal(firstAttemptJob.last_error_code, 'ORDER_NOT_APPROVED');
      assert.equal(
        (await deliveryJobService.listDeliverablesForJob(job.id)).length,
        0,
        'el primer intento no debe dejar ningún deliverable almacenado',
      );

      const attemptsAfterFirst = await deliveryJobService.listAttemptsForJob(job.id);
      assert.equal(attemptsAfterFirst.length, 1, 'debe existir exactamente una fila de historial tras el primer intento');
      assert.equal(attemptsAfterFirst[0].attempt_number, 1);
      assert.equal(attemptsAfterFirst[0].status, 'FAILED');
      assert.equal(attemptsAfterFirst[0].error_code, 'ORDER_NOT_APPROVED');
      assert.equal(attemptsAfterFirst[0].deliverable_id, null);

      // --- La orden pasa a APPROVED (aprobación real, fuera de este job). ---
      await query("update public.catastrox_payment_orders set status = 'APPROVED' where id = $1", [order.id]);

      // --- Segundo intento: ahora sí debe generar y almacenar el PDF. ---
      const secondAttemptJob = await deliveryJobService.retryDeliveryJob(job.id);
      assert.equal(secondAttemptJob.attempt_count, 2);
      // En dev/test el proveedor de correo real sigue deshabilitado -- el
      // job vuelve a quedar FAILED, pero esta vez el deliverable SÍ debe
      // haberse generado y almacenado (ajuste obligatorio #3).
      assert.equal(secondAttemptJob.last_error_code, 'EMAIL_PROVIDER_DISABLED');

      const deliverablesAfterSecond = await deliveryJobService.listDeliverablesForJob(job.id);
      assert.equal(deliverablesAfterSecond.length, 1, 'el segundo intento debe crear un único deliverable, no duplicarlo');
      const deliverable = deliverablesAfterSecond[0];

      const attemptsAfterSecond = await deliveryJobService.listAttemptsForJob(job.id);
      assert.equal(attemptsAfterSecond.length, 2, 'el historial debe conservar ambos intentos como filas separadas');
      assert.equal(attemptsAfterSecond[0].attempt_number, 1);
      assert.equal(attemptsAfterSecond[0].error_code, 'ORDER_NOT_APPROVED', 'el primer intento no debe reescribirse al insertar el segundo');
      assert.equal(attemptsAfterSecond[0].deliverable_id, null);
      assert.equal(attemptsAfterSecond[1].attempt_number, 2);
      assert.equal(attemptsAfterSecond[1].error_code, 'EMAIL_PROVIDER_DISABLED');
      assert.equal(attemptsAfterSecond[1].deliverable_id, deliverable.id);

      // --- Checksum: blob almacenado / descarga / adjunto de correo deben coincidir. ---
      // fetchVerifiedDeliverableForOrder es exactamente la función que usa
      // el endpoint GET .../deliverable/download (server/routes/catastroxPayments.js)
      // para servir los bytes -- reutilizarla aquí prueba la misma ruta de
      // lectura+re-verificación de checksum que atraviesa una descarga real,
      // sin necesidad de duplicar aquí la lógica de sesión/ownership ya
      // cubierta por la prueba 6.
      const verified = await deliveryJobService.fetchVerifiedDeliverableForOrder(order.id);
      const blobChecksum = crypto.createHash('sha256').update(verified.bytes).digest('hex');
      assert.equal(blobChecksum, deliverable.content_hash);

      const originalAppEnv = process.env.APP_ENV;
      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      let capturedAttachmentBase64 = null;
      withFetchMock((url, options) => {
        if (url.includes('api.resend.com')) {
          capturedAttachmentBase64 = JSON.parse(options.body).attachments[0].content;
          return jsonResponse(200, { id: 'msg_lifecycle_9' });
        }
        return jsonResponse(500, { message: 'no debería llamarse en este paso' });
      });
      let sentJob;
      try {
        sentJob = await deliveryJobService.retryDeliveryJob(job.id);
      } finally {
        restoreFetch();
        if (originalAppEnv === undefined) delete process.env.APP_ENV;
        else process.env.APP_ENV = originalAppEnv;
      }
      assert.equal(sentJob.status, 'SENT');
      assert.ok(capturedAttachmentBase64, 'el correo enviado debe llevar el PDF como adjunto');
      const emailChecksum = crypto.createHash('sha256').update(Buffer.from(capturedAttachmentBase64, 'base64')).digest('hex');
      assert.equal(emailChecksum, deliverable.content_hash, 'el adjunto del correo debe tener el mismo checksum que el blob almacenado');

      assert.equal(
        (await deliveryJobService.listDeliverablesForJob(job.id)).length,
        1,
        'el envío exitoso final tampoco debe duplicar el deliverable',
      );
      const attemptsFinal = await deliveryJobService.listAttemptsForJob(job.id);
      assert.equal(attemptsFinal.length, 3, 'el tercer intento (envío exitoso) agrega su propia fila, sin tocar las dos anteriores');
      assert.equal(attemptsFinal[2].status, 'SENT');
      assert.equal(attemptsFinal[2].content_hash, deliverable.content_hash);
    } finally {
      await cleanupOrder(order, customerId);
      await app.close();
    }
  });

  await t.test('10) dos processDeliveryJob concurrentes reclaman una sola vez, crean un deliverable y envían un solo correo', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedDeliveryJobForDirectProcessing(app);
      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      let sendCount = 0;
      withFetchMock((url) => {
        if (url.includes('api.resend.com')) {
          sendCount += 1;
          return jsonResponse(200, { id: `msg_concurrent_${sendCount}` });
        }
        return jsonResponse(500, { message: 'no debería llamarse en este paso' });
      });
      try {
        await Promise.all([
          deliveryJobService.processDeliveryJob(created.job.id),
          deliveryJobService.processDeliveryJob(created.job.id),
        ]);
      } finally {
        restoreFetch();
      }

      const finalJob = await deliveryJobService.findLatestDeliveryJobForOrder(created.order.id);
      const attempts = await deliveryJobService.listAttemptsForJob(created.job.id);
      const deliverables = await deliveryJobService.listDeliverablesForJob(created.job.id);

      assert.equal(finalJob.status, 'SENT');
      assert.equal(finalJob.attempt_count, 1);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attempt_number, 1);
      assert.equal(attempts[0].status, 'SENT');
      assert.equal(deliverables.length, 1);
      assert.equal(await countBlobsForJob(created.job.id), 1);
      assert.equal(sendCount, 1);
    } finally {
      restoreFetch();
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('11) dos retries simultáneos sobre FAILED producen un solo intento nuevo y un solo correo', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedDeliveryJobForDirectProcessing(app);
      const failed = await deliveryJobService.processDeliveryJob(created.job.id);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.attempt_count, 1);

      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      let sendCount = 0;
      withFetchMock((url) => {
        if (url.includes('api.resend.com')) {
          sendCount += 1;
          return jsonResponse(200, { id: `msg_retry_concurrent_${sendCount}` });
        }
        return jsonResponse(500, { message: 'no debería llamarse en este paso' });
      });
      try {
        await Promise.all([
          deliveryJobService.retryDeliveryJob(created.job.id),
          deliveryJobService.retryDeliveryJob(created.job.id),
        ]);
      } finally {
        restoreFetch();
      }

      const finalJob = await deliveryJobService.findLatestDeliveryJobForOrder(created.order.id);
      const attempts = await deliveryJobService.listAttemptsForJob(created.job.id);
      const deliverables = await deliveryJobService.listDeliverablesForJob(created.job.id);

      assert.equal(finalJob.status, 'SENT');
      assert.equal(finalJob.attempt_count, 2);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1].attempt_number, 2);
      assert.equal(attempts[1].status, 'SENT');
      assert.equal(deliverables.length, 1, 'el retry exitoso reutiliza el deliverable existente');
      assert.equal(await countBlobsForJob(created.job.id), 1);
      assert.equal(sendCount, 1);
    } finally {
      restoreFetch();
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('12) dos ejecuciones sobre un job SENT son idempotentes: cero intentos, cero deliverables y cero correos nuevos', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedDeliveryJobForDirectProcessing(app);
      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      withFetchMock((url) => (url.includes('api.resend.com') ? jsonResponse(200, { id: 'msg_sent_once' }) : jsonResponse(500, {})));
      try {
        await deliveryJobService.processDeliveryJob(created.job.id);
      } finally {
        restoreFetch();
      }

      const attemptsBefore = await deliveryJobService.listAttemptsForJob(created.job.id);
      const deliverablesBefore = await deliveryJobService.listDeliverablesForJob(created.job.id);
      let sendCount = 0;
      withFetchMock((url) => {
        if (url.includes('api.resend.com')) sendCount += 1;
        return jsonResponse(500, { message: 'no debería llamarse para SENT' });
      });
      try {
        await Promise.all([
          deliveryJobService.processDeliveryJob(created.job.id),
          deliveryJobService.processDeliveryJob(created.job.id),
        ]);
      } finally {
        restoreFetch();
      }

      assert.equal((await deliveryJobService.listAttemptsForJob(created.job.id)).length, attemptsBefore.length);
      assert.equal((await deliveryJobService.listDeliverablesForJob(created.job.id)).length, deliverablesBefore.length);
      assert.equal(await countBlobsForJob(created.job.id), 1);
      assert.equal(sendCount, 0);
    } finally {
      restoreFetch();
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('13) conflicto UNIQUE de intento se maneja sin generar deliverable ni enviar correo', { skip: !(await hasConstraint('uq_catastrox_delivery_attempts_job_attempt')) }, async () => {
    const app = await startTestApp();
    let created;
    try {
      created = await createApprovedDeliveryJobForDirectProcessing(app);
      await query(
        `insert into public.catastrox_delivery_attempts (delivery_job_id, attempt_number, status)
         values ($1, 1, 'FAILED')`,
        [created.job.id],
      );
      const processed = await deliveryJobService.processDeliveryJob(created.job.id);
      assert.equal(processed.status, 'FAILED');
      assert.equal(processed.last_error_code, 'DELIVERY_ATTEMPT_CONFLICT');
      assert.equal((await deliveryJobService.listDeliverablesForJob(created.job.id)).length, 0);
      assert.equal(await countBlobsForJob(created.job.id), 0);
    } finally {
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });

  await t.test('14) estado activo vencido es recuperable por timeout y no queda bloqueado permanentemente', async () => {
    const app = await startTestApp();
    let created;
    const originalAppEnv = process.env.APP_ENV;
    try {
      created = await createApprovedDeliveryJobForDirectProcessing(app);
      const failed = await deliveryJobService.processDeliveryJob(created.job.id);
      assert.equal(failed.status, 'FAILED');
      await query(
        `update public.catastrox_delivery_jobs
            set status = 'SENDING',
                provider_message_id = null,
                last_attempt_at = now() - interval '31 minutes'
          where id = $1`,
        [created.job.id],
      );

      process.env.APP_ENV = 'staging';
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
      process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

      let sendCount = 0;
      withFetchMock((url) => {
        if (url.includes('api.resend.com')) {
          sendCount += 1;
          return jsonResponse(200, { id: 'msg_stale_sending_recovered' });
        }
        return jsonResponse(500, { message: 'no debería llamarse en este paso' });
      });
      try {
        await deliveryJobService.processDeliveryJob(created.job.id);
      } finally {
        restoreFetch();
      }

      const finalJob = await deliveryJobService.findLatestDeliveryJobForOrder(created.order.id);
      assert.equal(finalJob.status, 'SENT');
      assert.equal(finalJob.attempt_count, 2);
      assert.equal(sendCount, 1);
      assert.equal((await deliveryJobService.listDeliverablesForJob(created.job.id)).length, 1);
      assert.equal(await countBlobsForJob(created.job.id), 1);
    } finally {
      restoreFetch();
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await cleanupOrder(created?.order, created?.customerId);
      await app.close();
    }
  });
});
