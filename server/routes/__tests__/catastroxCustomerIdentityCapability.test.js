// Pruebas de integración (Postgres real, se auto-omiten si no hay base
// alcanzable, mismo patrón que catastroxPaymentOrders.test.js) para R3/B6-26
// + B6-26-ADJ-01: Modelo B de identidad inmutable, verificationHandle e
// identityCapability. Cubre exclusivamente POST /customers y
// POST /customers/verify-email -- checkout todavía acepta customerId en
// esta etapa (Etapa 2), así que este archivo nunca lo ejercita.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

let dbAvailable = false;
let getConfig;
let getDbPool;
let query;
let catastroxPaymentsRouter;
let hashDocumentNumber;
let normalizeDocumentNumber;
let verifyCheckoutIdentityCapability;

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
  ({ verifyCheckoutIdentityCapability } = await import('../../services/catastrox/identityCapability.js'));
}

function resetRateLimiters() {
  for (const limiter of rateLimiters) {
    for (const candidateKey of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      limiter.resetKey(candidateKey);
    }
  }
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

function uniqueDocumentNumber() {
  counter += 1;
  return `91${counter}${Date.now()}`.slice(0, 15);
}

function uniqueEmail() {
  counter += 1;
  return `identity-test-${Date.now()}-${counter}@example.com`;
}

function buildCustomerBody(overrides = {}) {
  return {
    customerType: 'natural',
    firstName: 'Identidad',
    lastName: 'Test',
    documentType: 'CC',
    phone: '3000000000',
    countryCode: 'CO',
    department: 'Caqueta',
    city: 'Florencia',
    address: 'Direccion de prueba',
    privacyConsentAccepted: true,
    termsAccepted: true,
    deliveryAuthorizationAccepted: true,
    ...overrides,
  };
}

// Toda la limpieza de este archivo se hace por document_number_hash de los
// documentos que este archivo mismo generó -- nunca por rango/prefijo, para
// no arriesgar tocar filas de otro archivo de test que corra en paralelo.
const createdDocumentNumbers = [];

async function lookupCustomerRowByDocument(documentNumber) {
  const documentHash = hashDocumentNumber(normalizeDocumentNumber(documentNumber));
  const result = await query('select * from public.catastrox_customers where document_number_hash = $1', [documentHash]);
  return result.rows[0] || null;
}

async function countEmailVerifications(customerId) {
  const result = await query('select count(*)::int as n from public.catastrox_email_verifications where customer_id = $1', [
    customerId,
  ]);
  return result.rows[0].n;
}

// Cierre de protección backend (cooldown de 30s por comprador,
// EMAIL_PROVIDER_002): el escenario B de este archivo dispara un segundo
// envío de OTP para el MISMO customer.id inmediatamente después del
// primero -- sin este bypass, chocaría contra el cooldown real (429
// EMAIL_VERIFICATION_COOLDOWN), que es una prueba de otro archivo
// (catastroxCustomerOtpAndHistory.test.js), no de este. Mismo patrón ya
// usado ahí: retrasar artificialmente last_delivered_at, nunca
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

async function otpStateSnapshot(customerId) {
  const result = await query(
    'select reserved_at, last_delivered_at from public.catastrox_customer_otp_state where customer_id = $1',
    [customerId],
  );
  return result.rows[0] || null;
}

async function cleanupTestData() {
  if (!dbAvailable || !createdDocumentNumbers.length) return;
  const hashes = createdDocumentNumbers.map((documentNumber) => hashDocumentNumber(normalizeDocumentNumber(documentNumber)));
  const rows = await query('select id from public.catastrox_customers where document_number_hash = any($1)', [hashes]);
  const customerIds = rows.rows.map((row) => row.id);
  if (customerIds.length) {
    await query('delete from public.catastrox_email_verifications where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customer_otp_state where customer_id = any($1)', [customerIds]);
    await query('delete from public.catastrox_customers where id = any($1)', [customerIds]);
  }
}

test('R3/B6-26 + B6-26-ADJ-01: resolución de identidad del comprador (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(async () => {
    await cleanupTestData();
  });

  await t.test('A) documento nuevo: verificationHandle opaco, sin customerId, verify-email entrega identityCapability válida', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const documentNumber = uniqueDocumentNumber();
      createdDocumentNumbers.push(documentNumber);
      const email = uniqueEmail();

      // 1) POST /customers
      const response = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCustomerBody({ documentNumber, email, emailConfirmation: email })),
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(typeof payload.verificationHandle, 'string');
      assert.ok(payload.verificationHandle.length > 0);
      assert.equal('customerId' in payload, false, 'NEW no debe exponer customerId');
      assert.equal(payload.emailVerificationRequired, true);
      assert.equal(typeof payload.devOtpCode, 'string', 'development/test debe seguir exponiendo devOtpCode');

      // 2) el handle debe ser opaco: no contiene el UUID del customer ni el email en claro
      const row = await lookupCustomerRowByDocument(documentNumber);
      assert.ok(row, 'el customer debe haberse creado');
      assert.equal(payload.verificationHandle.includes(row.id), false, 'el handle no debe contener el UUID del customer en forma visible');
      assert.equal(payload.verificationHandle.toLowerCase().includes(email.toLowerCase()), false, 'el handle no debe contener el correo en claro');

      // 3) verify-email con handle + OTP correcto
      const verifyResponse = await fetch(`${app.baseUrl}/customers/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationHandle: payload.verificationHandle, code: payload.devOtpCode }),
      });
      const verifyPayload = await verifyResponse.json();
      assert.equal(verifyResponse.status, 200);
      assert.equal(verifyPayload.ok, true);
      assert.equal(verifyPayload.verified, true);
      assert.equal(typeof verifyPayload.identityCapability, 'string');
      assert.ok(verifyPayload.identityCapability.length > 0);
      assert.equal('customerId' in verifyPayload, false);

      // 4) la identityCapability valida internamente con el propio módulo y corresponde al customer creado
      const capabilityResult = verifyCheckoutIdentityCapability(verifyPayload.identityCapability);
      assert.equal(capabilityResult.ok, true);
      assert.equal(capabilityResult.customerId, row.id);
      assert.equal(capabilityResult.emailHash, row.email_hash);
    } finally {
      await app.close();
    }
  });

  await t.test('B) documento existente + mismo email + PII completamente distinta: no muta nada, exige OTP fresco, nuevo handle', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const documentNumber = uniqueDocumentNumber();
      createdDocumentNumbers.push(documentNumber);
      const email = uniqueEmail();

      // 5) crear y verificar el customer inicial
      const firstResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildCustomerBody({
            documentNumber,
            email,
            emailConfirmation: email,
            firstName: 'Original',
            lastName: 'Legitimo',
            phone: '3001111111',
            address: 'Direccion Original',
            city: 'Florencia',
            department: 'Caqueta',
          }),
        ),
      });
      const firstPayload = await firstResponse.json();
      assert.equal(firstResponse.status, 200);

      const firstVerify = await fetch(`${app.baseUrl}/customers/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationHandle: firstPayload.verificationHandle, code: firstPayload.devOtpCode }),
      });
      assert.equal((await firstVerify.json()).ok, true);

      const rowBefore = await lookupCustomerRowByDocument(documentNumber);
      assert.ok(rowBefore.email_verified_at, 'debe quedar verificado tras el primer OTP');

      // Simula que ya pasó el cooldown de 30s del envío inicial -- este
      // caso prueba la mutabilidad/OTP fresco de Modelo B, no el cooldown
      // en sí (que tiene su propia suite dedicada en
      // catastroxCustomerOtpAndHistory.test.js).
      await bypassOtpCooldown(rowBefore.id);

      // 6) segundo POST /customers: mismo documento, mismo email normalizado, PII completamente distinta
      const secondResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildCustomerBody({
            documentNumber,
            email,
            emailConfirmation: email,
            firstName: 'Distinto',
            lastName: 'NoLegitimo',
            phone: '3009999999',
            address: 'Direccion Distinta',
            city: 'OtraCiudad',
            department: 'OtroDepartamento',
          }),
        ),
      });
      const secondPayload = await secondResponse.json();
      assert.equal(secondResponse.status, 200);
      assert.equal(secondPayload.ok, true);

      // 7) DB: mismo customer.id, TODOS los campos protegidos intactos
      const rowAfter = await lookupCustomerRowByDocument(documentNumber);
      assert.equal(rowAfter.id, rowBefore.id);
      assert.equal(rowAfter.customer_type, rowBefore.customer_type);
      assert.equal(rowAfter.first_name_encrypted, rowBefore.first_name_encrypted);
      assert.equal(rowAfter.last_name_encrypted, rowBefore.last_name_encrypted);
      assert.equal(rowAfter.legal_name_encrypted, rowBefore.legal_name_encrypted);
      assert.equal(rowAfter.document_type, rowBefore.document_type);
      assert.equal(rowAfter.document_number_encrypted, rowBefore.document_number_encrypted);
      assert.equal(rowAfter.document_number_hash, rowBefore.document_number_hash);
      assert.equal(rowAfter.email_encrypted, rowBefore.email_encrypted);
      assert.equal(rowAfter.email_hash, rowBefore.email_hash);
      assert.equal(rowAfter.phone_encrypted, rowBefore.phone_encrypted);
      assert.equal(rowAfter.country_code, rowBefore.country_code);
      assert.equal(rowAfter.department_encrypted, rowBefore.department_encrypted);
      assert.equal(rowAfter.city_encrypted, rowBefore.city_encrypted);
      assert.equal(rowAfter.address_encrypted, rowBefore.address_encrypted);
      // email_verified_at histórico intacto (nunca se limpia, aunque el
      // body haya llegado con PII distinta)
      assert.equal(rowAfter.email_verified_at?.toISOString?.(), rowBefore.email_verified_at?.toISOString?.());
      // privacy_consent_at/terms_accepted_at intactos -- no se refrescan
      // como efecto de una petición no autenticada
      assert.equal(rowAfter.privacy_consent_at?.toISOString?.(), rowBefore.privacy_consent_at?.toISOString?.());
      assert.equal(rowAfter.terms_accepted_at?.toISOString?.(), rowBefore.terms_accepted_at?.toISOString?.());

      // 8) segundo request devuelve un verificationHandle NUEVO
      assert.notEqual(secondPayload.verificationHandle, firstPayload.verificationHandle);
      assert.equal('customerId' in secondPayload, false);

      // 9) exige OTP fresco: el segundo POST /customers nunca devuelve una identityCapability
      assert.equal('identityCapability' in secondPayload, false);

      // 10) verificar el OTP fresco (del segundo request) sí entrega identityCapability
      const secondVerify = await fetch(`${app.baseUrl}/customers/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationHandle: secondPayload.verificationHandle, code: secondPayload.devOtpCode }),
      });
      const secondVerifyPayload = await secondVerify.json();
      assert.equal(secondVerify.status, 200);
      assert.equal(secondVerifyPayload.ok, true);
      assert.equal(typeof secondVerifyPayload.identityCapability, 'string');

      // 11) destinatario lógico = email almacenado: email_encrypted nunca
      // cambió de valor (byte a byte) entre rowBefore/rowAfter -- si se
      // hubiera vuelto a escribir la fila (aunque fuera con el mismo
      // email), el ciphertext AES-GCM habría cambiado por el IV aleatorio.
      // Igualdad exacta demuestra que la fila nunca se reescribió.
      assert.equal(rowAfter.email_encrypted, rowBefore.email_encrypted);
    } finally {
      await app.close();
    }
  });

  await t.test('C) documento existente + email diferente: fail closed, cero mutación, cero OTP nuevo', async () => {
    resetRateLimiters();
    const app = await startTestApp();
    try {
      const documentNumber = uniqueDocumentNumber();
      createdDocumentNumbers.push(documentNumber);
      const victimEmail = uniqueEmail();
      const attackerEmail = uniqueEmail();

      const initialResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCustomerBody({ documentNumber, email: victimEmail, emailConfirmation: victimEmail })),
      });
      const initialPayload = await initialResponse.json();
      const initialVerify = await fetch(`${app.baseUrl}/customers/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationHandle: initialPayload.verificationHandle, code: initialPayload.devOtpCode }),
      });
      assert.equal((await initialVerify.json()).ok, true);

      // 12) snapshot completo antes del intento conflictivo
      const rowBefore = await lookupCustomerRowByDocument(documentNumber);
      const emailVerificationsCountBefore = await countEmailVerifications(rowBefore.id);
      const otpStateBefore = await otpStateSnapshot(rowBefore.id);

      // 13) POST /customers con el mismo documento + email del atacante
      const attackResponse = await fetch(`${app.baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildCustomerBody({ documentNumber, email: attackerEmail, emailConfirmation: attackerEmail, firstName: 'Atacante' }),
        ),
      });
      const attackPayload = await attackResponse.json();

      // 14)
      assert.equal(attackResponse.status, 403);
      assert.equal(attackPayload.ok, false);
      assert.equal(attackPayload.code, 'IDENTITY_VERIFICATION_REQUIRED');
      assert.equal('customerId' in attackPayload, false);
      assert.equal('verificationHandle' in attackPayload, false);
      assert.equal('devOtpCode' in attackPayload, false);

      // 15) la fila, la verificación previa y el estado de OTP quedan idénticos
      const rowAfter = await lookupCustomerRowByDocument(documentNumber);
      assert.equal(rowAfter.id, rowBefore.id);
      assert.equal(rowAfter.email_encrypted, rowBefore.email_encrypted);
      assert.equal(rowAfter.email_hash, rowBefore.email_hash);
      assert.equal(rowAfter.first_name_encrypted, rowBefore.first_name_encrypted);
      assert.equal(rowAfter.email_verified_at?.toISOString?.(), rowBefore.email_verified_at?.toISOString?.());

      const emailVerificationsCountAfter = await countEmailVerifications(rowBefore.id);
      assert.equal(emailVerificationsCountAfter, emailVerificationsCountBefore, 'no debe crearse ninguna fila de verificación nueva');

      const otpStateAfter = await otpStateSnapshot(rowBefore.id);
      assert.deepEqual(otpStateAfter, otpStateBefore, 'catastrox_customer_otp_state de la víctima no debe tocarse');
    } finally {
      await app.close();
    }
  });
});
