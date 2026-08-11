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
 * llamador no ya está dentro de una (client === null) -- usado por
 * reserveEmailVerificationSend() más abajo, que necesita un `select ...
 * for update` y su `update` posterior atómicos entre sí. Si el llamador
 * ya pasó un `client` (p. ej. un futuro flujo que envuelva esto en una
 * transacción mayor), se reutiliza tal cual -- nunca anida BEGIN dentro
 * de BEGIN.
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
 * R3/B6-26 (Modelo B, reemplaza al antiguo upsertCustomer()): una
 * identidad existente (document_number_hash) es INMUTABLE desde este
 * punto de entrada. Nunca hace `ON CONFLICT DO UPDATE` sobre una fila ya
 * existente -- ni PII, ni email, ni consentimientos/términos se
 * refrescan como efecto de una petición no autenticada, sin importar qué
 * datos traiga el body. La única escritura posible es un INSERT genuino
 * de un documento nunca visto.
 *
 * Clasifica el resultado en tres estados explícitos:
 *   - NEW: el documento no existía -- se crea la fila tal cual.
 *   - EXISTING_SAME_EMAIL: el documento existe y el email_hash coincide
 *     con el ya almacenado -- se reutiliza la fila EXISTENTE sin tocar
 *     ninguna columna (el llamador solo debe iniciar un step-up de OTP
 *     fresco contra el correo ya almacenado).
 *   - EXISTING_DIFFERENT_EMAIL: el documento existe con un email_hash
 *     distinto -- la fila se devuelve para que el llamador pueda
 *     reconocer el caso, pero el llamador NUNCA debe escribir nada a
 *     partir de ella (ver POST /customers en catastroxPayments.js, que
 *     falla cerrado sin tocar la base en este estado).
 *
 * Concurrencia (dos POST /customers simultáneos con el mismo documento):
 * `INSERT ... ON CONFLICT (document_number_hash) DO NOTHING RETURNING *`
 * es una única sentencia atómica -- Postgres garantiza que, del conjunto
 * de escrituras concurrentes para el MISMO document_number_hash, como
 * mucho una inserta de verdad (según el constraint UNIQUE ya existente);
 * el resto obtiene 0 filas del INSERT y cae al SELECT de solo lectura de
 * abajo, que siempre observa la fila que "ganó" la carrera -- nunca hay
 * una ventana en la que una escritura concurrente pueda sobrescribir la
 * fila de otra como efecto de resolver el conflicto.
 *
 * @param {ReturnType<typeof import('./customerValidation.js').validateCustomerInput>} input
 * @returns {Promise<{ customer: object, state: 'NEW'|'EXISTING_SAME_EMAIL'|'EXISTING_DIFFERENT_EMAIL' }>}
 */
export async function resolveCustomerForVerification(input, client = null) {
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

  const insertResult = await run(
    client,
    `insert into ${CUSTOMERS_TABLE}
       (customer_type, first_name_encrypted, last_name_encrypted, legal_name_encrypted, document_type,
        document_number_encrypted, document_number_hash, email_encrypted, email_hash,
        phone_encrypted, country_code, department_encrypted, city_encrypted, address_encrypted,
        privacy_consent_at, terms_accepted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now())
     on conflict (document_number_hash) do nothing
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

  if (insertResult.rows[0]) {
    return { customer: insertResult.rows[0], state: 'NEW' };
  }

  // Conflicto: ya existe una fila con este document_number_hash (creada
  // antes, o por otra escritura concurrente que ganó la carrera del
  // INSERT de arriba) -- se relee TAL CUAL está, nunca se escribe nada
  // aquí. La clasificación compara el email_hash de ESTA petición contra
  // el ya almacenado; el email del body nunca decide nada más allá de eso.
  const existingResult = await run(client, `select * from ${CUSTOMERS_TABLE} where document_number_hash = $1`, [documentHash]);
  const existingCustomer = existingResult.rows[0];
  if (!existingCustomer) {
    // Ventana teórica extrema: el INSERT perdió la carrera (0 filas) pero
    // la fila que la ganó ya no existe para cuando corre este SELECT
    // (borrada por un proceso externo entre ambas sentencias). Nunca es
    // un problema de seguridad (no hay ninguna fila que proteger de una
    // escritura indebida); se falla explícito en vez de reintentar en
    // bucle o inventar un estado nuevo no solicitado.
    throw new Error('resolveCustomerForVerification: conflicto de documento sin fila existente localizable.');
  }

  const state = existingCustomer.email_hash === emailHash ? 'EXISTING_SAME_EMAIL' : 'EXISTING_DIFFERENT_EMAIL';
  return { customer: existingCustomer, state };
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
 * ÚNICAMENTE a este llamador -- la ruta decide si lo transporta por
 * sendVerificationEmail() (server/services/catastrox/emailSender.js) o,
 * solo en development/test, lo devuelve en la respuesta para pruebas.
 *
 * También devuelve `id` (EMAIL_PROVIDER_002): la fila recién creada
 * identifica de forma única esta emisión concreta del código -- la ruta la
 * usa para derivar el `Idempotency-Key` que se envía al proveedor de
 * correo, estable dentro del mismo intento de verificación pero distinto
 * en cada reenvío real (cada reenvío inserta una fila nueva).
 */
export async function createEmailVerification(customerId, client = null) {
  const code = generateSixDigitCode();
  const codeHash = hashPii(code);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  const result = await run(
    client,
    `insert into ${EMAIL_VERIFICATIONS_TABLE} (customer_id, code_hash, expires_at) values ($1, $2, $3) returning id`,
    [customerId, codeHash, expiresAt],
  );

  return { id: result.rows[0].id, code, expiresAt };
}

/**
 * EMAIL_PROVIDER_002 (revisión de reenvío): genera un código candidato SIN
 * persistirlo -- pura generación en memoria, sin tocar la base de datos.
 * Existe porque `verifyEmailCode()` siempre valida contra la fila MÁS
 * RECIENTE no consumida/no expirada (`order by created_at desc limit 1`):
 * si se insertara la fila antes de confirmar que sendVerificationEmail()
 * entregó el correo, un fallo del proveedor dejaría una fila "activa" con
 * un código que el comprador nunca recibió, ensombreciendo (shadowing)
 * cualquier código anterior que sí le hubiera llegado -- un candado
 * autoinfligido. El `id` generado aquí (UUID de aplicación, nunca el
 * default de la base) es la misma clave que
 * server/routes/catastroxPayments.js usa para derivar el Idempotency-Key
 * de Resend, exista o no exista finalmente la fila en la base.
 *
 * @returns {{ id: string, code: string, codeHash: string, expiresAt: Date }}
 */
export function generatePendingEmailVerification() {
  const id = crypto.randomUUID();
  const code = generateSixDigitCode();
  const codeHash = hashPii(code);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  return { id, code, codeHash, expiresAt };
}

/**
 * Persiste un candidato generado por generatePendingEmailVerification() --
 * el llamador decide CUÁNDO llamar esto (solo tras confirmar entrega real,
 * o siempre en development/test donde no hay entrega real que confirmar).
 * `id` se inserta explícito (no se usa el default `gen_random_uuid()` de la
 * columna) para que sea exactamente el mismo id ya usado como base del
 * Idempotency-Key del intento de envío.
 */
export async function persistEmailVerification({ id, customerId, codeHash, expiresAt }, client = null) {
  await run(
    client,
    `insert into ${EMAIL_VERIFICATIONS_TABLE} (id, customer_id, code_hash, expires_at) values ($1, $2, $3, $4)`,
    [id, customerId, codeHash, expiresAt],
  );
}

// --- Cooldown backend de emisión de OTP (cierre de protección backend) ---
// El frontend ya aplica un cooldown de 30s (CatastroXOtpVerification.jsx),
// pero eso nunca protege el endpoint en sí -- un cliente que llame
// POST /customers directamente no pasa por esa UI. Lo de abajo es la
// contraparte de backend, respaldada en Postgres (no en memoria del
// proceso, porque staging puede reiniciar o correr múltiples instancias --
// un contador en memoria no sobreviviría ni se compartiría entre ellas).
//
// catastrox_customer_otp_state (migración 006) es una tabla de UN registro
// por comprador, deliberadamente separada de catastrox_email_verifications:
// esta última solo debe contener códigos REALMENTE entregados (política de
// la revisión de reenvío anterior) -- mezclar ahí un estado de "reserva
// breve" habría reabierto ese mismo riesgo.
const OTP_STATE_TABLE = 'public.catastrox_customer_otp_state';

// Cooldown real entre emisiones REALMENTE entregadas -- coincide con el
// cooldown de UI del frontend (RESEND_COOLDOWN_SECONDS,
// CatastroXOtpVerification.jsx) para que el comportamiento visible y el
// exigido por el backend sean el mismo número.
const EMAIL_VERIFICATION_COOLDOWN_SECONDS = 30;

// Duración máxima que una "reserva" (envío en curso) cuenta como activa.
// Debe ser: (a) mayor que el peor caso REAL de duración de un intento de
// envío (intento inicial + el único reintento interno de
// sendVerificationEmail(), cada uno acotado por EMAIL_SEND_TIMEOUT_MS) y
// (b) menor que el cooldown de 30s, para que un envío fallido nunca
// bloquee al comprador el cooldown completo -- solo el tiempo que de
// verdad duró el intento. Se calcula a partir de EMAIL_SEND_TIMEOUT_MS en
// vez de un valor fijo -- un valor fijo (p. ej. 20s) sería insuficiente si
// se configurara un timeout cercano a su máximo permitido (15000ms:
// 2 intentos completos superarían los 30s del cooldown). Con el timeout
// por defecto (5000ms) da 11s -- cómodo margen sobre el peor caso real
// (~10.2s). Riesgo residual documentado en
// docs/catastrox/EMAIL_PROVIDER_001.md: en la configuración más extrema
// permitida (EMAIL_SEND_TIMEOUT_MS=15000), el peor caso real (~30.2s)
// puede superar levemente el techo de 29s aplicado aquí -- una segunda
// solicitud podría, en ese único escenario extremo, no ser bloqueada en
// el último instante. Nunca es un problema de seguridad (verificar sigue
// exigiendo el código correcto), solo de duplicar, en el peor caso, un
// envío ya de por sí muy lento.
function resolveReservationTtlSeconds() {
  const raw = process.env.EMAIL_SEND_TIMEOUT_MS;
  const trimmed = String(raw ?? '').trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : 5000;
  const timeoutMs = Math.min(Math.max(parsed, 1000), 15000);
  const worstCaseMs = timeoutMs * 2 + 1000; // dos intentos + margen fijo (retraso entre reintentos + red)
  const ttlSeconds = Math.ceil(worstCaseMs / 1000);
  return Math.min(EMAIL_VERIFICATION_COOLDOWN_SECONDS - 1, Math.max(10, ttlSeconds));
}

function clampRetryAfterSeconds(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return EMAIL_VERIFICATION_COOLDOWN_SECONDS;
  return Math.min(EMAIL_VERIFICATION_COOLDOWN_SECONDS, Math.max(1, Math.round(parsed)));
}

/**
 * Reserva atómicamente el derecho a intentar un nuevo envío de OTP para
 * este comprador, o informa que debe esperar. Dos motivos posibles de
 * espera, mismo código de respuesta para el llamador (la ruta):
 *   - cooldown: han pasado menos de 30s desde el último envío REALMENTE
 *     entregado (o development/test) para este comprador;
 *   - reserva activa: otra solicitud para el mismo comprador ya está en
 *     curso (reserved_at reciente, menor que el TTL de reserva).
 *
 * Usa `select ... for update` sobre la fila de este comprador -- Postgres
 * serializa naturalmente solicitudes concurrentes para el MISMO
 * customer_id (la segunda espera a que la transacción de la primera haga
 * commit/rollback antes de poder leer). El lock se libera al hacer commit
 * de esta función (dentro de withCustomerTransaction) -- ANTES de llamar a
 * sendVerificationEmail(), nunca durante esa llamada externa.
 *
 * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
 */
export async function reserveEmailVerificationSend(customerId, client = null) {
  return withCustomerTransaction(client, async (txClient) => {
    await txClient.query(`insert into ${OTP_STATE_TABLE} (customer_id) values ($1) on conflict (customer_id) do nothing`, [
      customerId,
    ]);

    const result = await txClient.query(
      `select
         (last_delivered_at is not null and now() - last_delivered_at < make_interval(secs => $2)) as in_cooldown,
         greatest(0, ceil(extract(epoch from (last_delivered_at + make_interval(secs => $2) - now()))))::int as cooldown_remaining_seconds,
         (reserved_at is not null and now() - reserved_at < make_interval(secs => $3)) as reservation_active,
         greatest(0, ceil(extract(epoch from (reserved_at + make_interval(secs => $3) - now()))))::int as reservation_remaining_seconds
       from ${OTP_STATE_TABLE}
       where customer_id = $1
       for update`,
      [customerId, EMAIL_VERIFICATION_COOLDOWN_SECONDS, resolveReservationTtlSeconds()],
    );
    const row = result.rows[0];

    if (row.in_cooldown) {
      return { allowed: false, retryAfterSeconds: clampRetryAfterSeconds(row.cooldown_remaining_seconds) };
    }
    if (row.reservation_active) {
      return { allowed: false, retryAfterSeconds: clampRetryAfterSeconds(row.reservation_remaining_seconds) };
    }

    await txClient.query(`update ${OTP_STATE_TABLE} set reserved_at = now() where customer_id = $1`, [customerId]);
    return { allowed: true };
  });
}

/**
 * Libera la reserva tomada por reserveEmailVerificationSend() una vez se
 * conoce el resultado real del envío -- se llama siempre, haya tenido
 * éxito o no, para nunca dejar `reserved_at` "colgado" más allá de este
 * intento concreto (aunque también expira solo, por TTL, si algo lo
 * impidiera).
 *
 * `delivered`: entregado de verdad, o development/test (donde no hay
 * entrega real que confirmar pero sí se considera "la última emisión" a
 * efectos del cooldown, igual que ya decide la ruta para persistir la fila
 * de verificación). Si es `false` (fallo real en staging/producción), solo
 * se libera la reserva -- NUNCA se actualiza last_delivered_at, para que el
 * cooldown de 30s no se reinicie por un envío que nunca llegó.
 */
export async function releaseEmailVerificationSend(customerId, { delivered }, client = null) {
  if (delivered) {
    await run(
      client,
      `update ${OTP_STATE_TABLE} set last_delivered_at = now(), reserved_at = null where customer_id = $1`,
      [customerId],
    );
  } else {
    await run(client, `update ${OTP_STATE_TABLE} set reserved_at = null where customer_id = $1`, [customerId]);
  }
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
