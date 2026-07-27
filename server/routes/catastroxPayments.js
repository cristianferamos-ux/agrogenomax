import crypto from 'crypto';
import { Router } from 'express';

const router = Router();
const CHECKOUT_CURRENCY = 'COP';
const PACKAGE_CODES = {
  basico: 'BASICO',
  plus: 'PLUS',
  profesional: 'PROFESIONAL',
};

const ALLOWED_PACKAGES = {
  basico: 3990000,
  plus: 4990000,
  profesional: 5990000,
};
const WOMPI_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;
const WOMPI_API_DEFAULT_URL = 'https://sandbox.wompi.co/v1';

function normalizePackageId(value) {
  const raw = String(value || '').trim().toLowerCase();

  const aliases = {
    basico: 'basico',
    basic: 'basico',
    plus: 'plus',
    profesional: 'profesional',
    professional: 'profesional',
    premium: 'profesional',
    pro: 'profesional',
  };

  return aliases[raw] || raw;
}

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

router.get('/verify/:transactionId', async (req, res) => {
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

  try {
    const transaction = await fetchWompiTransaction({
      transactionId,
      apiBaseUrl: WOMPI_API_BASE_URL,
      publicKey: WOMPI_PUBLIC_KEY_TEST,
    });

    return res.json({
      ok: true,
      transaction: {
        id: transaction.id,
        status: transaction.status,
        reference: transaction.reference,
        amountInCents: Number(transaction.amount_in_cents || 0),
        currency: transaction.currency,
        paymentMethodType: transaction.payment_method_type || null,
        customerEmail: transaction.customer_email || null,
      },
    });
  } catch (error) {
    return res.status(error.status === 404 ? 404 : 502).json({
      ok: false,
      error: 'No fue posible verificar el pago con Wompi.',
      detail: error.message,
    });
  }
});

router.post('/checkout', (req, res) => {
  const packageId = normalizePackageId(req.body?.packageId);
  const purchaseKey = String(req.body?.purchaseKey || '').trim();
  const codigoPredial = String(req.body?.codigoPredial || '').trim();
  const predioId = String(req.body?.predioId || '').trim();
  const routeId = String(req.body?.routeId || '').trim();

  if (!packageId) {
    return res.status(400).json({
      ok: false,
      code: 'PACKAGE_ID_REQUIRED',
      message: 'packageId es obligatorio.',
    });
  }

  if (!purchaseKey) {
    return res.status(400).json({
      ok: false,
      code: 'PURCHASE_KEY_REQUIRED',
      message: 'purchaseKey es obligatorio.',
    });
  }

  if (!ALLOWED_PACKAGES[packageId]) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_PACKAGE',
      message: 'El paquete solicitado no es válido para CatastroX.',
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

  const amountInCents = ALLOWED_PACKAGES[packageId];
  const reference = buildReference({ purchaseKey, packageId });
  const integrity = buildIntegritySignature({
    reference,
    amountInCents,
    integritySecret: WOMPI_INTEGRITY_SECRET_TEST,
  });
  const shouldSendRedirectUrl = shouldSendWompiRedirectUrl({
    appEnv: process.env.APP_ENV,
    wompiEnv: process.env.WOMPI_ENV,
    frontendUrl,
  });
  const redirectUrl = shouldSendRedirectUrl ? buildRedirectUrl({ frontendUrl }) : null;

  return res.json({
    ok: true,
    checkout: {
      publicKey: WOMPI_PUBLIC_KEY_TEST,
      amountInCents,
      currency: CHECKOUT_CURRENCY,
      reference,
      signature: {
        integrity,
      },
      redirectUrl,
      packageId,
      purchaseKey: sanitizeReferenceSegment(purchaseKey) || purchaseKey,
      codigoPredial,
      predioId,
      routeId,
    },
  });
});

export default router;
