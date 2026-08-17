// AUTH-RECOVERY-002 §9: sender de correo transaccional AISLADO de
// Ganadería -- NUNCA importa server/services/catastrox/emailSender.js
// (instrucción explícita), aunque reutiliza la MISMA infraestructura ya
// configurada (RESEND_API_KEY/EMAIL_FROM/EMAIL_PROVIDER, ya validadas y
// requeridas en staging por server/config/env.js). Único llamador:
// server/routes/ganaderiaAuth.js (POST /recovery/request).
//
// Misma postura de seguridad que el sender de CatastroX (implementada de
// forma independiente, no importada):
// - development/test JAMÁS llaman a un proveedor real, sin importar
//   EMAIL_PROVIDER -- gate por APP_ENV.
// - production no habilita Resend automáticamente (misma decisión
//   pendiente que CatastroX, sin resolver aquí).
// - Nunca se loguea el correo completo, el token/enlace de recuperación,
//   la API key ni el cuerpo de la respuesta del proveedor -- solo
//   provider + errorCode del set cerrado de abajo.
// - Fail-closed: `delivered` nace `false`, solo pasa a `true` si Resend
//   confirmó la aceptación (2xx + `id` presente).

// server/ nunca importa fuera de server/ en tiempo de ejecución (Railway
// solo instala server/ -- ver server/__tests__/architecture/noSrcImports.test.js).
// corsPolicyCore.js ya mantiene su PROPIA copia server-local de
// CORS_MANDATORY_ORIGINS_BY_ENV (idéntica a shared/security/corsPolicy.js,
// consumida también por server/security/ganaderiaSession.js vía
// isOriginAllowed) -- se reusa esa, nunca shared/.
import { CORS_MANDATORY_ORIGINS_BY_ENV, resolvePublicOriginForEnvironment } from '../../security/corsPolicyCore.js';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 200;

const EMAIL_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;
const EMAIL_ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const RESERVED_NON_PUBLIC_TLDS = Object.freeze(['.local', '.internal', '.test', '.example', '.invalid', '.localdomain']);

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function logEmailEvent(type, { provider, errorCode } = {}) {
  console.info(`[Ganaderia Email] ${type}`, { provider, ...(errorCode ? { errorCode } : {}) });
}

function logEmailFailure(type, { provider, errorCode }) {
  console.error(`[Ganaderia Email] ${type}`, { provider, errorCode });
}

// --- EMAIL_FROM: validación propia, sin importar la de CatastroX (§9) ---

function parseEmailFromHeader(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return null;

  const angleMatch = value.match(/^(.*)<([^<>]+)>$/);
  let email;
  if (angleMatch) {
    email = angleMatch[2].trim();
  } else {
    email = value;
  }

  if (!EMAIL_ADDRESS_PATTERN.test(email)) return null;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return { raw: value, email, domain };
}

function isPublicEmailDomain(domain) {
  if (!domain) return false;
  if (domain.startsWith('[')) return false;
  if (domain === 'localhost' || domain.endsWith('.localhost')) return false;
  if (domain === '0.0.0.0') return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) return false;
  if (RESERVED_NON_PUBLIC_TLDS.some((tld) => domain.endsWith(tld))) return false;
  if (!domain.includes('.')) return false;
  return true;
}

function isEmailFromValidForEnvironment(rawValue, appEnv) {
  const parsed = parseEmailFromHeader(rawValue);
  if (!parsed) return false;
  if (appEnv === 'staging' || appEnv === 'production') return isPublicEmailDomain(parsed.domain);
  return true;
}

// AUTH-RECOVERY-003: nombre visible propio de Ganadería, sin tocar la
// variable EMAIL_FROM global (compartida con CatastroX -- cambiarla
// alteraría también su remitente, prohibido explícitamente). Se toma
// SOLO la dirección/dominio ya verificado en Resend desde EMAIL_FROM y
// se reconstruye con el nombre visible "AgroGenomaX" -- la dirección de
// envío real nunca cambia, por lo que la verificación de dominio de
// Resend sigue siendo válida.
const GANADERIA_DISPLAY_NAME = 'AgroGenomaX';

function buildGanaderiaFromHeader(rawEnvValue) {
  const parsed = parseEmailFromHeader(rawEnvValue);
  if (!parsed) return null;
  return `${GANADERIA_DISPLAY_NAME} <${parsed.email}>`;
}

// --- Origen público para construir el enlace absoluto ---
//
// AGX-SUPERADMIN-AUTH-006: la versión anterior derivaba el origin de
// APP_ENV vía CORS_MANDATORY_ORIGINS_BY_ENV. Eso rompió en producción real:
// el servicio Railway "production" corre con APP_ENV=staging (anomalía ya
// documentada en otras fases), así que el enlace de recuperación apuntaba
// a https://staging.agrogenomax.com -- un dominio que no existe (DNS
// NXDOMAIN). Regla aprobada: PUBLIC_APP_ORIGIN es ahora la ÚNICA autoridad
// para el origin público en staging/production (validado en
// server/config/env.js -- https, nunca localhost/127.0.0.1, obligatoria en
// ambos ambientes). NUNCA se deriva de APP_ENV en esos dos ambientes. El
// fallback a CORS_MANDATORY_ORIGINS_BY_ENV se conserva SOLO para
// development/test, donde no hay Resend real ni PUBLIC_APP_ORIGIN
// configurada.
export function resolveGanaderiaPublicOrigin(appEnv) {
  const explicitOrigin = process.env.PUBLIC_APP_ORIGIN;
  if (isNonEmpty(explicitOrigin)) {
    return resolvePublicOriginForEnvironment(explicitOrigin, appEnv);
  }

  if (appEnv === 'development' || appEnv === 'test') {
    const origins = CORS_MANDATORY_ORIGINS_BY_ENV[appEnv];
    return origins && origins.length > 0 ? origins[0] : null;
  }

  return null;
}

export function buildRestablecerContrasenaUrl(rawToken, appEnv) {
  const origin = resolveGanaderiaPublicOrigin(appEnv);
  if (!origin) return null;
  return `${origin}/ganaderia/restablecer-contrasena?token=${encodeURIComponent(rawToken)}`;
}

// --- Plantilla del correo de recuperación ---

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRecoveryEmailContent({ recoveryUrl }) {
  const safeUrl = escapeHtml(recoveryUrl);
  const subject = 'Recupera tu acceso a AgroGenomaX Ganadería Inteligente';

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p><strong>AgroGenomaX</strong> — Ganadería Inteligente</p>
    <p>Recibimos una solicitud para recuperar el acceso a tu cuenta.</p>
    <p>
      <a href="${safeUrl}" style="display: inline-block; background: #39ff14; color: #04140b; font-weight: bold; padding: 12px 20px; border-radius: 999px; text-decoration: none;">
        Establecer nueva contraseña
      </a>
    </p>
    <p>Este enlace vence en 60 minutos.</p>
    <p>Si no solicitaste este cambio, puedes ignorar este mensaje -- tu contraseña actual seguirá funcionando.</p>
  </body>
</html>`;

  const text = [
    'AgroGenomaX — Ganadería Inteligente',
    '',
    'Recibimos una solicitud para recuperar el acceso a tu cuenta.',
    '',
    `Establecer nueva contraseña: ${recoveryUrl}`,
    '',
    'Este enlace vence en 60 minutos.',
    '',
    'Si no solicitaste este cambio, puedes ignorar este mensaje -- tu contraseña actual seguirá funcionando.',
  ].join('\n');

  return { subject, html, text };
}

// SPRINT-2-CLIENT-PROVISIONING: correo de activación de una cuenta
// provisionada por el superadmin -- mismo enlace/endpoint que recuperación
// (POST /password/set, proposito='establecer_inicial'), copia distinta
// (bienvenida, nunca "recuperar"). Nunca incluye contraseña, token plano
// fuera de la URL, IDs internos ni información técnica (§6).
function buildActivationEmailContent({ activationUrl, nombre }) {
  const safeUrl = escapeHtml(activationUrl);
  const safeNombre = escapeHtml(nombre);
  const subject = 'Activa tu cuenta de AgroGenomaX';

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p><strong>AgroGenomaX</strong> — Ganadería Inteligente</p>
    <p>Hola ${safeNombre},</p>
    <p>Se creó una cuenta para ti en AgroGenomaX. Para activarla, define tu propia contraseña.</p>
    <p>
      <a href="${safeUrl}" style="display: inline-block; background: #39ff14; color: #04140b; font-weight: bold; padding: 12px 20px; border-radius: 999px; text-decoration: none;">
        Activar mi cuenta
      </a>
    </p>
    <p>Este enlace vence en 60 minutos.</p>
  </body>
</html>`;

  const text = [
    'AgroGenomaX — Ganadería Inteligente',
    '',
    `Hola ${nombre},`,
    '',
    'Se creó una cuenta para ti en AgroGenomaX. Para activarla, define tu propia contraseña.',
    '',
    `Activar mi cuenta: ${activationUrl}`,
    '',
    'Este enlace vence en 60 minutos.',
  ].join('\n');

  return { subject, html, text };
}

// --- Transporte (duplicado deliberadamente de la lógica de timeout/retry
// de CatastroX -- mismo comportamiento, sin importar su código) ---

function resolveTimeoutMs() {
  const raw = process.env.EMAIL_SEND_TIMEOUT_MS;
  if (!isNonEmpty(raw)) return DEFAULT_TIMEOUT_MS;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyFetchError(error) {
  if (error?.name === 'AbortError') return 'EMAIL_TIMEOUT';
  return 'EMAIL_TRANSPORT_ERROR';
}

async function performResendRequest({ url, options, timeoutMs }) {
  try {
    const response = await fetchWithTimeout(url, options, timeoutMs);
    return { response };
  } catch (error) {
    return { errorCode: classifyFetchError(error) };
  }
}

function isRetryableOutcome(outcome) {
  if (outcome.errorCode) return true;
  const status = outcome.response?.status;
  return status === 429 || (status >= 500 && status <= 599);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendViaResend({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!isNonEmpty(apiKey) || EMAIL_PLACEHOLDER_PATTERN.test(apiKey)) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_API_KEY_MISSING' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_API_KEY_MISSING' };
  }

  const appEnvForFrom = String(process.env.APP_ENV || '').trim().toLowerCase();
  const fromHeader = process.env.EMAIL_FROM || '';
  if (!isEmailFromValidForEnvironment(fromHeader, appEnvForFrom)) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_FROM_INVALID' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_FROM_INVALID' };
  }

  // Misma dirección/dominio ya verificado en EMAIL_FROM -- solo el nombre
  // visible cambia, exclusivamente para el correo que este sender emite.
  const ganaderiaFromHeader = buildGanaderiaFromHeader(fromHeader);
  if (!ganaderiaFromHeader) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_FROM_INVALID' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_FROM_INVALID' };
  }

  const timeoutMs = resolveTimeoutMs();

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ from: ganaderiaFromHeader, to: [to], subject, html, text });
  const requestArgs = { url: RESEND_API_URL, options: { method: 'POST', headers, body }, timeoutMs };

  logEmailEvent('intento de envío', { provider: 'resend' });

  let outcome = await performResendRequest(requestArgs);
  if (isRetryableOutcome(outcome)) {
    await delay(RETRY_DELAY_MS);
    outcome = await performResendRequest(requestArgs);
  }

  if (outcome.errorCode) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: outcome.errorCode });
    return { delivered: false, provider: 'resend', errorCode: outcome.errorCode };
  }

  const { response } = outcome;

  if (response.status === 429) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_RATE_LIMITED' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_RATE_LIMITED' };
  }
  if (response.status >= 500) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' };
  }
  if (!response.ok) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_PROVIDER_REJECTED' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_PROVIDER_REJECTED' };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' };
  }

  const providerMessageId = typeof payload?.id === 'string' && payload.id ? payload.id : null;
  if (!providerMessageId) {
    logEmailFailure('envío fallido', { provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' });
    return { delivered: false, provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' };
  }

  logEmailEvent('envío confirmado', { provider: 'resend' });
  return { delivered: true, provider: 'resend', errorCode: null };
}

const REAL_PROVIDER_ENABLED_ENVIRONMENTS = new Set(['staging']);

/**
 * Punto único de despacho (gate de ambiente + proveedor) compartido por
 * sendRecoveryEmail y sendActivationEmail (SPRINT-2-CLIENT-PROVISIONING)
 * -- mismo comportamiento fail-closed para ambos: development/test NUNCA
 * llaman a un proveedor real, production sigue sin habilitarlo, solo
 * staging despacha de verdad. Nunca lanza.
 */
async function dispatchGanaderiaEmail({ to, subject, html, text }) {
  const appEnv = String(process.env.APP_ENV || '').trim().toLowerCase();

  if (appEnv === 'development' || appEnv === 'test') {
    logEmailEvent('intento de envío (stub)', { provider: 'stub' });
    return { delivered: false, provider: 'stub', errorCode: null };
  }

  if (!REAL_PROVIDER_ENABLED_ENVIRONMENTS.has(appEnv)) {
    logEmailEvent('intento de envío (proveedor no habilitado en este ambiente)', { provider: 'stub' });
    return { delivered: false, provider: 'stub', errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED' };
  }

  const configuredProvider = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (!configuredProvider) {
    return { delivered: false, provider: 'stub', errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED' };
  }
  if (configuredProvider !== 'resend') {
    return { delivered: false, provider: 'stub', errorCode: 'EMAIL_PROVIDER_UNSUPPORTED' };
  }

  return sendViaResend({ to, subject, html, text });
}

/**
 * Único punto de integración con un proveedor de correo transaccional
 * real para Ganadería. `server/routes/ganaderiaAuth.js` es el único
 * llamador. Nunca lanza -- el fallo se comunica solo vía `delivered`/
 * `errorCode`, nunca al solicitante del recovery (§4/§9).
 *
 * @param {{ to: string, recoveryUrl: string }} input
 * @returns {Promise<{ delivered: boolean, provider: string, errorCode: string|null }>}
 */
export async function sendRecoveryEmail({ to, recoveryUrl }) {
  const { subject, html, text } = buildRecoveryEmailContent({ recoveryUrl });
  return dispatchGanaderiaEmail({ to, subject, html, text });
}

/**
 * SPRINT-2-CLIENT-PROVISIONING §6: correo de activación de una cuenta
 * provisionada por el superadmin. Único llamador: server/routes/
 * ganaderiaAdmin.js (POST /clientes), SIEMPRE después del COMMIT de la
 * transacción -- nunca dentro de ella (mismo criterio que sendRecoveryEmail
 * en POST /recovery/request). Nunca lanza.
 *
 * @param {{ to: string, activationUrl: string, nombre: string }} input
 * @returns {Promise<{ delivered: boolean, provider: string, errorCode: string|null }>}
 */
export async function sendActivationEmail({ to, activationUrl, nombre }) {
  const { subject, html, text } = buildActivationEmailContent({ activationUrl, nombre });
  return dispatchGanaderiaEmail({ to, subject, html, text });
}
