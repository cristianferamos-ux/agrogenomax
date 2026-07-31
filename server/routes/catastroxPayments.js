import crypto from 'crypto';
import { Router } from 'express';
import { resolveCanonicalPredioId, validateCadastralCodeInput } from './catastrox.js';
import { resolveCorsAllowedOrigins } from '../config/env.js';
import { isOriginAllowed } from '../security/corsPolicy.js';
import {
  buildRecoveryClearCookieHeader,
  buildRecoverySetCookieHeader,
  getRecoverySessionTokenFromCookieHeader,
} from '../security/recoveryCookie.js';
import {
  checkoutLimiter,
  customerLimiter,
  emailVerificationLimiter,
  entitlementLimiter,
  myOrdersLimiter,
  orderStatusLimiter,
  verifyLimiter,
  webhookLimiter,
} from '../middleware/rateLimit.js';
import * as paymentOrders from '../services/catastrox/paymentOrderRepository.js';
import { OrderConflictError } from '../services/catastrox/paymentOrderRepository.js';
import * as recoverySessions from '../services/catastrox/recoverySessionRepository.js';
import * as customers from '../services/catastrox/customerRepository.js';
import { validateCustomerInput } from '../services/catastrox/customerValidation.js';
import { sendVerificationEmail } from '../services/catastrox/emailSender.js';
import { createDeliveryJobForOrder, processDeliveryJob } from '../services/catastrox/deliveryJobService.js';
import { createInvoiceJobForOrder } from '../services/catastrox/invoiceJobService.js';
import {
  CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS,
  decideVerificationOutcome,
  normalizePackageId,
  packageSatisfies,
} from '../services/catastrox/paymentOrderTransitions.js';
import {
  isAllowedWompiEventType,
  verifyWompiEventSignature,
} from '../services/catastrox/wompiEventVerification.js';

const router = Router();
const CHECKOUT_CURRENCY = 'COP';
const PACKAGE_CODES = {
  basico: 'BASICO',
  plus: 'PLUS',
  profesional: 'PROFESIONAL',
};

const WOMPI_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;
const WOMPI_API_DEFAULT_URL = 'https://sandbox.wompi.co/v1';

function sanitizeReferenceSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

function buildDateToken(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function buildReference({ purchaseKey, packageId }) {
  const packageCode = PACKAGE_CODES[packageId] || 'PAGO';
  const dateToken = buildDateToken();
  const uniqueToken = crypto.randomBytes(5).toString('hex').toUpperCase();
  const keyToken = sanitizeReferenceSegment(purchaseKey);

  return keyToken
    ? `CATX-${packageCode}-${dateToken}-${uniqueToken}-${keyToken}`.slice(0, 96)
    : `CATX-${packageCode}-${dateToken}-${uniqueToken}`;
}

function buildIntegritySignature({ reference, amountInCents, integritySecret }) {
  const signaturePayload = `${reference}${amountInCents}${CHECKOUT_CURRENCY}${integritySecret}`;
  return crypto.createHash('sha256').update(signaturePayload, 'utf8').digest('hex');
}

// El retorno no lleva datos comerciales en la URL (packageId/purchaseKey/reference/
// predioId/codigoPredial): CatastroXWompiReturnPage recupera ese contexto desde el
// registro pendiente guardado en localStorage antes de abrir Wompi (ver
// catastroxPaymentService.js). Wompi solo agrega su propio "?id=TRANSACTION_ID".
export function buildRedirectUrl({ frontendUrl }) {
  return new URL('/catastrox/pagos/wompi/retorno', frontendUrl).toString();
}

export function isLocalFrontendUrl(value) {
  const url = String(value || '').toLowerCase();
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// EMAIL_PROVIDER_002: nombre a mostrar en el correo de verificación --
// prioriza la razón social (persona jurídica) sobre nombre/apellido, y
// devuelve null si no hay ninguno (la plantilla usa un saludo genérico).
export function buildCustomerDisplayNameForEmail(decryptedCustomer) {
  if (!decryptedCustomer) return null;
  if (decryptedCustomer.legalName) return decryptedCustomer.legalName;
  const parts = [decryptedCustomer.firstName, decryptedCustomer.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// EMAIL_PROVIDER_002: el Idempotency-Key enviado a Resend debe ser estable
// dentro de un mismo intento de verificación (incluyendo el único
// reintento interno de sendVerificationEmail ante un fallo transitorio) --
// nunca aleatorio en cada llamada, o el reintento por transporte/429/5xx se
// vería, para Resend, como dos envíos distintos. Se deriva del id de la
// fila de catastrox_email_verifications recién creada -- único por
// emisión, estable durante todo el ciclo de vida de esta request.
export function buildEmailIdempotencyKey(verificationId) {
  return `catastrox-otp-${verificationId}`;
}

// El retorno local (redirectUrl apuntando a localhost/127.0.0.1) solo se permite
// cuando el backend corre en development y Wompi en modo test (Sandbox). Fuera de
// esa combinación exacta (staging, production, o WOMPI_ENV=production) nunca se
// envía una redirectUrl local, sin importar CATASTROX_FRONTEND_URL.
export function shouldSendWompiRedirectUrl({ appEnv, wompiEnv, frontendUrl }) {
  if (!frontendUrl) return false;
  if (frontendUrl.startsWith('https://')) return true;

  const normalizedAppEnv = String(appEnv || '').toLowerCase();
  const normalizedWompiEnv = String(wompiEnv || '').toLowerCase();
  const isLocalDevTest = normalizedAppEnv === 'development' && normalizedWompiEnv === 'test';

  return isLocalDevTest && isLocalFrontendUrl(frontendUrl);
}

// LOTE 019-C2: fallo de transporte confirmado en produccion real (Node fetch
// rechazando con "fetch failed" contra sandbox.wompi.co, resuelto en el intento
// inmediatamente siguiente sin ningun otro cambio) -- nunca una respuesta HTTP de
// Wompi. `fetch()` solo rechaza (throw) por fallos de red/DNS/socket antes de
// obtener ninguna respuesta; cualquier respuesta HTTP real (400/401/403/404/409/
// 422/429/500...) resuelve la promesa con normalidad y jamas entra aqui -- por
// eso basta con envolver unicamente esta llamada, sin tocar el manejo de
// response.ok/payload de mas abajo.
export function isWompiTransportError(error) {
  if (error instanceof TypeError) return true;
  return /fetch failed/i.test(String(error?.message || ''));
}

const WOMPI_VERIFY_RETRY_DELAY_MS = 200;

async function fetchWithSingleTransportRetry(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (!isWompiTransportError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, WOMPI_VERIFY_RETRY_DELAY_MS));
    return fetch(url, options);
  }
}

export async function fetchWompiTransaction({ transactionId, apiBaseUrl, publicKey }) {
  const response = await fetchWithSingleTransportRetry(
    `${apiBaseUrl.replace(/\/$/, '')}/transactions/${encodeURIComponent(transactionId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${publicKey}`,
        Accept: 'application/json',
      },
    },
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.data) {
    const errorMessage =
      payload?.error?.reason ||
      payload?.error?.messages?.[0] ||
      payload?.message ||
      'Wompi no devolvio una transaccion valida.';
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }

  return payload.data;
}

function mapWompiTransactionForApp(transaction) {
  return {
    id: transaction.id,
    status: transaction.status,
    reference: transaction.reference,
    amountInCents: Number(transaction.amount_in_cents || 0),
    currency: transaction.currency,
    paymentMethodType: transaction.payment_method_type || null,
    customerEmail: transaction.customer_email || null,
  };
}

// HMAC de auditoría (IP/user-agent) -- NUNCA la propiedad del pago (el pedido
// original es explícito: la IP puede compartirse/rotar/estar detrás de NAT o
// VPN, nunca es la llave primaria del derecho). Requiere un secreto propio,
// distinto de cualquier secreto de Wompi, configurado por separado
// (CATASTROX_AUDIT_HASH_SECRET). Si no está configurado, se omite el hash
// (se guarda null) en vez de hashear sin secreto (un SHA256 sin secreto de
// un espacio de IPv4 es trivialmente reversible por diccionario -- no
// serviría como anonimización real). Riesgo residual documentado mientras
// no esté configurado.
function hashAuditValue(value) {
  const secret = process.env.CATASTROX_AUDIT_HASH_SECRET || '';
  if (!value || !secret) return null;
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/**
 * Defensa adicional contra CSRF, complementaria a SameSite=Lax (la barrera
 * real: un navegador nunca adjunta un cookie SameSite=Lax en un POST/fetch
 * cross-site) y a la allowlist de CORS ya montada globalmente
 * (server/index.js) -- que de por sí ya rechaza esta misma solicitud antes
 * de llegar aquí si Origin no está permitido. Esta función solo repite esa
 * verificación explícitamente en las rutas que emiten/consumen el cookie
 * de sesión, para que la intención quede documentada en el propio endpoint
 * y no dependa únicamente de middleware global. Ausencia de Origin
 * (server-to-server, mismo origen en navegadores antiguos) no se trata
 * como sospechosa -- igual criterio que evaluateCorsRequest().
 */
function isRequestOriginTrusted(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const allowedOrigins = resolveCorsAllowedOrigins(process.env.APP_ENV, process.env);
    return isOriginAllowed({ allowedOrigins }, origin);
  } catch (error) {
    // resolveCorsAllowedOrigins ya corrió con éxito al arrancar el proceso
    // (server/index.js, getConfig() -- fail-fast si la configuración fuera
    // inválida); si aun así lanza aquí, se falla cerrado (no autorizado)
    // en vez de dejar pasar la solicitud o tumbar el proceso.
    console.error('[CatastroX Payments] Error resolviendo allowlist de CORS para validar Origin', {
      message: error.message,
    });
    return false;
  }
}

function resolveCanonicalPredioIdFromRequestBody(body) {
  const explicit = String(body?.canonicalPredioId || '').trim();
  if (explicit) return explicit;

  // Compatibilidad: si el llamador todavía manda codigoPredial en vez de
  // canonicalPredioId (contrato previo), se deriva de la misma manera que
  // ya hace server/routes/catastrox.js para las tres vías de búsqueda --
  // nunca dos reglas de normalización distintas para la misma identidad.
  const normalizedCode = validateCadastralCodeInput(body?.codigoPredial);
  return resolveCanonicalPredioId({ codigoPredial: normalizedCode, source: 'code', terrenoId: null });
}

// Idempotencia de doble clic (Bloque 6, endurecida en la revisión de
// seguridad) -- NUNCA de predio+paquete solos (eso sería el "derecho
// global" que la fase anterior elimina). El diseño anterior derivaba la
// llave de una ventana temporal de 2 minutos (customerId+predio+paquete+
// bucket de tiempo): cerca del borde de la ventana, dos clics genuinamente
// simultáneos podían caer en buckets distintos (sin protección real), y
// una compra voluntaria SEGUNDA dentro de esos mismos 2 minutos quedaba
// fusionada con la primera (reutilizada) en vez de crear una orden nueva,
// aunque el usuario hubiera iniciado un intento explícitamente distinto.
//
// Ahora la llave depende de un `purchaseAttemptId` generado por el
// frontend (crypto.randomUUID(), una sola vez al entrar al resumen final
// de compra, mantenido solo en memoria) -- un reintento técnico (doble
// clic, timeout, reenvío) reutiliza el MISMO purchaseAttemptId y por tanto
// la MISMA orden; una compra voluntaria nueva siempre genera un
// purchaseAttemptId distinto y por tanto una orden distinta,
// independientemente de cuánto tiempo haya pasado. No es un secreto -- es
// una llave de deduplicación de intento, no de autorización (la
// autorización real sigue siendo customerId+email_verified_at+sesión), por
// eso un sha256 plano (sin HMAC) es suficiente aquí, igual que antes.
const PURCHASE_ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPurchaseAttemptId(value) {
  return typeof value === 'string' && PURCHASE_ATTEMPT_ID_PATTERN.test(value);
}

export function buildIdempotencyKey({ customerId, canonicalPredioId, packageId, purchaseAttemptId }) {
  return crypto
    .createHash('sha256')
    .update(`${customerId}|${canonicalPredioId}|${packageId}|${purchaseAttemptId}`)
    .digest('hex');
}

/**
 * Resuelve la sesión de recuperación de esta request DENTRO de la
 * transacción de checkout: reutiliza una sesión vigente si el cookie ya
 * trae una, o crea una nueva. Debe llamarse con el `client` de
 * withCheckoutLock -- la creación de la orden y su enlace a la sesión son
 * atómicos (nunca una orden sin enlazar por un fallo a mitad de camino).
 */
async function resolveSessionForCheckout(req, client) {
  const existingToken = getRecoverySessionTokenFromCookieHeader(req.headers.cookie);
  if (existingToken) {
    const tokenHash = recoverySessions.hashSessionToken(existingToken);
    const existingSession = await recoverySessions.findActiveSessionByTokenHash(tokenHash, client);
    if (existingSession) {
      await recoverySessions.touchRecoverySession(existingSession.id, client);
      return { session: existingSession, isNewSession: false, rawToken: null };
    }
  }

  const { session, token } = await recoverySessions.createRecoverySession(client);
  return { session, isNewSession: true, rawToken: token };
}

/**
 * Se ejecuta después de una transición REAL a APPROVED (nunca en un
 * replay/idempotente -- ver los dos únicos llamadores). Crea el trabajo de
 * entrega y el de facturación (Bloque 8/11) -- la generación/envío
 * reales quedan como interfaz stub documentada (ver deliveryJobService.js).
 * Errores aquí se registran pero NUNCA hacen fallar la respuesta al
 * cliente/webhook -- el pago ya está aprobado y persistido; un problema en
 * el disparo de entrega es recuperable por separado (el job queda en la
 * tabla, reintentable), no debe parecer que el pago falló.
 */
async function triggerPostApprovalWorkflows(order) {
  try {
    const customer = order.customer_id ? await customers.findCustomerById(order.customer_id) : null;
    const deliveryEmail = customer ? customers.decryptCustomerPii(customer)?.email || null : null;

    if (deliveryEmail) {
      const job = await createDeliveryJobForOrder({
        orderId: order.id,
        customerId: order.customer_id,
        deliveryEmail,
      });
      await processDeliveryJob(job.id);
    } else {
      console.error('[CatastroX Payments] Orden aprobada sin comprador/correo asociado -- no se crea delivery job', {
        orderId: order.id,
      });
    }

    await createInvoiceJobForOrder(order.id);
  } catch (error) {
    console.error('[CatastroX Payments] Error disparando flujos posteriores a la aprobación', {
      orderId: order.id,
      message: error.message,
    });
  }
}

// --- Comprador (Bloque 2/5) ---------------------------------------------

router.post('/customers', customerLimiter, async (req, res) => {
  if (!isRequestOriginTrusted(req)) {
    return res.status(403).json({ ok: false, code: 'ORIGIN_NOT_TRUSTED', message: 'Origen no permitido.' });
  }

  let validated;
  try {
    validated = validateCustomerInput(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      code: error.publicCode || 'INVALID_CUSTOMER_INPUT',
      message: error.publicMessage || error.message,
    });
  }

  try {
    const customer = await customers.upsertCustomer(validated);

    // Cooldown backend de emisión de OTP (cierre de protección backend): el
    // cooldown de 30s del frontend (CatastroXOtpVerification.jsx) no
    // protege el endpoint en sí -- esta es la contraparte de backend,
    // respaldada en Postgres (nunca en memoria del proceso, ver
    // reserveEmailVerificationSend()). Se reserva el derecho a enviar ANTES
    // de generar el código o llamar a Resend -- si otra solicitud para el
    // mismo comprador ya está en curso, o si el último envío REALMENTE
    // entregado fue hace menos de 30s, se responde 429 de inmediato: no se
    // genera código nuevo, no se llama al proveedor, no se persiste nada.
    const reservation = await customers.reserveEmailVerificationSend(customer.id);
    if (!reservation.allowed) {
      return res.status(429).json({
        ok: false,
        code: 'EMAIL_VERIFICATION_COOLDOWN',
        retryAfterSeconds: reservation.retryAfterSeconds,
        message: 'Ya se envió un código recientemente. Espera unos segundos antes de solicitar uno nuevo.',
      });
    }

    const appEnv = String(process.env.APP_ENV || '').toLowerCase();
    const isDevOrTest = appEnv === 'development' || appEnv === 'test';

    // El comprador se persiste siempre (upsert idempotente), pero el código
    // de verificación NO se escribe todavía -- ver política transaccional
    // más abajo (revisión de reenvío, EMAIL_PROVIDER_002 §12/§13).
    const pending = customers.generatePendingEmailVerification();
    // El correo se descifra solo en memoria, en este instante, para poder
    // transportarlo -- nunca se reintroduce en email_normalized (columna
    // deprecada, ver migración 005).
    const decryptedCustomer = customers.decryptCustomerPii(customer);

    // La reserva se libera pase lo que pase -- éxito, fallo honesto de
    // sendVerificationEmail(), o una excepción inesperada (no debería
    // ocurrir dado su contrato fail-closed, pero nunca debe dejar
    // reserved_at "colgado" hasta que expire solo por TTL). `finally`
    // envuelve la llamada completa; el resultado se usa después, fuera de
    // este bloque, para decidir persistencia y la respuesta HTTP.
    let emailResult;
    try {
      emailResult = await sendVerificationEmail({
        to: decryptedCustomer.email,
        verificationCode: pending.code,
        expiresAt: pending.expiresAt,
        customerName: buildCustomerDisplayNameForEmail(decryptedCustomer),
        // Estable dentro de este intento (incluyendo el reintento interno de
        // sendVerificationEmail); cada llamada a este endpoint -- incluido un
        // reenvío real -- genera un pending.id nuevo y por tanto una
        // idempotencyKey nueva -- ver buildEmailIdempotencyKey().
        idempotencyKey: buildEmailIdempotencyKey(pending.id),
      });
    } finally {
      await customers.releaseEmailVerificationSend(customer.id, {
        delivered: Boolean(emailResult?.delivered || isDevOrTest),
      });
    }

    // Política transaccional (revisión de reenvío): verifyEmailCode() más
    // abajo siempre valida contra la fila MÁS RECIENTE no consumida/no
    // expirada -- si se persistiera esta fila sin importar el resultado del
    // envío, un fallo de Resend dejaría "activo" un código que el
    // comprador nunca recibió, ensombreciendo cualquier código anterior que
    // sí le hubiera llegado (candado autoinfligido). Por eso solo se
    // persiste si: (a) el envío se confirmó entregado, o (b)
    // development/test, donde no hay entrega real que confirmar y
    // devOtpCode es la vía de prueba ya autorizada -- en ese caso SIEMPRE
    // se persiste, para que verify-email tenga contra qué validar.
    if (emailResult.delivered || isDevOrTest) {
      await customers.persistEmailVerification({
        id: pending.id,
        customerId: customer.id,
        codeHash: pending.codeHash,
        expiresAt: pending.expiresAt,
      });
    }

    // Bloque 2 (revisión de seguridad), EMAIL_PROVIDER_002: fuera de
    // development/test no hay ninguna vía alterna (devOtpCode) para que el
    // comprador reciba el código -- si el envío real no se entregó, se
    // falla explícitamente en vez de responder como si el correo se
    // hubiera enviado ("código enviado" nunca se afirma sin
    // delivered:true). El comprador ya quedó registrado (upsert
    // idempotente); el código NUNCA quedó persistido (ver arriba) -- el
    // comprador puede reintentar de inmediato, o seguir usando un código
    // anterior todavía vigente si lo tiene.
    if (!emailResult.delivered && !isDevOrTest) {
      console.error('[CatastroX Payments] No fue posible entregar el correo de verificación', {
        customerId: customer.id,
        provider: emailResult.provider,
        errorCode: emailResult.errorCode,
      });
      return res.status(503).json({
        ok: false,
        code: 'EMAIL_DELIVERY_UNAVAILABLE',
        message: 'No fue posible enviar el código de verificación en este momento. Intente más tarde.',
      });
    }

    return res.json({
      ok: true,
      customerId: customer.id,
      emailVerificationRequired: true,
      // Solo en development/test: sendVerificationEmail() siempre es el
      // stub ahí (ver server/services/catastrox/emailSender.js), así que
      // esta es la única vía de completar el flujo en pruebas -- NUNCA en
      // staging/producción, sin importar delivered/provider.
      ...(isDevOrTest ? { devOtpCode: pending.code } : {}),
    });
  } catch (error) {
    console.error('[CatastroX Payments] Error creando/actualizando comprador', { message: error.message });
    return res.status(500).json({ ok: false, code: 'CUSTOMER_PERSISTENCE_ERROR', message: 'No fue posible registrar sus datos.' });
  }
});

router.post('/customers/:customerId/verify-email', emailVerificationLimiter, async (req, res) => {
  const customerId = String(req.params?.customerId || '').trim();
  const code = String(req.body?.code || '').trim();

  if (!customerId || !code) {
    return res.status(400).json({ ok: false, code: 'INVALID_VERIFICATION_REQUEST', message: 'Solicitud inválida.' });
  }

  try {
    const result = await customers.verifyEmailCode(customerId, code);
    if (!result.ok) {
      const publicCodeByReason = {
        no_active_code: 'CODE_EXPIRED',
        too_many_attempts: 'TOO_MANY_ATTEMPTS',
        code_mismatch: 'CODE_MISMATCH',
      };
      return res.status(400).json({
        ok: false,
        code: publicCodeByReason[result.reason] || 'CODE_MISMATCH',
        message: 'El código no es válido o ya expiró. Solicite uno nuevo si es necesario.',
      });
    }

    return res.json({ ok: true, verified: true });
  } catch (error) {
    console.error('[CatastroX Payments] Error verificando código de correo', { message: error.message });
    return res.status(500).json({ ok: false, code: 'EMAIL_VERIFICATION_ERROR', message: 'No fue posible verificar el código.' });
  }
});

router.get('/verify/:transactionId', verifyLimiter, async (req, res) => {
  const transactionId = String(req.params?.transactionId || '').trim();
  const WOMPI_PUBLIC_KEY_TEST = process.env.WOMPI_PUBLIC_KEY_TEST || '';
  const WOMPI_API_BASE_URL = process.env.WOMPI_API_BASE_URL || WOMPI_API_DEFAULT_URL;

  if (!transactionId) {
    return res.status(400).json({
      ok: false,
      error: 'transactionId es obligatorio.',
    });
  }

  if (!WOMPI_PUBLIC_KEY_TEST) {
    return res.status(500).json({
      ok: false,
      error: 'Wompi Sandbox no esta configurado en backend.',
    });
  }

  let transaction;
  try {
    const rawTransaction = await fetchWompiTransaction({
      transactionId,
      apiBaseUrl: WOMPI_API_BASE_URL,
      publicKey: WOMPI_PUBLIC_KEY_TEST,
    });
    transaction = mapWompiTransactionForApp(rawTransaction);
  } catch (error) {
    return res.status(error.status === 404 ? 404 : 502).json({
      ok: false,
      error: 'No fue posible verificar el pago con Wompi.',
      detail: error.message,
    });
  }

  // Persistencia: la orden se busca EXCLUSIVAMENTE por la reference que
  // Wompi reportó para esta transacción real -- nunca por nada que el
  // cliente pueda mandar en el query string. Si no hay una orden creada por
  // nuestro propio /checkout con esa reference, no hay nada que aprobar.
  let order = null;
  try {
    order = await paymentOrders.findOrderByReference(transaction.reference);

    if (order) {
      const decision = decideVerificationOutcome({ order, wompiTransaction: transaction });

      if (decision.outcome === 'APPROVE' || decision.outcome === 'PENDING' || decision.outcome === 'DECLINE') {
        try {
          const updated = await paymentOrders.applyVerifiedTransaction({
            orderId: order.id,
            nextStatus: decision.nextStatus,
            wompiTransactionId: transaction.id,
            paymentMethodType: transaction.paymentMethodType,
            verificationSource: 'return',
            fromStatuses: ['CREATED', 'PENDING'],
          });
          // updated === null: otra verificación concurrente (webhook) ya
          // transicionó esta orden primero -- se relee para responder con
          // el estado real y consistente, sin tratarlo como error ni
          // disparar los flujos posteriores dos veces.
          if (updated && decision.outcome === 'APPROVE') {
            await triggerPostApprovalWorkflows(updated);
          }
          order = updated || (await paymentOrders.findOrderByReference(transaction.reference));
        } catch (error) {
          if (error instanceof OrderConflictError) {
            order = await paymentOrders.findOrderByReference(transaction.reference);
          } else {
            throw error;
          }
        }
      }
      // ALREADY_APPROVED: no-op, se responde con el estado ya persistido.
      // REJECTED: no se toca el registro, se responde con el estado actual
      // (nunca con lo que Wompi acaba de reportar, para no filtrar el
      // detalle del rechazo al cliente más de lo necesario).
    }
  } catch (error) {
    console.error('[CatastroX Payments] Error persistiendo verificación', { message: error.message });
    return res.status(500).json({ ok: false, error: 'No fue posible registrar la verificación del pago.' });
  }

  return res.json({
    ok: true,
    transaction,
    order: order
      ? { status: order.status, packageId: order.package_id, orderToken: order.order_token }
      : null,
  });
});

// Cada compra es una orden independiente (Bloque 6): este endpoint YA NO
// consulta "¿existe algún APPROVED para este predio+paquete?" -- el mismo
// predio y el mismo paquete pueden comprarse N veces, por el mismo
// comprador o por compradores distintos. La única deduplicación es la de
// doble clic (idempotency_key, ventana corta) -- nunca una prohibición
// comercial. Exige un comprador con correo verificado (customerId) antes
// de crear cualquier orden.
router.post('/checkout', checkoutLimiter, async (req, res) => {
  if (!isRequestOriginTrusted(req)) {
    return res.status(403).json({ ok: false, code: 'ORIGIN_NOT_TRUSTED', message: 'Origen no permitido.' });
  }

  const packageId = normalizePackageId(req.body?.packageId);
  const purchaseKey = String(req.body?.purchaseKey || '').trim();
  const routeId = String(req.body?.routeId || '').trim();
  const customerId = String(req.body?.customerId || '').trim();
  const purchaseAttemptId = String(req.body?.purchaseAttemptId || '').trim();

  if (!packageId || !CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS[packageId]) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_PACKAGE',
      message: 'El paquete solicitado no es válido para CatastroX.',
    });
  }

  // Validación estricta de formato (Bloque 3 de la revisión de seguridad):
  // debe ser exactamente un UUID -- nunca un valor libre que el cliente
  // pudiera manipular para intentar colisionar o alargar artificialmente
  // la llave de idempotencia.
  if (!isValidPurchaseAttemptId(purchaseAttemptId)) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_PURCHASE_ATTEMPT_ID',
      message: 'Solicitud de compra inválida. Vuelva a intentar desde el resumen de compra.',
    });
  }

  // Validación de formato (predio) antes de exigir un comprador registrado
  // -- una solicitud con datos de identidad de predio mal formados debe
  // fallar por ese motivo específico, sin importar si además le falta
  // customerId.
  let canonicalPredioId;
  try {
    canonicalPredioId = resolveCanonicalPredioIdFromRequestBody(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      code: error.publicCode || 'INVALID_CADASTRAL_CODE',
      message: error.publicMessage || error.message,
    });
  }

  if (!customerId) {
    return res.status(400).json({
      ok: false,
      code: 'CUSTOMER_ID_REQUIRED',
      message: 'Debe registrar sus datos de comprador antes de continuar (POST /customers).',
    });
  }

  // codigoPredial se conserva solo como metadato de referencia/legado (no
  // como llave de entitlement) -- si no vino uno explícito válido, se
  // guarda null en vez de inventar un valor.
  let codigoPredialNormalized = null;
  try {
    codigoPredialNormalized = req.body?.codigoPredial ? validateCadastralCodeInput(req.body.codigoPredial) : null;
  } catch {
    codigoPredialNormalized = null;
  }

  let customer;
  try {
    customer = await customers.findCustomerById(customerId);
  } catch (error) {
    console.error('[CatastroX Payments] Error consultando comprador', { message: error.message });
    return res.status(500).json({ ok: false, code: 'CUSTOMER_LOOKUP_ERROR', message: 'No fue posible validar el comprador.' });
  }

  if (!customer) {
    return res.status(404).json({ ok: false, code: 'CUSTOMER_NOT_FOUND', message: 'Comprador no encontrado.' });
  }

  if (!customer.email_verified_at) {
    return res.status(403).json({
      ok: false,
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Debe confirmar su correo electrónico antes de completar la compra.',
    });
  }

  const WOMPI_PUBLIC_KEY_TEST = process.env.WOMPI_PUBLIC_KEY_TEST || '';
  const WOMPI_INTEGRITY_SECRET_TEST = process.env.WOMPI_INTEGRITY_SECRET_TEST || '';
  const frontendUrl = String(process.env.CATASTROX_FRONTEND_URL || '').replace(/\/+$/, '');

  if (!WOMPI_PUBLIC_KEY_TEST || !WOMPI_INTEGRITY_SECRET_TEST) {
    return res.status(500).json({
      ok: false,
      code: 'WOMPI_CONFIG_MISSING',
      message: 'Wompi Sandbox no está configurado en backend.',
    });
  }

  if (WOMPI_PLACEHOLDER_PATTERN.test(WOMPI_PUBLIC_KEY_TEST)) {
    return res.status(500).json({
      ok: false,
      code: 'WOMPI_PUBLIC_KEY_INVALID',
      error: 'Configuracion Wompi invalida: llave publica Sandbox no configurada.',
    });
  }

  if (!WOMPI_PUBLIC_KEY_TEST.startsWith('pub_test_')) {
    return res.status(500).json({
      ok: false,
      code: 'WOMPI_PUBLIC_KEY_INVALID',
      error: 'Configuracion Wompi invalida: WOMPI_PUBLIC_KEY_TEST debe iniciar con pub_test_.',
    });
  }

  const amountInCents = CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS[packageId];
  const shouldSendRedirectUrl = shouldSendWompiRedirectUrl({
    appEnv: process.env.APP_ENV,
    wompiEnv: process.env.WOMPI_ENV,
    frontendUrl,
  });
  const redirectUrl = shouldSendRedirectUrl ? buildRedirectUrl({ frontendUrl }) : null;
  const idempotencyKey = buildIdempotencyKey({ customerId, canonicalPredioId, packageId, purchaseAttemptId });

  try {
    const outcome = await paymentOrders.withCheckoutLock(idempotencyKey, async (client) => {
      const { session, isNewSession, rawToken } = await resolveSessionForCheckout(req, client);

      const existingOrder = await paymentOrders.findOrderByIdempotencyKey(idempotencyKey, client);
      if (existingOrder) {
        // Reintento técnico inmediato (doble clic) -- se enlaza igual a la
        // sesión actual (por si el cookie se perdió entre el primer y el
        // segundo intento) y se reutiliza, nunca se crea una segunda orden.
        await recoverySessions.linkOrderToSession(session.id, existingOrder.id, client);
        return { action: 'REUSE_PENDING', order: existingOrder, isNewSession, rawToken };
      }

      const reference = buildReference({ purchaseKey, packageId });
      const orderToken = paymentOrders.generateOrderToken();
      const clientIpHash = hashAuditValue(req.ip);
      const userAgentHash = hashAuditValue(req.headers['user-agent']);

      const order = await paymentOrders.insertPendingOrder(
        {
          orderToken,
          packageId,
          canonicalPredioId,
          codigoPredialNormalized,
          customerId,
          idempotencyKey,
          routeIdOriginal: routeId || null,
          purchaseKeyOriginal: purchaseKey || null,
          wompiReference: reference,
          expectedAmountInCents: amountInCents,
          currency: CHECKOUT_CURRENCY,
          clientIpHash,
          userAgentHash,
        },
        client,
      );

      // Instantánea de facturación (Bloque 3) -- se descifra el comprador
      // solo en memoria, en este instante, para construir la instantánea;
      // createBillingProfile() vuelve a cifrar antes de insertar (nunca
      // reutiliza el ciphertext del comprador tal cual, porque billingName
      // combina nombre+apellido en un solo valor). Una corrección
      // posterior del perfil del comprador nunca reescribe una instantánea
      // ya creada.
      const decryptedCustomer = customers.decryptCustomerPii(customer);
      const billingName =
        customer.customer_type === 'NATURAL'
          ? `${decryptedCustomer.firstName || ''} ${decryptedCustomer.lastName || ''}`.trim()
          : decryptedCustomer.legalName;

      await paymentOrders.createBillingProfile(
        {
          paymentOrderId: order.id,
          customerType: customer.customer_type,
          billingName,
          documentType: customer.document_type,
          documentNumberEncrypted: customer.document_number_encrypted,
          documentNumberHash: customer.document_number_hash,
          billingEmail: decryptedCustomer.email,
          phoneEncrypted: customer.phone_encrypted,
          addressEncrypted: customer.address_encrypted,
          city: decryptedCustomer.city,
          department: decryptedCustomer.department,
          countryCode: customer.country_code,
        },
        client,
      );

      await recoverySessions.linkOrderToSession(session.id, order.id, client);

      return { action: 'CREATE_NEW', order, isNewSession, rawToken };
    });

    const order = outcome.order;
    const integrity = buildIntegritySignature({
      reference: order.wompi_reference,
      amountInCents: order.expected_amount_in_cents,
      integritySecret: WOMPI_INTEGRITY_SECRET_TEST,
    });

    if (outcome.isNewSession) {
      res.setHeader('Set-Cookie', buildRecoverySetCookieHeader({ token: outcome.rawToken, appEnv: process.env.APP_ENV }));
    }

    return res.json({
      ok: true,
      checkout: {
        status: outcome.action === 'REUSE_PENDING' ? 'PENDING_REUSE' : 'CREATED',
        publicKey: WOMPI_PUBLIC_KEY_TEST,
        amountInCents: order.expected_amount_in_cents,
        currency: order.currency,
        reference: order.wompi_reference,
        signature: { integrity },
        redirectUrl,
        packageId: order.package_id,
        orderToken: order.order_token,
      },
    });
  } catch (error) {
    console.error('[CatastroX Payments] Error creando/recuperando orden de checkout', { message: error.message });
    return res.status(500).json({
      ok: false,
      code: 'CHECKOUT_PERSISTENCE_ERROR',
      message: 'No fue posible iniciar el checkout de Wompi.',
    });
  }
});

// Fuente principal de confirmación cuando el navegador no vuelve (falla la
// redirección, se cierra la pestaña, etc.). El retorno del navegador
// (GET /verify/:transactionId) es la vía secundaria de experiencia de
// usuario -- ambas comparten la misma lógica de persistencia
// (decideVerificationOutcome + applyVerifiedTransaction), por eso ninguna de
// las dos puede aprobar dos veces ni divergir en el resultado.
//
// Transaccional de punta a punta (Bloque 2): dedupe + fetch a Wompi +
// transición de la orden + marcar PROCESSED ocurren en una sola
// transacción (withWebhookTransaction). Si cualquier paso falla, Postgres
// revierte TODO -- nunca queda un evento marcado "visto" sin que la orden
// realmente haya transicionado. Solo se responde 200 ante éxito real o un
// replay genuinamente ya PROCESSED; cualquier otro fallo responde 500 para
// que Wompi reintente, y adicionalmente deja un registro FAILED (en una
// transacción nueva y separada, ya que la principal se revirtió) para
// trazabilidad.
router.post('/wompi/events', webhookLimiter, async (req, res) => {
  const eventsSecret = process.env.WOMPI_EVENTS_SECRET_TEST || '';
  const verification = verifyWompiEventSignature(req.body, eventsSecret);

  if (!verification.valid) {
    const status = verification.reason === 'events_secret_not_configured' ? 503 : 401;
    return res.status(status).json({ ok: false, error: 'No fue posible autenticar el evento.' });
  }

  const eventType = req.body?.event;
  if (!isAllowedWompiEventType(eventType)) {
    // Evento reconocido por Wompi pero fuera de lo que este backend procesa
    // -- se responde 200 para no provocar reintentos infinitos de un tipo
    // que nunca se va a manejar, y se ignora sin tocar ninguna orden.
    return res.status(200).json({ ok: true, ignored: true });
  }

  const transactionId = req.body?.data?.transaction?.id;
  const reference = req.body?.data?.transaction?.reference;

  if (!transactionId) {
    return res.status(400).json({ ok: false, error: 'Evento sin transactionId.' });
  }

  // Huella de deduplicación: nunca el body completo (podría contener datos
  // de tarjeta enmascarados u otra información que no debe persistirse tal
  // cual) -- solo un hash de los campos que identifican de forma única este
  // evento puntual.
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${eventType}|${transactionId}|${reference}|${req.body?.timestamp}|${req.body?.signature?.checksum}`)
    .digest('hex');

  const WOMPI_PUBLIC_KEY_TEST = process.env.WOMPI_PUBLIC_KEY_TEST || '';
  const WOMPI_API_BASE_URL = process.env.WOMPI_API_BASE_URL || WOMPI_API_DEFAULT_URL;
  let approvedOrderToNotify = null;

  try {
    if (!WOMPI_PUBLIC_KEY_TEST) {
      const error = new Error('Wompi Sandbox no esta configurado en backend.');
      error.publicErrorCode = 'WOMPI_CONFIG_MISSING';
      throw error;
    }

    const alreadyProcessed = await paymentOrders.withWebhookTransaction(async (client) => {
      const eventRow = await paymentOrders.upsertWebhookEventForProcessing(
        { eventFingerprint: fingerprint, wompiTransactionId: transactionId, wompiReference: reference || null, eventType },
        client,
      );

      // processed_at ya no-nulo significa que una transacción ANTERIOR (ya
      // confirmada) completó este evento -- replay/reintento de Wompi,
      // idempotente, no se reprocesa nada más en esta transacción.
      if (eventRow.processed_at) {
        return true;
      }

      // Nunca se confía en monto/estado del body del webhook -- se
      // reconsulta la transacción server-to-server, exactamente como en
      // /verify.
      const rawTransaction = await fetchWompiTransaction({
        transactionId,
        apiBaseUrl: WOMPI_API_BASE_URL,
        publicKey: WOMPI_PUBLIC_KEY_TEST,
      });
      const transaction = mapWompiTransactionForApp(rawTransaction);

      const order = await paymentOrders.findOrderByReference(transaction.reference, client);
      if (order) {
        const decision = decideVerificationOutcome({ order, wompiTransaction: transaction });

        if (decision.outcome === 'APPROVE' || decision.outcome === 'PENDING' || decision.outcome === 'DECLINE') {
          const updated = await paymentOrders.applyVerifiedTransaction(
            {
              orderId: order.id,
              nextStatus: decision.nextStatus,
              wompiTransactionId: transaction.id,
              paymentMethodType: transaction.paymentMethodType,
              verificationSource: 'webhook',
              fromStatuses: ['CREATED', 'PENDING'],
            },
            client,
          );
          if (updated && decision.outcome === 'APPROVE') {
            approvedOrderToNotify = updated;
          }
        }
        // ALREADY_APPROVED/REJECTED: no-op -- de cualquier forma se marca
        // PROCESSED abajo, porque el webhook ya cumplió su propósito
        // (confirmar/objetar contra el estado actual), sin importar si
        // hubo o no una transición de estado real.
      }
      // order inexistente: no es un error del webhook (puede ser de otro
      // ambiente/reference que no reconocemos) -- se marca PROCESSED igual,
      // para no reintentar indefinidamente algo que nunca vamos a resolver.

      await paymentOrders.markWebhookEventProcessed(fingerprint, client);
      return false;
    });

    // Disparo de flujos posteriores a la aprobación FUERA de la
    // transacción del webhook -- nunca debe hacer que la transacción del
    // pago (ya comprometida/COMMIT) se revierta por un problema al crear
    // el delivery/invoice job.
    if (approvedOrderToNotify) {
      await triggerPostApprovalWorkflows(approvedOrderToNotify);
    }

    return res.status(200).json({ ok: true, deduplicated: alreadyProcessed === true });
  } catch (error) {
    console.error('[CatastroX Payments] Error procesando webhook de Wompi', { message: error.message });

    const errorCode = error?.publicErrorCode || (error instanceof OrderConflictError ? error.code : 'WEBHOOK_PROCESSING_ERROR');

    try {
      await paymentOrders.recordWebhookFailure({
        eventFingerprint: fingerprint,
        wompiTransactionId: transactionId,
        wompiReference: reference || null,
        eventType,
        errorCode,
      });
    } catch (recordError) {
      console.error('[CatastroX Payments] Error registrando fallo de webhook', { message: recordError.message });
    }

    // 500: la transacción principal ya revirtió TODO (incluida la huella de
    // deduplicación) -- Wompi debe reintentar este evento, no se responde
    // 200 ante un fallo real recuperable (defecto corregido de la
    // implementación anterior).
    return res.status(500).json({ ok: false, error: 'No fue posible procesar el evento. Reintente.' });
  }
});

router.get('/orders/:orderToken/status', orderStatusLimiter, async (req, res) => {
  const orderToken = String(req.params?.orderToken || '').trim();

  if (!orderToken) {
    return res.status(404).json({ ok: false, error: 'Orden no encontrada.' });
  }

  try {
    const order = await paymentOrders.findOrderByToken(orderToken);
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Orden no encontrada.' });
    }

    // Quien posea el orderToken (256 bits, capability opaca) obtiene este
    // estado mínimo -- por diseño no incluye reference completa,
    // transactionId ni ningún dato de contacto: es deliberadamente
    // insuficiente para reclamar el derecho de descarga (eso exige la
    // sesión de recuperación, ver POST /entitlements/check).
    return res.json({
      ok: true,
      order: {
        status: order.status,
        packageId: order.package_id,
        currency: order.currency,
        amountInCents: order.expected_amount_in_cents,
        createdAt: order.created_at,
        approvedAt: order.approved_at,
      },
    });
  } catch (error) {
    console.error('[CatastroX Payments] Error consultando estado de orden', { message: error.message });
    return res.status(500).json({ ok: false, error: 'No fue posible consultar el estado de la orden.' });
  }
});

// Historial multiorden en este navegador (Bloque 9): exclusivamente a
// partir de la sesión de recuperación HttpOnly -- nunca de nada que el
// cliente pueda declarar. Cada campo devuelto ya está minimizado en el
// propio SELECT (recoverySessionRepository.findOrdersForSession); esta
// función solo re-nombra a camelCase y nunca agrega documento, correo,
// teléfono, dirección, reference completa, transactionId ni datos
// cifrados -- ninguno de esos existe siquiera en el resultado de esa
// consulta.
function toPublicOrderHistoryEntry(row) {
  return {
    orderToken: row.order_token,
    packageId: row.package_id,
    codigoPredial: row.codigo_predial_normalized || null,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    paymentStatus: row.payment_status,
    deliveryStatus: row.delivery_status || 'NOT_STARTED',
    invoiceStatus: row.invoice_status || 'NOT_REQUESTED',
  };
}

router.get('/orders/mine', myOrdersLimiter, async (req, res) => {
  const sessionToken = getRecoverySessionTokenFromCookieHeader(req.headers.cookie);

  if (!sessionToken) {
    return res.json({ ok: true, orders: [] });
  }

  try {
    const tokenHash = recoverySessions.hashSessionToken(sessionToken);
    const session = await recoverySessions.findActiveSessionByTokenHash(tokenHash);
    if (!session) {
      return res.json({ ok: true, orders: [] });
    }

    const rows = await recoverySessions.findOrdersForSession(session.id);
    return res.json({ ok: true, orders: rows.map(toPublicOrderHistoryEntry) });
  } catch (error) {
    console.error('[CatastroX Payments] Error consultando historial de órdenes de la sesión', { message: error.message });
    return res.status(500).json({ ok: false, error: 'No fue posible consultar su historial de compras.' });
  }
});

// Única vía de reconocer un pago como propio del solicitante (Bloque 1/7).
// Exige la sesión de recuperación (cookie HttpOnly emitida por /checkout)
// -- codigoPredial/canonicalPredioId/packageId por sí solos NO autorizan
// nada, porque el código predial no es secreto. La respuesta es
// EXACTAMENTE la misma (200, isPaid:false) sin importar la razón de la
// denegación (sin cookie, sesión ajena/expirada, ninguna orden aprobada
// enlazada, rango insuficiente) -- nunca se distingue "no existe pago" de
// "sesión inválida".
router.post('/entitlements/check', entitlementLimiter, async (req, res) => {
  const packageId = normalizePackageId(req.body?.packageId);

  if (!packageId || !CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS[packageId]) {
    return res.status(400).json({ ok: false, code: 'INVALID_PACKAGE', message: 'Paquete inválido.' });
  }

  let canonicalPredioId;
  try {
    canonicalPredioId = resolveCanonicalPredioIdFromRequestBody(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      code: error.publicCode || 'INVALID_CADASTRAL_CODE',
      message: error.publicMessage || error.message,
    });
  }

  const sessionToken = getRecoverySessionTokenFromCookieHeader(req.headers.cookie);
  const respondNotAuthorized = () => res.json({ ok: true, isPaid: false, packageId });

  if (!sessionToken) {
    return respondNotAuthorized();
  }

  try {
    const tokenHash = recoverySessions.hashSessionToken(sessionToken);
    const session = await recoverySessions.findActiveSessionByTokenHash(tokenHash);
    if (!session) {
      return respondNotAuthorized();
    }

    const order = await recoverySessions.findApprovedOrderForSession({ sessionId: session.id, canonicalPredioId });

    if (!order || !packageSatisfies({ ownedPackageId: order.package_id, requiredPackageId: packageId })) {
      return respondNotAuthorized();
    }

    return res.json({ ok: true, isPaid: true, packageId: order.package_id });
  } catch (error) {
    console.error('[CatastroX Payments] Error consultando entitlement', { message: error.message });
    return res.status(500).json({ ok: false, error: 'No fue posible consultar el estado del pago.' });
  }
});

// Revocación explícita de la sesión de recuperación en este navegador (p.
// ej. equipo compartido/público) -- revoca la sesión en base de datos (las
// órdenes ya enlazadas dejan de ser recuperables desde ese cookie, aunque
// alguien lo copiara antes de esta llamada) y borra el cookie local.
router.post('/recovery/clear', entitlementLimiter, async (req, res) => {
  const sessionToken = getRecoverySessionTokenFromCookieHeader(req.headers.cookie);

  if (sessionToken) {
    try {
      const tokenHash = recoverySessions.hashSessionToken(sessionToken);
      const session = await recoverySessions.findActiveSessionByTokenHash(tokenHash);
      if (session) {
        await recoverySessions.revokeRecoverySession(session.id);
      }
    } catch (error) {
      console.error('[CatastroX Payments] Error revocando sesión de recuperación', { message: error.message });
    }
  }

  res.setHeader('Set-Cookie', buildRecoveryClearCookieHeader({ appEnv: process.env.APP_ENV }));
  res.json({ ok: true });
});

export default router;
