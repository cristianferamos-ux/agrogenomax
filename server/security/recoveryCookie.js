// Cookie de sesión de recuperación de CatastroX (Bloque 7) -- hand-rolled a
// propósito, sin `cookie-parser`: solo necesitamos leer/escribir UN cookie
// de nombre conocido con un valor ya URL-safe (base64url), mismo estilo
// que el resto de módulos de seguridad de este repo
// (shared/security/corsPolicy.js, server/middleware/rateLimit.js) -- nunca
// se añade una dependencia nueva para algo de esta complejidad.
//
// Evolución del modelo: en la fase anterior, este cookie representaba el
// token de UNA orden. La política comercial definitiva permite N compras
// del mismo predio/paquete -- una cookie ahora representa una SESIÓN de
// recuperación (server/services/catastrox/recoverySessionRepository.js)
// que puede tener enlazadas múltiples órdenes. El cookie se renombra
// (`catastrox_recovery_session`, antes `catastrox_recovery`) para que un
// cookie antiguo de la fase anterior, si sobrevive en el navegador de
// algún probador, simplemente se ignore en vez de mezclarse con la
// semántica nueva.
//
// El valor del cookie ES el token de sesión en claro (nunca su hash) --
// el servidor solo guarda sha256(token) en Postgres. HttpOnly impide que
// cualquier script en el navegador (propio o inyectado) lo lea vía
// document.cookie -- nunca debe aparecer en una respuesta JSON, log, URL ni
// almacenamiento accesible desde JavaScript.

export const RECOVERY_COOKIE_NAME = 'catastrox_recovery_session';

// 180 días: suficientemente largo para que "cerrar el navegador y volver
// días/semanas después" siga funcionando, sin ser indefinido.
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

// Ámbito del cookie: solo las rutas de pago de CatastroX lo reciben --
// nunca viaja a ningún otro endpoint de la API (aislamiento adicional,
// independiente de que CORS credentials esté activado globalmente).
const RECOVERY_COOKIE_PATH = '/api/catastrox/payments';

function shouldUseSecureCookie(appEnv) {
  // Secure exige HTTPS real -- en development local (HTTP plano) el
  // navegador simplemente descartaría el cookie si se marcara Secure, lo
  // que rompería el flujo de pruebas locales. staging/production sirven
  // siempre por HTTPS (detrás de Cloudflare/ALB).
  return appEnv === 'production' || appEnv === 'staging';
}

/**
 * Parsea el header `Cookie` crudo de una request y devuelve únicamente el
 * valor del cookie de sesión de recuperación, o null si no viene. No
 * expone ni procesa ningún otro cookie -- este backend no usa cookies para
 * nada más.
 *
 * @param {string | undefined | null} cookieHeader
 * @returns {string | null}
 */
export function getRecoverySessionTokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;

  const pairs = String(cookieHeader).split(';');
  for (const pair of pairs) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;

    const name = pair.slice(0, separatorIndex).trim();
    if (name !== RECOVERY_COOKIE_NAME) continue;

    const rawValue = pair.slice(separatorIndex + 1).trim();
    if (!rawValue) return null;

    try {
      return decodeURIComponent(rawValue);
    } catch {
      // Valor mal formado (no decodificable) -- se trata como ausente, no
      // como un token inválido a comparar (evita cualquier ruta de código
      // que intente usar un valor corrupto como si fuera un token real).
      return null;
    }
  }

  return null;
}

/**
 * Construye el header `Set-Cookie` completo para emitir/renovar la sesión
 * de recuperación. Se llama al crear una sesión nueva en POST /checkout
 * (cuando la request no traía ya una sesión válida) -- una sesión
 * existente y vigente nunca se reemite.
 *
 * @param {{ token: string, appEnv: string }} input
 * @returns {string}
 */
export function buildRecoverySetCookieHeader({ token, appEnv }) {
  const attributes = [
    `${RECOVERY_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${RECOVERY_COOKIE_MAX_AGE_SECONDS}`,
    `Path=${RECOVERY_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (shouldUseSecureCookie(appEnv)) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

/**
 * Header `Set-Cookie` que borra la sesión de recuperación del navegador
 * (Max-Age=0) -- para revocación explícita (p. ej. equipo compartido).
 * Debe usar exactamente los mismos atributos Path/SameSite/Secure que
 * buildRecoverySetCookieHeader(), o el navegador lo trataría como un
 * cookie distinto y no lo reemplazaría.
 *
 * @param {{ appEnv: string }} input
 * @returns {string}
 */
export function buildRecoveryClearCookieHeader({ appEnv }) {
  const attributes = [
    `${RECOVERY_COOKIE_NAME}=`,
    'Max-Age=0',
    `Path=${RECOVERY_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (shouldUseSecureCookie(appEnv)) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}
