// R3/B6-26 + B6-26-ADJ-01: tokens de identidad que reemplazan customerId
// desnudo como credencial de cliente en el flujo de comprador de CatastroX.
//
// Dos tokens, dos claves independientes, dos propósitos:
//   - verificationHandle (VERIFY_HANDLE_V1): correlaciona un intento de
//     verificación de OTP con el customer correcto, sin exponer customerId
//     al frontend.
//   - identityCapability (CHECKOUT_IDENTITY_V1): emitida SOLO tras un OTP
//     válido, autoriza checkouts como ese customer durante su TTL --
//     deliberadamente reutilizable dentro de esa ventana (no es de un solo
//     uso: no hay jti consumido ni tabla de estado). La seguridad no
//     depende de un uso único, sino del TTL corto, el binding a
//     emailHash y el propio OTP fresco exigido para emitirla.
//
// AES-256-GCM stateless vía node:crypto (sin dependencias nuevas) -- mismo
// formato de tres partes (iv.ciphertext.authTag en base64url) que ya usa
// piiCrypto.js, pero con una diferencia deliberada: aquí SÍ se usa AAD
// ligada al propósito exacto del token. piiCrypto.js protege PII en reposo
// dentro de una sola tabla (sin necesidad de separación de propósito); un
// token que cruza la red y autoriza una acción concreta sí la necesita --
// sin AAD, nada impediría (si alguna vez compartieran clave) que un
// VERIFY_HANDLE_V1 se reinterpretara como CHECKOUT_IDENTITY_V1. Aquí,
// además, cada propósito usa una clave completamente separada
// (CATASTROX_VERIFY_HANDLE_KEY / CATASTROX_CHECKOUT_IDENTITY_KEY) -- la AAD
// es defensa en profundidad, no la única barrera.
//
// El payload NUNCA contiene PII: solo customerId (UUID interno) y
// emailHash (ya un HMAC-SHA256 de piiCrypto.js, nunca el correo en claro).
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const TOKEN_VERSION = 1;

// Margen de tolerancia SOLO para iat futuro por diferencia de reloj entre
// procesos -- nunca se usa para extender la expiración (exp se compara sin
// ningún margen: now >= exp siempre es inválido).
const CLOCK_SKEW_SECONDS = 60;

const VERIFY_HANDLE_TTL_SECONDS = 10 * 60;
const CHECKOUT_IDENTITY_TTL_SECONDS = 10 * 60;

const PURPOSE_VERIFY_HANDLE = 'VERIFY_HANDLE_V1';
const PURPOSE_CHECKOUT_IDENTITY = 'CHECKOUT_IDENTITY_V1';

// Base64 canónico y estricto: exactamente lo que produce una clave AES-256
// (32 bytes) en base64 estándar -- 43 caracteres del alfabeto + un único
// '=' de padding, sin variantes. Buffer.from(str, 'base64') de Node decodifica
// de forma permisiva (ignora caracteres fuera del alfabeto en vez de fallar),
// así que un string "basura" podría, por accidente, decodificar a
// exactamente 32 bytes -- este patrón lo descarta antes de intentar
// decodificar nada.
const STRICT_BASE64_32_BYTES_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

class IdentityTokenConfigError extends Error {
  constructor(message, { code, variable }) {
    super(message);
    this.status = 503;
    this.code = code;
    this.variable = variable;
  }
}

function isCanonicalTrimmed(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function loadKey(envVarName) {
  const raw = process.env[envVarName] || '';
  if (!isCanonicalTrimmed(raw)) {
    throw new IdentityTokenConfigError(
      `${envVarName} no está configurada -- no es posible emitir/verificar tokens de identidad.`,
      { code: 'IDENTITY_TOKEN_KEY_NOT_CONFIGURED', variable: envVarName },
    );
  }
  if (!STRICT_BASE64_32_BYTES_PATTERN.test(raw)) {
    throw new IdentityTokenConfigError(
      `${envVarName} debe ser base64 estándar canónico de exactamente 32 bytes (AES-256).`,
      { code: 'IDENTITY_TOKEN_KEY_INVALID', variable: envVarName },
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new IdentityTokenConfigError(`${envVarName} debe decodificar a exactamente 32 bytes (AES-256) en base64.`, {
      code: 'IDENTITY_TOKEN_KEY_INVALID',
      variable: envVarName,
    });
  }
  return key;
}

function loadVerifyHandleKey() {
  return loadKey('CATASTROX_VERIFY_HANDLE_KEY');
}

function loadCheckoutIdentityKey() {
  return loadKey('CATASTROX_CHECKOUT_IDENTITY_KEY');
}

function isValidCustomerId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isValidEmailHash(value) {
  return typeof value === 'string' && HEX_SHA256_PATTERN.test(value);
}

function resolveNowSeconds(now) {
  return Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
}

function buildPayload({ customerId, emailHash, purpose, ttlSeconds, now }) {
  if (!isValidCustomerId(customerId)) {
    throw new Error(`identityCapability: customerId inválido al crear un token ${purpose}.`);
  }
  if (!isValidEmailHash(emailHash)) {
    throw new Error(`identityCapability: emailHash inválido al crear un token ${purpose}.`);
  }
  const nowSeconds = resolveNowSeconds(now);
  return {
    v: TOKEN_VERSION,
    purpose,
    customerId,
    emailHash,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
}

function encodeToken(key, purpose, payload) {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64url'), ciphertext.toString('base64url'), authTag.toString('base64url')].join('.');
}

/**
 * Nunca lanza -- cualquier fallo de forma/autenticación/versión/propósito/
 * campos/tiempo devuelve { ok:false, reason:'invalid' } de forma uniforme y
 * SILENCIOSA (sin console.error/console.warn aquí): un atacante probando
 * tokens inválidos en bucle no debe poder convertir este módulo en una
 * fuente de log flooding. Las rutas que consuman este resultado decidirán,
 * más adelante, qué merece registrarse.
 *
 * Campos extra en el payload (fuera de v/purpose/customerId/emailHash/iat/
 * exp) se ignoran deliberadamente -- nunca se leen, así que no pueden
 * afectar la decisión de validez ni filtrar nada.
 */
function decodeToken(key, expectedPurpose, token, { now } = {}) {
  try {
    if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'invalid' };

    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'invalid' };

    const [ivPart, ciphertextPart, authTagPart] = parts;
    const iv = Buffer.from(ivPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    const authTag = Buffer.from(authTagPart, 'base64url');

    if (iv.length !== IV_LENGTH_BYTES) return { ok: false, reason: 'invalid' };
    if (authTag.length !== AUTH_TAG_LENGTH_BYTES) return { ok: false, reason: 'invalid' };
    if (ciphertext.length === 0) return { ok: false, reason: 'invalid' };

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(expectedPurpose, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    let payload;
    try {
      payload = JSON.parse(plaintext.toString('utf8'));
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid' };
    }

    if (payload.v !== TOKEN_VERSION) return { ok: false, reason: 'invalid' };
    if (payload.purpose !== expectedPurpose) return { ok: false, reason: 'invalid' };
    if (!isValidCustomerId(payload.customerId)) return { ok: false, reason: 'invalid' };
    if (!isValidEmailHash(payload.emailHash)) return { ok: false, reason: 'invalid' };

    const { iat, exp } = payload;
    if (!Number.isFinite(iat) || !Number.isInteger(iat)) return { ok: false, reason: 'invalid' };
    if (!Number.isFinite(exp) || !Number.isInteger(exp)) return { ok: false, reason: 'invalid' };
    if (exp <= iat) return { ok: false, reason: 'invalid' };

    const nowSeconds = resolveNowSeconds(now);
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'invalid' };
    if (nowSeconds >= exp) return { ok: false, reason: 'invalid' };

    return { ok: true, customerId: payload.customerId, emailHash: payload.emailHash };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function createVerificationHandle({ customerId, emailHash, now } = {}) {
  const key = loadVerifyHandleKey();
  const payload = buildPayload({
    customerId,
    emailHash,
    purpose: PURPOSE_VERIFY_HANDLE,
    ttlSeconds: VERIFY_HANDLE_TTL_SECONDS,
    now,
  });
  return encodeToken(key, PURPOSE_VERIFY_HANDLE, payload);
}

export function verifyVerificationHandle(token, { now } = {}) {
  let key;
  try {
    key = loadVerifyHandleKey();
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  return decodeToken(key, PURPOSE_VERIFY_HANDLE, token, { now });
}

export function createCheckoutIdentityCapability({ customerId, emailHash, now } = {}) {
  const key = loadCheckoutIdentityKey();
  const payload = buildPayload({
    customerId,
    emailHash,
    purpose: PURPOSE_CHECKOUT_IDENTITY,
    ttlSeconds: CHECKOUT_IDENTITY_TTL_SECONDS,
    now,
  });
  return encodeToken(key, PURPOSE_CHECKOUT_IDENTITY, payload);
}

export function verifyCheckoutIdentityCapability(token, { now } = {}) {
  let key;
  try {
    key = loadCheckoutIdentityKey();
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  return decodeToken(key, PURPOSE_CHECKOUT_IDENTITY, token, { now });
}
