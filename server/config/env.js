/**
 * Módulo central de configuración runtime del backend (LOTE-002, ADR-014 §13;
 * extendido en LOTE-004 con la resolución de la *allowlist* de CORS).
 *
 * APP_ENV es la única fuente de verdad del ambiente funcional. NODE_ENV
 * nunca la sustituye ni participa en ninguna decisión -- solo se expone de
 * forma informativa en getConfig().
 */

import { CorsConfigurationError, resolveAllowedOriginsForEnvironment } from '../../shared/security/corsPolicy.js';

export const ALLOWED_APP_ENVIRONMENTS = Object.freeze([
  'development',
  'test',
  'demo',
  'staging',
  'production',
]);

// Variables server-side exigidas explícitamente en staging/production
// (ADR-014 §13). CORS_ORIGIN queda fuera de este lote a propósito: su
// endurecimiento definitivo es alcance de un lote posterior (CORS/relay).
// LOTE-007 (ADR-012 §35.A): HEALTH_MONITOR_TOKEN autentica el acceso técnico
// a readiness por dominio y a GET /api/health/db -- obligatorio en
// staging/production (nunca readiness protegida sin credencial real),
// inyectable de forma opcional en development/test (sin exigirla), y
// prohibida en demo (demo no tiene backend real que proteger).
const REQUIRED_VARIABLES_BY_ENV = Object.freeze({
  development: Object.freeze([]),
  test: Object.freeze([]),
  demo: Object.freeze([]),
  staging: Object.freeze(['DATABASE_URL', 'CATASTROX_DATABASE_URL', 'HEALTH_MONITOR_TOKEN']),
  production: Object.freeze(['DATABASE_URL', 'CATASTROX_DATABASE_URL', 'HEALTH_MONITOR_TOKEN']),
});

// Variables que nunca deben aparecer cuando APP_ENV=demo (ADR-014 §13/§7):
// demo no tiene backend, no tiene credenciales, no tiene relay productivo.
const DEMO_PROHIBITED_EXACT_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'CATASTROX_DATABASE_URL',
  'API_BACKEND_URL',
  'VITE_API_URL',
  'VITE_AGX_API_URL',
  // LOTE-004: demo no tiene backend Express real que proteger con CORS --
  // configurar esta variable en demo delataría un backend inexistente.
  'CORS_ALLOWED_ORIGINS',
  // LOTE-007 (ADR-012 §35.A): demo no tiene readiness protegida que
  // autenticar -- una credencial técnica configurada en demo delataría un
  // backend real inexistente.
  'HEALTH_MONITOR_TOKEN',
]);

// LOTE-004 (ADR-014 §7 Barrera 4, ADR-013 §21): la resolución y validación
// de la allowlist de CORS por ambiente vive en
// shared/security/corsPolicy.js (resolveAllowedOriginsForEnvironment) --
// única fuente de verdad, reutilizada también por los relays de
// Cloudflare. Este módulo solo traduce CORS_ALLOWED_ORIGINS (CSV) y
// envuelve los errores como ConfigurationError.

const DEMO_PROHIBITED_PREFIXES = Object.freeze(['WOMPI_', 'COGNITO_']);

// Sustrings que, si aparecen en variables de conexión, delatan una
// referencia cruzada de ambiente (ADR-014 §7/§8: agx-staging nunca
// comparte configuración con agx-production, y viceversa).
const CROSS_ENVIRONMENT_HINTS = Object.freeze(['staging.agrogenomax.com', 'demo.agrogenomax.com']);

const LOCALHOST_HINTS = Object.freeze(['localhost', '127.0.0.1']);

// Variables que, de estar presentes, delatan razonablemente un contexto de
// CI/despliegue -- descartan por completo el fallback local aunque se
// solicite explícitamente con allowLocalFallback (corrección 3: nunca se
// infiere por hostname del sistema operativo, que no es fiable en
// computadores de desarrollo reales).
const DEPLOYMENT_INDICATOR_VARIABLES = Object.freeze([
  'CI',
  'GITHUB_ACTIONS',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_STATIC_URL',
  'RAILWAY_PROJECT_ID',
  'AWS_EXECUTION_ENV',
  'AWS_REGION',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'CF_PAGES',
  'VERCEL',
  'NETLIFY',
]);

export class ConfigurationError extends Error {
  /**
   * @param {string} message - mensaje claro, sin exponer valores sensibles.
   * @param {{code: string, environment?: string, variable?: string}} details
   */
  constructor(message, { code, environment, variable } = {}) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code || 'CONFIGURATION_ERROR';
    if (environment) this.environment = environment;
    if (variable) this.variable = variable;
  }
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function containsAny(value, hints) {
  if (!isNonEmpty(value)) return false;
  const lowered = value.toLowerCase();
  return hints.some((hint) => lowered.includes(hint.toLowerCase()));
}

/**
 * Determina si, dado un `source` de variables, existe algún indicio
 * razonable de que la ejecución NO es un desarrollo local seguro.
 *
 * CORRECCIÓN (LOTE-002): esta función NUNCA consulta el hostname del
 * sistema operativo. os.hostname() no identifica de forma fiable "esta es
 * mi computador de desarrollo" -- en la práctica devuelve el nombre real
 * de la máquina (p. ej. "DESKTOP-ABC123"), casi nunca "localhost". La
 * única señal fiable es la combinación de: NODE_ENV distinto de
 * production, ausencia de variables que delaten un contexto de CI/nube, y
 * ausencia de cualquier indicio de configuración de staging/producción.
 */
function looksLikeSafeLocalDevelopment(source) {
  if (source.NODE_ENV === 'production') return false;

  const hasDeploymentIndicator = DEPLOYMENT_INDICATOR_VARIABLES.some((key) => isNonEmpty(source[key]));
  if (hasDeploymentIndicator) return false;

  const suspiciousValues = [
    source.DATABASE_URL,
    source.CATASTROX_DATABASE_URL,
    source.CORS_ORIGIN,
    source.CORS_ALLOWED_ORIGINS,
    source.API_BACKEND_URL,
  ];
  if (suspiciousValues.some((value) => containsAny(value, CROSS_ENVIRONMENT_HINTS))) return false;

  if (source.WOMPI_ENV === 'production') return false;

  return true;
}

/**
 * Resuelve el ambiente funcional (APP_ENV).
 *
 * El único fallback posible cuando APP_ENV está ausente requiere
 * `options.allowLocalFallback === true` de forma EXPLÍCITA -- ningún
 * llamador lo activa por accidente ni por inferencia automática de
 * entorno. server/index.js, tal como queda integrado en este lote, NO
 * pasa esta opción: APP_ENV es, en la práctica, obligatoria sin excepción
 * para arrancar el backend real. La opción queda disponible únicamente
 * para un futuro entrypoint de desarrollo local explícito o para pruebas.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 * @param {{allowLocalFallback?: boolean}} options
 * @returns {{appEnv: string, isLocalDevelopmentFallback: boolean}}
 */
export function loadEnv(source = process.env, options = {}) {
  const allowLocalFallback = options.allowLocalFallback === true;
  const raw = source.APP_ENV;

  if (isNonEmpty(raw)) {
    const value = raw.trim();
    if (!ALLOWED_APP_ENVIRONMENTS.includes(value)) {
      throw new ConfigurationError(
        `APP_ENV tiene un valor no permitido. Valores permitidos: ${ALLOWED_APP_ENVIRONMENTS.join(', ')}.`,
        { code: 'APP_ENV_INVALID', variable: 'APP_ENV' },
      );
    }
    return { appEnv: value, isLocalDevelopmentFallback: false };
  }

  if (allowLocalFallback && looksLikeSafeLocalDevelopment(source)) {
    return { appEnv: 'development', isLocalDevelopmentFallback: true };
  }

  throw new ConfigurationError(
    'APP_ENV no está definida. No existe inferencia automática por hostname ni por ningún ' +
      `otro heurístico implícito. Defínela explícitamente con uno de: ${ALLOWED_APP_ENVIRONMENTS.join(', ')}.`,
    { code: 'APP_ENV_MISSING' },
  );
}

/**
 * Valida la configuración disponible contra las reglas del ambiente ya
 * resuelto. Lanza ConfigurationError en el primer incumplimiento -- nunca
 * continúa con un valor inseguro ni intenta adivinar una corrección.
 *
 * @param {string} appEnv
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
export function validateEnv(appEnv, source = process.env) {
  if (!ALLOWED_APP_ENVIRONMENTS.includes(appEnv)) {
    throw new ConfigurationError(
      `APP_ENV tiene un valor no permitido. Valores permitidos: ${ALLOWED_APP_ENVIRONMENTS.join(', ')}.`,
      { code: 'APP_ENV_INVALID', variable: 'APP_ENV' },
    );
  }

  for (const variable of REQUIRED_VARIABLES_BY_ENV[appEnv]) {
    if (!isNonEmpty(source[variable])) {
      throw new ConfigurationError('La variable requerida no está definida para este ambiente.', {
        code: 'REQUIRED_VARIABLE_MISSING',
        environment: appEnv,
        variable,
      });
    }
  }

  if (appEnv === 'demo') {
    for (const variable of DEMO_PROHIBITED_EXACT_VARIABLES) {
      if (isNonEmpty(source[variable])) {
        throw new ConfigurationError(
          'Esta variable está prohibida en el ambiente demo (demo no tiene backend ni credenciales).',
          { code: 'PROHIBITED_VARIABLE_PRESENT', environment: appEnv, variable },
        );
      }
    }

    for (const key of Object.keys(source)) {
      const matchedPrefix = DEMO_PROHIBITED_PREFIXES.find((prefix) => key.startsWith(prefix));
      if (matchedPrefix && isNonEmpty(source[key])) {
        throw new ConfigurationError(
          'Esta variable está prohibida en el ambiente demo (demo no tiene backend ni credenciales).',
          { code: 'PROHIBITED_VARIABLE_PRESENT', environment: appEnv, variable: key },
        );
      }
    }
  }

  // LOTE-007 (ADR-012 §35.A, endurecimiento): dondequiera que
  // HEALTH_MONITOR_TOKEN esté presente (staging/production obligatorio,
  // development/test opcional -- nunca demo, ya descartado arriba), debe
  // cumplir un formato mínimo seguro. Nunca se expone el valor del token
  // en el mensaje de error.
  if (isNonEmpty(source.HEALTH_MONITOR_TOKEN)) {
    const token = source.HEALTH_MONITOR_TOKEN;

    if (token !== token.trim()) {
      throw new ConfigurationError(
        'HEALTH_MONITOR_TOKEN no puede tener espacios iniciales o finales.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'HEALTH_MONITOR_TOKEN' },
      );
    }

    if (token.length < 32) {
      throw new ConfigurationError('HEALTH_MONITOR_TOKEN debe tener al menos 32 caracteres.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'HEALTH_MONITOR_TOKEN',
      });
    }
  }

  if (appEnv === 'production') {
    const connectionValues = {
      DATABASE_URL: source.DATABASE_URL,
      CATASTROX_DATABASE_URL: source.CATASTROX_DATABASE_URL,
    };

    for (const [variable, value] of Object.entries(connectionValues)) {
      if (containsAny(value, LOCALHOST_HINTS)) {
        throw new ConfigurationError('Esta variable apunta a un host local, no permitido en producción.', {
          code: 'INSECURE_VALUE',
          environment: appEnv,
          variable,
        });
      }
      if (containsAny(value, CROSS_ENVIRONMENT_HINTS)) {
        throw new ConfigurationError(
          'Esta variable referencia un dominio de staging/demo, no permitido en producción.',
          { code: 'INCOMPATIBLE_COMBINATION', environment: appEnv, variable },
        );
      }
    }

    if (source.WOMPI_ENV === 'test') {
      throw new ConfigurationError('WOMPI_ENV está en modo de prueba (test), no permitido en producción.', {
        code: 'INCOMPATIBLE_COMBINATION',
        environment: appEnv,
        variable: 'WOMPI_ENV',
      });
    }
  }

  if (appEnv === 'staging') {
    if (source.WOMPI_ENV === 'production') {
      throw new ConfigurationError(
        'WOMPI_ENV está en modo productivo, no permitido en staging (ADR-014 §18: staging usa Wompi sandbox).',
        { code: 'INCOMPATIBLE_COMBINATION', environment: appEnv, variable: 'WOMPI_ENV' },
      );
    }
  }
}

function parseCommaSeparatedList(rawValue) {
  if (!isNonEmpty(rawValue)) return [];
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Resuelve la *allowlist* de orígenes CORS para `appEnv` (LOTE-004,
 * ADR-014 §7 Barrera 4). Envoltorio delgado sobre
 * `resolveAllowedOriginsForEnvironment()` (shared/security/corsPolicy.js,
 * única fuente de verdad de esta regla, también consumida por los relays
 * de Cloudflare): aquí solo se traduce `CORS_ALLOWED_ORIGINS` (CSV) y se
 * envuelven los errores como `ConfigurationError` para mantener un único
 * tipo de error en todo este módulo.
 *
 * En `demo` la variable está prohibida en `validateEnv()` -- para cuando
 * esta función se invoca, `source.CORS_ALLOWED_ORIGINS` ya está
 * garantizada ausente si `appEnv === 'demo'`.
 *
 * @param {string} appEnv
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 * @returns {readonly string[]}
 */
export function resolveCorsAllowedOrigins(appEnv, source = process.env) {
  const explicitRaw = parseCommaSeparatedList(source.CORS_ALLOWED_ORIGINS);

  try {
    return resolveAllowedOriginsForEnvironment(appEnv, explicitRaw);
  } catch (error) {
    if (error instanceof CorsConfigurationError) {
      throw new ConfigurationError(error.message, {
        code: error.code,
        environment: error.environment,
        variable: 'CORS_ALLOWED_ORIGINS',
      });
    }
    throw error;
  }
}

// Estado compartido: permite que server/db.js y server/catastroxDb.js
// (corrección LOTE-002) verifiquen, sin acoplarse a los detalles internos
// de este módulo, que getConfig() ya se ejecutó con éxito antes de
// construir cualquier pg.Pool.
let validatedAppEnv = null;

/**
 * Punto de entrada único: resuelve y valida el ambiente, y devuelve una
 * configuración inmutable. Nunca incluye valores sensibles (cadenas de
 * conexión, llaves, tokens) -- solo señales derivadas no sensibles.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 * @param {{allowLocalFallback?: boolean}} options
 */
export function getConfig(source = process.env, options = {}) {
  const { appEnv, isLocalDevelopmentFallback } = loadEnv(source, options);
  validateEnv(appEnv, source);

  // Bloqueo de ambiente (corrección de auditoría LOTE-002): una vez que
  // este proceso ya validó con éxito un APP_ENV, ninguna llamada
  // posterior puede revalidar silenciosamente con un valor distinto. Sin
  // este resguardo, una segunda llamada a getConfig() con un ambiente
  // incompatible (p. ej. development -> production) reemplazaría el
  // estado validado sin ningún aviso, dejando al proceso en un estado
  // incoherente respecto de cualquier Pool ya creado o por crear.
  if (validatedAppEnv !== null && validatedAppEnv !== appEnv) {
    throw new ConfigurationError(
      'La configuración del ambiente ya fue validada con un valor distinto en este ' +
        'proceso. No se permite revalidar con un APP_ENV diferente en tiempo de ejecución.',
      { code: 'CONFIG_ALREADY_VALIDATED', environment: appEnv },
    );
  }

  const usesRealServices = appEnv === 'test' ? source.TEST_USE_REAL_SERVICES === 'true' : true;
  const corsAllowedOrigins = resolveCorsAllowedOrigins(appEnv, source);

  const config = Object.freeze({
    appEnv,
    isLocalDevelopmentFallback,
    usesRealServices,
    // LOTE-004: allowlist de CORS ya resuelta y validada para este
    // ambiente -- server/security/corsPolicy.js la consume para construir
    // la política final (métodos/headers/credentials son constantes, no
    // dependen de APP_ENV, y se declaran en ese módulo).
    cors: Object.freeze({ allowedOrigins: corsAllowedOrigins }),
    // Informativo únicamente -- nunca usado para tomar decisiones.
    nodeEnv: source.NODE_ENV ?? null,
  });

  validatedAppEnv = config.appEnv;
  return config;
}

/** @returns {boolean} si getConfig() ya se ejecutó con éxito en este proceso. */
export function isConfigValidated() {
  return validatedAppEnv !== null;
}

/**
 * Guarda de uso obligatorio antes de construir cualquier pg.Pool
 * (server/db.js, server/catastroxDb.js). Lanza si getConfig() todavía no
 * se ejecutó con éxito.
 */
export function assertConfigValidated() {
  if (validatedAppEnv === null) {
    throw new ConfigurationError(
      'La configuración del ambiente no ha sido validada todavía. getConfig() debe ' +
        'ejecutarse con éxito antes de crear cualquier conexión a base de datos.',
      { code: 'CONFIG_NOT_VALIDATED' },
    );
  }
}

// Exclusivamente para pruebas unitarias aisladas (LOTE-002): permite
// resetear el estado de validación compartido entre casos, sin depender
// de reiniciar el proceso ni de tocar process.env real.
export function __resetValidationStateForTests() {
  validatedAppEnv = null;
}
