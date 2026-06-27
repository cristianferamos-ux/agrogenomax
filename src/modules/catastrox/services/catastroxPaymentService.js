import { getCatastroxPackage, getCatastroxPackageRank } from '../config/catastroxPackages.js';

const PURCHASE_STORAGE_KEY = 'catastrox_purchases_v2';
const LEGACY_STORAGE_KEYS = [
  'catastrox_purchases',
  'catastrox_paid_packages',
  'catastrox_package_purchases',
];
const ENV = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};
const CONFIGURED_API_BASE = ENV.VITE_API_URL || ENV.VITE_AGX_API_URL || '';
const WOMPI_WIDGET_SRC = 'https://checkout.wompi.co/widget.js';
const WOMPI_WIDGET_TIMEOUT_MS = 15000;
const WOMPI_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;
let wompiWidgetLoadPromise = null;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isLocalhost() {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function normalizeApiBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function getApiBaseCandidates() {
  const configuredApiBase = normalizeApiBase(CONFIGURED_API_BASE);
  const candidates = [];

  if (isLocalhost()) {
    candidates.push('/api');
    if (configuredApiBase && !/^https?:\/\/localhost:3001\/?$/i.test(configuredApiBase) && !/^https?:\/\/127\.0\.0\.1:3001\/?$/i.test(configuredApiBase)) {
      candidates.push(configuredApiBase);
    }
  } else {
    if (configuredApiBase) {
      candidates.push(configuredApiBase);
    }

    if (!configuredApiBase) {
      candidates.push('/api');
    }
  }

  if (!candidates.length) {
    candidates.push('/api');
  }

  return [...new Set(candidates.filter(Boolean))];
}

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

function getExpectedAmountInCents(packageId) {
  const normalizedPackageId = normalizePackageId(packageId);
  const pkg = getCatastroxPackage(normalizedPackageId);
  return pkg ? Number(pkg.priceCop) * 100 : 0;
}

function validateWompiCheckoutData(checkout) {
  if (!checkout) {
    throw new Error('El backend no devolvio datos de checkout.');
  }

  if (!checkout.publicKey || !String(checkout.publicKey).startsWith('pub_')) {
    throw new Error('La llave publica de Wompi no llego correctamente.');
  }

  if (WOMPI_PLACEHOLDER_PATTERN.test(String(checkout.publicKey))) {
    throw new Error('La llave publica de Wompi sigue en placeholder. Revise service worker, cache o backend.');
  }

  if (!checkout.amountInCents || Number(checkout.amountInCents) <= 0) {
    throw new Error('El monto de Wompi no llego correctamente.');
  }

  if (checkout.currency !== 'COP') {
    throw new Error('La moneda de Wompi debe ser COP.');
  }

  if (!checkout.reference) {
    throw new Error('La referencia de Wompi no llego correctamente.');
  }

  if (!checkout.signature?.integrity) {
    throw new Error('La firma de integridad de Wompi no llego correctamente.');
  }
}

function readJsonStorage(key) {
  if (!isBrowser()) return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonLocalStorage(key) {
  if (!isBrowser()) return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readPurchaseStore() {
  const store = readJsonStorage(PURCHASE_STORAGE_KEY);
  return store || {};
}

function writePurchaseStore(store) {
  if (!isBrowser()) return;
  window.localStorage.setItem(PURCHASE_STORAGE_KEY, JSON.stringify(store));
}

function writePurchaseRecord(record) {
  const store = readPurchaseStore();
  store[record.purchaseKey] = record;
  writePurchaseStore(store);
}

function buildPurchaseRecordBase(lookup) {
  return {
    purchaseKey: getLookupPurchaseKey(lookup),
    routeId: lookup?.routeId || lookup?.predio?.routeId || lookup?.predio?.id || null,
    codigoPredial: lookup?.predio?.codigoPredial || lookup?.predio?.codigo || null,
  };
}

function buildPurchaseRecordBaseFromMeta({ purchaseKey, routeId = null, codigoPredial = null, predioId = null }) {
  return {
    purchaseKey,
    routeId,
    codigoPredial,
    predioId,
  };
}

function buildQueryPointFallback(queryPoint) {
  const lat = Number.parseFloat(queryPoint?.lat);
  const lng = Number.parseFloat(queryPoint?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return `catastrox_purchase_point_${lat.toFixed(6)}_${lng.toFixed(6)}`;
}

export function getPackageRank(packageId) {
  const configRank = getCatastroxPackageRank(packageId);
  return configRank >= 0 ? configRank + 1 : 0;
}

export function getLookupPurchaseKey(lookup) {
  const routeId = lookup?.routeId || lookup?.predio?.routeId;
  if (routeId) {
    return `catastrox_purchase_${routeId}`;
  }

  const predioId = lookup?.predio?.id;
  if (predioId) {
    return `catastrox_purchase_predio_${predioId}`;
  }

  const codigoPredial = lookup?.predio?.codigoPredial;
  if (codigoPredial) {
    return `catastrox_purchase_codigo_${codigoPredial}`;
  }

  const codigo = lookup?.predio?.codigo;
  if (codigo) {
    return `catastrox_purchase_codigo_${codigo}`;
  }

  const pointKey = buildQueryPointFallback(lookup?.queryPoint || lookup?.predio?.queryPoint);
  if (pointKey) {
    return pointKey;
  }

  return 'catastrox_purchase_unknown';
}

export function getPurchasedPackageForLookup(lookup) {
  const purchaseKey = getLookupPurchaseKey(lookup);
  const record = readPurchaseStore()[purchaseKey];

  if (!record || record.paid !== true) {
    return null;
  }

  return record;
}

export function getStoredPurchaseRecordByKey(purchaseKey) {
  if (!purchaseKey) return null;
  return readPurchaseStore()[purchaseKey] || null;
}

export function getApprovedPurchaseRecordByKeys({
  purchaseKey = '',
  routeId = '',
  predioId = '',
  codigoPredial = '',
} = {}) {
  const candidateKeys = [
    purchaseKey,
    routeId ? `catastrox_purchase_${routeId}` : '',
    predioId ? `catastrox_purchase_predio_${predioId}` : '',
    codigoPredial ? `catastrox_purchase_codigo_${codigoPredial}` : '',
  ].filter(Boolean);

  for (const key of candidateKeys) {
    const record = getStoredPurchaseRecordByKey(key);
    if (record?.paid === true) {
      return record;
    }
  }

  return null;
}

export function readCatastroxLocalStorageJson(key) {
  return readJsonLocalStorage(key);
}

function getStoredPurchaseForLookup(lookup) {
  const purchaseKey = getLookupPurchaseKey(lookup);
  return readPurchaseStore()[purchaseKey] || null;
}

export function isPackageUnlockedForLookup({ lookup, packageId }) {
  const purchasedPackage = getPurchasedPackageForLookup(lookup);
  return getPackageRank(purchasedPackage?.packageId) >= getPackageRank(packageId);
}

export function getUnlockedDownloadsForPackage({ lookup, packageId }) {
  if (!isPackageUnlockedForLookup({ lookup, packageId })) {
    return [];
  }

  const pkg = getCatastroxPackage(packageId);
  return pkg?.downloads || [];
}

function buildCheckoutUrl({ packageId, lookup }) {
  const normalizedPackageId = normalizePackageId(packageId);
  const pkg = getCatastroxPackage(normalizedPackageId);
  if (!pkg) return null;

  return {
    amountInCents: pkg.priceCop * 100,
    currency: 'COP',
    packageId: normalizedPackageId,
    packageLabel: pkg.label,
    purchaseKey: getLookupPurchaseKey(lookup),
  };
}

function markPackageAsPending({ packageId, lookup, reference, mode }) {
  const existingStoredPurchase = getStoredPurchaseForLookup(lookup);
  const existingPaidPurchase = getPurchasedPackageForLookup(lookup);

  const record = existingPaidPurchase
    ? {
        ...existingStoredPurchase,
        ...existingPaidPurchase,
        pendingCheckout: {
          packageId,
          reference,
          status: 'pending',
          mode,
          updatedAt: new Date().toISOString(),
        },
      }
    : {
        ...buildPurchaseRecordBase(lookup),
        packageId,
        paid: false,
        status: 'pending',
        reference,
        paidAt: null,
        transactionId: null,
        mode,
        updatedAt: new Date().toISOString(),
      };

  writePurchaseRecord(record);
  return record;
}

function updatePendingPurchaseStatus({ lookup, packageId, reference, status, transactionId = null, mode }) {
  const existingPurchase = getStoredPurchaseForLookup(lookup);
  const existingPaidPurchase = getPurchasedPackageForLookup(lookup);

  const record = existingPaidPurchase
    ? {
        ...existingPurchase,
        ...existingPaidPurchase,
        pendingCheckout: {
          packageId,
          reference,
          status,
          transactionId,
          mode,
          updatedAt: new Date().toISOString(),
        },
      }
    : {
        ...buildPurchaseRecordBase(lookup),
        packageId,
        paid: false,
        status,
        reference,
        paidAt: null,
        transactionId,
        mode,
        updatedAt: new Date().toISOString(),
      };

  writePurchaseRecord(record);
  return record;
}

function normalizeWompiStatus(rawStatus) {
  return String(rawStatus || '').trim().toUpperCase();
}

function mapWompiResult(result) {
  const transaction = result?.transaction || result || {};
  const status = normalizeWompiStatus(transaction.status);
  const transactionId = transaction.id || transaction.transactionId || null;

  if (status === 'APPROVED') {
    return {
      status: 'approved',
      transactionId,
      message: 'Pago aprobado por Wompi. Ya puede habilitar las descargas del paquete para este predio.',
      wompi: result,
    };
  }

  if (status === 'PENDING' || status === 'PENDING_VALIDATION') {
    return {
      status: 'pending',
      transactionId,
      message: 'El pago quedó pendiente en Wompi. Las descargas seguirán bloqueadas hasta la aprobación.',
      wompi: result,
    };
  }

  if (status === 'DECLINED' || status === 'VOIDED' || status === 'ERROR') {
    return {
      status: 'failed',
      transactionId,
      message: 'Wompi reportó un pago no aprobado. Las descargas permanecen bloqueadas.',
      wompi: result,
    };
  }

  return {
    status: 'cancelled',
    transactionId,
    message: 'El checkout de Wompi se cerró sin un pago aprobado. Las descargas siguen bloqueadas.',
    wompi: result,
  };
}

function loadWompiWidgetScript() {
  if (!isBrowser()) {
    return Promise.reject(new Error('Wompi solo puede iniciarse en el navegador.'));
  }

  if (window.WidgetCheckout) {
    return Promise.resolve(window.WidgetCheckout);
  }

  if (wompiWidgetLoadPromise) {
    return wompiWidgetLoadPromise;
  }

  wompiWidgetLoadPromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      wompiWidgetLoadPromise = null;
      reject(new Error('No fue posible cargar el widget de Wompi. Revise conexion, bloqueadores o consola del navegador.'));
    }, WOMPI_WIDGET_TIMEOUT_MS);

    const clear = () => {
      window.clearTimeout(timeout);
    };

    const resolveWidget = () => {
      clear();
      if (typeof window.WidgetCheckout === 'function') {
        resolve(window.WidgetCheckout);
        return;
      }

      wompiWidgetLoadPromise = null;
      reject(new Error('El script de Wompi cargo, pero WidgetCheckout no quedo disponible.'));
    };

    const rejectLoad = () => {
      clear();
      wompiWidgetLoadPromise = null;
      reject(new Error('Fallo la carga del widget de Wompi.'));
    };

    const existingScript = document.querySelector(`script[src="${WOMPI_WIDGET_SRC}"]`);
    if (existingScript) {
      if (existingScript.dataset.loaded === 'true') {
        resolveWidget();
        return;
      }

      existingScript.addEventListener('load', resolveWidget, { once: true });
      existingScript.addEventListener('error', rejectLoad, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = WOMPI_WIDGET_SRC;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolveWidget();
    };
    script.onerror = rejectLoad;
    document.head.appendChild(script);
  });

  return wompiWidgetLoadPromise;
}

function openWompiWebCheckout(checkoutData) {
  if (!isBrowser()) {
    throw new Error('Wompi solo puede iniciarse en el navegador.');
  }

  const form = document.createElement('form');
  form.method = 'GET';
  form.action = 'https://checkout.wompi.co/p/';
  form.target = '_self';

  const fields = {
    'public-key': checkoutData.publicKey,
    currency: checkoutData.currency,
    'amount-in-cents': checkoutData.amountInCents,
    reference: checkoutData.reference,
    'signature:integrity': checkoutData.signature?.integrity,
    'redirect-url': checkoutData.redirectUrl,
  };

  Object.entries(fields).forEach(([name, value]) => {
    if (value === undefined || value === null || value === '') return;

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = String(value);
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}

async function openWompiWidget(checkoutData, {
  onOpened = null,
  onResult = null,
  onApproved = null,
  onRejected = null,
  onError = null,
} = {}) {
  await loadWompiWidgetScript();

  if (typeof window.WidgetCheckout !== 'function') {
    throw new Error('El widget de Wompi no estuvo disponible en este navegador.');
  }

  const widgetConfig = {
    currency: String(checkoutData.currency || 'COP'),
    amountInCents: Number(checkoutData.amountInCents),
    reference: String(checkoutData.reference),
    publicKey: String(checkoutData.publicKey),
    signature: {
      integrity: String(checkoutData.signature.integrity),
    },
  };

  if (checkoutData.redirectUrl) {
    widgetConfig.redirectUrl = checkoutData.redirectUrl;
  }

  console.info('[CatastroX Wompi] Configuracion lista para WidgetCheckout', {
    currency: widgetConfig.currency,
    amountInCents: widgetConfig.amountInCents,
    reference: widgetConfig.reference,
    hasPublicKey: Boolean(widgetConfig.publicKey),
    hasIntegritySignature: Boolean(widgetConfig.signature?.integrity),
    hasRedirectUrl: Boolean(widgetConfig.redirectUrl),
  });

  console.info('[CatastroX Wompi] Config final WidgetCheckout', {
    publicKeyPrefix: widgetConfig.publicKey.slice(0, 12),
    amountInCents: widgetConfig.amountInCents,
    currency: widgetConfig.currency,
    reference: widgetConfig.reference,
    hasIntegrity: Boolean(widgetConfig.signature?.integrity),
    hasRedirectUrl: Boolean(widgetConfig.redirectUrl),
  });

  const checkout = new window.WidgetCheckout(widgetConfig);
  try {
    onOpened?.({
      checkout: checkoutData,
      openWompiWebCheckout: () => openWompiWebCheckout(checkoutData),
    });

    window.setTimeout(() => {
      try {
        checkout.open((result) => {
          const transaction = result?.transaction;
          void (async () => {
            console.info('[CatastroX Wompi] Callback transaccion', {
              status: transaction?.status,
              id: transaction?.id,
              reference: transaction?.reference,
            });

            onResult?.({
              result,
              transaction,
              checkout: checkoutData,
            });

            if (transaction?.id) {
              try {
                const verified = await verifyWompiTransaction(transaction.id);

                if (
                  verified?.status === 'APPROVED' &&
                  verified?.reference === checkoutData.reference &&
                  Number(verified?.amountInCents) === Number(checkoutData.amountInCents) &&
                  verified?.currency === checkoutData.currency
                ) {
                  onApproved?.({
                    result,
                    transaction: verified,
                    checkout: checkoutData,
                  });
                  return;
                }

                onRejected?.({
                  result,
                  transaction: verified,
                  checkout: checkoutData,
                });
                return;
              } catch (error) {
                console.error('[CatastroX Wompi] Error verificando transaccion', error);
                onError?.(error);
                return;
              }
            }

            onRejected?.({
              result,
              transaction,
              checkout: checkoutData,
            });
          })();
        });

        console.info('[CatastroX Wompi] checkout.open fue invocado');

        window.setTimeout(() => {
          const wompiFrames = Array.from(document.querySelectorAll('iframe')).filter((iframe) => {
            const src = iframe.getAttribute('src') || '';
            return src.includes('wompi') || src.includes('checkout');
          });

          console.info('[CatastroX Wompi] iframes detectados despues de open', {
            count: wompiFrames.length,
            srcs: wompiFrames.map((iframe) => iframe.getAttribute('src')),
          });
        }, 1500);
      } catch (error) {
        console.error('[CatastroX Wompi] Error invocando checkout.open', error);
        onError?.(error);
      }
    }, 0);

    return {
      opened: true,
      checkout: checkoutData,
    };
  } catch (error) {
    console.error('[CatastroX Wompi] Error preparando WidgetCheckout', error);
    onError?.(error);
    throw error;
  }
}

async function requestCheckoutSession({ packageId, lookup }) {
  const checkoutIntent = buildCheckoutUrl({ packageId, lookup });
  if (!checkoutIntent) {
    throw new Error('No fue posible preparar el paquete solicitado.');
  }

  const body = {
    packageId,
    purchaseKey: checkoutIntent.purchaseKey,
    codigoPredial: lookup?.predio?.codigoPredial || lookup?.predio?.codigo || '',
    predioId: lookup?.predio?.id || lookup?.routeId || '',
    routeId: lookup?.routeId || lookup?.predio?.routeId || lookup?.predio?.id || '',
  };

  console.info('[CatastroX Wompi] Checkout backend solicitado', {
    packageId: checkoutIntent.packageId,
    purchaseKey: body.purchaseKey,
  });

  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/checkout`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        if (payload?.code === 'WOMPI_CONFIG_MISSING') {
          return {
            ok: false,
            status: 'config_missing',
            message: payload?.message || 'Wompi Sandbox no está configurado en backend.',
          };
        }

        return {
          ok: false,
          status: 'error',
          message: payload?.message || 'No fue posible iniciar el checkout de Wompi.',
        };
      }

      if (payload?.ok === true) {
        console.info('[CatastroX Wompi] Checkout backend OK', {
          packageId: payload.checkout?.packageId,
          amountInCents: payload.checkout?.amountInCents,
          currency: payload.checkout?.currency,
          reference: payload.checkout?.reference,
          hasPublicKey: Boolean(payload.checkout?.publicKey),
          hasIntegritySignature: Boolean(payload.checkout?.signature?.integrity),
        });

        return {
          ok: true,
          checkout: payload.checkout,
        };
      }

      return {
        ok: false,
        status: 'error',
        message: payload?.message || 'No fue posible iniciar el checkout de Wompi.',
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    status: 'error',
    message:
      lastError instanceof Error
        ? lastError.message
        : 'No fue posible conectar con el backend de pagos de CatastroX.',
  };
}

export async function verifyWompiTransaction(transactionId) {
  const normalizedTransactionId = String(transactionId || '').trim();
  if (!normalizedTransactionId) {
    throw new Error('No se recibio el identificador de transaccion de Wompi.');
  }

  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/verify/${encodeURIComponent(normalizedTransactionId)}`;

    try {
      const response = await fetch(url);
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || data?.detail || 'No fue posible verificar el pago con Wompi.');
      }

      return data.transaction;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No fue posible verificar el pago con Wompi.');
}

export async function startPackageCheckout({
  packageId,
  lookup,
  onCheckoutStart = null,
  onOpened = null,
  onResult = null,
  onApproved = null,
  onRejected = null,
  onError = null,
} = {}) {
  const normalizedPackageId = normalizePackageId(packageId);
  const currentPurchase = getPurchasedPackageForLookup(lookup);

  if (getPackageRank(currentPurchase?.packageId) >= getPackageRank(normalizedPackageId)) {
    return {
      status: 'already_paid',
      message: 'Este paquete ya está habilitado para el predio consultado.',
      purchase: currentPurchase,
    };
  }

  const checkoutResponse = await requestCheckoutSession({ packageId: normalizedPackageId, lookup });

  if (checkoutResponse.ok === true) {
    const wompiConfig = checkoutResponse.checkout;
    validateWompiCheckoutData(wompiConfig);

    markPackageAsPending({
      packageId: normalizedPackageId,
      lookup,
      reference: wompiConfig.reference,
      mode: 'wompi-sandbox',
    });

    if (typeof onCheckoutStart === 'function') {
      onCheckoutStart({
        status: 'wompi_started',
        message: 'Pago iniciado con Wompi. Complete el pago para habilitar descargas.',
        reference: wompiConfig.reference,
      });
    }

    return await openWompiWidget(wompiConfig, {
      onOpened,
      onResult: ({ result, transaction, checkout }) => {
        onResult?.({ result, transaction, checkout });
      },
      onApproved: ({ result, transaction, checkout }) => {
        onApproved?.({ result, transaction, checkout });
      },
      onRejected: ({ result, transaction, checkout }) => {
        const mappedResult = mapWompiResult(result);
        updatePendingPurchaseStatus({
          lookup,
          packageId: normalizedPackageId,
          reference: wompiConfig.reference,
          status: mappedResult.status,
          transactionId: mappedResult.transactionId,
          mode: 'wompi-sandbox',
        });
        onRejected?.({ result, transaction, checkout, mappedResult });
      },
      onError: (error) => {
        updatePendingPurchaseStatus({
          lookup,
          packageId: normalizedPackageId,
          reference: wompiConfig.reference,
          status: 'error',
          mode: 'wompi-sandbox',
        });
        onError?.(error);
      },
    });
  }

  if (checkoutResponse.status === 'config_missing') {
    return {
      status: 'error',
      message: checkoutResponse.message || 'Wompi Sandbox no está configurado en backend.',
    };
  }

  return {
    status: 'error',
    message: checkoutResponse.message || 'No fue posible iniciar el checkout de Wompi.',
  };
}

export function markPackageAsPaid({
  packageId,
  lookup = null,
  purchaseKey = null,
  predioId = null,
  routeId = null,
  codigoPredial = null,
  transactionId,
  reference = null,
  mode = null,
}) {
  const resolvedPurchaseKey = purchaseKey || (lookup ? getLookupPurchaseKey(lookup) : null);
  if (!resolvedPurchaseKey) {
    throw new Error('No se pudo determinar la llave de compra para habilitar el paquete.');
  }

  const store = readPurchaseStore();
  const existingPaidPurchase = lookup ? getPurchasedPackageForLookup(lookup) : store[resolvedPurchaseKey];
  const existingRank = getPackageRank(existingPaidPurchase?.packageId);
  const requestedRank = getPackageRank(packageId);
  const effectivePackageId = existingRank > requestedRank ? existingPaidPurchase.packageId : packageId;

  const record = {
    ...(lookup
      ? buildPurchaseRecordBase(lookup)
      : buildPurchaseRecordBaseFromMeta({
          purchaseKey: resolvedPurchaseKey,
          routeId,
          codigoPredial,
          predioId,
        })),
    packageId: effectivePackageId,
    paid: true,
    status: 'approved',
    reference,
    transactionId: transactionId || `local-${Date.now()}`,
    paidAt: new Date().toISOString(),
    mode: mode || 'wompi-sandbox',
    pendingCheckout: null,
  };

  store[resolvedPurchaseKey] = record;
  writePurchaseStore(store);
  return record;
}

export function markPackageAsPaidByPurchaseKey({
  packageId,
  purchaseKey,
  routeId = null,
  codigoPredial = null,
  predioId = null,
  transactionId,
  reference = null,
  mode = null,
}) {
  return markPackageAsPaid({
    packageId,
    purchaseKey,
    routeId,
    codigoPredial,
    predioId,
    transactionId: transactionId || `wompi-${Date.now()}`,
    reference,
    mode,
  });
}

export function getCatastroxExpectedAmountInCents(packageId) {
  return getExpectedAmountInCents(packageId);
}

export function normalizeCatastroxPackageId(value) {
  return normalizePackageId(value);
}

export function clearPurchaseForLookup(lookup) {
  const purchaseKey = getLookupPurchaseKey(lookup);
  const store = readPurchaseStore();

  if (!store[purchaseKey]) {
    return;
  }

  delete store[purchaseKey];
  writePurchaseStore(store);
}

export function clearAllLocalPurchases() {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.removeItem(PURCHASE_STORAGE_KEY);
  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    window.localStorage.removeItem(legacyKey);
  }
}
