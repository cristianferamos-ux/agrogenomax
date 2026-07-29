#!/usr/bin/env node
// Backfill MANUAL de una única orden aprobada, para la transacción Sandbox
// de Wompi ya validada server-to-server antes de que existiera el sistema
// de órdenes persistentes de CatastroX (ver informe de auditoría, Fases
// 11/12/15/16 del pedido).
//
// NO se ejecuta automáticamente en ningún flujo de la aplicación ni en
// npm run test:all / npm run build -- es una herramienta de operador, para
// correr una sola vez a mano después de aplicar las migraciones 002-004.
//
// Nunca inserta una orden APPROVED solo porque se le pida: siempre
// re-verifica la transacción contra Wompi (fetchWompiTransaction, la misma
// función que usan /verify y el webhook) y solo inserta si Wompi todavía
// reporta APPROVED con los mismos datos que se documentaron como evidencia.
//
// Comprador de prueba: los datos vienen de variables de entorno
// (BACKFILL_TEST_CUSTOMER_*), con valores sintéticos por defecto -- NUNCA
// PII real codificada en este script ni en Git. Para usar datos distintos,
// exportar las variables antes de ejecutar, p. ej.:
//   BACKFILL_TEST_CUSTOMER_EMAIL=otro@ejemplo.com node scripts/catastrox/backfill-known-approved-order.mjs
//
// transactionId (revisión de seguridad): NUNCA codificado en este archivo
// -- se exige por CATASTROX_BACKFILL_TRANSACTION_ID, sin valor por
// defecto ni fallback. Este script solo respalda la reference/monto/
// moneda/paquete/código predial ya documentados como evidencia (ver
// KNOWN_APPROVED_TRANSACTION_STATIC más abajo); el transactionId real de
// Wompi Sandbox que se está respaldando es lo único que varía por
// ejecución/operador y por eso vive únicamente en el entorno de quien
// ejecuta el script, nunca en el código versionado.
//
// Uso:
//   CATASTROX_ALLOW_TEST_BACKFILL=true \
//   CATASTROX_BACKFILL_TRANSACTION_ID=<transactionId real de Wompi Sandbox> \
//   node scripts/catastrox/backfill-known-approved-order.mjs
//
// Requiere las mismas variables que el backend real: APP_ENV, DATABASE_URL,
// WOMPI_PUBLIC_KEY_TEST, WOMPI_API_BASE_URL (opcional, default Sandbox),
// CATASTROX_PII_ENCRYPTION_KEY, CATASTROX_PII_HASH_SECRET.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(workspaceRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(workspaceRoot, 'server', '.env'), quiet: true });

// Guardas de seguridad (revisión de seguridad, Bloque 6) -- este script
// escribe en la base configurada por DATABASE_URL sin pedir confirmación
// interactiva; una ejecución accidental contra una base real sería
// gravísima. Dos barreras independientes, ambas obligatorias:
//  1) APP_ENV debe ser exactamente development o test (nunca staging ni
//     production, sin excepción, sin importar otras variables).
//  2) Una bandera de opt-in explícita y propia de este script
//     (CATASTROX_ALLOW_TEST_BACKFILL=true) -- que APP_ENV sea development
//     no basta por sí solo, porque un desarrollador podría tener
//     DATABASE_URL apuntando por error a algo que no debería tocarse.
// Además: DATABASE_URL/CATASTROX_DATABASE_URL nunca puede contener pistas
// de un ambiente real (staging/demo/producción conocidos) -- ni siquiera
// con las dos barreras anteriores satisfechas.
const KNOWN_REAL_ENVIRONMENT_HINTS = ['staging.agrogenomax.com', 'demo.agrogenomax.com', 'production', '-prod.', '-prod:'];

function assertSafeToRunBackfill() {
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  if (appEnv !== 'development' && appEnv !== 'test') {
    throw new Error(
      `Este script solo puede ejecutarse con APP_ENV=development o APP_ENV=test (valor actual: "${appEnv || '(vacío)'}"). Abortado.`,
    );
  }

  if (process.env.CATASTROX_ALLOW_TEST_BACKFILL !== 'true') {
    throw new Error(
      'Falta la bandera explícita CATASTROX_ALLOW_TEST_BACKFILL=true -- este script nunca corre por default, ' +
        'ni siquiera en development/test. Abortado.',
    );
  }

  for (const [variable, value] of [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['CATASTROX_DATABASE_URL', process.env.CATASTROX_DATABASE_URL],
  ]) {
    const lowered = String(value || '').toLowerCase();
    const matchedHint = KNOWN_REAL_ENVIRONMENT_HINTS.find((hint) => lowered.includes(hint));
    if (matchedHint) {
      throw new Error(`${variable} contiene una pista de ambiente real ("${matchedHint}") -- este script nunca corre contra eso. Abortado.`);
    }
  }
}

const { getConfig } = await import('../../server/config/env.js');
const { fetchWompiTransaction } = await import('../../server/routes/catastroxPayments.js');
const paymentOrders = await import('../../server/services/catastrox/paymentOrderRepository.js');
const recoverySessions = await import('../../server/services/catastrox/recoverySessionRepository.js');
const customers = await import('../../server/services/catastrox/customerRepository.js');
const { validateCustomerInput } = await import('../../server/services/catastrox/customerValidation.js');
const { createDeliveryJobForOrder, processDeliveryJob } = await import('../../server/services/catastrox/deliveryJobService.js');
const { createInvoiceJobForOrder } = await import('../../server/services/catastrox/invoiceJobService.js');
const { closeMainDbPool, query } = await import('../../server/db.js');

// Evidencia documentada por el operador (Fase 12 del pedido) -- la única
// transacción que este script sabe respaldar. No se acepta ningún dato de
// la transacción por argumentos de línea de comandos: eso convertiría este
// script en una vía genérica de "marcar como pagado", exactamente lo que
// el sistema de órdenes existe para impedir. Deliberadamente NO incluye
// transactionId -- ver resolveBackfillTransactionId() más abajo.
const KNOWN_APPROVED_TRANSACTION_STATIC = Object.freeze({
  expectedReference: 'CATX-BASICO-20260727-E7BA80393F-catastrox_purchase_cx-8f',
  expectedAmountInCents: 3990000,
  expectedCurrency: 'COP',
  packageId: 'basico',
  codigoPredialNormalized: '181500003000000130054000000000',
});

// Formato esperado de un transactionId de Wompi (alfanumérico + guion/guion
// bajo) -- rechaza explícitamente cualquier carácter de control, espacio o
// símbolo fuera de ese conjunto, y acota la longitud a un máximo razonable
// (los transactionId reales de Wompi observados tienen ~26 caracteres;
// 128 deja margen sin permitir un valor arbitrariamente largo).
const BACKFILL_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Enmascara un transactionId para logging -- nunca se imprime completo,
 * ni siquiera en un mensaje de error (Bloque 3/6 de la revisión de
 * seguridad: "no imprimir su valor completo" es una regla sin
 * excepciones, incluida la ruta de fallo).
 */
function maskTransactionId(value) {
  const str = String(value || '');
  if (str.length <= 8) return '*'.repeat(str.length || 1);
  return `${str.slice(0, 4)}...${str.slice(-4)}`;
}

/**
 * Resuelve y valida CATASTROX_BACKFILL_TRANSACTION_ID -- única fuente del
 * transactionId real que este script respalda. Nunca hay valor por
 * defecto, fallback, fixture ni ejemplo real en el código: sin esta
 * variable, el script se niega a correr.
 */
function resolveBackfillTransactionId() {
  const raw = process.env.CATASTROX_BACKFILL_TRANSACTION_ID;

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    const error = new Error(
      'CATASTROX_BACKFILL_TRANSACTION_ID es obligatoria -- este script ya no acepta ningún transactionId ' +
        'codificado en el código fuente. Defínala con el identificador de la transacción Sandbox a respaldar.',
    );
    error.code = 'CATASTROX_BACKFILL_TRANSACTION_ID_REQUIRED';
    throw error;
  }

  const trimmed = String(raw).trim();

  if (!BACKFILL_TRANSACTION_ID_PATTERN.test(trimmed)) {
    const error = new Error(
      'CATASTROX_BACKFILL_TRANSACTION_ID tiene un formato inválido (solo letras, números, guion y guion bajo, ' +
        `máximo 128 caracteres) -- valor recibido (enmascarado): ${maskTransactionId(trimmed)}.`,
    );
    error.code = 'CATASTROX_BACKFILL_TRANSACTION_ID_INVALID';
    throw error;
  }

  return trimmed;
}

function readTestCustomerInputFromEnv() {
  const env = (name, fallback) => process.env[name] || fallback;
  return {
    customerType: 'natural',
    firstName: env('BACKFILL_TEST_CUSTOMER_FIRST_NAME', 'Sandbox'),
    lastName: env('BACKFILL_TEST_CUSTOMER_LAST_NAME', 'Test'),
    documentType: env('BACKFILL_TEST_CUSTOMER_DOCUMENT_TYPE', 'CC'),
    documentNumber: env('BACKFILL_TEST_CUSTOMER_DOCUMENT_NUMBER', '000000000'),
    email: env('BACKFILL_TEST_CUSTOMER_EMAIL', 'sandbox-test@example.com'),
    emailConfirmation: env('BACKFILL_TEST_CUSTOMER_EMAIL', 'sandbox-test@example.com'),
    phone: env('BACKFILL_TEST_CUSTOMER_PHONE', '3000000000'),
    countryCode: env('BACKFILL_TEST_CUSTOMER_COUNTRY', 'CO'),
    department: env('BACKFILL_TEST_CUSTOMER_DEPARTMENT', 'Caqueta'),
    city: env('BACKFILL_TEST_CUSTOMER_CITY', 'Florencia'),
    address: env('BACKFILL_TEST_CUSTOMER_ADDRESS', 'Direccion sintetica de backfill (sin PII real)'),
    // Backfill de operador sobre una transacción Sandbox ya validada, no
    // una compra real -- se registra el consentimiento sintético
    // explícitamente aquí, nunca inferido de datos reales de un tercero.
    privacyConsentAccepted: true,
    termsAccepted: true,
    deliveryAuthorizationAccepted: true,
  };
}

async function ensureCustomerAttached(order) {
  if (order.customer_id) {
    console.log('[backfill] La orden ya tiene un comprador asociado -- no se reemplaza.');
    return await customers.findCustomerById(order.customer_id);
  }

  const validated = validateCustomerInput(readTestCustomerInputFromEnv());
  const customer = await customers.upsertCustomer(validated);
  const decryptedCustomer = customers.decryptCustomerPii(customer);
  // Backfill de un solo operador -- se marca el correo como verificado
  // directamente (no hay OTP que enviar a una dirección sintética).
  await query('update public.catastrox_customers set email_verified_at = now() where id = $1 and email_verified_at is null', [
    customer.id,
  ]);
  await query('update public.catastrox_payment_orders set customer_id = $2 where id = $1', [order.id, customer.id]);

  const billingExisting = await query('select id from public.catastrox_billing_profiles where payment_order_id = $1', [order.id]);
  if (!billingExisting.rows[0]) {
    await paymentOrders.createBillingProfile({
      paymentOrderId: order.id,
      customerType: customer.customer_type,
      billingName: `${decryptedCustomer.firstName || ''} ${decryptedCustomer.lastName || ''}`.trim(),
      documentType: customer.document_type,
      documentNumberEncrypted: customer.document_number_encrypted,
      documentNumberHash: customer.document_number_hash,
      billingEmail: decryptedCustomer.email,
      phoneEncrypted: customer.phone_encrypted,
      addressEncrypted: customer.address_encrypted,
      city: decryptedCustomer.city,
      department: decryptedCustomer.department,
      countryCode: customer.country_code,
    });
    console.log('[backfill] Perfil de facturación creado para la orden.');
  }

  // Nunca el correo completo en el log -- ni siquiera de un comprador
  // sintético (Bloque 6 de la revisión de seguridad: "no imprimir PII" es
  // una regla sin excepciones para datos sintéticos también).
  console.log(`[backfill] Comprador de prueba asociado (customerId=${customer.id}).`);
  return customer;
}

// Bloque 16 (E2E): una orden APPROVED real (por webhook/verify) siempre
// dispara estos dos trabajos -- se replica aquí para que la orden
// retro-cargada quede en el mismo estado observable que una compra nueva
// aprobada hoy, y así la validación E2E pueda comprobar delivery/invoice
// job también sobre esta orden histórica.
async function ensurePostApprovalJobs(order, customer) {
  const decryptedEmail = customer ? customers.decryptCustomerPii(customer)?.email : null;
  const existingDelivery = await query('select id from public.catastrox_delivery_jobs where payment_order_id = $1', [order.id]);
  if (!existingDelivery.rows[0] && decryptedEmail) {
    const job = await createDeliveryJobForOrder({
      orderId: order.id,
      customerId: customer.id,
      deliveryEmail: decryptedEmail,
    });
    await processDeliveryJob(job.id);
    console.log('[backfill] Delivery job creado y procesado (FAILED esperado -- generación no implementada, ver informe).');
  } else {
    console.log('[backfill] Ya existe un delivery job para esta orden -- no se crea otro.');
  }

  const existingInvoice = await query('select id from public.catastrox_invoice_jobs where payment_order_id = $1', [order.id]);
  if (!existingInvoice.rows[0]) {
    await createInvoiceJobForOrder(order.id);
    console.log('[backfill] Invoice job creado (NOT_REQUESTED).');
  } else {
    console.log('[backfill] Ya existe un invoice job para esta orden -- no se crea otro.');
  }
}

async function ensureRecoverySession(order) {
  const linked = await query(
    `select rs.id from public.catastrox_recovery_sessions rs
       join public.catastrox_recovery_session_orders rso on rso.recovery_session_id = rs.id
      where rso.payment_order_id = $1 and rs.revoked_at is null and rs.expires_at > now()
      limit 1`,
    [order.id],
  );

  if (linked.rows[0]) {
    console.log(
      '[backfill] La orden ya está enlazada a una sesión de recuperación vigente -- no se crea una nueva ' +
        '(el token en claro de esa sesión ya no puede volver a mostrarse, por diseño).',
    );
    return;
  }

  const { session, token } = await recoverySessions.createRecoverySession();
  await recoverySessions.linkOrderToSession(session.id, order.id);

  console.log('[backfill] Sesión de recuperación creada y enlazada. Token en claro (solo se muestra esta vez):');
  console.log(`  ${token}`);
  console.log(
    '[backfill] Para probar la recuperación manualmente: Cookie: catastrox_recovery_session=' +
      `${token} en POST /api/catastrox/payments/entitlements/check.`,
  );
}

async function main() {
  assertSafeToRunBackfill();
  const transactionId = resolveBackfillTransactionId();
  const KNOWN_APPROVED_TRANSACTION = Object.freeze({
    transactionId,
    ...KNOWN_APPROVED_TRANSACTION_STATIC,
  });

  const appConfig = getConfig();
  console.log(`[backfill] APP_ENV=${appConfig.appEnv}`);
  console.log(`[backfill] CATASTROX_BACKFILL_TRANSACTION_ID=${maskTransactionId(transactionId)}`);

  let order = await paymentOrders.findOrderByReference(KNOWN_APPROVED_TRANSACTION.expectedReference);

  if (order) {
    console.log(
      `[backfill] Ya existe una orden para esta reference (status=${order.status}, id=${order.id}). ` +
        'No se crea de nuevo -- este script es idempotente.',
    );
  } else {
    const WOMPI_PUBLIC_KEY_TEST = process.env.WOMPI_PUBLIC_KEY_TEST || '';
    const WOMPI_API_BASE_URL = process.env.WOMPI_API_BASE_URL || 'https://sandbox.wompi.co/v1';

    if (!WOMPI_PUBLIC_KEY_TEST) {
      throw new Error('WOMPI_PUBLIC_KEY_TEST no está configurada -- no es posible re-verificar contra Wompi.');
    }

    console.log(`[backfill] Re-verificando ${maskTransactionId(KNOWN_APPROVED_TRANSACTION.transactionId)} contra Wompi (server-to-server)...`);
    const raw = await fetchWompiTransaction({
      transactionId: KNOWN_APPROVED_TRANSACTION.transactionId,
      apiBaseUrl: WOMPI_API_BASE_URL,
      publicKey: WOMPI_PUBLIC_KEY_TEST,
    });

    const status = String(raw.status || '').toUpperCase();
    const amountInCents = Number(raw.amount_in_cents || 0);

    if (status !== 'APPROVED') {
      throw new Error(`Wompi ya no reporta esta transacción como APPROVED (status actual: ${status}). Abortado.`);
    }
    if (raw.reference !== KNOWN_APPROVED_TRANSACTION.expectedReference) {
      throw new Error(
        `La reference reportada por Wompi (${raw.reference}) no coincide con la documentada. Abortado -- posible evidencia incorrecta.`,
      );
    }
    if (amountInCents !== KNOWN_APPROVED_TRANSACTION.expectedAmountInCents) {
      throw new Error(`El monto reportado por Wompi (${amountInCents}) no coincide con el esperado. Abortado.`);
    }
    if (raw.currency !== KNOWN_APPROVED_TRANSACTION.expectedCurrency) {
      throw new Error(`La moneda reportada por Wompi (${raw.currency}) no coincide con COP. Abortado.`);
    }

    console.log('[backfill] Verificación server-to-server OK. Insertando orden APPROVED...');

    const orderToken = paymentOrders.generateOrderToken();
    const inserted = await paymentOrders.insertPendingOrder({
      orderToken,
      packageId: KNOWN_APPROVED_TRANSACTION.packageId,
      canonicalPredioId: KNOWN_APPROVED_TRANSACTION.codigoPredialNormalized,
      codigoPredialNormalized: KNOWN_APPROVED_TRANSACTION.codigoPredialNormalized,
      wompiReference: raw.reference,
      expectedAmountInCents: amountInCents,
      currency: raw.currency,
    });

    order = await paymentOrders.applyVerifiedTransaction({
      orderId: inserted.id,
      nextStatus: 'APPROVED',
      wompiTransactionId: raw.id,
      paymentMethodType: raw.payment_method_type || null,
      verificationSource: 'manual',
      fromStatuses: ['PENDING'],
    });

    console.log('[backfill] Orden creada y aprobada:', {
      id: order.id,
      orderToken: order.order_token,
      packageId: order.package_id,
      canonicalPredioId: order.canonical_predio_id,
      status: order.status,
    });
  }

  const customer = await ensureCustomerAttached(order);
  await ensureRecoverySession(order);
  await ensurePostApprovalJobs(order, customer);
}

main()
  .catch((error) => {
    console.error('[backfill] Falló:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMainDbPool();
  });
