// CATX-FREEZE-01: capability temporal para el modo de acceso por
// contraseña compartida (CATASTROX_COMMERCE_MODE=password). Dominio
// criptográfico INDEPENDIENTE de identityCapability.js -- nunca reutiliza
// CATASTROX_CHECKOUT_IDENTITY_KEY/CATASTROX_VERIFY_HANDLE_KEY/
// CATASTROX_PII_ENCRYPTION_KEY. Mismo mecanismo (AES-256-GCM stateless vía
// node:crypto, formato de tres partes iv.ciphertext.authTag en base64url,
// "nunca lanza al verificar") que identityCapability.js, pero con su propia
// clave (CATASTROX_TEMP_ACCESS_TOKEN_KEY) y su propio payload.
//
// El capability liga EXACTAMENTE canonicalPredioId + lookupId + packageId
// -- uno emitido para (predio A, básico) nunca autoriza (predio A, plus) ni
// (predio B, básico). Nunca contiene PII, la contraseña, ni datos de Wompi.
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const TOKEN_VERSION = 1;

// Margen de tolerancia SOLO para iat futuro por diferencia de reloj entre
// procesos -- nunca extiende la expiración (exp se compara sin margen).
const CLOCK_SKEW_SECONDS = 60;
const TEMP_ACCESS_TTL_SECONDS = 15 * 60;

const PURPOSE_TEMP_ACCESS = 'TEMP_ACCESS_V1';
const SCOPE_TEMP_ACCESS = 'catastrox:temporary-deliverable';

// Mismo patrón estricto que identityCapability.js: base64 canónico exacto
// de una clave AES-256 (32 bytes) -- 43 caracteres del alfabeto + un único
// '=' de padding, descartado antes de intentar decodificar nada (evita que
// Buffer.from(str,'base64') decodifique de forma permisiva un valor
// "basura" a exactamente 32 bytes por accidente).
const STRICT_BASE64_32_BYTES_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

// Únicos packageId reales de CatastroX (src/modules/catastrox/config/
// catastroxPackages.js) -- duplicado aquí deliberadamente como lista
// literal: server/ nunca importa de src/ (server/__tests__/architecture/
// noSrcImports.test.js), así que esta es la única fuente de verdad posible
// del lado del backend para validar packageId.
const VALID_PACKAGE_IDS = new Set(['basico', 'plus', 'profesional']);

class TemporaryAccessConfigError extends Error {
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidTemporaryAccessPackageId(packageId) {
  return typeof packageId === 'string' && VALID_PACKAGE_IDS.has(packageId);
}

function loadTokenKey() {
  const raw = process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY || '';
  if (!isCanonicalTrimmed(raw)) {
    throw new TemporaryAccessConfigError(
      'CATASTROX_TEMP_ACCESS_TOKEN_KEY no está configurada -- no es posible emitir/verificar capabilities de acceso temporal.',
      { code: 'TEMP_ACCESS_TOKEN_KEY_NOT_CONFIGURED', variable: 'CATASTROX_TEMP_ACCESS_TOKEN_KEY' },
    );
  }
  if (!STRICT_BASE64_32_BYTES_PATTERN.test(raw)) {
    throw new TemporaryAccessConfigError(
      'CATASTROX_TEMP_ACCESS_TOKEN_KEY debe ser base64 estándar canónico de exactamente 32 bytes (AES-256).',
      { code: 'TEMP_ACCESS_TOKEN_KEY_INVALID', variable: 'CATASTROX_TEMP_ACCESS_TOKEN_KEY' },
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new TemporaryAccessConfigError(
      'CATASTROX_TEMP_ACCESS_TOKEN_KEY debe decodificar a exactamente 32 bytes (AES-256) en base64.',
      { code: 'TEMP_ACCESS_TOKEN_KEY_INVALID', variable: 'CATASTROX_TEMP_ACCESS_TOKEN_KEY' },
    );
  }
  return key;
}

function resolveNowSeconds(now) {
  return Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
}

function buildPayload({ canonicalPredioId, lookupId, packageId, now }) {
  if (!isNonEmptyString(canonicalPredioId)) {
    throw new Error('temporaryAccessCapability: canonicalPredioId inválido al crear el capability.');
  }
  if (!isNonEmptyString(lookupId)) {
    throw new Error('temporaryAccessCapability: lookupId inválido al crear el capability.');
  }
  if (!isValidTemporaryAccessPackageId(packageId)) {
    throw new Error('temporaryAccessCapability: packageId inválido al crear el capability.');
  }
  const nowSeconds = resolveNowSeconds(now);
  return {
    v: TOKEN_VERSION,
    scope: SCOPE_TEMP_ACCESS,
    canonicalPredioId,
    lookupId,
    packageId,
    iat: nowSeconds,
    exp: nowSeconds + TEMP_ACCESS_TTL_SECONDS,
  };
}

function encodeToken(key, payload) {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(PURPOSE_TEMP_ACCESS, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64url'), ciphertext.toString('base64url'), authTag.toString('base64url')].join('.');
}

/**
 * Nunca lanza -- mismo contrato que identityCapability.js: cualquier fallo
 * de forma/autenticación/versión/scope/campos/tiempo devuelve
 * { ok:false, reason:'invalid' } de forma uniforme y silenciosa (sin
 * console.error/warn aquí -- un atacante probando tokens en bucle no debe
 * convertir este módulo en una fuente de log flooding).
 */
function decodeToken(key, token, { now } = {}) {
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
    decipher.setAAD(Buffer.from(PURPOSE_TEMP_ACCESS, 'utf8'));
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
    if (payload.scope !== SCOPE_TEMP_ACCESS) return { ok: false, reason: 'invalid' };
    if (!isNonEmptyString(payload.canonicalPredioId)) return { ok: false, reason: 'invalid' };
    if (!isNonEmptyString(payload.lookupId)) return { ok: false, reason: 'invalid' };
    if (!isValidTemporaryAccessPackageId(payload.packageId)) return { ok: false, reason: 'invalid' };

    const { iat, exp } = payload;
    if (!Number.isFinite(iat) || !Number.isInteger(iat)) return { ok: false, reason: 'invalid' };
    if (!Number.isFinite(exp) || !Number.isInteger(exp)) return { ok: false, reason: 'invalid' };
    if (exp <= iat) return { ok: false, reason: 'invalid' };

    const nowSeconds = resolveNowSeconds(now);
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'invalid' };
    if (nowSeconds >= exp) return { ok: false, reason: 'invalid' };

    return {
      ok: true,
      canonicalPredioId: payload.canonicalPredioId,
      lookupId: payload.lookupId,
      packageId: payload.packageId,
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function createTemporaryAccessCapability({ canonicalPredioId, lookupId, packageId, now } = {}) {
  const key = loadTokenKey();
  const payload = buildPayload({ canonicalPredioId, lookupId, packageId, now });
  return encodeToken(key, payload);
}

export function verifyTemporaryAccessCapability(token, { now } = {}) {
  let key;
  try {
    key = loadTokenKey();
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  return decodeToken(key, token, { now });
}

/**
 * Comparación constant-time de la contraseña temporal candidata contra
 * CATASTROX_TEMP_ACCESS_SECRET. crypto.timingSafeEqual lanza si los dos
 * buffers no tienen exactamente el mismo largo -- para no filtrar esa
 * diferencia de longitud por una ruta de tiempo distinta (un `return false`
 * inmediato sin comparar sería observable por temporización frente al
 * camino de longitudes iguales), ante un mismatch de longitud se compara
 * igualmente contra un buffer del mismo tamaño que el candidato (el
 * resultado siempre será false, pero el costo aproximado de la operación
 * se mantiene parejo).
 */
export function verifyTemporaryAccessPassword(candidatePassword) {
  const configured = process.env.CATASTROX_TEMP_ACCESS_SECRET || '';
  if (!isNonEmptyString(configured)) return false;
  if (typeof candidatePassword !== 'string' || candidatePassword.length === 0) return false;

  const configuredBuffer = Buffer.from(configured, 'utf8');
  const candidateBuffer = Buffer.from(candidatePassword, 'utf8');

  if (configuredBuffer.length !== candidateBuffer.length) {
    crypto.timingSafeEqual(candidateBuffer, Buffer.alloc(candidateBuffer.length));
    return false;
  }

  return crypto.timingSafeEqual(configuredBuffer, candidateBuffer);
}
