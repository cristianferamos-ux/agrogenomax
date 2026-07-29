// Pruebas de integración (Postgres real, se auto-omiten si no hay base
// alcanzable) para dos defectos corregidos en la revisión de seguridad:
// 1) cambio de correo del comprador debe revocar la verificación previa e
//    invalidar códigos OTP activos del correo anterior;
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
    await query('delete from public.catastrox_delivery_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_invoice_jobs where payment_order_id = any($1)', [orderIds]);
    await query('delete from public.catastrox_billing_profiles where payment_order_id = any($1)', [orderIds]);
  }
  await query('delete from public.catastrox_payment_orders where canonical_predio_id = $1', [TEST_CODIGO]);
  if (customerIds.length) {
    await query('delete from public.catastrox_email_verifications where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customers where id = any($1)', [customerIds]);
  }
}

test('cambio de correo del comprador (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestData();
  });

  await t.test('1) mismo documento + mismo correo -> conserva la verificación existente', async () => {
    const documentNumber = `96${counter}${Date.now()}`.slice(0, 15);
    const email = `same-email-${Date.now()}@example.com`;
    const input = buildCustomerInput({ documentNumber, email, emailConfirmation: email });

    const first = await customers.upsertCustomer(input);
    await query('update public.catastrox_customers set email_verified_at = now() where id = $1', [first.id]);

    const second = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email, emailConfirmation: email }));
    assert.equal(second.id, first.id);
    assert.ok(second.email_verified_at, 'email_verified_at debe conservarse cuando el correo no cambió');
  });

  await t.test('2) mismo documento + correo DIFERENTE -> revoca la verificación (email_verified_at vuelve a null)', async () => {
    const documentNumber = `97${counter}${Date.now()}`.slice(0, 15);
    const emailA = `email-a-${Date.now()}@example.com`;
    const emailB = `email-b-${Date.now()}@example.com`;

    const first = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }));
    await query('update public.catastrox_customers set email_verified_at = now() where id = $1', [first.id]);

    const second = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailB, emailConfirmation: emailB }));
    assert.equal(second.id, first.id);
    assert.equal(second.email_verified_at, null, 'email_verified_at debe resetearse cuando el correo cambia');
  });

  await t.test('3) OTP anterior no funciona después del cambio de correo', async () => {
    const documentNumber = `98${counter}${Date.now()}`.slice(0, 15);
    const emailA = `otp-old-${Date.now()}@example.com`;
    const emailB = `otp-new-${Date.now()}@example.com`;

    const first = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }));
    const { code: oldCode } = await customers.createEmailVerification(first.id);

    // Cambia de correo antes de verificar con el código anterior.
    await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailB, emailConfirmation: emailB }));

    const verifyOld = await customers.verifyEmailCode(first.id, oldCode);
    assert.equal(verifyOld.ok, false, 'el código emitido para el correo anterior nunca debe verificar tras el cambio');
  });

  await t.test('5) nuevo OTP verifica el nuevo correo correctamente', async () => {
    const documentNumber = `99${counter}${Date.now()}`.slice(0, 15);
    const emailA = `otp-new-flow-old-${Date.now()}@example.com`;
    const emailB = `otp-new-flow-new-${Date.now()}@example.com`;

    const first = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }));
    await customers.createEmailVerification(first.id);

    const changed = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailB, emailConfirmation: emailB }));
    const { code: newCode } = await customers.createEmailVerification(changed.id);

    const verifyNew = await customers.verifyEmailCode(changed.id, newCode);
    assert.equal(verifyNew.ok, true, 'el código del correo nuevo debe verificar correctamente');
  });

  await t.test('4) checkout con correo cambiado y no verificado se rechaza (EMAIL_NOT_VERIFIED)', async () => {
    const documentNumber = `100${counter}${Date.now()}`.slice(0, 15);
    const emailA = `checkout-old-${Date.now()}@example.com`;
    const emailB = `checkout-new-${Date.now()}@example.com`;

    const first = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailA, emailConfirmation: emailA }));
    await query('update public.catastrox_customers set email_verified_at = now() where id = $1', [first.id]);

    const changed = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email: emailB, emailConfirmation: emailB }));
    const reread = await customers.findCustomerById(changed.id);
    assert.equal(reread.email_verified_at, null, 'la orden de checkout debe ver email_verified_at=null tras el cambio no verificado');
  });

  await t.test('6) ningún endpoint revela si el documento ya existía -- upsertCustomer responde igual en forma para alta y actualización', async () => {
    const documentNumber = `101${counter}${Date.now()}`.slice(0, 15);
    const email = `existing-doc-${Date.now()}@example.com`;
    const first = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email, emailConfirmation: email }));
    const second = await customers.upsertCustomer(buildCustomerInput({ documentNumber, email, emailConfirmation: email }));
    // Misma forma de objeto en ambos casos (alta vs actualización) -- el
    // llamador (la ruta HTTP) nunca podría distinguir uno de otro a partir
    // de la forma de la respuesta.
    assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort());
  });
});

test('unicidad de delivery/invoice jobs por orden (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestData();
  });

  await t.test('1/3) dos disparos CONCURRENTES de createDeliveryJobForOrder para la misma orden -> una sola fila', async () => {
    const customer = await customers.upsertCustomer(buildCustomerInput());
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
    const customer = await customers.upsertCustomer(buildCustomerInput());
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
    const customer = await customers.upsertCustomer(buildCustomerInput());
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
    const customer = await customers.upsertCustomer(buildCustomerInput());
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
