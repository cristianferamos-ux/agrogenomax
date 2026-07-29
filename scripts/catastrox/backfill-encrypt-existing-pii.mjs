#!/usr/bin/env node
// Backfill de cifrado de PII (revisión de seguridad, Bloque 1, punto 8/9):
// migra filas creadas ANTES de la migración 005 -- que todavía tienen
// correo/nombres/ciudad/departamento/correo de entrega en texto plano --
// a las columnas *_encrypted/*_hash, y NULEA las columnas legadas de esa
// misma fila una vez copiado el valor cifrado (nunca antes de verificar
// que el cifrado round-tripea correctamente).
//
// Operador ejecuta esto UNA VEZ por ambiente, después de aplicar la
// migración 005 y desplegar el código que ya no escribe texto plano
// (customerRepository.js/paymentOrderRepository.js/deliveryJobService.js).
// Idempotente: una fila ya migrada (columna *_encrypted no nula) se
// omite, así que correrlo dos veces no hace nada la segunda vez.
//
// Nunca imprime PII -- solo conteos.
//
// Uso:
//   CATASTROX_ALLOW_TEST_BACKFILL=true node scripts/catastrox/backfill-encrypt-existing-pii.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(workspaceRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(workspaceRoot, 'server', '.env'), quiet: true });

// Misma guarda que backfill-known-approved-order.mjs -- este script
// también escribe/borra datos en la base configurada por DATABASE_URL sin
// confirmación interactiva.
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

async function main() {
  assertSafeToRunBackfill();

  const { getConfig } = await import('../../server/config/env.js');
  getConfig();
  const { query, closeMainDbPool } = await import('../../server/db.js');
  const { encryptPii, hashEmail, normalizeEmail } = await import('../../server/services/catastrox/piiCrypto.js');

  try {
    // --- catastrox_customers ---------------------------------------
    const customers = await query(
      `select id, first_name, last_name, legal_name, email_normalized, department, city
         from public.catastrox_customers
        where email_encrypted is null and email_normalized is not null`,
    );
    let customersMigrated = 0;
    for (const row of customers.rows) {
      const emailNormalized = normalizeEmail(row.email_normalized);
      await query(
        `update public.catastrox_customers
            set first_name_encrypted = $2,
                last_name_encrypted = $3,
                legal_name_encrypted = $4,
                email_encrypted = $5,
                email_hash = $6,
                department_encrypted = $7,
                city_encrypted = $8,
                first_name = null,
                last_name = null,
                legal_name = null,
                email_normalized = null,
                department = null,
                city = null
          where id = $1`,
        [
          row.id,
          encryptPii(row.first_name),
          encryptPii(row.last_name),
          encryptPii(row.legal_name),
          encryptPii(emailNormalized),
          hashEmail(emailNormalized),
          encryptPii(row.department),
          encryptPii(row.city),
        ],
      );
      customersMigrated += 1;
    }

    // --- catastrox_billing_profiles ---------------------------------
    const billingProfiles = await query(
      `select id, billing_name, billing_email, city, department
         from public.catastrox_billing_profiles
        where billing_email_encrypted is null and billing_email is not null`,
    );
    let billingProfilesMigrated = 0;
    for (const row of billingProfiles.rows) {
      const billingEmailNormalized = normalizeEmail(row.billing_email);
      await query(
        `update public.catastrox_billing_profiles
            set billing_name_encrypted = $2,
                billing_email_encrypted = $3,
                billing_email_hash = $4,
                city_encrypted = $5,
                department_encrypted = $6,
                billing_name = null,
                billing_email = null,
                city = null,
                department = null
          where id = $1`,
        [
          row.id,
          encryptPii(row.billing_name),
          encryptPii(billingEmailNormalized),
          hashEmail(billingEmailNormalized),
          encryptPii(row.city),
          encryptPii(row.department),
        ],
      );
      billingProfilesMigrated += 1;
    }

    // --- catastrox_delivery_jobs -------------------------------------
    const deliveryJobs = await query(
      `select id, delivery_email
         from public.catastrox_delivery_jobs
        where delivery_email_encrypted is null and delivery_email is not null`,
    );
    let deliveryJobsMigrated = 0;
    for (const row of deliveryJobs.rows) {
      const deliveryEmailNormalized = normalizeEmail(row.delivery_email);
      await query(
        `update public.catastrox_delivery_jobs
            set delivery_email_encrypted = $2,
                delivery_email_hash = $3,
                delivery_email = null
          where id = $1`,
        [row.id, encryptPii(deliveryEmailNormalized), hashEmail(deliveryEmailNormalized)],
      );
      deliveryJobsMigrated += 1;
    }

    console.log('[backfill-encrypt] Migración completada (solo conteos, nunca PII):', {
      customersMigrated,
      billingProfilesMigrated,
      deliveryJobsMigrated,
    });
  } finally {
    await closeMainDbPool();
  }
}

main().catch((error) => {
  console.error('[backfill-encrypt] Falló:', error.message);
  process.exitCode = 1;
});
