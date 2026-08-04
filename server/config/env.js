/**
 * Módulo central de configuración runtime del backend (LOTE-002, ADR-014 §13;
 * extendido en LOTE-004 con la resolución de la *allowlist* de CORS).
 *
 * APP_ENV es la única fuente de verdad del ambiente funcional. NODE_ENV
 * nunca la sustituye ni participa en ninguna decisión -- solo se expone de
 * forma informativa en getConfig().
 */

import {
  CorsConfigurationError,
  resolveAllowedOriginsForEnvironment,
  resolvePublicOriginForEnvironment,
} from '../security/corsPolicyCore.js';
import { isEmailFromValidForEnvironment } from '../services/catastrox/emailSender.js';

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
// CATASTROX_PII_ENCRYPTION_KEY/CATASTROX_PII_HASH_SECRET (modelo de
// comprador -- migración 004): sin ellas, POST /customers no puede cifrar/
// indexar documento/teléfono/dirección -- obligatorias donde haya
// compradores reales (staging/production), opcionales en development/test.
// STAGING_READINESS_001 (Bloque 4): WOMPI_PUBLIC_KEY_TEST/
// WOMPI_INTEGRITY_SECRET_TEST/WOMPI_EVENTS_SECRET_TEST/CATASTROX_FRONTEND_URL
// pasan a ser obligatorias en staging -- sin ellas, /checkout y el flujo de
// retorno de Wompi fallarían en silencio en el primer intento real de
// compra. Se agregan solo a staging, no a production: WOMPI_PUBLIC_KEY/
// WOMPI_INTEGRITY_SECRET/WOMPI_EVENTS_SECRET en modo productivo aún no
// están implementados en este repo (riesgo residual documentado en
// docs/catastrox/STAGING_READINESS_001.md).
const REQUIRED_VARIABLES_BY_ENV = Object.freeze({
  development: Object.freeze([]),
  test: Object.freeze([]),
  demo: Object.freeze([]),
  staging: Object.freeze([
    'DATABASE_URL',
    'CATASTROX_DATABASE_URL',
    'HEALTH_MONITOR_TOKEN',
    'CATASTROX_PII_ENCRYPTION_KEY',
    'CATASTROX_PII_HASH_SECRET',
    'WOMPI_PUBLIC_KEY_TEST',
    'WOMPI_INTEGRITY_SECRET_TEST',
    'WOMPI_EVENTS_SECRET_TEST',
    'CATASTROX_FRONTEND_URL',
    // EMAIL_PROVIDER_002: sin estas tres, POST /customers respondería
    // siempre 503 EMAIL_DELIVERY_UNAVAILABLE en staging -- mejor fallar al
    // arrancar con un mensaje claro que dejar el backend "arriba" pero con
    // el flujo de comprador roto desde la primera solicitud real.
    'EMAIL_PROVIDER',
    'RESEND_API_KEY',
    'EMAIL_FROM',
  ]),
  production: Object.freeze([
    'DATABASE_URL',
    'CATASTROX_DATABASE_URL',
    'HEALTH_MONITOR_TOKEN',
    'CATASTROX_PII_ENCRYPTION_KEY',
    'CATASTROX_PII_HASH_SECRET',
  ]),
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
  // LOTE 019-C: la excepcion de tunel de desarrollo es exclusiva de
  // development -- demo no tiene backend real que exponer via tunel.
  'CORS_ALLOW_DEV_TUNNEL',
  // LOTE-007 (ADR-012 §35.A): demo no tiene readiness protegida que
  // autenticar -- una credencial técnica configurada en demo delataría un
  // backend real inexistente.
  'HEALTH_MONITOR_TOKEN',
  // Modelo de comprador (migración 004): demo no tiene backend real ni
  // base de datos de compradores que cifrar/indexar.
  'CATASTROX_PII_ENCRYPTION_KEY',
  'CATASTROX_PII_HASH_SECRET',
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

// STAGING_READINESS_001 (Bloque 4): mismo patrón que
// server/routes/catastroxPayments.js -- detecta valores de marcador de
// posición evidentes en llaves/secretos de Wompi copiados sin reemplazar.
const WOMPI_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;

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

  // Sistema de órdenes de pago CatastroX: el secreto de eventos de Wompi
  // (distinto de WOMPI_INTEGRITY_SECRET_TEST) autentica el webhook
  // POST /api/catastrox/payments/wompi/events. Aún no es obligatorio en
  // ningún ambiente (Sandbox/webhook opcional mientras se activa en el
  // dashboard de Wompi), pero donde esté presente debe cumplir el mismo
  // formato mínimo seguro que HEALTH_MONITOR_TOKEN -- nunca se expone su
  // valor en el mensaje de error.
  if (isNonEmpty(source.WOMPI_EVENTS_SECRET_TEST)) {
    const secret = source.WOMPI_EVENTS_SECRET_TEST;

    if (secret !== secret.trim()) {
      throw new ConfigurationError(
        'WOMPI_EVENTS_SECRET_TEST no puede tener espacios iniciales o finales.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'WOMPI_EVENTS_SECRET_TEST' },
      );
    }

    if (secret.length < 32) {
      throw new ConfigurationError('WOMPI_EVENTS_SECRET_TEST debe tener al menos 32 caracteres.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'WOMPI_EVENTS_SECRET_TEST',
      });
    }

    // STAGING_READINESS_001 (revisión final): la longitud mínima por sí sola
    // no basta -- un placeholder largo (p. ej. copiado y "rellenado" a mano
    // hasta pasar los 32 caracteres) seguiría pareciendo válido. Mismo
    // patrón que WOMPI_PUBLIC_KEY_TEST más abajo.
    if (WOMPI_PLACEHOLDER_PATTERN.test(secret)) {
      throw new ConfigurationError(
        'WOMPI_EVENTS_SECRET_TEST tiene un valor de marcador de posición, no un secreto real.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'WOMPI_EVENTS_SECRET_TEST' },
      );
    }
  }

  // CATASTROX_PII_HASH_SECRET: mismo formato mínimo que los demás secretos
  // de este módulo -- nunca se expone su valor en el error.
  if (isNonEmpty(source.CATASTROX_PII_HASH_SECRET)) {
    const secret = source.CATASTROX_PII_HASH_SECRET;

    if (secret !== secret.trim()) {
      throw new ConfigurationError(
        'CATASTROX_PII_HASH_SECRET no puede tener espacios iniciales o finales.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'CATASTROX_PII_HASH_SECRET' },
      );
    }

    if (secret.length < 32) {
      throw new ConfigurationError('CATASTROX_PII_HASH_SECRET debe tener al menos 32 caracteres.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'CATASTROX_PII_HASH_SECRET',
      });
    }

    // STAGING_READINESS_001 (revisión final, hallazgo real): el placeholder
    // documentado en .env.example/server/.env.example
    // ("pii_hash_secret_REEMPLAZAR_treinta_dos_caracteres") tiene 49
    // caracteres -- pasaría el check de longitud de arriba sin esta
    // validación adicional, dejando desplegar staging con un secreto HMAC
    // conocido/públicamente documentado en el propio repositorio.
    if (WOMPI_PLACEHOLDER_PATTERN.test(secret)) {
      throw new ConfigurationError(
        'CATASTROX_PII_HASH_SECRET tiene un valor de marcador de posición, no un secreto real.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'CATASTROX_PII_HASH_SECRET' },
      );
    }
  }

  // STAGING_READINESS_001 (revisión final): WOMPI_INTEGRITY_SECRET_TEST no
  // tenía ninguna validación de formato -- a diferencia de
  // WOMPI_EVENTS_SECRET_TEST/CATASTROX_PII_HASH_SECRET/HEALTH_MONITOR_TOKEN,
  // un valor vacío-de-contenido-real (espacios, o el placeholder
  // "test_integrity_REEMPLAZAR" de .env.example) pasaba sin control. No se
  // exige una longitud mínima aquí porque no hay una garantía documentada
  // del formato exacto que emite el dashboard de Wompi para este secreto --
  // exigir un mínimo arbitrario podría rechazar un secreto real válido más
  // corto. El rechazo de placeholder sí es seguro: ningún secreto real
  // contendría literalmente "REEMPLAZAR"/"PLACEHOLDER"/etc.
  if (isNonEmpty(source.WOMPI_INTEGRITY_SECRET_TEST)) {
    const secret = source.WOMPI_INTEGRITY_SECRET_TEST;

    if (secret !== secret.trim()) {
      throw new ConfigurationError(
        'WOMPI_INTEGRITY_SECRET_TEST no puede tener espacios iniciales o finales.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'WOMPI_INTEGRITY_SECRET_TEST' },
      );
    }

    if (WOMPI_PLACEHOLDER_PATTERN.test(secret)) {
      throw new ConfigurationError(
        'WOMPI_INTEGRITY_SECRET_TEST tiene un valor de marcador de posición, no un secreto real.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'WOMPI_INTEGRITY_SECRET_TEST' },
      );
    }
  }

  // CATASTROX_PII_ENCRYPTION_KEY: debe decodificar exactamente a 32 bytes
  // en base64 (AES-256) -- una clave más corta debilitaría el cifrado, una
  // más larga indica casi con certeza un valor mal generado/copiado.
  if (isNonEmpty(source.CATASTROX_PII_ENCRYPTION_KEY)) {
    const key = source.CATASTROX_PII_ENCRYPTION_KEY;
    let decodedLength = -1;
    try {
      decodedLength = Buffer.from(key, 'base64').length;
    } catch {
      decodedLength = -1;
    }

    if (decodedLength !== 32) {
      throw new ConfigurationError(
        'CATASTROX_PII_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes (AES-256) en base64.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'CATASTROX_PII_ENCRYPTION_KEY' },
      );
    }
  }

  // STAGING_READINESS_001 (Bloque 4): WOMPI_PUBLIC_KEY_TEST dondequiera que
  // esté presente (no solo en staging) debe ser una llave Sandbox real, no
  // un placeholder ni -- en particular -- una llave de producción (`pub_`
  // sin el sufijo `_test_`). Antes solo se validaba en tiempo de request
  // dentro de POST /checkout (server/routes/catastroxPayments.js); ahora
  // también falla-rápido al arrancar, para que un despliegue de staging con
  // la llave mal configurada nunca llegue a aceptar tráfico.
  if (isNonEmpty(source.WOMPI_PUBLIC_KEY_TEST)) {
    const key = source.WOMPI_PUBLIC_KEY_TEST;

    if (WOMPI_PLACEHOLDER_PATTERN.test(key)) {
      throw new ConfigurationError('WOMPI_PUBLIC_KEY_TEST tiene un valor de marcador de posición, no una llave real.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'WOMPI_PUBLIC_KEY_TEST',
      });
    }

    if (!key.startsWith('pub_test_')) {
      throw new ConfigurationError('WOMPI_PUBLIC_KEY_TEST debe iniciar con pub_test_ (nunca una llave de producción).', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'WOMPI_PUBLIC_KEY_TEST',
      });
    }
  }

  // STAGING_READINESS_001 (Bloque 4): CATASTROX_FRONTEND_URL es la URL
  // pública que el backend usa para construir los enlaces de retorno de
  // Wompi y los correos de verificación -- en staging/production debe ser
  // https y nunca apuntar a localhost/127.0.0.1 (misma regla que
  // API_BACKEND_URL en los relays de Cloudflare, ver
  // resolvePublicOriginForEnvironment() en shared/security/corsPolicy.js).
  if (isNonEmpty(source.CATASTROX_FRONTEND_URL) && (appEnv === 'staging' || appEnv === 'production')) {
    const resolved = resolvePublicOriginForEnvironment(source.CATASTROX_FRONTEND_URL, appEnv);
    if (!resolved) {
      throw new ConfigurationError(
        'CATASTROX_FRONTEND_URL debe ser una URL https pública, nunca localhost/127.0.0.1, en este ambiente.',
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'CATASTROX_FRONTEND_URL' },
      );
    }
  }

  // EMAIL_PROVIDER_002: selecciona la implementación real de envío de OTP
  // (server/services/catastrox/emailSender.js). Dondequiera que esté
  // presente debe ser un valor soportado; en staging, además, debe ser
  // exactamente 'resend' -- 'stub' en staging desactivaría el flujo de
  // comprador real sin que el arranque lo señale.
  if (isNonEmpty(source.EMAIL_PROVIDER)) {
    const provider = source.EMAIL_PROVIDER.trim().toLowerCase();

    if (provider !== 'stub' && provider !== 'resend') {
      throw new ConfigurationError(
        "EMAIL_PROVIDER debe ser 'stub' o 'resend'.",
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'EMAIL_PROVIDER' },
      );
    }

    if (appEnv === 'staging' && provider !== 'resend') {
      throw new ConfigurationError("EMAIL_PROVIDER debe ser 'resend' en staging.", {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'EMAIL_PROVIDER',
      });
    }
  }

  // RESEND_API_KEY: mismo formato mínimo que los demás secretos de este
  // módulo -- nunca se expone su valor en el error.
  if (isNonEmpty(source.RESEND_API_KEY)) {
    const key = source.RESEND_API_KEY;

    if (key !== key.trim()) {
      throw new ConfigurationError('RESEND_API_KEY no puede tener espacios iniciales o finales.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'RESEND_API_KEY',
      });
    }

    if (WOMPI_PLACEHOLDER_PATTERN.test(key)) {
      throw new ConfigurationError('RESEND_API_KEY tiene un valor de marcador de posición, no una llave real.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'RESEND_API_KEY',
      });
    }
  }

  // EMAIL_FROM: debe ser `Nombre <correo@dominio>` o `correo@dominio`. En
  // staging/producción, además, el dominio debe ser público -- nunca
  // localhost/127.0.0.1/TLD reservado para uso no público
  // (isEmailFromValidForEnvironment, compartida con
  // server/services/catastrox/emailSender.js para aplicar la misma regla
  // otra vez en tiempo de request, sin depender de que este módulo ya haya
  // corrido).
  if (isNonEmpty(source.EMAIL_FROM) && !isEmailFromValidForEnvironment(source.EMAIL_FROM, appEnv)) {
    throw new ConfigurationError(
      'EMAIL_FROM debe tener el formato "Nombre <correo@dominio>" o "correo@dominio", con un dominio público en este ambiente.',
      { code: 'INSECURE_VALUE', environment: appEnv, variable: 'EMAIL_FROM' },
    );
  }

  // EMAIL_SEND_TIMEOUT_MS (opcional, entero 1000-15000ms, default 5000):
  // límite del AbortController alrededor de la llamada al proveedor de
  // correo (server/services/catastrox/emailSender.js). Mismo criterio que
  // TRUST_PROXY_HOPS -- un valor fuera de rango falla-rápido en vez de
  // degradar silenciosamente.
  if (isNonEmpty(source.EMAIL_SEND_TIMEOUT_MS)) {
    const raw = source.EMAIL_SEND_TIMEOUT_MS.trim();
    const parsed = Number(raw);

    if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1000 || parsed > 15000) {
      throw new ConfigurationError('EMAIL_SEND_TIMEOUT_MS debe ser un entero entre 1000 y 15000.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'EMAIL_SEND_TIMEOUT_MS',
      });
    }
  }

  // CATASTROX_STORAGE_DRIVER (opcional, default 'postgres'): backend de
  // almacenamiento de los PDF entregables (CATX-DELIVERY-001). 'local-dev-only'
  // escribe al sistema de archivos del proceso -- en Railway ese disco es
  // efímero (se pierde en cada redeploy/reinicio), así que ese driver NUNCA
  // puede usarse en producción bajo ninguna circunstancia (ajuste obligatorio
  // del plan aprobado) -- se falla-rápido aquí, en vez de dejar que
  // storage/localFsStorage.js lo descubra en tiempo de ejecución con el
  // primer PDF perdido.
  const STORAGE_DRIVERS = ['postgres', 'local-dev-only'];
  if (isNonEmpty(source.CATASTROX_STORAGE_DRIVER)) {
    const driver = source.CATASTROX_STORAGE_DRIVER.trim();
    if (!STORAGE_DRIVERS.includes(driver)) {
      throw new ConfigurationError(
        `CATASTROX_STORAGE_DRIVER tiene un valor no soportado. Valores permitidos: ${STORAGE_DRIVERS.join(', ')}.`,
        { code: 'INSECURE_VALUE', environment: appEnv, variable: 'CATASTROX_STORAGE_DRIVER' },
      );
    }
    if (appEnv === 'production' && driver !== 'postgres') {
      throw new ConfigurationError(
        'CATASTROX_STORAGE_DRIVER debe ser "postgres" en producción -- local-dev-only usa disco efímero y perdería los PDF entregados.',
        { code: 'INCOMPATIBLE_COMBINATION', environment: appEnv, variable: 'CATASTROX_STORAGE_DRIVER' },
      );
    }
  }

  // CATASTROX_DELIVERABLE_MAX_BYTES (opcional, entero 1-10485760, default
  // 10 MB = 10485760): límite documentado antes de insertar un PDF en
  // Postgres (bytea) -- ver server/services/catastrox/storage/postgresBlobStorage.js
  // y el CHECK equivalente en la migración 007. Falla-rápido con el mismo
  // patrón que TRUST_PROXY_HOPS/EMAIL_SEND_TIMEOUT_MS más abajo.
  if (isNonEmpty(source.CATASTROX_DELIVERABLE_MAX_BYTES)) {
    const raw = source.CATASTROX_DELIVERABLE_MAX_BYTES.trim();
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 10485760) {
      throw new ConfigurationError('CATASTROX_DELIVERABLE_MAX_BYTES debe ser un entero entre 1 y 10485760 (10 MB).', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'CATASTROX_DELIVERABLE_MAX_BYTES',
      });
    }
  }

  // TRUST_PROXY_HOPS (opcional, default 0 = no confiar en ningún proxy):
  // número exacto de saltos de reverse proxy confiables (p. ej. Cloudflare +
  // ALB) para resolver la IP real del cliente en rate limiting. Restrictivo
  // por diseño -- un valor mal formado falla-rápido en vez de degradar
  // silenciosamente a "confiar en todo" (Express interpretaría un valor no
  // numérico de forma impredecible).
  if (isNonEmpty(source.TRUST_PROXY_HOPS)) {
    const raw = source.TRUST_PROXY_HOPS.trim();
    const parsed = Number(raw);

    if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
      throw new ConfigurationError('TRUST_PROXY_HOPS debe ser un entero entre 0 y 5.', {
        code: 'INSECURE_VALUE',
        environment: appEnv,
        variable: 'TRUST_PROXY_HOPS',
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
  // LOTE 019-C: opt-in explicito, propio y acotado (ver
  // shared/security/corsPolicy.js) -- por si solo, esta variable no habilita
  // nada: solo se consulta dentro de la rama `development`, y ademas exige
  // WOMPI_ENV=test y que el origen ya este listado en CORS_ALLOWED_ORIGINS.
  const allowDevTunnel = String(source.CORS_ALLOW_DEV_TUNNEL || '').toLowerCase() === 'true';

  try {
    return resolveAllowedOriginsForEnvironment(appEnv, explicitRaw, {
      wompiEnv: source.WOMPI_ENV,
      allowDevTunnel,
    });
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
  // Ya validado arriba (entero 0-5 si está presente); default 0 = no
  // confiar en ningún proxy (Express usa el socket real).
  const trustProxyHops = isNonEmpty(source.TRUST_PROXY_HOPS) ? Number(source.TRUST_PROXY_HOPS.trim()) : 0;

  const config = Object.freeze({
    appEnv,
    isLocalDevelopmentFallback,
    usesRealServices,
    // LOTE-004: allowlist de CORS ya resuelta y validada para este
    // ambiente -- server/security/corsPolicy.js la consume para construir
    // la política final (métodos/headers/credentials son constantes, no
    // dependen de APP_ENV, y se declaran en ese módulo).
    cors: Object.freeze({ allowedOrigins: corsAllowedOrigins }),
    trustProxyHops,
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
