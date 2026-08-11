// Pruebas de integración (Postgres real, se auto-omiten si no hay base
// alcanzable) para dos áreas:
// 1) R3/B6-26 (Modelo B): un documento existente es una identidad
//    INMUTABLE desde resolveCustomerForVerification() -- mismo email
//    reutiliza la fila existente sin tocar ninguna columna; email
//    distinto falla cerrado (EXISTING_DIFFERENT_EMAIL), sin mutar la
//    fila, sin invalidar la verificación/OTP del comprador legítimo y
//    sin crear ningún estado nuevo para quien hizo el intento
//    conflictivo. Reemplaza la suite anterior, que legitimaba
//    exactamente el comportamiento contrario (cambio de correo silencioso
//    ante solo conocer el documento) -- ver diagnóstico R3/B6-26.
// 2) creación concurrente de delivery/invoice jobs para la misma orden
//    nunca debe producir dos filas (UNIQUE + inserción idempotente,
//    migración 005).
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const TEST_CODIGO = '900000000000000000000000000077';

let dbAvailable = false;
let query;
let customers;
let paymentOrders;
let deliveryJobService;
let invoiceJobService;
let validateCustomerInput;

try {
  const { getConfig } = await import('../../../config/env.js');
  ({ query } = await import('../../../db.js'));
  getConfig();
  const tableCheck = await query("select to_regclass('public.catastrox_customers') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  customers = await import('../customerRepository.js');
  paymentOrders = await import('../paymentOrderRepository.js');
  deliveryJobService = await import('../deliveryJobService.js');
  invoiceJobService = await import('../invoiceJobService.js');
  ({ validateCustomerInput } = await import('../customerValidation.js'));
}

let counter = 0;

function buildCustomerInput(overrides = {}) {
  counter += 1;
  return validateCustomerInput({
    customerType: 'natural',
    firstName: 'Cambio',
    lastName: 'Correo',
    documentType: 'CC',
    documentNumber: `95${counter}${Date.now()}`.slice(0, 15),
    email: `email-change-${Date.now()}-${counter}@example.com`,
    emailConfirmation: `email-change-${Date.now()}-${counter}@example.com`,
    phone: '3000000000',
    countryCode: 'CO',
    department: 'Caqueta',
    city: 'Florencia',
    address: 'Direccion de prueba',
    privacyConsentAccepted: true,
    termsAccepted: true,
    deliveryAuthorizationAccepted: true,
    ...overrides,
  });
}

async function createOrderForConcurrencyTest(customerId) {
  counter += 1;
  const orderToken = paymentOrders.generateOrderToken();
  const order = await paymentOrders.insertPendingOrder({
    orderToken,
    packageId: 'basico',
    canonicalPredioId: TEST_CODIGO,
    codigoPredialNormalized: TEST_CODIGO,
    customerId,
    idempotencyKey: `concurrency-test-${Date.now()}-${counter}`,
    wompiReference: `CATX-CONCURRENCY-${Date.now()}-${counter}`,
    expectedAmountInCents: 3990000,
    currency: 'COP',
  });
  return order;
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
    await query('delete from public.catastrox_billing_profiles where payment_order_id = any($1)', [orderIds]);
  }
  await query('delete from public.catastrox_payment_orders where canonical_predio_id = $1', [TEST_CODIGO]);
  if (customerIds.length) {
    await query('delete from public.catastrox_email_verifications where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customer_otp_state where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customers where id = any($1)', [customerIds]);
  }
}

test('resolución de identidad del comprador -- Modelo B (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestData();
  });

  await t.test('1) mismo documento + mismo correo -> state EXISTING_SAME_EMAIL, reutiliza la fila, conserva la verificación', async () => {
    const documentNumber = `96${counter}${Date.now()}`.slice(0, 15);
    const email = `same-email-${Date.now()}@example.com`;
    const input = buildCustomerInput({ documentNumber, email, emailConfirmation: email });

    const { customer: first, state: firstState } = await customers.resolveCustomerForVerification(input);
    assert.equal(firstState, 'NEW');
    await query('update public.catastrox_customers set email_verified_at = now() where id = $1', [first.id]);

    const { customer: second, state: secondState } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email, emailConfirmation: email }),
    );
    assert.equal(secondState, 'EXISTING_SAME_EMAIL');
    assert.equal(second.id, first.id);
    assert.ok(second.email_verified_at, 'email_verified_at debe conservarse cuando el correo no cambió');
  });

  await t.test('2) mismo documento + correo DIFERENTE -> state EXISTING_DIFFERENT_EMAIL, NO muta absolutamente nada de la fila', async () => {
    const documentNumber = `97${counter}${Date.now()}`.slice(0, 15);
    const emailA = `email-a-${Date.now()}@example.com`;
    const emailB = `email-b-${Date.now()}@example.com`;

    const { customer: first } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }),
    );
    await query('update public.catastrox_customers set email_verified_at = now() where id = $1', [first.id]);
    const rowBefore = await customers.findCustomerById(first.id);

    const { customer: second, state } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailB, emailConfirmation: emailB, firstName: 'Distinto', phone: '3009999999' }),
    );

    assert.equal(state, 'EXISTING_DIFFERENT_EMAIL');
    assert.equal(second.id, first.id);
    assert.equal(second.email_encrypted, rowBefore.email_encrypted, 'el email de la fila no debe reescribirse');
    assert.equal(second.email_hash, rowBefore.email_hash);
    assert.equal(second.first_name_encrypted, rowBefore.first_name_encrypted, 'ninguna otra columna de PII debe reescribirse');
    assert.equal(second.phone_encrypted, rowBefore.phone_encrypted);
    assert.ok(second.email_verified_at, 'email_verified_at NUNCA debe resetearse por un intento con otro correo');
    assert.equal(second.email_verified_at.toISOString(), rowBefore.email_verified_at.toISOString());
  });

  await t.test('3) OTP del comprador legítimo SIGUE funcionando tras un intento conflictivo con otro correo (nunca se invalida)', async () => {
    const documentNumber = `98${counter}${Date.now()}`.slice(0, 15);
    const emailA = `otp-legit-${Date.now()}@example.com`;
    const emailAttacker = `otp-attacker-${Date.now()}@example.com`;

    const { customer: first } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }),
    );
    const { code: legitCode } = await customers.createEmailVerification(first.id);

    // Intento conflictivo con otro correo -- Modelo B falla cerrado, y en
    // particular NUNCA debe tocar el OTP del comprador legítimo.
    const { state } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailAttacker, emailConfirmation: emailAttacker }),
    );
    assert.equal(state, 'EXISTING_DIFFERENT_EMAIL');

    const verifyLegit = await customers.verifyEmailCode(first.id, legitCode);
    assert.equal(verifyLegit.ok, true, 'el código emitido para el correo legítimo debe seguir siendo válido tras el intento conflictivo');
  });

  await t.test('4) el intento conflictivo no crea ninguna fila de verificación nueva (no OTP nuevo para quien no controla el correo real)', async () => {
    const documentNumber = `102${counter}${Date.now()}`.slice(0, 15);
    const emailA = `otp-count-legit-${Date.now()}@example.com`;
    const emailAttacker = `otp-count-attacker-${Date.now()}@example.com`;

    const { customer: first } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }),
    );
    const countBefore = await query(
      'select count(*)::int as n from public.catastrox_email_verifications where customer_id = $1',
      [first.id],
    );

    const { state } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailAttacker, emailConfirmation: emailAttacker }),
    );
    assert.equal(state, 'EXISTING_DIFFERENT_EMAIL');

    const countAfter = await query(
      'select count(*)::int as n from public.catastrox_email_verifications where customer_id = $1',
      [first.id],
    );
    assert.equal(
      countAfter.rows[0].n,
      countBefore.rows[0].n,
      'ningún intento conflictivo debe crear una fila de verificación nueva',
    );
  });

  await t.test('5) un checkout posterior sigue viendo el email_verified_at ORIGINAL, intacto, tras un intento conflictivo con otro correo', async () => {
    const documentNumber = `100${counter}${Date.now()}`.slice(0, 15);
    const emailA = `checkout-legit-${Date.now()}@example.com`;
    const emailAttacker = `checkout-attacker-${Date.now()}@example.com`;

    const { customer: first } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }),
    );
    await query('update public.catastrox_customers set email_verified_at = now() where id = $1', [first.id]);
    const rowBefore = await customers.findCustomerById(first.id);

    await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email: emailAttacker, emailConfirmation: emailAttacker }),
    );

    const reread = await customers.findCustomerById(first.id);
    assert.equal(
      reread.email_verified_at.toISOString(),
      rowBefore.email_verified_at.toISOString(),
      'un checkout posterior debe ver exactamente el mismo estado de verificación que antes del intento conflictivo',
    );
  });

  await t.test('6) el objeto customer tiene la misma forma para NEW y EXISTING_SAME_EMAIL -- state es un detalle interno, nunca se expone al cliente HTTP', async () => {
    const documentNumber = `101${counter}${Date.now()}`.slice(0, 15);
    const email = `existing-doc-${Date.now()}@example.com`;
    const { customer: first, state: firstState } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email, emailConfirmation: email }),
    );
    const { customer: second, state: secondState } = await customers.resolveCustomerForVerification(
      buildCustomerInput({ documentNumber, email, emailConfirmation: email }),
    );
    assert.equal(firstState, 'NEW');
    assert.equal(secondState, 'EXISTING_SAME_EMAIL');
    // Misma forma de objeto en ambos casos -- catastroxPayments.js nunca
    // serializa `customer` completo hacia el cliente HTTP en ninguno de
    // los dos casos (solo lo usa para derivar verificationHandle/
    // identityCapability), así que esta diferencia de `state` nunca es
    // observable externamente.
    assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort());
  });
});

test('unicidad de delivery/invoice jobs por orden (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestData();
  });

  await t.test('1/3) dos disparos CONCURRENTES de createDeliveryJobForOrder para la misma orden -> una sola fila', async () => {
    const { customer } = await customers.resolveCustomerForVerification(buildCustomerInput());
    const order = await createOrderForConcurrencyTest(customer.id);

    const [jobA, jobB] = await Promise.all([
      deliveryJobService.createDeliveryJobForOrder({ orderId: order.id, customerId: customer.id, deliveryEmail: 'concurrency-a@example.com' }),
      deliveryJobService.createDeliveryJobForOrder({ orderId: order.id, customerId: customer.id, deliveryEmail: 'concurrency-b@example.com' }),
    ]);

    assert.equal(jobA.id, jobB.id, 'ambas llamadas deben resolver a la MISMA fila (UNIQUE payment_order_id)');

    const rows = await query('select id from public.catastrox_delivery_jobs where payment_order_id = $1', [order.id]);
    assert.equal(rows.rows.length, 1, 'debe existir exactamente una fila de delivery job para esta orden');
  });

  await t.test('2/3) dos disparos CONCURRENTES de createInvoiceJobForOrder para la misma orden -> una sola fila', async () => {
    const { customer } = await customers.resolveCustomerForVerification(buildCustomerInput());
    const order = await createOrderForConcurrencyTest(customer.id);

    const [jobA, jobB] = await Promise.all([
      invoiceJobService.createInvoiceJobForOrder(order.id),
      invoiceJobService.createInvoiceJobForOrder(order.id),
    ]);

    assert.equal(jobA.id, jobB.id);

    const rows = await query('select id from public.catastrox_invoice_jobs where payment_order_id = $1', [order.id]);
    assert.equal(rows.rows.length, 1, 'debe existir exactamente una fila de invoice job para esta orden');
  });

  await t.test('4) reintento de processDeliveryJob actualiza la MISMA fila (attempt_count aumenta, no se crea una nueva)', async () => {
    const { customer } = await customers.resolveCustomerForVerification(buildCustomerInput());
    const order = await createOrderForConcurrencyTest(customer.id);
    const job = await deliveryJobService.createDeliveryJobForOrder({
      orderId: order.id,
      customerId: customer.id,
      deliveryEmail: 'retry-test@example.com',
    });

    await deliveryJobService.processDeliveryJob(job.id);
    await deliveryJobService.processDeliveryJob(job.id);

    const rows = await query('select id, attempt_count, status from public.catastrox_delivery_jobs where payment_order_id = $1', [order.id]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, 'FAILED');
    assert.equal(rows.rows[0].attempt_count, 2, 'dos intentos deben incrementar attempt_count en la misma fila');
  });

  await t.test('6) invoice ISSUED nunca vuelve a FAILED/PENDING por un reintento posterior', async () => {
    const { customer } = await customers.resolveCustomerForVerification(buildCustomerInput());
    const order = await createOrderForConcurrencyTest(customer.id);
    // createElectronicInvoiceForOrder exige una orden APPROVED con perfil
    // de facturación -- se preparan ambos para poder probar la guarda de
    // "ya emitida" (lo único que este caso quiere ejercitar).
    await query(`update public.catastrox_payment_orders set status = 'APPROVED' where id = $1`, [order.id]);
    await paymentOrders.createBillingProfile({
      paymentOrderId: order.id,
      customerType: 'NATURAL',
      billingName: 'Cambio Correo',
      documentType: 'CC',
      documentNumberEncrypted: customer.document_number_encrypted,
      documentNumberHash: customer.document_number_hash,
      billingEmail: 'billing-issued-test@example.com',
      countryCode: 'CO',
    });
    await invoiceJobService.createInvoiceJobForOrder(order.id);

    // Simula una emisión real exitosa (no hay proveedor conectado en este
    // alcance -- se marca ISSUED directamente para probar la guarda).
    await query(
      `update public.catastrox_invoice_jobs set status = 'ISSUED', provider_invoice_id = 'inv-test-1' where payment_order_id = $1`,
      [order.id],
    );

    await assert.rejects(
      () => invoiceJobService.createElectronicInvoiceForOrder(order.id),
      (error) => error.code === 'INVOICE_ALREADY_ISSUED',
    );

    const rows = await query('select status, provider_invoice_id from public.catastrox_invoice_jobs where payment_order_id = $1', [order.id]);
    assert.equal(rows.rows[0].status, 'ISSUED', 'el estado ISSUED nunca debe sobrescribirse por un reintento');
    assert.equal(rows.rows[0].provider_invoice_id, 'inv-test-1');
  });
});
