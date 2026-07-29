// Cifrado y hashing de PII de comprador (Bloque 2/12 del pedido) -- AES-256-GCM
// nativo de node:crypto, sin dependencias nuevas. La clave vive únicamente
// en la variable de entorno del backend (CATASTROX_PII_ENCRYPTION_KEY),
// nunca en Postgres -- un volcado de la base de datos por sí solo nunca
// revela documento/teléfono/dirección en claro.
//
// document_number_hash (y equivalentes) usan HMAC-SHA256 con un secreto
// PROPIO (CATASTROX_PII_HASH_SECRET, distinto del de cifrado) -- nunca un
// hash simple sin clave: un documento de identidad tiene un espacio de
// valores lo bastante pequeño como para ser enumerable por diccionario/
// fuerza bruta con SHA256 plano, exactamente el motivo por el que HMAC es
// obligatorio aquí (a diferencia del recoveryToken de la fase anterior,
// que sí tiene 256 bits de entropía propios).
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // recomendado para GCM
const KEY_LENGTH_BYTES = 32; // AES-256

function loadEncryptionKey() {
  const raw = process.env.CATASTROX_PII_ENCRYPTION_KEY || '';
  if (!raw) {
    const error = new Error('CATASTROX_PII_ENCRYPTION_KEY no está configurada -- no es posible cifrar/descifrar PII.');
    error.status = 503;
    error.code = 'PII_ENCRYPTION_NOT_CONFIGURED';
    throw error;
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    const error = new Error('CATASTROX_PII_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes (AES-256) en base64.');
    error.status = 503;
    error.code = 'PII_ENCRYPTION_KEY_INVALID';
    throw error;
  }

  return key;
}

function loadHashSecret() {
  const secret = process.env.CATASTROX_PII_HASH_SECRET || '';
  if (!secret) {
    const error = new Error('CATASTROX_PII_HASH_SECRET no está configurada -- no es posible indexar PII de forma segura.');
    error.status = 503;
    error.code = 'PII_HASH_SECRET_NOT_CONFIGURED';
    throw error;
  }
  return secret;
}

/**
 * Cifra un valor de texto. Devuelve `iv.ciphertext.authTag` en base64url,
 * o null si `plaintext` está vacío (nunca cifra una cadena vacía como si
 * fuera un valor real).
 *
 * @param {string|null|undefined} plaintext
 * @returns {string|null}
 */
export function encryptPii(plaintext) {
  const value = String(plaintext ?? '').trim();
  if (!value) return null;

  const key = loadEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64url'), ciphertext.toString('base64url'), authTag.toString('base64url')].join('.');
}

/**
 * Descifra un valor producido por encryptPii(). Nunca expone detalles del
 * fallo (autenticación GCM fallida, formato corrupto) más allá de un error
 * genérico -- evita oráculos de padding/formato.
 *
 * @param {string|null|undefined} encoded
 * @returns {string|null}
 */
export function decryptPii(encoded) {
  if (!encoded) return null;

  const parts = String(encoded).split('.');
  if (parts.length !== 3) {
    throw new Error('Valor cifrado con formato inválido.');
  }

  const key = loadEncryptionKey();
  const [ivPart, ciphertextPart, authTagPart] = parts;

  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    const authTag = Buffer.from(authTagPart, 'base64url');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('No fue posible descifrar el valor (formato inválido o clave incorrecta).');
  }
}

/**
 * HMAC-SHA256 de un valor normalizado (trim), en hexadecimal minúscula.
 * Nunca null-safe silencioso: un valor vacío no produce un hash "válido"
 * reutilizable como si representara ausencia de dato.
 *
 * GENÉRICA -- nunca se usa directamente para documento o correo (ver
 * hashDocumentNumber()/hashEmail() más abajo, endurecimiento de
 * separación de dominios). Sigue siendo la función correcta para
 * cualquier otro valor que solo necesite un hash indexable con el mismo
 * secreto pero sin ambigüedad de dominio real -- hoy, el código OTP
 * (customerRepository.js).
 *
 * @param {string} value
 * @returns {string|null}
 */
export function hashPii(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;

  const secret = loadHashSecret();
  return crypto.createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeDocumentNumber(value) {
  // Se conservan letras (algunos tipos de documento/NIT usan dígitos de
  // verificación alfanuméricos en ciertos países) -- solo se recortan
  // espacios y separadores comunes, nunca se asume "solo dígitos".
  return String(value ?? '').trim().replace(/[\s.-]+/g, '');
}

// Separación explícita de dominios (endurecimiento final): el mismo
// CATASTROX_PII_HASH_SECRET se sigue usando (secreto gestionado único),
// pero cada campo indexable hashea sobre un prefijo propio de
// dominio+versión, nunca sobre el valor desnudo. Sin esto, un documento y
// un correo que coincidieran textualmente (o cualquier futuro campo
// indexable reutilizando el mismo texto) producirían el MISMO hash bajo
// el mismo secreto -- una filtración cruzada de índice entre campos
// lógicamente distintos. El sufijo ":v1:" permite introducir un dominio
// ":v2:" el día que el esquema de hash deba rotar sin invalidar los demás
// campos.
const HASH_DOMAIN_DOCUMENT_V1 = 'catastrox:document:v1:';
const HASH_DOMAIN_EMAIL_V1 = 'catastrox:email:v1:';

function hashWithDomain(domainPrefix, normalizedValue) {
  const value = String(normalizedValue ?? '').trim();
  if (!value) return null;

  const secret = loadHashSecret();
  return crypto.createHmac('sha256', secret).update(`${domainPrefix}${value}`, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256(secret, "catastrox:document:v1:" + normalizedDocument) --
 * única función que debe usarse para indexar/buscar un número de
 * documento por hash. Normaliza internamente (normalizeDocumentNumber)
 * para que el resultado sea determinista sin importar si el llamador ya
 * normalizó o no.
 *
 * @param {string} documentNumber
 * @returns {string|null}
 */
export function hashDocumentNumber(documentNumber) {
  return hashWithDomain(HASH_DOMAIN_DOCUMENT_V1, normalizeDocumentNumber(documentNumber));
}

/**
 * HMAC-SHA256(secret, "catastrox:email:v1:" + normalizedEmail) -- única
 * función que debe usarse para indexar/buscar un correo por hash.
 * Normaliza internamente (normalizeEmail: trim + lowercase) para que
 * mayúsculas/espacios nunca produzcan un hash distinto para el mismo
 * correo real.
 *
 * @param {string} email
 * @returns {string|null}
 */
export function hashEmail(email) {
  return hashWithDomain(HASH_DOMAIN_EMAIL_V1, normalizeEmail(email));
}
