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

    // EMAIL_PROVIDER_002 (revisión de reenvío -- hallazgo real): se lee el
    // email_hash YA guardado para este documento, ANTES del upsert, para
    // poder distinguir más abajo "el correo cambió en esta escritura" de
    // "el comprador simplemente no se ha verificado todavía" -- antes de
    // esta corrección, la invalidación de OTPs activos usaba
    // `customer.email_verified_at === null` como proxy de "el correo
    // cambió", pero esa condición también es cierta en CADA reenvío previo
    // a la primera verificación exitosa (email_verified_at no se vuelve
    // NOT NULL hasta que el comprador verifica) -- un reenvío con el MISMO
    // correo invalidaba, como efecto secundario, el código anterior
    // todavía vigente y ya entregado, incluso si el reenvío en sí fallaba
    // después en Resend. Concurrencia: si dos escrituras del mismo
    // documento con correos distintos llegaran verdaderamente en
    // simultáneo, existe una ventana teórica y estrecha en la que ambas
    // lean el mismo valor "anterior" -- no es una vía de bypass de
    // seguridad (el código OTP verificado sigue exigiendo el hash
    // correcto), solo podría dejar un código viejo activo un instante de
    // más en un escenario ya de por sí extremadamente inusual.
    const existingCustomerResult = await txClient.query(
      `select email_hash from ${CUSTOMERS_TABLE} where document_number_hash = $1`,
      [documentHash],
    );
    const previousEmailHash = existingCustomerResult.rows[0]?.email_hash ?? null;
    const emailChangedInThisWrite = previousEmailHash !== null && previousEmailHash !== emailHash;

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
    // muertos, sin depender únicamente del orden de creación). Condición
    // corregida (EMAIL_PROVIDER_002, revisión de reenvío): solo cuando el
    // correo REALMENTE cambió en esta escritura -- ver
    // emailChangedInThisWrite arriba. Antes se usaba
    // `customer.email_verified_at === null`, que también es cierto en cada
    // reenvío previo a la primera verificación y consumía, por error, un
    // código anterior todavía vigente y ya entregado.
    if (emailChangedInThisWrite) {
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
