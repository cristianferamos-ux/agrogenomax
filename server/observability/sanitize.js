/**
 * FASE 3B -- sanitizador central para observabilidad. Todo dato de una
 * solicitud que vaya a un log (URL, query, cabeceras, body, metadatos de
 * error) pasa por aquí ANTES de serializarse. Lista explícita de claves
 * sensibles + patrones de valor: lo que calza se reemplaza por REDACTED.
 *
 * Nunca se registra: token QR (ni su hash ni su versión cifrada), token de
 * recuperación, cookie de sesión, CSRF, Authorization, cookies, secretos,
 * contraseñas, API keys ni connection strings. Las funciones son puras y
 * nunca lanzan (un log nunca rompe la solicitud).
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const MAX_STRING = 200;

// Claves sensibles (comparación sobre el nombre normalizado: minúsculas,
// sin guiones ni guiones bajos). Calce exacto o por subcadena.
const SENSITIVE_KEY_PARTS = Object.freeze([
  'token',
  'secret',
  'password',
  'passwd',
  'contrasena',
  'authorization',
  'cookie',
  'csrf',
  'apikey',
  'privatekey',
  'databaseurl',
  'connectionstring',
  'hash',
  'cifrado',
  'encrypted',
  'credential',
  'credencial',
  'session',
  'sesion',
  'signature',
  'otp',
]);

// Cabeceras que nunca se registran, aunque no calcen con la lista anterior.
const SENSITIVE_HEADERS = Object.freeze(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-csrf-token', 'x-api-key', 'referer']);

// Patrones de VALOR sensibles, aunque la clave parezca inocua.
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /^[A-Za-z0-9_-]{32}$/, // token QR AGX (base64url de 24 bytes)
  /^[0-9a-f]{64}$/i, // SHA-256 hex (token_hash, hashes de sesión)
  /^[A-Za-z0-9_-]{40,}={0,2}$/, // secretos/tokens base64url largos
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // base64 largo (token cifrado, claves)
  /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, // JWT
  /^bearer\s+/i,
  /^basic\s+/i,
  /^(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqps?):\/\//i, // connection strings
  /^(?:sk|pk|rk)_(?:live|test)_/i, // API keys tipo Stripe
]);

// Segmentos de ruta que nunca se registran tal cual.
const SENSITIVE_SEGMENT_PATTERNS = Object.freeze([
  /^[A-Za-z0-9_-]{32}$/,
  /^[0-9a-f]{64}$/i,
  /^[A-Za-z0-9_-]{40,}$/,
  /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/,
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[-_\s]/g, '');
}

export function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function isSensitiveValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function truncate(value) {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
}

function sanitizeScalar(value) {
  if (typeof value === 'string') return isSensitiveValue(value) ? REDACTED : truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

/** Objeto/array arbitrario (body, metadatos) -> copia con claves y valores sensibles redactados. */
export function sanitizeValue(value, depth = 0) {
  try {
    if (value === null || typeof value !== 'object') return sanitizeScalar(value);
    if (depth >= MAX_DEPTH) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((item) => sanitizeValue(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(value[key], depth + 1);
    }
    return out;
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

export const sanitizeBody = sanitizeValue;

/** req.query (o URLSearchParams) -> objeto con valores sensibles redactados. */
export function sanitizeQuery(query) {
  if (!query) return {};
  if (typeof URLSearchParams !== 'undefined' && query instanceof URLSearchParams) {
    return sanitizeValue(Object.fromEntries(query.entries()));
  }
  return sanitizeValue(query);
}

/** Cabeceras -> copia sin Authorization, Cookie, CSRF, Referer ni valores sensibles. */
export function sanitizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  const entries = typeof headers.entries === 'function' && !Array.isArray(headers)
    ? Array.from(headers.entries())
    : Object.entries(headers);
  for (const [rawName, rawValue] of entries.slice(0, MAX_KEYS)) {
    const name = String(rawName).toLowerCase();
    if (SENSITIVE_HEADERS.includes(name) || isSensitiveKey(name)) {
      out[name] = REDACTED;
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
    out[name] = sanitizeScalar(typeof value === 'string' ? value : String(value ?? ''));
  }
  return out;
}

function sanitizePathname(pathname) {
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // segmento mal codificado: se evalúa tal cual
      }
      return SENSITIVE_SEGMENT_PATTERNS.some((pattern) => pattern.test(decoded)) ? REDACTED : segment;
    })
    .join('/');
}

/**
 * URL (absoluta o relativa) -> ruta segura para log: segmentos con forma de
 * token/hash redactados, query reducida a claves con valores redactados si
 * son sensibles, sin fragmento, sin credenciales de usuario:contraseña.
 */
export function sanitizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return '';
  try {
    const url = new URL(rawUrl, 'http://placeholder.invalid');
    const pathname = sanitizePathname(url.pathname);
    const params = [];
    for (const [key, value] of url.searchParams.entries()) {
      const safe = isSensitiveKey(key) || isSensitiveValue(value) ? REDACTED : truncate(value);
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(safe)}`);
      if (params.length >= MAX_KEYS) break;
    }
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl);
    const prefix = isAbsolute ? `${url.protocol}//${url.host}` : '';
    return `${prefix}${pathname}${params.length ? `?${params.join('&')}` : ''}`;
  } catch {
    return REDACTED;
  }
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Error -> metadatos seguros. Solo `code` (si tiene forma de código: SQLSTATE
 * de pg, ECONNREFUSED, QR_NOT_FOUND...) y `status` numérico. Nunca message,
 * stack, name, detail, constraint, table, query ni parámetros.
 */
export function sanitizeErrorMeta(error) {
  const meta = {};
  try {
    const code = error?.code;
    if (typeof code === 'string' && SAFE_ERROR_CODE.test(code)) meta.errorCode = code;
    const status = error?.status ?? error?.statusCode;
    if (Number.isInteger(status)) meta.errorStatus = status;
  } catch {
    // getter hostil: sin metadatos
  }
  return meta;
}
