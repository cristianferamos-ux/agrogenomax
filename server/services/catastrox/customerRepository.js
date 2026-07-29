// Acceso a datos de comprador + verificación de correo (Bloque 2/5 del
// pedido, endurecido en la revisión de PII/idempotencia). Vive en la misma
// base `agx` que las órdenes de pago (server/db.js) -- un comprador y sus
// órdenes son parte del mismo dominio transaccional.
//
// PII en reposo (correo, nombres, ciudad, departamento, documento,
// teléfono, dirección) se cifra con AES-256-GCM (piiCrypto.js) antes de
// insertarse -- ninguna de estas columnas *_encrypted/*_hash viaja nunca
// hacia una ruta que responda al cliente; solo este archivo (y
// deliveryJobService.js/paymentOrderRepository.js/invoiceJobService.js,
// que la necesitan para operar de verdad) descifra con decryptPii().
//
// Las columnas legadas en texto plano (email_normalized, first_name,
// last_name, legal_name, department, city) quedan en el esquema
// (migración 005 es aditiva) pero este archivo YA NO LAS ESCRIBE -- se
// dejan explícitamente en null en cada INSERT/UPDATE nuevo. Ver
// scripts/catastrox/backfill-encrypt-existing-pii.mjs para migrar filas
// creadas antes de este cambio.
import crypto from 'crypto';
import { getDbPool, query } from '../../db.js';
import { decryptPii, encryptPii, hashDocumentNumber, hashEmail, hashPii, normalizeDocumentNumber, normalizeEmail } from './piiCrypto.js';

const CUSTOMERS_TABLE = 'public.catastrox_customers';
const EMAIL_VERIFICATIONS_TABLE = 'public.catastrox_email_verifications';
const EMAIL_VERIFICATION_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;

async function run(client, text, params) {
  if (client) return client.query(text, params);
  return query(text, params);
}

/**
 * Ejecuta `callback(client)` dentro de una transacción propia cuando el
 * llamador no ya está dentro de una (client === null) -- upsertCustomer
 * necesita leer el correo previo, escribir el comprador y, si el correo
 * cambió, invalidar códigos de verificación activos, todo de forma
 * atómica. Si el llamador ya pasó un `client` (p. ej. un futuro flujo que
 * envuelva esto en una transacción mayor), se reutiliza tal cual -- nunca
 * anida BEGIN dentro de BEGIN.
 */
async function withCustomerTransaction(externalClient, callback) {
  if (externalClient) return callback(externalClient);

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Crea o actualiza el comprador identificado por su documento (hash).
 * Un mismo comprador que vuelve a comprar actualiza sus datos de contacto
 * a los últimos declarados -- privacy_consent_at/terms_accepted_at
 * también se refrescan (el formulario exige aceptar de nuevo en cada
 * compra), nunca se aceptan como timestamp del cliente.
 *
 * Cambio de correo (Bloque 2 de la revisión): si el email_hash difiere del
 * ya guardado para este documento, email_verified_at se resetea a NULL
 * (dentro del propio UPSERT, vía CASE sobre el valor previo de la fila) y
 * todos los códigos de verificación activos del comprador se invalidan
 * explícitamente -- un OTP emitido para el correo anterior nunca debe
 * verificar el nuevo. Si el correo no cambió, la verificación existente se
 * conserva intacta.
 *
 * @param {ReturnType<typeof import('./customerValidation.js').validateCustomerInput>} input
 */
export async function upsertCustomer(input, client = null) {
  return withCustomerTransaction(client, async (txClient) => {
    const documentNumber = normalizeDocumentNumber(input.documentNumber);
    // Separación de dominios (endurecimiento final): hashDocumentNumber()/
    // hashEmail() hashean sobre "catastrox:document:v1:"/"catastrox:email:v1:"
    // + el valor normalizado -- nunca el valor desnudo -- para que un
    // documento y un correo que coincidieran textualmente nunca produzcan
    // el mismo hash bajo el mismo secreto. hashPii() genérico queda
    // reservado para el código OTP (más abajo), nunca para documento/correo.
    const documentHash = hashDocumentNumber(documentNumber);
    const documentEncrypted = encryptPii(documentNumber);
    const emailNormalized = normalizeEmail(input.email);
    const emailHash = hashEmail(emailNormalized);
    const emailEncrypted = encryptPii(emailNormalized);
    const firstNameEncrypted = encryptPii(input.firstName);
    const lastNameEncrypted = encryptPii(input.lastName);
    const legalNameEncrypted = encryptPii(input.legalName);
    const departmentEncrypted = encryptPii(input.department);
    const cityEncrypted = encryptPii(input.city);
    const phoneEncrypted = encryptPii(input.phone);
    const addressEncrypted = encryptPii(input.address);

    const result = await txClient.query(
      `insert into ${CUSTOMERS_TABLE}
         (customer_type, first_name_encrypted, last_name_encrypted, legal_name_encrypted, document_type,
          document_number_encrypted, document_number_hash, email_encrypted, email_hash,
          phone_encrypted, country_code, department_encrypted, city_encrypted, address_encrypted,
          privacy_consent_at, terms_accepted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now())
       on conflict (document_number_hash) do update set
         customer_type = excluded.customer_type,
         first_name_encrypted = excluded.first_name_encrypted,
         last_name_encrypted = excluded.last_name_encrypted,
         legal_name_encrypted = excluded.legal_name_encrypted,
         document_type = excluded.document_type,
         document_number_encrypted = excluded.document_number_encrypted,
         email_encrypted = excluded.email_encrypted,
         email_hash = excluded.email_hash,
         phone_encrypted = excluded.phone_encrypted,
         country_code = excluded.country_code,
         department_encrypted = excluded.department_encrypted,
         city_encrypted = excluded.city_encrypted,
         address_encrypted = excluded.address_encrypted,
         privacy_consent_at = now(),
         terms_accepted_at = now(),
         -- Referencia sin calificar / calificada por nombre de tabla dentro de
         -- ON CONFLICT DO UPDATE SET significa el valor de la fila YA
         -- EXISTENTE (antes de este UPDATE) -- comparar contra excluded.email_hash
         -- (el valor nuevo) es exactamente la detección de cambio de correo,
         -- atómica, sin condición de carrera con una segunda escritura
         -- concurrente del mismo comprador.
         email_verified_at = case
           when ${CUSTOMERS_TABLE}.email_hash = excluded.email_hash then ${CUSTOMERS_TABLE}.email_verified_at
           else null
         end
       returning *`,
      [
        input.customerType,
        firstNameEncrypted,
        lastNameEncrypted,
        legalNameEncrypted,
        input.documentType,
        documentEncrypted,
        documentHash,
        emailEncrypted,
        emailHash,
        phoneEncrypted,
        input.countryCode,
        departmentEncrypted,
        cityEncrypted,
        addressEncrypted,
      ],
    );

    const customer = result.rows[0];

    // Invalidación explícita de OTPs activos del correo anterior (defensa
    // en profundidad -- verifyEmailCode() ya solo mira el código más
    // reciente, así que esto nunca deja pasar un código viejo, pero deja
    // constancia inequívoca en la tabla de que esos códigos quedaron
    // muertos, sin depender únicamente del orden de creación).
    if (customer.email_verified_at === null) {
      await txClient.query(
        `update ${EMAIL_VERIFICATIONS_TABLE}
            set consumed_at = now()
          where customer_id = $1
            and consumed_at is null
            and created_at < now()`,
        [customer.id],
      );
    }

    return customer;
  });
}

export async function findCustomerById(customerId, client = null) {
  if (!customerId) return null;
  const result = await run(client, `select * from ${CUSTOMERS_TABLE} where id = $1`, [customerId]);
  return result.rows[0] || null;
}

/**
 * Vista segura de un comprador para exponer en respuestas HTTP -- nunca
 * incluye documento/correo/nombre/teléfono/dirección, ni siquiera
 * cifrados (no hay ninguna razón operativa para que el frontend los
 * reciba de vuelta).
 */
export function toPublicCustomerSummary(customerRow) {
  if (!customerRow) return null;
  return {
    customerId: customerRow.id,
    customerType: customerRow.customer_type,
    emailVerified: Boolean(customerRow.email_verified_at),
  };
}

/**
 * Descifra los campos de PII de un comprador para uso EXCLUSIVAMENTE
 * interno de backend (envío de OTP, entrega de archivos, facturación
 * electrónica, soporte autorizado) -- el resultado de esta función nunca
 * debe serializarse directamente en una respuesta HTTP. Prioriza las
 * columnas cifradas nuevas; si un comprador todavía no tiene valor cifrado
 * (fila creada antes de esta migración y aún no re-guardada), cae de
 * vuelta a la columna legada en texto plano -- nunca al revés.
 */
export function decryptCustomerPii(customerRow) {
  if (!customerRow) return null;
  return {
    firstName: customerRow.first_name_encrypted ? decryptPii(customerRow.first_name_encrypted) : customerRow.first_name || null,
    lastName: customerRow.last_name_encrypted ? decryptPii(customerRow.last_name_encrypted) : customerRow.last_name || null,
    legalName: customerRow.legal_name_encrypted ? decryptPii(customerRow.legal_name_encrypted) : customerRow.legal_name || null,
    email: customerRow.email_encrypted ? decryptPii(customerRow.email_encrypted) : customerRow.email_normalized || null,
    department: customerRow.department_encrypted ? decryptPii(customerRow.department_encrypted) : customerRow.department || null,
    city: customerRow.city_encrypted ? decryptPii(customerRow.city_encrypted) : customerRow.city || null,
  };
}

function generateSixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Genera un código de un solo uso (6 dígitos, expira en 10 min) y lo
 * persiste hasheado (nunca en claro). Devuelve el código en claro
 * ÚNICAMENTE a este llamador -- la ruta decide si lo transporta por un
 * proveedor de correo real (no implementado, ver informe) o, solo en
 * development/test, lo devuelve en la respuesta para pruebas.
 */
export async function createEmailVerification(customerId, client = null) {
  const code = generateSixDigitCode();
  const codeHash = hashPii(code);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await run(
    client,
    `insert into ${EMAIL_VERIFICATIONS_TABLE} (customer_id, code_hash, expires_at) values ($1, $2, $3)`,
    [customerId, codeHash, expiresAt],
  );

  return { code, expiresAt };
}

/**
 * Verifica un código contra el más reciente aún vigente para ese
 * comprador. Nunca revela si el comprador existe o si el problema fue
 * "código incorrecto" vs "sin intento activo" en el mensaje público de la
 * ruta -- aquí se devuelve el motivo exacto solo para logging interno.
 */
export async function verifyEmailCode(customerId, rawCode) {
  const result = await query(
    `select * from ${EMAIL_VERIFICATIONS_TABLE}
      where customer_id = $1 and consumed_at is null and expires_at > now()
      order by created_at desc
      limit 1`,
    [customerId],
  );
  const record = result.rows[0];

  if (!record) {
    return { ok: false, reason: 'no_active_code' };
  }

  if (record.attempt_count >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  const submittedHash = hashPii(String(rawCode || '').trim());
  const matches = Boolean(submittedHash) && submittedHash === record.code_hash;

  await query(`update ${EMAIL_VERIFICATIONS_TABLE} set attempt_count = attempt_count + 1 where id = $1`, [record.id]);

  if (!matches) {
    return { ok: false, reason: 'code_mismatch' };
  }

  await query(`update ${EMAIL_VERIFICATIONS_TABLE} set consumed_at = now() where id = $1`, [record.id]);
  await query(`update ${CUSTOMERS_TABLE} set email_verified_at = now() where id = $1`, [customerId]);

  return { ok: true };
}
