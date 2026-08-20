// Rate limiting del dominio de pagos de CatastroX (express-rate-limit).
//
// Store: en memoria (default de express-rate-limit) -- válido para
// desarrollo y para una sola instancia. RIESGO RESIDUAL DOCUMENTADO: en
// producción con más de una instancia detrás del balanceador, cada proceso
// lleva su propio contador -- el límite efectivo se multiplica por el
// número de instancias. Migrar a un store compartido (Redis, vía
// `rate-limit-redis` u otro adaptador de express-rate-limit) antes de
// escalar horizontalmente a producción con más de una instancia.
//
// Clave de limitación: req.ip. Express solo resuelve req.ip a partir de
// X-Forwarded-For cuando `trust proxy` está configurado explícitamente
// (server/index.js lo activa únicamente si TRUST_PROXY_HOPS > 0, validado
// en server/config/env.js como un entero acotado 0-5) -- por defecto
// (TRUST_PROXY_HOPS=0) Express nunca confía en X-Forwarded-For y req.ip es
// siempre la IP real del socket TCP, inmune a que el cliente falsifique el
// header.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

function jsonRateLimitHandler(publicCode, publicMessage) {
  return (_req, res) => {
    res.status(429).json({ ok: false, code: publicCode, message: publicMessage });
  };
}

// ipKeyGenerator (helper oficial de express-rate-limit): normaliza IPv6 a su
// bloque /64 antes de usarlo como clave -- sin esto, un cliente IPv6 podría
// eludir el límite variando la porción de interfaz de su propia dirección
// (2^64 direcciones equivalentes a efectos de "un mismo cliente").
export function ipRateLimitKeyGenerator(req) {
  return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
}

// SPRINT-3C1.1 §4: keyGenerator por defecto, reutilizable, para limiters
// que sí necesitan clave `keyGenerator` explícita en su factory (todos
// los de más abajo, salvo prediosSearchLimiter).
function buildLimiter({ windowMs, max, publicCode, publicMessage, keyGenerator = ipRateLimitKeyGenerator }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: jsonRateLimitHandler(publicCode, publicMessage),
  });
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

// Creación de orden: la operación con mayor costo (abre un checkout real de
// Wompi) -- el límite más estricto de los cinco.
export const checkoutLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 10,
  publicCode: 'RATE_LIMITED_CHECKOUT',
  publicMessage: 'Demasiados intentos de compra. Intenta nuevamente en unos minutos.',
});

export const verifyLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 30,
  publicCode: 'RATE_LIMITED_VERIFY',
  publicMessage: 'Demasiadas verificaciones de pago. Intenta nuevamente en unos minutos.',
});

export const orderStatusLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 60,
  publicCode: 'RATE_LIMITED_ORDER_STATUS',
  publicMessage: 'Demasiadas consultas de estado. Intenta nuevamente en unos minutos.',
});

export const entitlementLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 60,
  publicCode: 'RATE_LIMITED_ENTITLEMENT',
  publicMessage: 'Demasiadas consultas. Intenta nuevamente en unos minutos.',
});

// Creación/actualización de comprador (Bloque 2/5): moderado -- cifra PII y
// dispara el envío de un código de un solo uso.
export const customerLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 15,
  publicCode: 'RATE_LIMITED_CUSTOMER',
  publicMessage: 'Demasiados intentos. Intenta nuevamente en unos minutos.',
});

// Verificación de código de correo: más estricto que customerLimiter --
// además del límite de intentos por código (5, en customerRepository.js),
// esto acota cuántos códigos distintos puede probar un mismo IP en la
// ventana.
export const emailVerificationLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 20,
  publicCode: 'RATE_LIMITED_EMAIL_VERIFICATION',
  publicMessage: 'Demasiados intentos de verificación. Intenta nuevamente en unos minutos.',
});

// Historial multiorden ("Mis compras en este navegador", Bloque 9): lectura
// de baja sensibilidad (campos ya minimizados en la propia consulta), mismo
// orden de magnitud que orderStatusLimiter.
export const myOrdersLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 60,
  publicCode: 'RATE_LIMITED_MY_ORDERS',
  publicMessage: 'Demasiadas consultas. Intenta nuevamente en unos minutos.',
});

// Webhook: deliberadamente generoso y NUNCA el único filtro de seguridad de
// esta ruta -- la autenticidad real la da verifyWompiEventSignature(), no
// el rate limit. Un límite agresivo por IP podría bloquear reintentos
// legítimos de Wompi (que puede reintentar el mismo evento desde IPs de su
// propia infraestructura). Pendiente de producción: restringir por rango
// de IPs documentado de Wompi si/cuando esté disponible de forma estable
// (no se hardcodea aquí sin esa confirmación -- ver informe de riesgos
// residuales).
export const webhookLimiter = buildLimiter({
  windowMs: ONE_MINUTE_MS,
  max: 300,
  publicCode: 'RATE_LIMITED_WEBHOOK',
  publicMessage: 'Too many requests.',
});

// CATX-FREEZE-01: verificación de la contraseña temporal compartida --
// deliberadamente el más estricto de todos (una contraseña única y
// compartida es un objetivo de fuerza bruta más simple que un OTP de un
// solo uso). 5 intentos por ventana de 5 minutos, mismo patrón buildLimiter
// que el resto de este archivo -- sin Redis, sin infraestructura nueva.
export const temporaryAccessLimiter = buildLimiter({
  windowMs: FIVE_MINUTES_MS,
  max: 5,
  publicCode: 'RATE_LIMITED_TEMPORARY_ACCESS',
  publicMessage: 'Demasiados intentos. Intenta nuevamente en unos minutos.',
});

// CATX-FREEZE-01 (P2-02): generación de PDF con un capability YA válido --
// distinto y más laxo que temporaryAccessLimiter (ese protege la contraseña
// contra fuerza bruta; este solo acota el costo de CPU de regenerar el PDF
// repetidamente dentro del TTL de 15 min del capability). Ventana alineada
// al propio TTL del capability para que un uso normal (reintentos tras un
// error de red, o descargar el mismo PDF más de una vez) nunca choque con
// el límite.
export const temporaryPdfLimiter = buildLimiter({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 10,
  publicCode: 'RATE_LIMITED_TEMPORARY_PDF',
  publicMessage: 'Demasiadas generaciones de PDF. Intenta nuevamente en unos minutos.',
});

// SPRINT-3C1.1 §4: clave por CUENTA autenticada (req.ganaderiaAuth.cuentaId
// -- resuelto server-side por createRequireGanaderiaSession, NUNCA del
// body/query/header del cliente), no por IP. Esto exige que este limiter
// se monte DESPUÉS del middleware de sesión en el router (ver
// server/routes/ganaderiaPredios.js) -- si req.ganaderiaAuth no existe
// todavía en ese punto, es un error de montaje del router, no un caso
// legítimo a tolerar en producción. El fallback a IP existe únicamente
// para no romper con un 500 si algún día una ruta pública reutilizara
// este limiter sin sesión resuelta; en la práctica, con el middleware de
// sesión montado antes, cuentaId siempre está presente aquí.
export function prediosSearchRateLimitKeyGenerator(req) {
  const cuentaId = req.ganaderiaAuth?.cuentaId;
  if (typeof cuentaId === 'string' && cuentaId.trim() !== '') {
    return `cuenta:${cuentaId}`;
  }
  return ipRateLimitKeyGenerator(req);
}

// SPRINT-3C1-MIS-PREDIOS-API §21 (SPRINT-3C1.1 §4: reescrito de IP a
// cuenta): búsquedas CatastroX desde "Mis Predios" (coordenadas/código).
// 30 búsquedas / 10 minutos por CUENTA -- mismo orden de magnitud que
// enforceLookupByCodeRateLimit de catastrox.js (30/10min, límite ya
// validado en producción para el mismo tipo de operación: consulta contra
// la base catastral), lo suficientemente amplio para el uso normal de un
// productor cargando varios predios en una sesión, y suficientemente
// estricto para no habilitar scraping masivo del dataset catastral vía
// esta ruta autenticada. Por cuenta (no por IP) para que varias cuentas
// detrás de la misma IP/NAT/oficina no compitan por el mismo cupo, y para
// que una cuenta que cambia de red conserve su propio contador.
export const prediosSearchLimiter = buildLimiter({
  windowMs: TEN_MINUTES_MS,
  max: 30,
  publicCode: 'RATE_LIMITED_PREDIOS_SEARCH',
  publicMessage: 'Demasiadas búsquedas de predios. Intenta nuevamente en unos minutos.',
  keyGenerator: prediosSearchRateLimitKeyGenerator,
});

// SPRINT-3D3-POTREROS-API-FOUNDATION §18: mismo patrón/orden de magnitud
// que prediosSearchLimiter -- previews de potreros (coordenadas/gps) son
// consultas espaciales contra Postgres-AGX-Business (ST_IsValid/
// ST_CoveredBy/ST_Area), no gratis mantener sin límite. 30/10min por
// CUENTA (reutiliza el mismo keyGenerator ya validado).
export const potrerosPreviewLimiter = buildLimiter({
  windowMs: TEN_MINUTES_MS,
  max: 30,
  publicCode: 'RATE_LIMITED_POTREROS_PREVIEW',
  publicMessage: 'Demasiados previews de potreros. Intenta nuevamente en unos minutos.',
  keyGenerator: prediosSearchRateLimitKeyGenerator,
});
