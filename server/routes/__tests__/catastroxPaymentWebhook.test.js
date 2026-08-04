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

const TEST_CODIGO = '900000000000000000000000000003';
const EVENTS_SECRET = 'events_secret_de_prueba_treinta_dos_caracteres_o_mas_1234';
// Corrección de seguridad (checkout sin fallback inseguro): POST /checkout
// exige un routeId que resuelva a un lookup vigente -- ver la misma nota
// en catastroxPaymentOrders.test.js.
const TEST_ROUTE_ID = 'cx-test-webhook-route';

let dbAvailable = false;
let getConfig;
let getDbPool;
let query;
let catastroxPaymentsRouter;
let computeWompiEventChecksum;
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

if (dbAvailable) {
  ({ default: catastroxPaymentsRouter } = await import('../catastroxPayments.js'));
  ({ computeWompiEventChecksum } = await import('../../services/catastrox/wompiEventVerification.js'));
  ({ __rememberLookupPreviewForTests } = await import('../catastrox.js'));
  __rememberLookupPreviewForTests(TEST_ROUTE_ID, { canonicalPredioId: TEST_CODIGO, codigoPredial: TEST_CODIGO });
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
    const result = await query('select status from public.catastrox_delivery_jobs where payment_order_id = $1', [orderId]);
    const status = result.rows[0]?.status;
    if (status === 'SENT' || status === 'FAILED') return result.rows;
    if (Date.now() >= deadline) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function cleanupTestData() {
  if (!dbAvailable) return;
  const orders = await query('select id, customer_id from public.catastrox_payment_orders where canonical_predio_id = $1', [
    TEST_CODIGO,
  ]);
  const orderIds = orders.rows.map((row) => row.id);
  const customerIds = orders.rows.map((row) => row.customer_id).filter(Boolean);

  if (orderIds.length) {
    await query('delete from public.catastrox_delivery_attempts where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1))', [orderIds]);
    await query('delete from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1))', [orderIds]);
    await query('delete from public.catastrox_delivery_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_invoice_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_recovery_session_orders where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_billing_profiles where payment_order_id = any($1)', [orderIds]);
  }
  await query('delete from public.catastrox_payment_orders where canonical_predio_id = $1', [TEST_CODIGO]);
  await query("delete from public.catastrox_payment_webhook_events where wompi_transaction_id like 'txn-webhook-%'");
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
      const event = buildSignedEvent({ transactionId: 'txn-webhook-1', reference: 'CATX-BASICO-NOEXISTE' });
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
      const event = buildSignedEvent({ transactionId: 'txn-webhook-2', reference: 'CATX-BASICO-CUALQUIERA' });
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

      const event = buildSignedEvent({ transactionId: 'txn-webhook-3', reference });

      withWompiFetchMock(() =>
        jsonResponse(200, {
          data: { id: 'txn-webhook-3', status: 'APPROVED', reference, amount_in_cents: 3990000, currency: 'COP' },
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
      // El predio de prueba (TEST_CODIGO) no existe en catastrox_clean, así
      // que la generación real (PDFKit) falla con PREDIO_DATA_UNAVAILABLE --
      // FAILED sigue siendo el resultado honesto esperado aquí, nunca
      // SENT/DELIVERED simulado.
      assert.equal(deliveryJobRows[0].status, 'FAILED', 'predio de prueba no resoluble -- FAILED esperado, nunca SENT/DELIVERED simulado');

      const invoiceJobs = await query('select status from public.catastrox_invoice_jobs where payment_order_id = $1', [orderId]);
      assert.equal(invoiceJobs.rows.length, 1, 'exactamente un invoice job, el replay no debe duplicarlo');
      assert.equal(invoiceJobs.rows[0].status, 'NOT_REQUESTED');
    } finally {
      await app.close();
    }
  });

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
        const event = buildSignedEvent({ transactionId: 'txn-webhook-fail-1', reference, amountInCents: 4990000 });
        const fingerprint = crypto
          .createHash('sha256')
          .update(`transaction.updated|txn-webhook-fail-1|${reference}|${event.timestamp}|${event.signature.checksum}`)
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
            data: { id: 'txn-webhook-fail-1', status: 'APPROVED', reference, amount_in_cents: 4990000, currency: 'COP' },
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
