/**
 * Fuente central única de configuración runtime del frontend (LOTE-003,
 * ADR-014 §13/§21). Ningún otro módulo debe reimplementar su propia
 * detección de ambiente, hostname local o resolución de URL de API.
 *
 * Todas las funciones aceptan un objeto de opciones inyectable (`env`,
 * `hostname`, `storage`, `search`, `reporter`) con valores por defecto
 * tomados del entorno real del navegador -- esto permite ejecutar las
 * pruebas con `node:test` puro, sin navegador, sin red y sin tocar el
 * `localStorage` real.
 */

export const ALLOWED_FRONTEND_ENVIRONMENTS = Object.freeze([
  'development',
  'test',
  'demo',
  'staging',
  'production',
]);

const LOCAL_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1']);

// Mismas claves que ya existían en el código heredado (ganaderiaApi.js) --
// se conservan exactamente para no romper enlaces/bookmarks de desarrollo
// ya en uso, ahora restringidas por la regla vinculante de este lote.
const OVERRIDE_QUERY_KEYS = Object.freeze(['agx_api_url', 'apiUrl']);
const OVERRIDE_STORAGE_KEYS = Object.freeze(['agx_api_url', 'apiUrl']);

const LOCAL_API_BASE = 'http://127.0.0.1:3001/api';
const SAME_ORIGIN_RELAY = '/api';

/**
 * Error clasificado, estable, lanzado cuando algo intenta resolver una URL
 * de API en un ambiente donde ninguna solicitud de red está permitida
 * (hoy: exclusivamente `demo`, ADR-014 §7 -- demo no tiene backend ni
 * relay `/api/*`). El mensaje nunca incluye URLs, valores de override ni
 * ningún dato sensible -- solo el código y el ambiente.
 */
export class ApiDisabledError extends Error {
  constructor(message, { code, environment } = {}) {
    super(message);
    this.name = 'ApiDisabledError';
    this.code = code || 'API_DISABLED';
    if (environment) this.environment = environment;
  }
}

function createApiDisabledInDemoError() {
  return new ApiDisabledError(
    'El ambiente demo no tiene backend ni relay de API configurado -- ninguna solicitud de red está permitida.',
    { code: 'API_DISABLED_IN_DEMO', environment: 'demo' },
  );
}

function getViteEnv(injected) {
  if (injected) return injected;
  // import.meta.env solo existe bajo Vite; en node:test (sin transformar)
  // import.meta existe pero .env es undefined -- se degrada a {} de forma
  // segura, sin lanzar.
  return typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};
}

function getWindowHostname(injected) {
  if (injected !== undefined) return injected;
  if (typeof window === 'undefined' || !window.location) return '';
  return window.location.hostname || '';
}

function getWindowSearch(injected) {
  if (injected !== undefined) return injected;
  if (typeof window === 'undefined' || !window.location) return '';
  return window.location.search || '';
}

function getSafeLocalStorage(injected) {
  if (injected !== undefined) return injected;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // SecurityError (almacenamiento bloqueado por el navegador/políticas
    // de privacidad) -- se trata como "sin almacenamiento disponible".
    return null;
  }
}

function isLocalHostnameValue(hostname) {
  return LOCAL_HOSTNAMES.includes(String(hostname || ''));
}

/** Verifica si el hostname actual (real o inyectado) es local. */
export function isLocalHostname(options = {}) {
  return isLocalHostnameValue(getWindowHostname(options.hostname));
}

export function normalizeApiBase(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Resuelve el ambiente funcional del frontend (VITE_APP_ENV). Nunca infiere
 * `production` por ausencia. El único fallback posible sin la variable es
 * `development`, y solo cuando el hostname es exactamente localhost/127.0.0.1
 * -- en cualquier otro caso devuelve `'unresolved'`, tratado de forma
 * máximamente restrictiva por el resto de este módulo (igual que
 * staging/production: sin overrides, solo relay same-origin).
 *
 * @param {{env?: object, hostname?: string}} options
 */
export function resolveFrontendEnvironment(options = {}) {
  const env = getViteEnv(options.env);
  const hostname = getWindowHostname(options.hostname);
  const raw = typeof env.VITE_APP_ENV === 'string' ? env.VITE_APP_ENV.trim() : '';

  if (raw && ALLOWED_FRONTEND_ENVIRONMENTS.includes(raw)) {
    return Object.freeze({ appEnv: raw, isLocalDevelopmentFallback: false });
  }

  if (isLocalHostnameValue(hostname)) {
    return Object.freeze({ appEnv: 'development', isLocalDevelopmentFallback: true });
  }

  return Object.freeze({ appEnv: 'unresolved', isLocalDevelopmentFallback: false });
}

/**
 * Regla vinculante única (ADR-014): el override de URL de API solo tiene
 * efecto cuando se cumplen SIMULTÁNEAMENTE (1) el ambiente resuelto es
 * `development` y (2) el hostname del navegador es exactamente
 * localhost/127.0.0.1. Ninguna otra condición lo habilita.
 */
export function isLocalDevelopment(options = {}) {
  const { appEnv } = resolveFrontendEnvironment(options);
  return appEnv === 'development' && isLocalHostnameValue(getWindowHostname(options.hostname));
}

/**
 * Valida un valor candidato a URL de API. Acepta rutas relativas
 * (`/api`) sin restricción de protocolo, y URLs absolutas únicamente con
 * protocolo http:/https:, sin credenciales embebidas. Devuelve la URL
 * normalizada o `null` si es inválida -- nunca lanza.
 */
export function validateApiUrl(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('/')) {
    return normalizeApiBase(trimmed);
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null; // URL malformada
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null; // rechaza javascript:, data:, file:, etc.
  }

  if (parsed.username || parsed.password) {
    return null; // rechaza credenciales embebidas (user:pass@host)
  }

  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return normalizeApiBase(`${parsed.origin}${path}`);
}

function readQueryOverride(search) {
  if (!search) return null;
  let params;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  for (const key of OVERRIDE_QUERY_KEYS) {
    if (params.has(key)) {
      return { key, value: validateApiUrl(params.get(key)) };
    }
  }
  return null;
}

function readStoredOverride(storage) {
  if (!storage) return null;
  for (const key of OVERRIDE_STORAGE_KEYS) {
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      continue; // SecurityError / almacenamiento bloqueado
    }
    if (raw) return { key, value: validateApiUrl(raw) };
  }
  return null;
}

function persistOverride(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Almacenamiento bloqueado/lleno: no romper la resolución de URL por esto.
  }
}

/**
 * Fuera de development local, elimina cualquier clave de override
 * persistida. Tolerante a `localStorage` ausente/bloqueado, idempotente.
 */
export function clearDisallowedApiOverrides(options = {}) {
  const storage = getSafeLocalStorage(options.storage);
  if (!storage) return;
  for (const key of OVERRIDE_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // SecurityError / almacenamiento bloqueado: idempotente, no romper la app.
    }
  }
}

/**
 * Emite una advertencia/telemetría segura ante un intento de override
 * fuera de development local. Nunca incluye el valor del override, ni
 * tokens, cookies o payloads -- únicamente el nombre de la clave, el
 * ambiente resuelto y el hostname. Si se inyecta un `reporter`, se usa en
 * su lugar de `console.warn` (trabajo de observabilidad completo diferido).
 */
export function reportDisallowedOverrideAttempt(details, options = {}) {
  const { appEnv, hostname, key } = details;
  const event = { type: 'disallowed_api_override_attempt', appEnv, hostname, key };

  if (typeof options.reporter === 'function') {
    options.reporter(event);
    return event;
  }

  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      `[AgroGenomaX] Override de URL de API ignorado fuera de desarrollo local ` +
        `(clave="${key}", ambiente="${appEnv}", hostname="${hostname}").`,
    );
  }
  return event;
}

function detectOverrideAttempt(search, storage) {
  if (search) {
    let params;
    try {
      params = new URLSearchParams(search);
    } catch {
      params = null;
    }
    if (params) {
      for (const key of OVERRIDE_QUERY_KEYS) {
        if (params.has(key)) return key;
      }
    }
  }

  if (storage) {
    for (const key of OVERRIDE_STORAGE_KEYS) {
      try {
        if (storage.getItem(key)) return key;
      } catch {
        // ignorar
      }
    }
  }

  return null;
}

/**
 * Resuelve la lista ordenada de URLs de API candidatas para el ambiente
 * actual -- fuente de verdad única, consumida por ganaderiaApi.js,
 * catastroxApi.js y catastroxPaymentService.js.
 *
 * Fuera de development local:
 * - `demo`: ningún candidato es válido (ADR-014 §7 -- demo no tiene
 *   backend ni relay `/api/*`). Se limpia/reporta cualquier intento de
 *   override y se lanza `ApiDisabledError` (`API_DISABLED_IN_DEMO`) antes
 *   de considerar ninguna URL -- ni `/api`, ni `VITE_API_URL`, ni
 *   `VITE_AGX_API_URL`, ni Railway, ni localhost.
 * - `test`: sin configuración explícita inyectada (`env.VITE_API_URL`/
 *   `env.VITE_AGX_API_URL`), no hay candidatos (`[]`) -- nunca se asume
 *   `/api` disponible por defecto, para evitar fetch accidental en
 *   pruebas. Con configuración explícita inyectada, se usa esa URL.
 * - staging/production/preview/hostname desplegado/ambiente no resuelto:
 *   candidato único e inamovible, el relay same-origin (`/api`) -- nunca
 *   `VITE_API_URL`/`VITE_AGX_API_URL`, nunca Railway, nunca ninguna URL
 *   configurada en build. Cualquier override detectado (query o
 *   localStorage) se limpia y se reporta, sin usarse.
 *
 * En development local, precedencia: query string > localStorage >
 * `VITE_API_URL`/`VITE_AGX_API_URL` configurada > backend local conocido
 * (127.0.0.1:3001) > relay same-origin.
 *
 * @param {{env?, hostname?, storage?, search?, reporter?}} options
 */
export function resolveApiBaseCandidates(options = {}) {
  const env = getViteEnv(options.env);
  const hostname = getWindowHostname(options.hostname);
  const storage = getSafeLocalStorage(options.storage);
  const search = getWindowSearch(options.search);

  const { appEnv } = resolveFrontendEnvironment({ env, hostname });
  const localDev = appEnv === 'development' && isLocalHostnameValue(hostname);

  if (!localDev) {
    const attemptedKey = detectOverrideAttempt(search, storage);
    if (attemptedKey) {
      reportDisallowedOverrideAttempt({ appEnv, hostname, key: attemptedKey }, { reporter: options.reporter });
    }
    clearDisallowedApiOverrides({ storage });

    if (appEnv === 'demo') {
      throw createApiDisabledInDemoError();
    }

    if (appEnv === 'test') {
      const explicitTestApiBase = normalizeApiBase(env.VITE_API_URL || env.VITE_AGX_API_URL || '');
      return explicitTestApiBase ? [explicitTestApiBase] : [];
    }

    return [SAME_ORIGIN_RELAY];
  }

  const configuredApiBase = normalizeApiBase(env.VITE_API_URL || env.VITE_AGX_API_URL || '');

  const queryOverride = readQueryOverride(search);
  if (queryOverride && queryOverride.value) {
    persistOverride(storage, queryOverride.key, queryOverride.value);
  }

  const storedOverride = readStoredOverride(storage);

  const candidates = [];
  if (queryOverride?.value) candidates.push(queryOverride.value);
  if (storedOverride?.value && storedOverride.value !== queryOverride?.value) {
    candidates.push(storedOverride.value);
  }
  if (configuredApiBase) candidates.push(configuredApiBase);
  candidates.push(LOCAL_API_BASE, SAME_ORIGIN_RELAY);

  return [...new Set(candidates.filter(Boolean))];
}

/**
 * Primer candidato resuelto -- conveniencia para consumidores que solo
 * necesitan una URL base. Propaga sin capturar el `ApiDisabledError` de
 * `demo`. En `test` sin configuración explícita devuelve `null` (nunca
 * un `/api` enmascarado) para no fabricar un backend implícito.
 */
export function resolveApiBaseUrl(options = {}) {
  const [first] = resolveApiBaseCandidates(options);
  return first ?? null;
}

/**
 * Config runtime consolidada e inmutable -- útil para depuración/paneles,
 * nunca para tomar decisiones de seguridad por sí sola (usar las
 * funciones específicas de arriba para eso).
 */
export function getRuntimeConfig(options = {}) {
  const hostname = getWindowHostname(options.hostname);
  const { appEnv, isLocalDevelopmentFallback } = resolveFrontendEnvironment({ env: options.env, hostname });
  return Object.freeze({
    appEnv,
    isLocalDevelopmentFallback,
    isLocalDevelopment: appEnv === 'development' && isLocalHostnameValue(hostname),
    hostname,
  });
}
