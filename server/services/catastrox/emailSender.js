// EMAIL_PROVIDER_002: implementación real del envío de OTP vía Resend,
// diseñada en docs/catastrox/EMAIL_PROVIDER_001.md. Único punto de
// integración con un proveedor de correo transaccional en todo el backend
// (server/routes/catastroxPayments.js es el único llamador).
//
// Garantías de seguridad que este archivo aplica de forma incondicional,
// sin depender de que server/config/env.js ya haya corrido:
// - development/test JAMÁS llaman a un proveedor real, sin importar qué
//   tenga configurado EMAIL_PROVIDER -- gate por APP_ENV, no solo por la
//   variable de proveedor (defensa en profundidad, mismo espíritu que el
//   doble gate de devOtpCode: backend isDevOrTest + frontend
//   !import.meta.env.PROD).
// - production NO habilita Resend automáticamente en este lote -- exige una
//   decisión/configuración separada todavía no implementada (pedido
//   explícito de EMAIL_PROVIDER_002). Se responde de forma honesta con
//   EMAIL_PROVIDER_NOT_CONFIGURED, nunca fingiendo un stub silencioso.
// - Nunca se registra el correo completo, el código OTP, la API key ni el
//   cuerpo completo de una respuesta del proveedor -- solo el dominio del
//   destinatario, el proveedor y un errorCode del set cerrado de abajo.
// - Fail-closed: `delivered` nace `false` y solo pasa a `true` si Resend
//   confirmó la aceptación (2xx + `id` presente en el cuerpo).

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 200;

// Mismo patrón que WOMPI_PLACEHOLDER_PATTERN (server/routes/catastroxPayments.js,
// server/config/env.js) -- detecta valores de marcador de posición
// evidentes copiados sin reemplazar desde .env.example.
const EMAIL_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;

const EMAIL_ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const RESERVED_NON_PUBLIC_TLDS = Object.freeze(['.local', '.internal', '.test', '.example', '.invalid', '.localdomain']);

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function toEmailDomain(value) {
  const raw = String(value || '');
  const atIndex = raw.lastIndexOf('@');
  return atIndex > 0 ? raw.slice(atIndex + 1) : null;
}

function logEmailEvent(type, { to, provider, errorCode } = {}) {
  console.info(`[CatastroX Email] ${type}`, {
    toDomain: toEmailDomain(to),
    provider,
    ...(errorCode ? { errorCode } : {}),
  });
}

function logEmailFailure(type, { to, provider, errorCode }) {
  console.error(`[CatastroX Email] ${type}`, {
    toDomain: toEmailDomain(to),
    provider,
    errorCode,
  });
}

// --- EMAIL_FROM: parseo/validación compartidos con server/config/env.js ---
// (importado desde allá para validar en boot-time; reutilizado aquí para la
// misma comprobación en tiempo de request, sin depender de que getConfig()
// ya haya corrido).

/**
 * Parsea un valor de remitente en cualquiera de los dos formatos aceptados:
 * `Nombre <correo@dominio>` o `correo@dominio`. Devuelve `null` si el valor
 * no es sintácticamente un correo válido -- nunca lanza.
 *
 * @param {string} rawValue
 * @returns {{ raw: string, displayName: string|null, email: string, domain: string } | null}
 */
export function parseEmailFromHeader(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return null;

  const angleMatch = value.match(/^(.*)<([^<>]+)>$/);
  let displayName = null;
  let email;

  if (angleMatch) {
    const namePart = angleMatch[1].trim();
    displayName = namePart || null;
    email = angleMatch[2].trim();
  } else {
    email = value;
  }

  if (!EMAIL_ADDRESS_PATTERN.test(email)) return null;

  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return { raw: value, displayName, email, domain };
}

function isPublicEmailDomain(domain) {
  if (!domain) return false;
  if (domain.startsWith('[')) return false; // sintaxis de IP literal -- nunca "público" para este propósito
  if (domain === 'localhost' || domain.endsWith('.localhost')) return false;
  if (domain === '0.0.0.0') return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) return false;
  if (RESERVED_NON_PUBLIC_TLDS.some((tld) => domain.endsWith(tld))) return false;
  if (!domain.includes('.')) return false; // hostname de una sola etiqueta -- nunca un dominio público real
  return true;
}

/**
 * @param {string} rawValue
 * @param {string} appEnv
 * @returns {boolean}
 */
export function isEmailFromValidForEnvironment(rawValue, appEnv) {
  const parsed = parseEmailFromHeader(rawValue);
  if (!parsed) return false;
  if (appEnv === 'staging' || appEnv === 'production') {
    return isPublicEmailDomain(parsed.domain);
  }
  return true;
}

// --- Plantilla del correo OTP ---

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatExpiryForDisplay(expiresAt) {
  try {
    const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Bogota',
    });
  } catch {
    return null;
  }
}

/**
 * Arma el contenido del correo internamente -- el llamador nunca decide el
 * asunto/cuerpo como texto libre. Sin enlaces, sin PII adicional (predio,
 * documento, teléfono, dirección) -- únicamente código, expiración y,
 * opcionalmente, el nombre del comprador (siempre escapado en HTML).
 */
function buildOtpEmailContent({ verificationCode, expiresAt, customerName }) {
  const safeCode = String(verificationCode || '').trim();
  const safeCodeHtml = escapeHtml(safeCode);
  const safeName = isNonEmpty(customerName) ? escapeHtml(String(customerName).trim()) : null;
  const expiryText = formatExpiryForDisplay(expiresAt) || 'en los próximos 10 minutos';
  const expiryTextHtml = escapeHtml(expiryText);

  const greeting = safeName ? `Hola ${safeName},` : 'Hola,';
  const subject = 'Tu código de verificación de CatastroX';

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p><strong>CatastroX</strong> — AgroGenomaX</p>
    <p>${greeting}</p>
    <p>Tu código de verificación es:</p>
    <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${safeCodeHtml}</p>
    <p>Este código vence ${expiryTextHtml}.</p>
    <p>Si no solicitaste este código, puedes ignorar este mensaje.</p>
  </body>
</html>`;

  const text = [
    'CatastroX — AgroGenomaX',
    '',
    greeting,
    '',
    `Tu código de verificación es: ${safeCode}`,
    `Este código vence ${expiryText}.`,
    '',
    'Si no solicitaste este código, puedes ignorar este mensaje.',
  ].join('\n');

  return { subject, html, text };
}

// --- CATX-DELIVERY-001: plantilla del correo de entrega del PDF comprado ---
// Función paralela a buildOtpEmailContent -- misma disciplina (el llamador
// nunca decide asunto/cuerpo como texto libre, todo escapado en HTML).

function buildDeliverableEmailContent({ customerName, orderReference, packageLabel, predioLabel }) {
  const safeName = isNonEmpty(customerName) ? escapeHtml(String(customerName).trim()) : null;
  const safeReference = escapeHtml(String(orderReference || '').trim());
  const safePackage = escapeHtml(String(packageLabel || '').trim());
  const safePredio = escapeHtml(String(predioLabel || '').trim());
  const greeting = safeName ? `Hola ${safeName},` : 'Hola,';
  const subject = `Tu diagnóstico predial CatastroX está listo — Orden ${orderReference || ''}`.trim();

  const legalNotice =
    'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. ' +
    'No reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.';
  const supportMessage =
    '¿Necesitas ayuda? Conserva el número de tu orden y contacta a soporte de CatastroX.';

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p><strong>CatastroX</strong> — AgroGenomaX</p>
    <p>${greeting}</p>
    <p>Tu documento predial ya está listo. Lo adjuntamos a este correo en formato PDF.</p>
    <ul>
      <li><strong>Orden:</strong> ${safeReference}</li>
      <li><strong>Paquete:</strong> ${safePackage}</li>
      <li><strong>Predio:</strong> ${safePredio}</li>
    </ul>
    <p>${escapeHtml(supportMessage)}</p>
    <p style="font-size: 11px; color: #666;">${escapeHtml(legalNotice)}</p>
  </body>
</html>`;

  const text = [
    'CatastroX — AgroGenomaX',
    '',
    greeting,
    '',
    'Tu documento predial ya está listo. Lo adjuntamos a este correo en formato PDF.',
    '',
    `Orden: ${orderReference || ''}`,
    `Paquete: ${packageLabel || ''}`,
    `Predio: ${predioLabel || ''}`,
    '',
    supportMessage,
    '',
    legalNotice,
  ].join('\n');

  return { subject, html, text };
}

// --- Idempotencia ---

/**
 * Los headers HTTP no toleran CR/LF/caracteres de control -- nunca se envía
 * un valor crudo sin sanear, aunque hoy siempre se genera internamente a
 * partir de un UUID (server/routes/catastroxPayments.js, a partir del id de
 * la fila de catastrox_email_verifications recién creada).
 */
function sanitizeIdempotencyKey(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return null;
  const sanitized = value.replace(/[^\x20-\x7E]/g, '').slice(0, 255);
  return sanitized || null;
}

// --- Timeout/transporte ---

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
  if (outcome.errorCode) return true; // timeout o error de transporte
  const status = outcome.response?.status;
  return status === 429 || (status >= 500 && status <= 599);
}

// Estatus que el proveedor puede devolver y que se consideran un rechazo
// definitivo, no reintentable (400/401/403/422 -- validación/autenticación
// ya resuelta por el proveedor, reintentar no cambiaría el resultado).
const NON_RETRYABLE_REJECTION_STATUSES = new Set([400, 401, 403, 422]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Envío real vía Resend ---

async function sendViaResend({ to, verificationCode, expiresAt, customerName, idempotencyKey }) {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!isNonEmpty(apiKey) || EMAIL_PLACEHOLDER_PATTERN.test(apiKey)) {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: 'EMAIL_API_KEY_MISSING' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_API_KEY_MISSING' };
  }

  const appEnvForFrom = String(process.env.APP_ENV || '').trim().toLowerCase();
  const fromHeader = process.env.EMAIL_FROM || '';
  if (!isEmailFromValidForEnvironment(fromHeader, appEnvForFrom)) {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: 'EMAIL_FROM_INVALID' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_FROM_INVALID' };
  }

  const timeoutMs = resolveTimeoutMs();
  const sanitizedIdempotencyKey = sanitizeIdempotencyKey(idempotencyKey);
  const { subject, html, text } = buildOtpEmailContent({ verificationCode, expiresAt, customerName });

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(sanitizedIdempotencyKey ? { 'Idempotency-Key': sanitizedIdempotencyKey } : {}),
  };

  // Nunca información predial, documento, teléfono ni dirección -- solo lo
  // estrictamente necesario para entregar el OTP.
  const body = JSON.stringify({
    from: fromHeader,
    to: [to],
    subject,
    html,
    text,
  });

  const requestArgs = { url: RESEND_API_URL, options: { method: 'POST', headers, body }, timeoutMs };

  logEmailEvent('intento de envío', { to, provider: 'resend' });

  let outcome = await performResendRequest(requestArgs);

  if (isRetryableOutcome(outcome)) {
    await delay(RETRY_DELAY_MS);
    outcome = await performResendRequest(requestArgs);
  }

  if (outcome.errorCode) {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: outcome.errorCode });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: outcome.errorCode };
  }

  const { response } = outcome;

  if (response.status === 429) {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: 'EMAIL_RATE_LIMITED' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RATE_LIMITED' };
  }

  if (response.status >= 500) {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' };
  }

  if (!response.ok) {
    // Incluye 400/401/403/422 y cualquier otro no-2xx no cubierto arriba --
    // rechazo definitivo del proveedor, nunca se reenvía el cuerpo de la
    // respuesta (podría contener el correo del destinatario, por ejemplo en
    // un mensaje de "recipient inválido").
    const errorCode = 'EMAIL_PROVIDER_REJECTED';
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RESPONSE_INVALID' };
  }

  const providerMessageId = typeof payload?.id === 'string' && payload.id ? payload.id : null;
  if (!providerMessageId) {
    logEmailFailure('envío fallido', { to, provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RESPONSE_INVALID' };
  }

  logEmailEvent('envío confirmado', { to, provider: 'resend' });
  return { delivered: true, provider: 'resend', providerMessageId, errorCode: null };
}

// --- CATX-DELIVERY-001: envío real del PDF comprado vía Resend ---
// Reutiliza exactamente la misma infraestructura de transporte que
// sendViaResend (fetchWithTimeout/performResendRequest/isRetryableOutcome/
// resolveTimeoutMs/sanitizeIdempotencyKey/validación de API key y de
// EMAIL_FROM) -- función paralela, no una rama condicional dentro de
// sendViaResend, para no arriesgar ningún comportamiento ya cubierto por
// las pruebas existentes del envío de OTP.
async function sendDeliverableViaResend({
  to,
  customerName,
  orderReference,
  packageLabel,
  predioLabel,
  pdfBuffer,
  pdfFilename,
  idempotencyKey,
}) {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!isNonEmpty(apiKey) || EMAIL_PLACEHOLDER_PATTERN.test(apiKey)) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_API_KEY_MISSING' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_API_KEY_MISSING' };
  }

  const appEnvForFrom = String(process.env.APP_ENV || '').trim().toLowerCase();
  const fromHeader = process.env.EMAIL_FROM || '';
  if (!isEmailFromValidForEnvironment(fromHeader, appEnvForFrom)) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_FROM_INVALID' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_FROM_INVALID' };
  }

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_ATTACHMENT_MISSING' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_ATTACHMENT_MISSING' };
  }

  const timeoutMs = resolveTimeoutMs();
  const sanitizedIdempotencyKey = sanitizeIdempotencyKey(idempotencyKey);
  const { subject, html, text } = buildDeliverableEmailContent({ customerName, orderReference, packageLabel, predioLabel });

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(sanitizedIdempotencyKey ? { 'Idempotency-Key': sanitizedIdempotencyKey } : {}),
  };

  // Adjunto en base64 -- campo soportado por la API de Resend
  // (attachments: [{ filename, content }]), no usado hasta ahora por el
  // envío de OTP (nunca lleva adjunto).
  const body = JSON.stringify({
    from: fromHeader,
    to: [to],
    subject,
    html,
    text,
    attachments: [{ filename: String(pdfFilename || 'documento.pdf'), content: pdfBuffer.toString('base64') }],
  });

  const requestArgs = { url: RESEND_API_URL, options: { method: 'POST', headers, body }, timeoutMs };

  logEmailEvent('intento de envío de entregable', { to, provider: 'resend' });

  let outcome = await performResendRequest(requestArgs);

  if (isRetryableOutcome(outcome)) {
    await delay(RETRY_DELAY_MS);
    outcome = await performResendRequest(requestArgs);
  }

  if (outcome.errorCode) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: outcome.errorCode });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: outcome.errorCode };
  }

  const { response } = outcome;

  if (response.status === 429) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_RATE_LIMITED' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RATE_LIMITED' };
  }
  if (response.status >= 500) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' };
  }
  if (!response.ok) {
    const errorCode = 'EMAIL_PROVIDER_REJECTED';
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RESPONSE_INVALID' };
  }

  const providerMessageId = typeof payload?.id === 'string' && payload.id ? payload.id : null;
  if (!providerMessageId) {
    logEmailFailure('envío de entregable fallido', { to, provider: 'resend', errorCode: 'EMAIL_RESPONSE_INVALID' });
    return { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RESPONSE_INVALID' };
  }

  logEmailEvent('envío de entregable confirmado', { to, provider: 'resend' });
  return { delivered: true, provider: 'resend', providerMessageId, errorCode: null };
}

// --- Punto de entrada único ---

const REAL_PROVIDER_ENABLED_ENVIRONMENTS = new Set(['staging']);

/**
 * Único punto de integración con un proveedor de correo transaccional real.
 * `server/routes/catastroxPayments.js` es el único llamador.
 *
 * @param {{
 *   to: string,
 *   verificationCode: string,
 *   expiresAt: Date,
 *   customerName: string | null,
 *   idempotencyKey: string | null,
 * }} input
 * @returns {Promise<{
 *   delivered: boolean,
 *   provider: 'resend' | 'stub',
 *   providerMessageId: string | null,
 *   errorCode: string | null,
 * }>}
 */
export async function sendVerificationEmail({ to, verificationCode, expiresAt, customerName, idempotencyKey }) {
  const appEnv = String(process.env.APP_ENV || '').trim().toLowerCase();

  // Regla obligatoria: development/test JAMÁS llaman a un proveedor real,
  // sin importar qué tenga configurado EMAIL_PROVIDER.
  if (appEnv === 'development' || appEnv === 'test') {
    logEmailEvent('intento de envío (stub)', { to, provider: 'stub' });
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: null };
  }

  const configuredProvider = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();

  // production: Resend no se habilita automáticamente en este lote -- exige
  // una decisión/configuración separada todavía no implementada. No se
  // asume ningún proveedor productivo por defecto (pedido explícito).
  if (appEnv !== 'staging') {
    logEmailEvent('intento de envío (proveedor no habilitado en este ambiente)', {
      to,
      provider: configuredProvider === 'resend' ? 'resend' : 'stub',
    });
    return {
      delivered: false,
      provider: configuredProvider === 'resend' ? 'resend' : 'stub',
      providerMessageId: null,
      errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED',
    };
  }

  if (!configuredProvider) {
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED' };
  }

  if (configuredProvider !== 'resend') {
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_UNSUPPORTED' };
  }

  return sendViaResend({ to, verificationCode, expiresAt, customerName, idempotencyKey });
}

/**
 * CATX-DELIVERY-001: envía el PDF comprado (adjunto) al correo verificado
 * del comprador. Mismo gate de ambiente que sendVerificationEmail
 * (REAL_PROVIDER_ENABLED_ENVIRONMENTS) -- deliberadamente NO se habilita
 * producción por separado en este sprint (decisión explícita pendiente,
 * documentada como riesgo residual). A diferencia de sendVerificationEmail,
 * el código de error cuando el ambiente no tiene el proveedor habilitado es
 * `EMAIL_PROVIDER_DISABLED` (no `EMAIL_PROVIDER_NOT_CONFIGURED`) -- señal
 * específica que deliveryJobService.js usa para NUNCA marcar la orden como
 * "enviada" cuando en realidad no se intentó ningún envío real (ajuste
 * obligatorio del plan aprobado: nunca declarar SENT sin una confirmación
 * real del proveedor).
 *
 * @param {{
 *   to: string,
 *   customerName: string | null,
 *   orderReference: string,
 *   packageLabel: string,
 *   predioLabel: string,
 *   pdfBuffer: Buffer,
 *   pdfFilename: string,
 *   idempotencyKey: string | null,
 * }} input
 * @returns {Promise<{ delivered: boolean, provider: string, providerMessageId: string|null, errorCode: string|null }>}
 */
export async function sendDeliverableEmail({
  to,
  customerName,
  orderReference,
  packageLabel,
  predioLabel,
  pdfBuffer,
  pdfFilename,
  idempotencyKey,
}) {
  const appEnv = String(process.env.APP_ENV || '').trim().toLowerCase();

  if (appEnv === 'development' || appEnv === 'test') {
    logEmailEvent('intento de envío de entregable (stub)', { to, provider: 'stub' });
    // A diferencia de sendVerificationEmail (donde development/test tiene
    // un bypass real -- devOtpCode -- que hace innecesario un errorCode),
    // aquí no existe ningún bypass equivalente: el PDF nunca se envía de
    // verdad en este ambiente. errorCode explícito para que
    // deliveryJobService.js deje el job en FAILED con una causa clara, en
    // vez de un código genérico.
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_DISABLED' };
  }

  if (!REAL_PROVIDER_ENABLED_ENVIRONMENTS.has(appEnv)) {
    logEmailEvent('intento de envío de entregable (proveedor no habilitado en este ambiente)', { to, provider: 'stub' });
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_DISABLED' };
  }

  const configuredProvider = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (!configuredProvider) {
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_DISABLED' };
  }
  if (configuredProvider !== 'resend') {
    return { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_UNSUPPORTED' };
  }

  return sendDeliverableViaResend({
    to,
    customerName,
    orderReference,
    packageLabel,
    predioLabel,
    pdfBuffer,
    pdfFilename,
    idempotencyKey,
  });
}
