/**
 * Módulo central de configuración runtime del backend (LOTE-002, ADR-014 §13).
 *
 * APP_ENV es la única fuente de verdad del ambiente funcional. NODE_ENV
 * nunca la sustituye ni participa en ninguna decisión -- solo se expone de
 * forma informativa en getConfig().
 */

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
const REQUIRED_VARIABLES_BY_ENV = Object.freeze({
  development: Object.freeze([]),
  test: Object.freeze([]),
  demo: Object.freeze([]),
  staging: Object.freeze(['DATABASE_URL', 'CATASTROX_DATABASE_URL']),
  production: Object.freeze(['DATABASE_URL', 'CATASTROX_DATABASE_URL']),
});

// Variables que nunca deben aparecer cuando APP_ENV=demo (ADR-014 §13/§7):
// demo no tiene backend, no tiene credenciales, no tiene relay productivo.
const DEMO_PROHIBITED_EXACT_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'CATASTROX_DATABASE_URL',
  'API_BACKEND_URL',
  'VITE_API_URL',
  'VITE_AGX_API_URL',
]);

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

  const config = Object.freeze({
    appEnv,
    isLocalDevelopmentFallback,
    usesRealServices,
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
