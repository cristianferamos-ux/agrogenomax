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
//   - reintento de SENT se rechaza (409, vía retryDeliveryJob y vía la ruta HTTP)
//   - descarga sin sesión -> 401; de otra orden/sesión -> 403; válida -> 200 application/pdf
//   - reintento HTTP sin sesión -> 401; de otra orden -> 403
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

// Predio real y resoluble por resolvePredioDataForDelivery (verificado en
// vivo durante el sprint: MILAN/CAQUETA, ~437 ha) -- se usa a propósito en
// vez de un código sintético (900...) porque estas pruebas necesitan que la
// generación PDFKit realmente tenga éxito (para probar checksum/tamaño y el
// camino hasta SENT), no solo que falle de forma honesta.
const REAL_TEST_CODIGO = '184600002000000030015000000000';
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

if (dbAvailable) {
  ({ default: catastroxPaymentsRouter } = await import('../catastroxPayments.js'));
  ({ computeWompiEventChecksum } = await import('../../services/catastrox/wompiEventVerification.js'));
  ({ __rememberLookupPreviewForTests } = await import('../catastrox.js'));
  __rememberLookupPreviewForTests(TEST_ROUTE_ID, { canonicalPredioId: REAL_TEST_CODIGO, codigoPredial: REAL_TEST_CODIGO });
  deliveryJobService = await import('../../services/catastrox/deliveryJobService.js');
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
      assert.equal(deliverable.file_name, `${REAL_TEST_CODIGO}_basico.pdf`);
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

  await t.test('5) reintentar un job SENT se rechaza (DELIVERY_NOT_RETRYABLE), directo y vía la ruta HTTP (409)', async () => {
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

      await assert.rejects(
        () => deliveryJobService.retryDeliveryJob(sentJob.id),
        (error) => error.code === 'DELIVERY_NOT_RETRYABLE',
      );

      const retryResponse = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(created.orderToken)}/delivery/retry`, {
        method: 'POST',
        headers: { Cookie: created.cookie },
      });
      assert.equal(retryResponse.status, 409);
      const retryPayload = await retryResponse.json();
      assert.equal(retryPayload.code, 'DELIVERY_NOT_RETRYABLE');
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
});
