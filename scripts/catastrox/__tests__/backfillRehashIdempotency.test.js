// Prueba de integración (Postgres real, se auto-omite si no hay base
// alcanzable) para el backfill de re-hasheo con separación de dominios --
// invoca el script REAL como proceso hijo (exactamente como lo haría un
// operador), no sus funciones internas, para probar de caja negra que:
//  1) corrige un hash calculado con el esquema viejo (hashPii() sin
//     dominio) al esquema nuevo (hashDocumentNumber()/hashEmail());
//  2) correrlo una segunda vez no cambia nada más (idempotente).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(workspaceRoot, 'scripts', 'catastrox', 'backfill-rehash-domain-separated-pii.mjs');

let dbAvailable = false;
let query;
let customers;
let validateCustomerInput;
let hashPii;

try {
  const { getConfig } = await import('../../../server/config/env.js');
  ({ query } = await import('../../../server/db.js'));
  getConfig();
  const tableCheck = await query("select to_regclass('public.catastrox_customers') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  customers = await import('../../../server/services/catastrox/customerRepository.js');
  ({ validateCustomerInput } = await import('../../../server/services/catastrox/customerValidation.js'));
  ({ hashPii } = await import('../../../server/services/catastrox/piiCrypto.js'));
}

let counter = 0;

async function cleanupTestCustomer(customerId) {
  if (!dbAvailable || !customerId) return;
  await query('delete from public.catastrox_email_verifications where customer_id = $1', [customerId]);
  await query('delete from public.catastrox_customers where id = $1', [customerId]);
}

function runBackfillScript() {
  // Se ejecuta el script REAL, tal como lo haría un operador -- hereda las
  // mismas variables de entorno de este proceso de prueba (DATABASE_URL,
  // CATASTROX_PII_*, APP_ENV) y solo agrega la bandera de opt-in.
  return execFileSync('node', [scriptPath], {
    cwd: workspaceRoot,
    env: { ...process.env, CATASTROX_ALLOW_TEST_BACKFILL: 'true' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('backfill de re-hasheo con separación de dominios (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  let customerId = null;
  t.after(async () => {
    await cleanupTestCustomer(customerId);
  });

  await t.test('corrige un hash calculado con el esquema viejo, y una segunda ejecución no cambia nada más (idempotente)', async () => {
    counter += 1;
    const documentNumber = `77${counter}${Date.now()}`.slice(0, 15);
    const email = `rehash-idempotency-${Date.now()}-${counter}@example.com`;

    const customer = await customers.upsertCustomer(
      validateCustomerInput({
        customerType: 'natural',
        firstName: 'Rehash',
        lastName: 'Idempotencia',
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
      }),
    );
    customerId = customer.id;

    // Simula una fila creada ANTES de este endurecimiento: se sobrescribe
    // el hash con el esquema viejo (hashPii() genérico, sin dominio).
    const oldStyleDocumentHash = hashPii(documentNumber);
    const oldStyleEmailHash = hashPii(email.toLowerCase());
    await query('update public.catastrox_customers set document_number_hash = $2, email_hash = $3 where id = $1', [
      customerId,
      oldStyleDocumentHash,
      oldStyleEmailHash,
    ]);

    const beforeFix = await customers.findCustomerById(customerId);
    assert.equal(beforeFix.document_number_hash, oldStyleDocumentHash);
    assert.equal(beforeFix.email_hash, oldStyleEmailHash);

    runBackfillScript();

    const afterFirstRun = await customers.findCustomerById(customerId);
    assert.notEqual(afterFirstRun.document_number_hash, oldStyleDocumentHash, 'el hash viejo debe corregirse al nuevo esquema con dominio');
    assert.notEqual(afterFirstRun.email_hash, oldStyleEmailHash);

    runBackfillScript();

    const afterSecondRun = await customers.findCustomerById(customerId);
    assert.equal(afterSecondRun.document_number_hash, afterFirstRun.document_number_hash, 'una segunda ejecución no debe cambiar un hash ya correcto');
    assert.equal(afterSecondRun.email_hash, afterFirstRun.email_hash);
  });
});
