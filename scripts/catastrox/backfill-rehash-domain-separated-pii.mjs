#!/usr/bin/env node
// Backfill de re-hasheo con separación de dominios (endurecimiento
// criptográfico final): document_number_hash/email_hash/billing_email_hash/
// delivery_email_hash existentes fueron calculados con hashPii() genérico
// (HMAC-SHA256 del valor desnudo, sin prefijo de dominio). Este script los
// recalcula con hashDocumentNumber()/hashEmail() (HMAC-SHA256 sobre
// "catastrox:document:v1:"/"catastrox:email:v1:" + valor normalizado) --
// ver server/services/catastrox/piiCrypto.js.
//
// Operador ejecuta esto UNA VEZ por ambiente, después de desplegar el
// código que ya usa hashDocumentNumber()/hashEmail() en vez de hashPii()
// para estos campos (de lo contrario, cualquier fila nueva se crearía con
// el hash nuevo mientras las filas viejas seguirían con el hash viejo,
// dejando el índice en un estado mixto).
//
// Determinista e idempotente: el nuevo hash de un valor descifrado es
// siempre el mismo, así que correr esto dos veces no cambia nada en el
// segundo intento -- las filas ya migradas se detectan (hash nuevo igual
// al ya guardado) y se omiten.
//
// Todo el trabajo de cada tabla corre dentro de una única transacción por
// tabla -- si algo falla a mitad de camino (p. ej. una colisión de
// unicidad inesperada), Postgres revierte esa tabla completa, nunca deja
// un subconjunto de filas con el hash nuevo y otro con el viejo.
//
// Nunca imprime PII -- solo conteos.
//
// Uso:
//   CATASTROX_ALLOW_TEST_BACKFILL=true node scripts/catastrox/backfill-rehash-domain-separated-pii.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(workspaceRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(workspaceRoot, 'server', '.env'), quiet: true });

const KNOWN_REAL_ENVIRONMENT_HINTS = ['staging.agrogenomax.com', 'demo.agrogenomax.com', 'production', '-prod.', '-prod:'];

function assertSafeToRunBackfill() {
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  if (appEnv !== 'development' && appEnv !== 'test') {
    throw new Error(
      `Este script solo puede ejecutarse con APP_ENV=development o APP_ENV=test (valor actual: "${appEnv || '(vacío)'}"). Abortado.`,
    );
  }
  if (process.env.CATASTROX_ALLOW_TEST_BACKFILL !== 'true') {
    throw new Error('Falta la bandera explícita CATASTROX_ALLOW_TEST_BACKFILL=true. Abortado.');
  }
  for (const [variable, value] of [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['CATASTROX_DATABASE_URL', process.env.CATASTROX_DATABASE_URL],
  ]) {
    const lowered = String(value || '').toLowerCase();
    const matchedHint = KNOWN_REAL_ENVIRONMENT_HINTS.find((hint) => lowered.includes(hint));
    if (matchedHint) {
      throw new Error(`${variable} contiene una pista de ambiente real ("${matchedHint}"). Abortado.`);
    }
  }
}

/** Resuelve el valor en claro de un campo que puede estar cifrado (nuevo) o en texto plano (legado, aún no migrado). */
function resolvePlaintext({ encrypted, plaintext, decryptPii }) {
  if (encrypted) return decryptPii(encrypted);
  return plaintext || null;
}

async function rehashCustomers({ client, decryptPii, hashDocumentNumber, hashEmail, normalizeDocumentNumber, normalizeEmail }) {
  const { rows } = await client.query(
    `select id, document_number_encrypted, document_number_hash, email_encrypted, email_normalized, email_hash
       from public.catastrox_customers
      where document_number_encrypted is not null
      for update`,
  );

  const nextDocumentHashes = new Map();
  const nextEmailHashes = new Map();

  for (const row of rows) {
    const documentPlaintext = normalizeDocumentNumber(decryptPii(row.document_number_encrypted));
    nextDocumentHashes.set(row.id, hashDocumentNumber(documentPlaintext));

    const emailPlaintext = resolvePlaintext({ encrypted: row.email_encrypted, plaintext: row.email_normalized, decryptPii });
    if (emailPlaintext) {
      nextEmailHashes.set(row.id, hashEmail(normalizeEmail(emailPlaintext)));
    }
  }

  // Preservar unicidad (requisito explícito): antes de escribir nada, se
  // verifica que el nuevo conjunto de document_number_hash siga siendo
  // único -- si dos documentos distintos produjeran el mismo hash nuevo
  // (no debería ocurrir nunca, HMAC-SHA256 es resistente a colisiones),
  // se aborta ANTES de tocar la base, nunca a mitad de camino.
  const documentHashValues = [...nextDocumentHashes.values()];
  const uniqueDocumentHashValues = new Set(documentHashValues);
  if (uniqueDocumentHashValues.size !== documentHashValues.length) {
    throw new Error('Colisión detectada al recalcular document_number_hash -- abortado antes de escribir nada.');
  }

  let updated = 0;
  for (const row of rows) {
    const newDocumentHash = nextDocumentHashes.get(row.id);
    const newEmailHash = nextEmailHashes.has(row.id) ? nextEmailHashes.get(row.id) : row.email_hash;
    if (newDocumentHash === row.document_number_hash && newEmailHash === row.email_hash) {
      continue; // ya migrado (idempotencia) -- no reescribe si no cambió nada.
    }
    await client.query('update public.catastrox_customers set document_number_hash = $2, email_hash = $3 where id = $1', [
      row.id,
      newDocumentHash,
      newEmailHash,
    ]);
    updated += 1;
  }

  return { total: rows.length, updated };
}

async function rehashBillingProfiles({ client, decryptPii, hashDocumentNumber, hashEmail, normalizeDocumentNumber, normalizeEmail }) {
  const { rows } = await client.query(
    `select id, document_number_encrypted, document_number_hash, billing_email_encrypted, billing_email, billing_email_hash
       from public.catastrox_billing_profiles
      where document_number_encrypted is not null
      for update`,
  );

  let updated = 0;
  for (const row of rows) {
    const documentPlaintext = normalizeDocumentNumber(decryptPii(row.document_number_encrypted));
    const newDocumentHash = hashDocumentNumber(documentPlaintext);

    const emailPlaintext = resolvePlaintext({ encrypted: row.billing_email_encrypted, plaintext: row.billing_email, decryptPii });
    const newEmailHash = emailPlaintext ? hashEmail(normalizeEmail(emailPlaintext)) : row.billing_email_hash;

    if (newDocumentHash === row.document_number_hash && newEmailHash === row.billing_email_hash) {
      continue;
    }
    await client.query(
      'update public.catastrox_billing_profiles set document_number_hash = $2, billing_email_hash = $3 where id = $1',
      [row.id, newDocumentHash, newEmailHash],
    );
    updated += 1;
  }

  return { total: rows.length, updated };
}

async function rehashDeliveryJobs({ client, decryptPii, hashEmail, normalizeEmail }) {
  const { rows } = await client.query(
    `select id, delivery_email_encrypted, delivery_email, delivery_email_hash
       from public.catastrox_delivery_jobs
      where delivery_email_encrypted is not null or delivery_email is not null
      for update`,
  );

  let updated = 0;
  for (const row of rows) {
    const emailPlaintext = resolvePlaintext({ encrypted: row.delivery_email_encrypted, plaintext: row.delivery_email, decryptPii });
    if (!emailPlaintext) continue;
    const newEmailHash = hashEmail(normalizeEmail(emailPlaintext));
    if (newEmailHash === row.delivery_email_hash) continue;
    await client.query('update public.catastrox_delivery_jobs set delivery_email_hash = $2 where id = $1', [row.id, newEmailHash]);
    updated += 1;
  }

  return { total: rows.length, updated };
}

async function main() {
  assertSafeToRunBackfill();

  const { getConfig } = await import('../../server/config/env.js');
  getConfig();
  const { getDbPool, closeMainDbPool } = await import('../../server/db.js');
  const piiCrypto = await import('../../server/services/catastrox/piiCrypto.js');

  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const customersResult = await rehashCustomers({ client, ...piiCrypto });
    const billingResult = await rehashBillingProfiles({ client, ...piiCrypto });
    const deliveryResult = await rehashDeliveryJobs({ client, ...piiCrypto });

    await client.query('COMMIT');

    console.log('[backfill-rehash] Re-hasheo con separación de dominios completado (solo conteos, nunca PII):', {
      customers: customersResult,
      billingProfiles: billingResult,
      deliveryJobs: deliveryResult,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await closeMainDbPool();
  }
}

main().catch((error) => {
  console.error('[backfill-rehash] Falló:', error.message);
  process.exitCode = 1;
});
