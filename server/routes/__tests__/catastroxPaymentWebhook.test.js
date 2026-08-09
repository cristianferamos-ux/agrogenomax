// Pruebas de integración del webhook POST /api/catastrox/payments/wompi/events
// contra Postgres real -- se auto-omiten si no hay base alcanzable (mismo
// criterio que catastroxPaymentOrders.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

// P1-02/P1-03 (remediación post-auditoría): POST /checkout ahora exige un
// predio resoluble por resolveCheckoutPredioEligibility antes de crear
// cualquier orden -- ya no es posible, a través de un checkout normal,
// obtener una orden APROBADA cuyo canonicalPredioId no pueda resolver
// después el pipeline de entrega. Este archivo usa INTEGRATION_TEST_CODIGO
// -- un código predial SINTÉTICO de 30 dígitos (nunca uno real; verificado
// contra validateCadastralCodeInput/normalizeCadastralCodeInput/
// resolveCanonicalPredioId: ninguna exige checksum ni validación
// territorial, solo dígitos numéricos), resuelto localmente por
// scripts/catastrox/test/setup_integration_postgis.sql -- mismo código que
// catastroxDeliveryLifecycle.test.js/catastroxPaymentOrders.test.js. Toda
// la limpieza de este archivo se hace por customer_id (ver
// createdCustomerIds/cleanupTestData más abajo), nunca por
// canonical_predio_id, porque INTEGRATION_TEST_CODIGO ahora se comparte
// entre varios archivos que node --test puede ejecutar en paralelo.
const INTEGRATION_TEST_CODIGO = '999999999999999999999999999901';
const EVENTS_SECRET = 'events_secret_de_prueba_treinta_dos_caracteres_o_mas_1234';
// Corrección de seguridad (checkout sin fallback inseguro): POST /checkout
// exige un routeId que resuelva a un lookup vigente -- ver la misma nota
// en catastroxPaymentOrders.test.js.
const TEST_ROUTE_ID = 'cx-test-webhook-route';

// Identificador único por ejecución del archivo -- misma razón que en
// catastroxPaymentOrders.test.js: wompi_transaction_id tiene una UNIQUE
// global, y un literal fijo reutilizado entre corridas puede colisionar con
// una fila residual de una ejecución anterior.
const TEST_RUN_ID = crypto.randomUUID();

function testTransactionId(label) {
  return `txn-${label}-${TEST_RUN_ID}`;
}

let dbAvailable = false;
let getConfig;
let getDbPool;
let query;
let catastroxPaymentsRouter;
let computeWompiEventChecksum;
let __rememberLookupPreviewForTests;
let paymentOrders;
let createDeliveryJobForOrder;
let processDeliveryJob;

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

if (dbAvailable) {
  ({ default: catastroxPaymentsRouter } = await import('../catastroxPayments.js'));
  ({ computeWompiEventChecksum } = await import('../../services/catastrox/wompiEventVerification.js'));
  ({ __rememberLookupPreviewForTests } = await import('../catastrox.js'));
  paymentOrders = await import('../../services/catastrox/paymentOrderRepository.js');
  ({ createDeliveryJobForOrder, processDeliveryJob } = await import('../../services/catastrox/deliveryJobService.js'));
  __rememberLookupPreviewForTests(TEST_ROUTE_ID, { canonicalPredioId: INTEGRATION_TEST_CODIGO, codigoPredial: INTEGRATION_TEST_CODIGO });
}

const originalFetch = globalThis.fetch;

function withWompiFetchMock(handler) {
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('sandbox.wompi.co')) return handler(url, options);
    return originalFetch(url, options);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
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

let customerCounter = 0;
// Toda limpieza de este archivo se hace por customer_id (ver comentario de
// INTEGRATION_TEST_CODIGO arriba) -- cada customerId es un UUID fresco de este
// proceso de test, así que este scope nunca colisiona con filas de otro
// archivo aunque compartan el mismo predio real.
const createdCustomerIds = [];

// El checkout ahora exige un comprador con correo verificado (Bloque 2/5) --
// este helper reproduce el flujo real (POST /customers -> POST
// .../verify-email) usando el devOtpCode que development/test exponen.
async function createVerifiedTestCustomer(baseUrl) {
  customerCounter += 1;
  const email = `webhook-test-${Date.now()}-${customerCounter}@example.com`;
  const response = await fetch(`${baseUrl}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerType: 'natural',
      firstName: 'Webhook',
      lastName: 'Test',
      documentType: 'CC',
      documentNumber: `90000${customerCounter}${Date.now()}`.slice(0, 15),
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
  if (payload.customerId) createdCustomerIds.push(payload.customerId);
  return payload.customerId;
}

function buildSignedEvent({ transactionId, reference, status = 'APPROVED', amountInCents = 3990000, timestamp = 1732550400, secret = EVENTS_SECRET }) {
  const data = {
    transaction: {
      id: transactionId,
      status,
      amount_in_cents: amountInCents,
      reference,
    },
  };
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents', 'transaction.reference'];
  const checksum = computeWompiEventChecksum({ properties, data, timestamp, secret });
  return {
    event: 'transaction.updated',
    data,
    environment: 'test',
    timestamp,
    sent_at: new Date().toISOString(),
    signature: { properties, checksum },
  };
}

// CATX-DELIVERY-001 (ajuste obligatorio #8): triggerPostApprovalWorkflows ya
// no espera a que termine processDeliveryJob -- lo dispara desacoplado para
// no bloquear la respuesta del webhook/verify. Las pruebas que necesitan el
// estado TERMINAL del delivery job (para no aseverar contra un QUEUED/
// GENERATING todavía en curso) deben esperarlo explícitamente en vez de
// asumir que ya terminó cuando la petición HTTP responde.
async function waitForDeliveryJobTerminal(orderId, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await query('select status, last_error_code from public.catastrox_delivery_jobs where payment_order_id = $1', [orderId]);
    const status = result.rows[0]?.status;
    if (status === 'SENT' || status === 'FAILED') return result.rows;
    if (Date.now() >= deadline) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// A diferencia de waitForDeliveryJobTerminal (arriba, por-orderId, usado
// dentro de un test puntual para poder asertar contra un estado terminal
// conocido), este helper es exclusivo del teardown: actúa sobre TODOS los
// orderIds creados por esta suite a la vez, y -- a propósito -- lanza si
// vence el timeout, en vez de devolver silenciosamente lo que haya. El
// checkout/verify/webhook real nunca espera a processDeliveryJob()
// (triggerPostApprovalWorkflows lo dispara con `void processDeliveryJob(job.id)
// .catch(...)`, fire-and-forget por diseño, CATX-DELIVERY-001 ajuste #8),
// así que un job puede seguir activo (QUEUED/GENERATING/READY/SENDING) en
// segundo plano incluso después de que la petición HTTP ya respondió. Si
// el teardown borra catastrox_delivery_jobs mientras esa escritura en
// curso todavía intenta insertar en catastrox_deliverables, choca contra
// la FK catastrox_deliverables_delivery_job_id_fkey -- una carrera de
// TEST, no un defecto del pipeline de entrega (SENT/FAILED siguen siendo
// sus únicos estados terminales por diseño). Solo consulta Postgres, nunca
// muta el job ni llama processDeliveryJob.
async function waitForDeliveryJobsToSettle(orderIds, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  if (!orderIds.length) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await query(
      `select id, status from public.catastrox_delivery_jobs
        where payment_order_id = any($1)
          and status not in ('SENT', 'FAILED')`,
      [orderIds],
    );
    if (result.rows.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForDeliveryJobsToSettle: timeout esperando estado terminal (SENT/FAILED) de ${result.rows.length} delivery job(s): ` +
          result.rows.map((row) => `${row.id}=${row.status}`).join(', '),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function cleanupTestData() {
  if (!dbAvailable || !createdCustomerIds.length) return;
  const orders = await query('select id from public.catastrox_payment_orders where customer_id = any($1)', [createdCustomerIds]);
  const orderIds = orders.rows.map((row) => row.id);

  if (orderIds.length) {
    await waitForDeliveryJobsToSettle(orderIds);
    await query('delete from public.catastrox_deliverable_blobs where deliverable_id in (select id from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1)))', [orderIds]);
    await query('delete from public.catastrox_delivery_attempts where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1))', [orderIds]);
    await query('delete from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1))', [orderIds]);
    await query('delete from public.catastrox_delivery_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_invoice_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_recovery_session_orders where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_billing_profiles where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_payment_orders where id = any($1)', [orderIds]);
  }
  await query("delete from public.catastrox_payment_webhook_events where wompi_transaction_id like 'txn-webhook-%' or wompi_transaction_id like 'txn-toctou-%'");
  await query('delete from public.catastrox_email_verifications where customer_id = any($1)', [createdCustomerIds]);
  await query('delete from public.catastrox_customer_otp_state where customer_id = any($1)', [createdCustomerIds]);
  await query('delete from public.catastrox_customers where id = any($1)', [createdCustomerIds]);
  await query(
    `delete from public.catastrox_recovery_sessions
      where id not in (select recovery_session_id from public.catastrox_recovery_session_orders)
        and created_at > now() - interval '1 hour'`,
  );
}

test('webhook de eventos de Wompi (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  const originalEventsSecret = process.env.WOMPI_EVENTS_SECRET_TEST;
  process.env.WOMPI_EVENTS_SECRET_TEST = EVENTS_SECRET;

  t.after(async () => {
    if (originalEventsSecret === undefined) delete process.env.WOMPI_EVENTS_SECRET_TEST;
    else process.env.WOMPI_EVENTS_SECRET_TEST = originalEventsSecret;
    await cleanupTestData();
  });

  await t.test('firma inválida -> 401, no procesa nada', async () => {
    const app = await startTestApp();
    try {
      const event = buildSignedEvent({ transactionId: testTransactionId('webhook-1'), reference: 'CATX-BASICO-NOEXISTE' });
      event.signature.checksum = 'f'.repeat(64);

      const response = await fetch(`${app.baseUrl}/wompi/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      assert.equal(response.status, 401);
    } finally {
      await app.close();
    }
  });

  await t.test('payload malformado -> rechazado, no lanza', async () => {
    const app = await startTestApp();
    try {
      const response = await fetch(`${app.baseUrl}/wompi/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'transaction.updated' }),
      });
      assert.equal(response.status, 401);
    } finally {
      await app.close();
    }
  });

  await t.test('evento de tipo desconocido -> 200 ignorado, no toca ninguna orden', async () => {
    const app = await startTestApp();
    try {
      const event = buildSignedEvent({ transactionId: testTransactionId('webhook-2'), reference: 'CATX-BASICO-CUALQUIERA' });
      event.event = 'nequi_token.updated';
      // Recalcular firma para el nuevo tipo de evento no es necesario --
      // el checksum no depende de `event`, solo de `data`/`timestamp`/secreto.

      const response = await fetch(`${app.baseUrl}/wompi/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.ignored, true);
    } finally {
      await app.close();
    }
  });

  await t.test('webhook aprueba una orden creada por /checkout sin pasar por /verify, y el replay es idempotente', async () => {
    const app = await startTestApp();
    try {
      const customerId = await createVerifiedTestCustomer(app.baseUrl);
      const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: 'basico', routeId: TEST_ROUTE_ID, customerId, purchaseAttemptId: crypto.randomUUID() }),
      });
      const { reference, orderToken } = (await checkoutResponse.json()).checkout;

      const txnId = testTransactionId('webhook-3');
      const event = buildSignedEvent({ transactionId: txnId, reference });

      withWompiFetchMock(() =>
        jsonResponse(200, {
          data: { id: txnId, status: 'APPROVED', reference, amount_in_cents: 3990000, currency: 'COP' },
        }),
      );

      let firstResponse;
      let secondResponse;
      try {
        firstResponse = await fetch(`${app.baseUrl}/wompi/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        // Replay exacto del mismo evento -- Wompi puede reenviarlo.
        secondResponse = await fetch(`${app.baseUrl}/wompi/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
      } finally {
        restoreFetch();
      }

      assert.equal(firstResponse.status, 200);
      assert.equal(secondResponse.status, 200);
      const secondPayload = await secondResponse.json();
      assert.equal(secondPayload.deduplicated, true);

      const statusResponse = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(orderToken)}/status`);
      const statusPayload = await statusResponse.json();
      assert.equal(statusPayload.order.status, 'APPROVED');

      // Bloque 8/11: la aprobación real (no el replay) debe haber creado
      // el trabajo de entrega y el de facturación exactamente una vez.
      const orderRow = await query('select id from public.catastrox_payment_orders where wompi_reference = $1', [reference]);
      const orderId = orderRow.rows[0].id;
      const deliveryJobRows = await waitForDeliveryJobTerminal(orderId);
      assert.equal(deliveryJobRows.length, 1, 'exactamente un delivery job, el replay no debe duplicarlo');
      // P1-02/P1-03: INTEGRATION_TEST_CODIGO SÍ es resoluble por
      // resolveCheckoutPredioEligibility/resolvePredioDataForDelivery --
      // la generación real del PDF (PDFKit) tiene éxito. FAILED aquí sigue
      // siendo honesto, pero por una razón distinta y ya cubierta por su
      // propia suite (EMAIL_PROVIDER_DISABLED, ver
      // catastroxDeliveryLifecycle.test.js): este entorno de test no
      // configura EMAIL_PROVIDER=resend, así que el envío de correo real
      // está deshabilitado -- nunca se simula un SENT falso. Antes de
      // P1-02/P1-03, este mismo test usaba un predio sintético no
      // resoluble y esperaba PREDIO_DATA_UNAVAILABLE -- ese escenario ya
      // no puede originarse mediante un checkout normal (el nuevo guard lo
      // bloquea antes de crear la orden); PREDIO_DATA_UNAVAILABLE se
      // prueba ahora por separado, como defensa del delivery ante una
      // orden histórica/corrupta (ver el test siguiente).
      assert.equal(deliveryJobRows[0].status, 'FAILED', 'entorno de test sin EMAIL_PROVIDER=resend -- FAILED esperado, nunca SENT simulado');
      assert.equal(deliveryJobRows[0].last_error_code, 'EMAIL_PROVIDER_DISABLED');

      const invoiceJobs = await query('select status from public.catastrox_invoice_jobs where payment_order_id = $1', [orderId]);
      assert.equal(invoiceJobs.rows.length, 1, 'exactamente un invoice job, el replay no debe duplicarlo');
      assert.equal(invoiceJobs.rows[0].status, 'NOT_REQUESTED');
    } finally {
      await app.close();
    }
  });

  // P1-02/P1-03 (remediación post-auditoría), regla 11: PREDIO_DATA_UNAVAILABLE
  // debe seguir probado como defensa del delivery ante TOCTOU/corrupción/
  // orden histórica -- pero ya NO es alcanzable a través de un checkout
  // normal (resolveCheckoutPredioEligibility lo bloquea antes de crear la
  // orden, ver catastroxPaymentOrders.test.js). Este test reproduce
  // exactamente ese escenario histórico: una orden APROBADA cuyo
  // canonicalPredioId ya no es resoluble (p. ej. el predio existía al
  // momento de la compra y fue depurado/corregido después) -- se construye
  // directamente a nivel de repositorio (insertPendingOrder +
  // applyVerifiedTransaction, exactamente las mismas funciones que usa el
  // webhook real internamente), deliberadamente SIN pasar por POST
  // /checkout, para no depender de ningún bypass/flag de producción.
  await t.test(
    'PREDIO_DATA_UNAVAILABLE sigue protegiendo la entrega ante una orden histórica con predio no resoluble (TOCTOU/corrupción) -- inalcanzable ya por un checkout nuevo',
    async () => {
      const app = await startTestApp();
      try {
        const customerId = await createVerifiedTestCustomer(app.baseUrl);
        const unresolvableCanonicalPredioId = '900000000000000000000000000003';
        const orderToken = paymentOrders.generateOrderToken();
        const order = await paymentOrders.insertPendingOrder({
          orderToken,
          packageId: 'basico',
          canonicalPredioId: unresolvableCanonicalPredioId,
          codigoPredialNormalized: null,
          customerId,
          idempotencyKey: crypto.randomUUID(),
          wompiReference: `CATX-BASICO-TOCTOU-${Date.now()}`,
          expectedAmountInCents: 3990000,
          currency: 'COP',
        });

        const approvedOrder = await paymentOrders.applyVerifiedTransaction({
          orderId: order.id,
          nextStatus: 'APPROVED',
          wompiTransactionId: `txn-toctou-${Date.now()}`,
          verificationSource: 'webhook',
          fromStatuses: ['PENDING'],
        });
        assert.ok(approvedOrder, 'la orden histórica simulada debe quedar APPROVED');

        const job = await createDeliveryJobForOrder({ orderId: order.id, customerId, deliveryEmail: 'toctou-test@example.com' });
        await processDeliveryJob(job.id);

        const terminalJob = await query(
          'select status, last_error_code from public.catastrox_delivery_jobs where id = $1',
          [job.id],
        );
        assert.equal(terminalJob.rows[0].status, 'FAILED');
        assert.equal(terminalJob.rows[0].last_error_code, 'PREDIO_DATA_UNAVAILABLE');
      } finally {
        await app.close();
      }
    },
  );

  // Bloque 2 -- defecto corregido: antes, un fallo entre "marcar el evento
  // como visto" y "transicionar la orden" perdía el webhook para siempre
  // (se respondía 200 igual, así que Wompi nunca reintentaba). Ahora todo
  // el ciclo es una sola transacción -- un fallo revierte también la
  // huella de deduplicación, así que un reintento del MISMO evento vuelve
  // a intentarse de cero, no queda huérfano.
  await t.test(
    'fallo real (Wompi no responde) -> 500 + FAILED persistido, y un reintento del mismo evento SÍ aprueba la orden',
    async () => {
      const app = await startTestApp();
      try {
        const customerId = await createVerifiedTestCustomer(app.baseUrl);
        const checkoutResponse = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packageId: 'plus',
            customerId,
            routeId: TEST_ROUTE_ID,
            purchaseAttemptId: crypto.randomUUID(),
          }),
        });
        const { reference, orderToken } = (await checkoutResponse.json()).checkout;
        assert.ok(reference, 'el checkout de esta prueba debe crear una orden nueva');
        const txnId = testTransactionId('webhook-fail-1');
        const event = buildSignedEvent({ transactionId: txnId, reference, amountInCents: 4990000 });
        const fingerprint = crypto
          .createHash('sha256')
          .update(`transaction.updated|${txnId}|${reference}|${event.timestamp}|${event.signature.checksum}`)
          .digest('hex');

        // Primer intento: Wompi "no responde" (fallo de red real, no un
        // 4xx/5xx de Wompi) -- debe fallar todo el ciclo.
        withWompiFetchMock(() => {
          throw new TypeError('fetch failed');
        });
        let firstResponse;
        try {
          firstResponse = await fetch(`${app.baseUrl}/wompi/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          });
        } finally {
          restoreFetch();
        }

        assert.equal(firstResponse.status, 500, 'un fallo real debe responder 500 para que Wompi reintente');

        const orderAfterFailure = await query('select status from public.catastrox_payment_orders where wompi_reference = $1', [reference]);
        assert.equal(orderAfterFailure.rows[0].status, 'PENDING', 'la orden NO debe haber transicionado');

        const eventAfterFailure = await query(
          'select status, attempt_count, last_error_code, processed_at from public.catastrox_payment_webhook_events where event_fingerprint = $1',
          [fingerprint],
        );
        assert.equal(eventAfterFailure.rows[0].status, 'FAILED');
        assert.equal(eventAfterFailure.rows[0].attempt_count, 1);
        assert.ok(eventAfterFailure.rows[0].last_error_code, 'debe registrar un código de error saneado');
        assert.equal(eventAfterFailure.rows[0].processed_at, null, 'nunca queda marcado como procesado sin haberlo estado');

        // Reintento (mismo fingerprint, Wompi ahora sí responde) -- debe
        // procesar de cero, no encontrarse "ya visto" a medias.
        withWompiFetchMock(() =>
          jsonResponse(200, {
            data: { id: txnId, status: 'APPROVED', reference, amount_in_cents: 4990000, currency: 'COP' },
          }),
        );
        let retryResponse;
        try {
          retryResponse = await fetch(`${app.baseUrl}/wompi/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          });
        } finally {
          restoreFetch();
        }

        assert.equal(retryResponse.status, 200);

        const statusResponse = await fetch(`${app.baseUrl}/orders/${encodeURIComponent(orderToken)}/status`);
        assert.equal((await statusResponse.json()).order.status, 'APPROVED');

        const eventAfterRetry = await query(
          'select status, attempt_count from public.catastrox_payment_webhook_events where event_fingerprint = $1',
          [fingerprint],
        );
        assert.equal(eventAfterRetry.rows[0].status, 'PROCESSED');
        assert.equal(eventAfterRetry.rows[0].attempt_count, 2, 'el reintento debe incrementar attempt_count, no reiniciarlo');
      } finally {
        await app.close();
      }
    },
  );
});
