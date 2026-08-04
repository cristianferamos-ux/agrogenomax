/**
 * HOTFIX RAILWAY (CATX-DELIVERY-001): copia server-side autosuficiente de
 * shared/security/corsPolicy.js. Railway instala/ejecuta únicamente server/
 * (npm ci --prefix server, npm --prefix server start) -- un import relativo
 * hacia shared/ (hermano de server/ en el repo) no está garantizado en el
 * runtime real, igual que ocurría con src/ (ver server/services/catastrox/pdf/).
 * Confirmado con una simulación de runtime aislado (solo server/ copiado a
 * un directorio limpio): `npm start` fallaba con ERR_MODULE_NOT_FOUND
 * buscando shared/security/corsPolicy.js.
 *
 * Contenido idéntico a shared/security/corsPolicy.js -- NO editar aquí sin
 * replicar el cambio allá (y viceversa); ese archivo original sigue siendo
 * la fuente usada por functions/api/catastrox/[[path]].js (Cloudflare,
 * runtime distinto, no afectado por este hotfix). Pura, sin dependencias de
 * Node ni de Cloudflare Workers -- únicamente APIs Web estándar (`URL`,
 * `Object.freeze`, `Array`, `Set`).
 *
 * server/__tests__/architecture/noSrcImports.test.js NO cubre este caso
 * (solo vigila imports hacia src/) -- este archivo es la mitigación en sí.
 */

export const DEFAULT_CORS_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const DEFAULT_CORS_HEADERS = Object.freeze(['Content-Type', 'Authorization', 'X-Request-ID', 'X-CSRF-Token']);

export class CorsConfigurationError extends Error {
  constructor(message, { code, environment, value } = {}) {
    super(message);
    this.name = 'CorsConfigurationError';
    this.code = code || 'CORS_CONFIGURATION_ERROR';
    if (environment) this.environment = environment;
    if (value) this.value = value;
  }
}

/**
 * Valida y normaliza un valor tipo "origen" (protocolo + host, sin *path*,
 * sin *query*, sin *fragment*, sin credenciales embebidas). Solo acepta
 * `http:`/`https:`. Devuelve la forma normalizada o `null` si es inválido
 * -- nunca lanza. Se reutiliza tanto para orígenes CORS (que por
 * definición del navegador nunca traen *path*) como para validar
 * `API_BACKEND_URL` en el relay, cuya forma exigida es idéntica.
 */
export function normalizeOrigin(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null;
  if (parsed.search || parsed.hash) return null;
  // STAGING_READINESS_001 (revisión final): el parser WHATWG URL no incluye
  // `*` entre los "forbidden host code points" -- `https://*.agrogenomax.com`
  // se parsea sin error, con hostname literal "*.agrogenomax.com". Un host
  // comodín nunca es un origen real (ni de CORS explícito ni de
  // API_BACKEND_URL/CATASTROX_FRONTEND_URL) -- se rechaza aquí, en el único
  // punto de normalización, para cerrar el hueco en todos los llamadores a
  // la vez (allowlist de CORS y resolvePublicOriginForEnvironment).
  if (parsed.hostname.includes('*')) return null;

  return parsed.origin;
}

/**
 * Construye una política CORS inmutable y validada. Lanza
 * `CorsConfigurationError` ante cualquier entrada ambigua -- nunca
 * silenciosamente descarta un origen inválido ni lo "corrige".
 *
 * @param {{
 *   appEnv: string,
 *   allowedOrigins: string[],
 *   allowedMethods?: string[],
 *   allowedHeaders?: string[],
 *   allowCredentials?: boolean,
 *   requireNonEmptyOrigins?: boolean,
 * }} options
 */
export function buildCorsPolicy({
  appEnv,
  allowedOrigins,
  allowedMethods = DEFAULT_CORS_METHODS,
  allowedHeaders = DEFAULT_CORS_HEADERS,
  allowCredentials = false,
  requireNonEmptyOrigins = false,
}) {
  if (!Array.isArray(allowedOrigins)) {
    throw new CorsConfigurationError('allowedOrigins debe ser un arreglo.', {
      code: 'CORS_ORIGINS_NOT_ARRAY',
      environment: appEnv,
    });
  }

  const normalizedOrigins = [];
  for (const raw of allowedOrigins) {
    const normalized = normalizeOrigin(raw);
    if (!normalized) {
      throw new CorsConfigurationError(
        'Un origen configurado no es válido (debe ser http(s) sin credenciales, path, query ni fragment).',
        { code: 'CORS_ORIGIN_INVALID', environment: appEnv },
      );
    }
    normalizedOrigins.push(normalized);
  }

  const dedupedOrigins = Object.freeze([...new Set(normalizedOrigins)]);

  if (requireNonEmptyOrigins && dedupedOrigins.length === 0) {
    throw new CorsConfigurationError('La allowlist de CORS no puede quedar vacía para este ambiente.', {
      code: 'CORS_ALLOWLIST_EMPTY',
      environment: appEnv,
    });
  }

  if (!Array.isArray(allowedMethods) || allowedMethods.length === 0) {
    throw new CorsConfigurationError('allowedMethods debe ser un arreglo no vacío.', {
      code: 'CORS_METHODS_INVALID',
      environment: appEnv,
    });
  }

  if (!Array.isArray(allowedHeaders) || allowedHeaders.length === 0) {
    throw new CorsConfigurationError('allowedHeaders debe ser un arreglo no vacío.', {
      code: 'CORS_HEADERS_INVALID',
      environment: appEnv,
    });
  }

  return Object.freeze({
    appEnv,
    allowedOrigins: dedupedOrigins,
    allowedMethods: Object.freeze([...new Set(allowedMethods.map((m) => String(m).toUpperCase()))]),
    allowedHeaders: Object.freeze([...new Set(allowedHeaders.map((h) => String(h)))]),
    allowCredentials: allowCredentials === true,
  });
}

/** @returns {boolean} si `origin` (ya crudo, sin normalizar) está en la allowlist de `policy`. */
export function isOriginAllowed(policy, origin) {
  const normalized = normalizeOrigin(origin);
  return normalized !== null && policy.allowedOrigins.includes(normalized);
}

// STAGING_READINESS_001 (revisión final): comparación exacta por hostname
// ya parseado -- nunca `includes()` sobre el string completo del origen.
// Un `includes('127.0.0.1')` dejaría pasar, sin querer, un hostname público
// legítimo que contuviera esa subcadena en otra parte (poco probable pero
// posible); comparar el hostname exacto también es la única forma correcta
// de cubrir el rango completo 127.0.0.0/8 y las formas equivalentes de
// loopback IPv6 (`::1`, que `URL.hostname` siempre normaliza a la forma
// canónica entre corchetes `[::1]`, sin importar cómo se haya escrito la
// entrada -- `[0:0:0:0:0:0:0:1]` incluida).
function isLocalOrLoopbackHostname(hostname) {
  const lowered = hostname.toLowerCase();
  // "localhost.localdomain" es el alias de loopback por defecto en /etc/hosts
  // de muchas distribuciones Linux -- startsWith('localhost.') lo cubre sin
  // bloquear por error un dominio real que solo contenga "localhost" en
  // otra posición (p. ej. "notlocalhost.example.com" no coincide).
  if (lowered === 'localhost' || lowered.startsWith('localhost.') || lowered.endsWith('.localhost')) return true;
  if (lowered === '0.0.0.0') return true;
  if (lowered === '[::1]' || lowered === '[::]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lowered)) return true;
  return false;
}

/**
 * Resuelve y valida una URL pública "de verdad" (STAGING_READINESS_001,
 * Bloque 4) -- usada tanto para `API_BACKEND_URL` (relays de Cloudflare,
 * functions/api/catastrox/[[path]].js y su gemela de pagos) como para
 * `CATASTROX_FRONTEND_URL` (server/config/env.js, redirectUrl de Wompi).
 * En staging/production exige https y prohíbe localhost, todo el rango de
 * loopback IPv4 (127.0.0.0/8), loopback/unspecified IPv6 (`::1`/`::`) y
 * `0.0.0.0` -- un valor así solo tiene sentido copiado por error desde
 * development. En development/test no se restringe más allá de lo que
 * `normalizeOrigin()` ya exige (http local es el caso normal). Nunca
 * lanza -- devuelve `null` si el valor no es válido para el ambiente, para
 * que el llamador decida cómo fallar (503 en el relay, ConfigurationError
 * en el backend Express).
 *
 * @param {string} rawValue
 * @param {string} appEnv
 * @returns {string|null}
 */
export function resolvePublicOriginForEnvironment(rawValue, appEnv) {
  const normalized = normalizeOrigin(rawValue);
  if (!normalized) return null;

  if (appEnv === 'staging' || appEnv === 'production') {
    if (!normalized.startsWith('https://')) return null;

    let hostname;
    try {
      hostname = new URL(normalized).hostname;
    } catch {
      return null;
    }
    if (isLocalOrLoopbackHostname(hostname)) return null;
  }

  return normalized;
}

// Allowlist obligatoria por ambiente (LOTE-004, ADR-014 §7 Barrera 4) --
// única fuente de verdad, consumida tanto por server/config/env.js
// (backend Express, vía un envoltorio que traduce a ConfigurationError)
// como directamente por los relays de Cloudflare (functions/api/catastrox/
// [[path]].js y su gemela de pagos), evitando mantener dos copias de esta
// regla en *runtimes* distintos.
// Precisión vinculante (corrección LOTE-004): AgroGenomaX tiene dos
// dominios oficiales de producción -- agrogenomax.com y agrogenomax.co --
// ambos orígenes productivos de primer nivel, obligatorios por defecto.
// staging/demo permanecen canónicos únicamente en .com: staging.agrogenomax.co
// y demo.agrogenomax.co NO están definidos como orígenes canónicos y no se
// autorizan automáticamente.
export const CORS_MANDATORY_ORIGINS_BY_ENV = Object.freeze({
  // 5173 es el puerto por defecto de Vite; 5178 es el puerto real usado
  // por el entorno de verificación local de este proyecto (defecto
  // corregido: quedaba fuera de la allowlist, causando que /checkout y el
  // resto de POST autenticados fallaran silenciosamente en CORS para
  // cualquiera probando en ese puerto).
  development: Object.freeze([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5178',
    'http://127.0.0.1:5178',
  ]),
  test: Object.freeze([]),
  demo: Object.freeze([]),
  staging: Object.freeze(['https://staging.agrogenomax.com']),
  production: Object.freeze(['https://agrogenomax.com', 'https://agrogenomax.co']),
});

export const CORS_ALLOWLIST_REQUIRED_ENVS = Object.freeze(['staging', 'production']);

// Sustrings que invalidan un origen explícito aunque tenga formato http(s)
// correcto -- impiden que demo/Railway/localhost se cuelen en staging vía
// una ampliación mal configurada. `production` NO usa esta lista de
// bloqueo: usa una allowlist cerrada de extensiones (ver
// CORS_PRODUCTION_ALLOWED_EXTENSIONS más abajo), porque una lista de
// bloqueo nunca puede enumerar exhaustivamente "cualquier otro subdominio
// de agrogenomax.com/agrogenomax.co".
const CORS_FORBIDDEN_ORIGIN_HINTS_BY_ENV = Object.freeze({
  // LOTE 019-C: trycloudflare.com se agrega explicitamente -- la excepcion de
  // tunel de desarrollo (CORS_ALLOW_DEV_TUNNEL) es exclusiva de development;
  // staging nunca debe aceptar un origen de Quick Tunnel, con o sin ese flag.
  staging: Object.freeze(['demo.agrogenomax.com', 'railway.app', 'localhost', '127.0.0.1', 'trycloudflare.com']),
});

// Producción: extensión cerrada. CORS_ALLOWED_ORIGINS, si está presente,
// solo puede contener uno o ambos de estos dos hosts -- nunca ningún otro
// valor (ni otro subdominio de agrogenomax.com/agrogenomax.co, ni un
// dominio externo, ni Railway/staging/demo/localhost/comodines). Cualquier
// otro valor explícito falla-rápido (CORS_ORIGIN_FORBIDDEN).
const CORS_PRODUCTION_ALLOWED_EXTENSIONS = Object.freeze([
  'https://www.agrogenomax.com',
  'https://www.agrogenomax.co',
]);

function isLocalOriginValue(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Resuelve y valida la *allowlist* final de orígenes CORS para `appEnv`,
 * combinando la lista obligatoria (nunca sustituible) con
 * `explicitOrigins` (valores crudos, sin normalizar, típicamente
 * provenientes de una variable de entorno CSV). Lanza
 * `CorsConfigurationError` ante cualquier origen explícito inválido o
 * prohibido para el ambiente -- nunca lo descarta silenciosamente.
 *
 * @param {string} appEnv
 * @param {string[]} explicitOrigins
 * @param {{wompiEnv?: string|null, allowDevTunnel?: boolean}} [options] LOTE 019-C:
 *   excepcion acotada de "tunel de desarrollo" -- ver comentario en el cuerpo.
 * @returns {readonly string[]}
 */
export function resolveAllowedOriginsForEnvironment(appEnv, explicitOrigins = [], options = {}) {
  const { wompiEnv = null, allowDevTunnel = false } = options;
  const mandatory = CORS_MANDATORY_ORIGINS_BY_ENV[appEnv] || [];

  // demo no tiene backend ni relay (ADR-014 §7): ningún origen explícito
  // puede ampliar su CORS, sin importar qué consumidor invoque esta
  // función -- la allowlist de demo es siempre exactamente `[]`.
  if (appEnv === 'demo' && explicitOrigins.length > 0) {
    throw new CorsConfigurationError(
      'demo no admite ningún origen CORS explícito (demo no tiene backend ni relay -- ADR-014 §7).',
      { code: 'CORS_ORIGIN_FORBIDDEN', environment: appEnv },
    );
  }

  const normalizedExplicit = [];

  for (const raw of explicitOrigins) {
    const normalized = normalizeOrigin(raw);
    if (!normalized) {
      throw new CorsConfigurationError(
        'Un origen explícito de CORS no es válido (debe ser http(s) sin credenciales, path, query ni fragment).',
        { code: 'CORS_ORIGIN_INVALID', environment: appEnv },
      );
    }

    if (appEnv === 'development' && !isLocalOriginValue(normalized)) {
      // LOTE 019-C: excepcion explicita y acotada para un tunel de desarrollo
      // (p. ej. Cloudflare Quick Tunnel) usado en pruebas E2E que exigen una
      // redirectUrl HTTPS real (Wompi Sandbox no acepta redirects a localhost
      // de forma confiable). Preserva la barrera ADR-014 SS7 Barrera 4: solo
      // se activa si TODAS estas condiciones se cumplen a la vez --
      //   1) appEnv === 'development';
      //   2) wompiEnv === 'test' (nunca con Wompi en modo productivo);
      //   3) allowDevTunnel === true (opt-in explicito, variable propia);
      //   4) el origen es exactamente el que ya aparece en CORS_ALLOWED_ORIGINS
      //      (esta funcion nunca acepta comodines: normalizeOrigin rechaza
      //      cualquier valor que no sea un origen http(s) completo y unico).
      // No aplica en test/demo/staging/production: esos ambientes ni siquiera
      // llegan a esta rama (tienen su propio bloque de reglas mas abajo).
      const isDevTunnelException =
        allowDevTunnel === true && wompiEnv === 'test' && normalized.startsWith('https://');

      if (!isDevTunnelException) {
        throw new CorsConfigurationError(
          'En development, únicamente se admiten orígenes http://localhost o http://127.0.0.1 explícitos ' +
            '(ningún dominio externo, ninguna IP LAN).',
          { code: 'CORS_ORIGIN_FORBIDDEN', environment: appEnv },
        );
      }
    }

    if (appEnv === 'production' && !CORS_PRODUCTION_ALLOWED_EXTENSIONS.includes(normalized)) {
      throw new CorsConfigurationError(
        'En production, CORS_ALLOWED_ORIGINS solo admite https://www.agrogenomax.com y/o ' +
          'https://www.agrogenomax.co -- ningún otro origen explícito está permitido.',
        { code: 'CORS_ORIGIN_FORBIDDEN', environment: appEnv },
      );
    }

    if (appEnv !== 'production') {
      const forbiddenHints = CORS_FORBIDDEN_ORIGIN_HINTS_BY_ENV[appEnv];
      if (forbiddenHints && forbiddenHints.some((hint) => normalized.toLowerCase().includes(hint.toLowerCase()))) {
        throw new CorsConfigurationError(
          'El origen explícito está prohibido para este ambiente (ADR-014 §7 Barrera 4).',
          { code: 'CORS_ORIGIN_FORBIDDEN', environment: appEnv },
        );
      }
    }

    normalizedExplicit.push(normalized);
  }

  const combined = Object.freeze([...new Set([...mandatory, ...normalizedExplicit])]);

  if (CORS_ALLOWLIST_REQUIRED_ENVS.includes(appEnv) && combined.length === 0) {
    throw new CorsConfigurationError('La allowlist de CORS no puede quedar vacía para este ambiente.', {
      code: 'CORS_ALLOWLIST_EMPTY',
      environment: appEnv,
    });
  }

  return combined;
}

/**
 * Función de decisión pura -- sin `req`/`res`, sin `Request`/`Response`.
 * Ambos adaptadores (Express y Cloudflare) la consumen para decidir cómo
 * responder, sin duplicar la lógica de negocio del CORS.
 *
 * CORS no es autenticación: esta función únicamente decide si se añaden o
 * no cabeceras CORS y si una solicitud cruzada se corta en este punto --
 * nunca decide autenticación/autorización, que sigue siendo responsabilidad
 * exclusiva de las rutas/del *upstream*.
 *
 * @param {ReturnType<typeof buildCorsPolicy>} policy
 * @param {{method: string, origin?: string|null, requestedMethod?: string|null, requestedHeaders?: string|null}} request
 * @returns {{action: 'continue'|'allow'|'preflight-ok'|'reject', status?: number, headers?: Record<string,string>, reason?: string}}
 */
export function evaluateCorsRequest(policy, { method, origin, requestedMethod, requestedHeaders } = {}) {
  const upperMethod = String(method || '').toUpperCase();

  // Sin cabecera Origin: solicitud same-origin, *health check* o cliente
  // server-to-server -- nunca se trata automáticamente como cross-origin,
  // y su ausencia tampoco se interpreta como prueba de confianza (la
  // autenticación/autorización de la ruta sigue aplicando aguas abajo).
  if (origin === undefined || origin === null || origin === '') {
    return { action: 'continue' };
  }

  // Origin: null (literal) -- contextos aislados (sandboxed iframe,
  // file://, ciertos workers) -- se rechaza siempre para operaciones web
  // normales.
  if (origin === 'null') {
    return { action: 'reject', status: 403, reason: 'null_origin' };
  }

  if (!isOriginAllowed(policy, origin)) {
    return { action: 'reject', status: 403, reason: 'origin_not_allowed' };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const baseHeaders = {
    'Access-Control-Allow-Origin': normalizedOrigin,
    Vary: 'Origin',
  };
  if (policy.allowCredentials) {
    baseHeaders['Access-Control-Allow-Credentials'] = 'true';
  }

  if (upperMethod === 'OPTIONS') {
    const requestedMethodUpper = String(requestedMethod || '').trim().toUpperCase();
    if (requestedMethodUpper && !policy.allowedMethods.includes(requestedMethodUpper)) {
      return { action: 'reject', status: 403, reason: 'method_not_allowed' };
    }

    const requestedHeadersList = String(requestedHeaders || '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const allowedHeadersLower = policy.allowedHeaders.map((h) => h.toLowerCase());
    const hasDisallowedHeader = requestedHeadersList.some((h) => !allowedHeadersLower.includes(h.toLowerCase()));
    if (hasDisallowedHeader) {
      return { action: 'reject', status: 403, reason: 'header_not_allowed' };
    }

    return {
      action: 'preflight-ok',
      status: 204,
      headers: {
        ...baseHeaders,
        'Access-Control-Allow-Methods': policy.allowedMethods.join(', '),
        'Access-Control-Allow-Headers': policy.allowedHeaders.join(', '),
      },
    };
  }

  return { action: 'allow', headers: baseHeaders };
}
