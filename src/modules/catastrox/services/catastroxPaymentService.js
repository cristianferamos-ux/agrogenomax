import { getCatastroxPackage, getCatastroxPackageRank, getCatastroxPackageRoute } from '../config/catastroxPackages.js';
// LOTE-003 (ADR-014 §13/§21): hallazgo de riesgo real corregido aquí --
// fuera de localhost, la implementación anterior usaba
// VITE_API_URL/VITE_AGX_API_URL (si estuviera configurada en build) como
// candidato PRINCIPAL en lugar del relay same-origin, lo que habría
// permitido que un despliegue de staging/producción llamara directamente
// a una URL externa (p. ej. Railway) si esas variables llegaran a
// poblarse. La resolución ahora vive exclusivamente en
// src/config/runtimeConfig.js, que fuera de development local siempre
// devuelve únicamente el relay same-origin (/api).
import { resolveApiBaseCandidates } from '../../../config/runtimeConfig.js';

const PURCHASE_STORAGE_KEY = 'catastrox_purchases_v2';
// LOTE 019-B: contexto no secreto de una compra iniciada, guardado justo antes de
// abrir Wompi y leido por CatastroXWompiReturnPage al volver, ya que la redirectUrl
// enviada a Wompi es intencionalmente limpia (sin packageId/purchaseKey/reference en
// la URL). Nunca debe contener llaves, secretos ni URLs de base de datos.
// LOTE 019-B2: esta clave (ranura unica) quedo demostrada como fragil -- un segundo
// checkout la sobreescribe, y el callback en pagina podia limpiarla antes de que la
// pagina de retorno la necesitara. Se mantiene solo como fuente de lectura legada
// (migracion); el flujo nuevo escribe en PENDING_PAYMENTS_STORE_KEY, indexado por
// reference.
const PENDING_PAYMENT_STORAGE_KEY = 'catastrox_pending_payment_v1';
// LOTE 019-B2: contexto pendiente indexado por reference (una entrada por checkout
// iniciado, no una unica ranura global). Misma prohibicion de contenido sensible que
// la clave legada.
const PENDING_PAYMENTS_STORE_KEY = 'catastrox_pending_payments_v2';
const PENDING_PAYMENTS_MAX_RECORDS = 10;
const LEGACY_STORAGE_KEYS = [
  'catastrox_purchases',
  'catastrox_paid_packages',
  'catastrox_package_purchases',
];
const WOMPI_WIDGET_SRC = 'https://checkout.wompi.co/widget.js';
const WOMPI_WIDGET_TIMEOUT_MS = 15000;
const WOMPI_PLACEHOLDER_PATTERN = /TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO/i;
let wompiWidgetLoadPromise = null;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function getApiBaseCandidates() {
  return resolveApiBaseCandidates();
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

// 30 minutos: tiempo razonable para completar un checkout Sandbox de Wompi. Un
// registro mas viejo que esto se trata como invalido para no reprocesar un intento
// abandonado hace horas/dias contra una transaccion nueva.
const PENDING_PAYMENT_MAX_AGE_MS = 30 * 60 * 1000;

export function isPendingPaymentContextExpired(pending, { nowMs = Date.now() } = {}) {
  if (!pending?.createdAt) return false;
  const createdAtMs = Date.parse(pending.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs > PENDING_PAYMENT_MAX_AGE_MS;
}

// --- LOTE 019-B2: contexto pendiente indexado por reference ---------------------
//
// Diagnostico (LOTE 019-B2, Fase 1): con `catastrox_pending_payment_v1` como ranura
// unica, dos problemas reales quedaron demostrados en pruebas manuales:
//  1) un segundo checkout (mismo predio u otro) sobreescribe la ranura del primero
//     antes de que su retorno se procese;
//  2) el callback en pagina (`startPackageCheckout`'s onApproved wrapper, antes en
//     esta misma linea) borraba la ranura inmediatamente, antes de que
//     CatastroXWompiReturnPage pudiera usarla si el usuario igual llegaba ahi
//     (recarga, redirectUrl que no navego, doble intento manual).
// La pagina de retorno ademas exigia tener el pending ANTES de llamar a
// /verify/:transactionId, cuando lo unico que Wompi entrega de vuelta es `id` -- el
// orden correcto es verificar primero, obtener la reference real, y buscar el
// pending por esa reference.

function readPendingPaymentsStore() {
  return readJsonLocalStorage(PENDING_PAYMENTS_STORE_KEY) || {};
}

function writePendingPaymentsStore(store) {
  if (!isBrowser()) return;
  window.localStorage.setItem(PENDING_PAYMENTS_STORE_KEY, JSON.stringify(store));
}

// Pura: no toca localStorage, solo decide que registros sobreviven. Facilita probar
// la regla de expiracion/limite sin depender del entorno del navegador.
export function pruneExpiredPendingPayments(store, { nowMs = Date.now() } = {}) {
  const entries = Object.entries(store || {}).filter(
    ([, record]) => !isPendingPaymentContextExpired(record, { nowMs }),
  );
  entries.sort(([, a], [, b]) => Date.parse(b?.createdAt || 0) - Date.parse(a?.createdAt || 0));
  return Object.fromEntries(entries.slice(0, PENDING_PAYMENTS_MAX_RECORDS));
}

// Guarda un registro por reference (no una ranura global). Iniciar un nuevo
// checkout nunca elimina los anteriores: cada uno vive bajo su propia reference
// hasta que se complete, falle o expire.
export function savePendingPayment({
  packageId,
  routeId,
  purchaseKey,
  codigoPredial,
  reference,
  expectedAmountInCents,
  currency,
  targetRoute,
}) {
  if (!isBrowser() || !reference) return;

  const record = {
    packageId,
    routeId: routeId || null,
    lookupId: routeId || null,
    purchaseKey: purchaseKey || null,
    codigoPredial: codigoPredial || null,
    reference,
    expectedAmountInCents,
    currency,
    targetRoute: targetRoute || null,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  const store = pruneExpiredPendingPayments(readPendingPaymentsStore());
  store[reference] = record;
  writePendingPaymentsStore(store);
}

export function getPendingPaymentByReference(reference) {
  if (!reference) return null;
  const store = readPendingPaymentsStore();
  return store[reference] || null;
}

// El callback del widget marca el intento como "en curso de confirmacion" en vez de
// borrarlo (LOTE 019-B2, Fase 4): si algo falla entre el callback y que
// markPackageAsPaid se registre, el registro sigue disponible para que la pagina de
// retorno (o un reintento) lo recupere por su reference.
export function updatePendingPaymentStatus(reference, status) {
  if (!isBrowser() || !reference) return;
  const store = readPendingPaymentsStore();
  if (!store[reference]) return;
  store[reference] = { ...store[reference], status, updatedAt: new Date().toISOString() };
  writePendingPaymentsStore(store);
}

// Se elimina unicamente por su propia reference (nunca toda la coleccion), y solo
// debe invocarse despues de confirmar que el pago quedo registrado (markPackageAsPaid
// ya se ejecuto). Tambien limpia la ranura legada si coincide, para no dejar un
// duplicado obsoleto detras.
export function clearPendingPaymentByReference(reference) {
  if (!isBrowser() || !reference) return;

  const store = readPendingPaymentsStore();
  if (store[reference]) {
    delete store[reference];
    writePendingPaymentsStore(store);
  }

  const legacy = readJsonLocalStorage(PENDING_PAYMENT_STORAGE_KEY);
  if (legacy?.reference === reference) {
    window.localStorage.removeItem(PENDING_PAYMENT_STORAGE_KEY);
  }
}

// Reconstruye, de forma segura, un contexto "tipo pending" cuando no hay registro
// vivo en catastrox_pending_payments_v2 para esa reference (LOTE 019-B2, Fase 5).
// Nunca desbloquea solo porque Wompi diga APPROVED: unicamente reconstruye los datos
// (packageId/monto/moneda esperados) para que evaluateWompiReturn los valide igual
// que si vinieran del pending original. Fuentes, en orden:
//  1) catastrox_pending_payment_v1 (ranura legada) si su reference coincide;
//  2) catastrox_purchases_v2, buscando un registro cuya reference coincida --
//     cubre tanto el caso "ya lo marco el callback en pagina" (paid=true, permite
//     una salida idempotente sin reprocesar) como "quedo en pendingCheckout" antes
//     de que el usuario llegara al retorno.
// Si ninguna fuente tiene esa reference, devuelve null: la pagina de retorno debe
// mostrar un error controlado y conservar la evidencia, nunca inventar un contexto.
export function recoverPendingLikeContextForReference(reference) {
  if (!reference) return null;

  const legacy = readJsonLocalStorage(PENDING_PAYMENT_STORAGE_KEY);
  if (legacy?.reference === reference) {
    return { ...legacy, source: 'legacy-v1' };
  }

  const purchases = readPurchaseStore();
  const matchByReference = Object.values(purchases).find(
    (record) => record?.reference === reference || record?.pendingCheckout?.reference === reference,
  );

  if (!matchByReference) return null;

  const packageId = matchByReference.paid === true && matchByReference.reference === reference
    ? matchByReference.packageId
    : matchByReference.pendingCheckout?.packageId || matchByReference.packageId;

  if (!packageId) return null;

  return {
    packageId,
    routeId: matchByReference.routeId || null,
    lookupId: matchByReference.routeId || null,
    purchaseKey: matchByReference.purchaseKey || null,
    codigoPredial: matchByReference.codigoPredial || null,
    reference,
    expectedAmountInCents: getExpectedAmountInCents(packageId),
    currency: 'COP',
    targetRoute: getCatastroxPackageRoute(packageId, matchByReference.routeId),
    createdAt: matchByReference.updatedAt || matchByReference.paidAt || null,
    source: 'purchases-v2',
    alreadyPaid: matchByReference.paid === true && matchByReference.reference === reference,
  };
}

// Evalua, de forma pura, el resultado de Wompi contra el contexto pendiente guardado
// antes de abrir el checkout. No hace red ni toca localStorage: solo decide el
// desenlace para que tanto la pagina de retorno como el callback del widget apliquen
// exactamente la misma regla (monto/referencia/moneda vienen siempre del contexto de
// checkout, nunca de la URL ni de datos que el usuario pueda alterar).
export function evaluateWompiReturn({ verifiedTransaction, pending }) {
  const status = String(verifiedTransaction?.status || '').trim().toUpperCase();

  if (status === 'APPROVED') {
    if (pending?.reference && verifiedTransaction.reference !== pending.reference) {
      return { outcome: 'rejected', reason: 'reference_mismatch', shouldClearPending: false };
    }

    if (Number(verifiedTransaction.amountInCents) !== Number(pending?.expectedAmountInCents)) {
      return { outcome: 'rejected', reason: 'amount_mismatch', shouldClearPending: false };
    }

    if (verifiedTransaction.currency !== (pending?.currency || 'COP')) {
      return { outcome: 'rejected', reason: 'currency_mismatch', shouldClearPending: false };
    }

    return { outcome: 'approved', shouldClearPending: true };
  }

  if (status === 'PENDING' || status === 'PENDING_VALIDATION') {
    // Se conserva el contexto: el usuario debe poder "verificar nuevamente" mas
    // tarde sin perder el predio/paquete que estaba comprando.
    return { outcome: 'pending', shouldClearPending: false };
  }

  // DECLINED, VOIDED, ERROR o cualquier otro estado no aprobado: el intento
  // termino, se limpia el contexto pendiente para no arrastrarlo a un intento futuro.
  return { outcome: 'declined', shouldClearPending: true };
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

async function requestCheckoutSession({ packageId, lookup, customerId, purchaseAttemptId }) {
  const checkoutIntent = buildCheckoutUrl({ packageId, lookup });
  if (!checkoutIntent) {
    throw new Error('No fue posible preparar el paquete solicitado.');
  }

  const normalizedCustomerId = String(customerId || '').trim();
  if (!normalizedCustomerId) {
    // Defensa en profundidad: el backend ya rechaza /checkout sin
    // customerId (CUSTOMER_ID_REQUIRED), pero este cliente nunca debe
    // siquiera intentar la llamada sin un comprador verificado -- evita un
    // round-trip de red innecesario y dejar rastro en logs de un intento
    // mal formado. Se devuelve un resultado (no se lanza) para mantener el
    // mismo contrato de retorno que el resto de esta función.
    return {
      ok: false,
      status: 'error',
      message: 'Debe registrar y verificar sus datos de comprador antes de continuar.',
    };
  }

  const normalizedAttemptId = String(purchaseAttemptId || '').trim();
  if (!normalizedAttemptId) {
    // Defensa en profundidad equivalente a la de customerId -- el backend
    // ya rechaza /checkout sin purchaseAttemptId válido
    // (INVALID_PURCHASE_ATTEMPT_ID), pero este cliente nunca debe intentar
    // la llamada sin uno: sin purchaseAttemptId no hay protección real
    // contra doble clic (ver catastroxPayments.js, buildIdempotencyKey).
    return {
      ok: false,
      status: 'error',
      message: 'No fue posible preparar el intento de compra. Vuelva a intentar desde el resumen.',
    };
  }

  // routeId (== lookup_id, mismo valor en todo este archivo -- nunca dos
  // nombres para la misma identidad) es el ÚNICO campo con el que el
  // backend resuelve el predio de la compra (server/routes/catastroxPayments.js,
  // resolveCheckoutCanonicalPredioId -- SIN fallback hacia ningún otro dato
  // del cliente). Defensa en profundidad equivalente a customerId/
  // purchaseAttemptId arriba: sin routeId, /checkout ya rechaza con 400
  // LOOKUP_REQUIRED, así que este cliente ni siquiera intenta la llamada.
  const normalizedRouteId = String(lookup?.routeId || lookup?.predio?.routeId || lookup?.predio?.id || '').trim();
  if (!normalizedRouteId) {
    return {
      ok: false,
      status: 'error',
      message: 'Debe realizar la búsqueda del predio nuevamente antes de comprar.',
    };
  }

  // Cuerpo exhaustivo a propósito (Bloque 6 del pedido): SOLO estos campos
  // viajan al backend. Nunca precio/amountInCents/currency/reference/
  // transactionId/status/email/datos de documento/datos cifrados/token de
  // sesión -- todo eso lo decide o ya lo tiene el backend por su cuenta
  // (monto desde CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS, sesión desde
  // el cookie HttpOnly que el navegador adjunta solo). canonicalPredioId/
  // codigoPredial YA NO viajan aquí (corrección de seguridad): el backend
  // los ignoraría de todas formas -- resolveCheckoutCanonicalPredioId()
  // los resuelve exclusivamente desde routeId, nunca desde el body.
  // Enviarlos solo arriesgaba un 403 PREDIO_MISMATCH espurio si quedara
  // algún valor residual de localStorage desalineado con el lookup actual.
  const body = {
    packageId,
    customerId: normalizedCustomerId,
    routeId: normalizedRouteId,
    purchaseKey: checkoutIntent.purchaseKey,
    // Protección de doble clic (revisión de seguridad): generado UNA sola
    // vez por CatastroXPackagePage al entrar al resumen final, reutilizado
    // en reintentos del mismo intento -- nunca regenerado por este
    // servicio ni por render.
    purchaseAttemptId: normalizedAttemptId,
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
        // credentials:'include' -- el backend responde Set-Cookie con la
        // credencial de recuperación (HttpOnly, ver
        // server/security/recoveryCookie.js) solo cuando este checkout crea
        // una orden nueva. El navegador la maneja por completo; este código
        // nunca lee ni ve el valor del cookie.
        credentials: 'include',
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

      // El backend ya persistió/validó esta verificación contra la orden
      // (server/routes/catastroxPayments.js) -- `order` (si existe) es la
      // fuente autoritativa de "¿está pagado?", nunca algo que este cliente
      // deba recalcular. Se anexa sin romper a los llamadores existentes
      // que solo leen campos de transacción (status/reference/amountInCents/
      // currency/id) directamente sobre el valor devuelto.
      return { ...data.transaction, order: data.order || null };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No fue posible verificar el pago con Wompi.');
}

// Fuente autoritativa de "¿está pagado?" para un predio+paquete -- el
// backend responde según catastrox_payment_orders (Postgres), nunca según
// nada que este cliente haya guardado. Se llama al montar/cambiar el lookup
// en CatastroXPackagePage, reemplazando la confianza ciega en localStorage
// que causaba el defecto de cobro duplicado (ver informe de auditoría).
//
// El backend ahora exige, además de canonicalPredioId/codigoPredial, la
// credencial de recuperación (cookie HttpOnly emitida por /checkout) --
// conocer el código predial ya NO basta para reconocer un pago como
// propio (defecto de acceso cruzado corregido). Este cliente nunca ve ni
// maneja el valor del cookie; `credentials:'include'` es lo único que hace
// falta para que el navegador lo adjunte solo. La respuesta ya no incluye
// `orderToken` -- ver server/routes/catastroxPayments.js.
export async function checkEntitlement({ canonicalPredioId, codigoPredial, packageId }) {
  const normalizedPackageId = normalizePackageId(packageId);
  const normalizedCanonicalPredioId = String(canonicalPredioId || '').trim();
  const normalizedCodigoPredial = String(codigoPredial || '').trim();

  if (!normalizedCanonicalPredioId && !normalizedCodigoPredial) {
    return { ok: false, isPaid: false, message: 'No se pudo determinar el predio consultado.' };
  }

  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/entitlements/check`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          canonicalPredioId: normalizedCanonicalPredioId || undefined,
          codigoPredial: normalizedCanonicalPredioId ? undefined : normalizedCodigoPredial,
          packageId: normalizedPackageId,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          isPaid: false,
          message: payload?.message || 'No fue posible consultar el estado del pago.',
        };
      }

      return {
        ok: true,
        isPaid: Boolean(payload.isPaid),
        packageId: payload.packageId || normalizedPackageId,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    isPaid: false,
    message:
      lastError instanceof Error
        ? lastError.message
        : 'No fue posible conectar con el backend de pagos de CatastroX.',
  };
}

// Consulta de recuperación por orderToken (capability token opaco, no
// sensible por sí mismo -- ver server/routes/catastroxPayments.js). Vía de
// respaldo cuando ya se tiene un orderToken cacheado localmente (p. ej.
// justo después de un checkout en esta misma sesión), complementaria a
// checkEntitlement().
export async function getOrderStatus(orderToken) {
  const normalizedOrderToken = String(orderToken || '').trim();
  if (!normalizedOrderToken) return null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/orders/${encodeURIComponent(normalizedOrderToken)}/status`;

    try {
      const response = await fetch(url, { credentials: 'include' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) continue;
      return payload.order || null;
    } catch {
      // Se intenta el siguiente candidato de API base; si ninguno responde,
      // se devuelve null -- el llamador debe tratarlo como "desconocido",
      // nunca como "pagado".
    }
  }

  return null;
}

// --- Comprador / verificación de correo (Bloque 2/3/4/5) -----------------
//
// Estas tres funciones nunca escriben nada en localStorage/sessionStorage --
// el formulario (CatastroXBuyerForm/CatastroXOtpVerification) mantiene los
// datos personales solo en estado de React (memoria), y customerId se
// conserva únicamente en memoria durante el flujo (ver CatastroXPackagePage).

/**
 * Crea o actualiza el comprador y dispara el envío del código de
 * verificación. `input` es exactamente lo que el formulario recogió --
 * este cliente no valida más que lo indispensable para no llamar a la red
 * con un objeto vacío; la validación real (única autoritativa) es la del
 * backend (server/services/catastrox/customerValidation.js).
 */
export async function createCustomer(input) {
  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/customers`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(input),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          code: payload?.code || 'CUSTOMER_ERROR',
          message: payload?.message || 'No fue posible registrar sus datos.',
        };
      }

      return {
        ok: true,
        customerId: payload.customerId,
        emailVerificationRequired: Boolean(payload.emailVerificationRequired),
        // Solo presente si el backend corre en development/test (ver
        // server/routes/catastroxPayments.js) -- nunca en staging/producción.
        devOtpCode: payload.devOtpCode || null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    code: 'NETWORK_ERROR',
    message:
      lastError instanceof Error
        ? lastError.message
        : 'No fue posible conectar con el backend de pagos de CatastroX.',
  };
}

/**
 * Verifica el código OTP para un customerId ya creado. El código nunca se
 * guarda en ningún almacenamiento del navegador -- solo viaja en este
 * único POST.
 */
export async function verifyCustomerEmail({ customerId, code }) {
  const normalizedCustomerId = String(customerId || '').trim();
  const normalizedCode = String(code || '').trim();

  if (!normalizedCustomerId || !normalizedCode) {
    return { ok: false, code: 'INVALID_VERIFICATION_REQUEST', message: 'Solicitud inválida.' };
  }

  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/customers/${encodeURIComponent(normalizedCustomerId)}/verify-email`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: normalizedCode }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          code: payload?.code || 'EMAIL_VERIFICATION_ERROR',
          message: payload?.message || 'No fue posible verificar el código.',
        };
      }

      return { ok: true, verified: true };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    code: 'NETWORK_ERROR',
    message:
      lastError instanceof Error
        ? lastError.message
        : 'No fue posible conectar con el backend de pagos de CatastroX.',
  };
}

// --- Historial multiorden en este navegador (Bloque 9) --------------------
//
// Se apoya exclusivamente en la sesión de recuperación HttpOnly
// (credentials:'include') -- este cliente nunca lee ni guarda la lista de
// órdenes en localStorage/sessionStorage; cada llamada vuelve a pedirla al
// backend.
export async function getMyOrders() {
  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/payments/orders/mine`;

    try {
      const response = await fetch(url, { credentials: 'include' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) continue;
      return { ok: true, orders: Array.isArray(payload.orders) ? payload.orders : [] };
    } catch {
      // Se intenta el siguiente candidato; si ninguno responde, se informa
      // el fallo sin fingir una lista vacía como si fuera "sin compras".
    }
  }

  return { ok: false, orders: [], message: 'No fue posible consultar su historial de compras.' };
}

export async function startPackageCheckout({
  packageId,
  lookup,
  customerId,
  purchaseAttemptId,
  targetRoute = null,
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

  const checkoutResponse = await requestCheckoutSession({
    packageId: normalizedPackageId,
    lookup,
    customerId,
    purchaseAttemptId,
  });

  if (checkoutResponse.ok === true) {
    const wompiConfig = checkoutResponse.checkout;

    // El backend ya encontró un derecho APPROVED para este predio+paquete
    // (o uno de rango superior) -- nunca se abre Wompi de nuevo. Esta es la
    // corrección central del defecto de cobro duplicado: la decisión viene
    // de catastrox_payment_orders (Postgres), no de localStorage.
    if (wompiConfig?.status === 'ALREADY_PAID') {
      // Ya NO se marca la caché local como pagada aquí: /checkout no hace
      // (ni puede hacer, por diseño) una verificación de posesión --
      // ALREADY_PAID solo informa que existe una orden aprobada para este
      // predio+paquete, no que el solicitante actual sea quien la posee.
      // La única fuente que puede confirmar eso es checkEntitlement()
      // (cookie de recuperación + hash), que CatastroXPackagePage ya
      // consulta de forma independiente.
      return {
        status: 'already_paid',
        message: wompiConfig.message || 'Este paquete ya fue adquirido para este predio.',
      };
    }

    validateWompiCheckoutData(wompiConfig);

    markPackageAsPending({
      packageId: normalizedPackageId,
      lookup,
      reference: wompiConfig.reference,
      mode: 'wompi-sandbox',
    });

    // El contexto pendiente se guarda aqui -- ya con la sesion de /checkout validada
    // (referencia/monto/moneda reales) y antes de abrir Wompi -- indexado por su
    // propia reference (LOTE 019-B2): iniciar este checkout nunca sobreescribe el
    // registro de un checkout anterior todavia sin resolver.
    savePendingPayment({
      packageId: normalizedPackageId,
      routeId: lookup?.routeId || lookup?.predio?.routeId || lookup?.predio?.id || null,
      // Se recalcula (no se usa wompiConfig.purchaseKey): el backend lo sanitiza/trunca
      // para la referencia de Wompi y ya no coincide con la llave real de
      // localStorage usada por markPackageAsPaid/getStoredPurchaseRecordByKey.
      purchaseKey: getLookupPurchaseKey(lookup),
      codigoPredial: lookup?.predio?.codigoPredial || lookup?.predio?.codigo || null,
      reference: wompiConfig.reference,
      expectedAmountInCents: wompiConfig.amountInCents,
      currency: wompiConfig.currency,
      targetRoute,
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
        // El callback del widget (flujo en pagina, sin navegar a Wompi) ya
        // verifico y marco la compra antes de llegar aqui (ver openWompiWidget).
        // LOTE 019-B2 (Fase 4): ya NO se borra el registro aqui -- se marca como
        // "confirmado por callback" y se deja vivo hasta que el consumidor
        // (CatastroXPackagePage.onApproved, llamado abajo) confirme que
        // markPackageAsPaid ya se ejecuto y recien entonces lo elimine por su
        // reference. Si algo falla entre este punto y ese, el registro sigue
        // disponible para que el usuario lo recupere desde la pagina de retorno.
        updatePendingPaymentStatus(wompiConfig.reference, 'approved-callback');
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
        if (mappedResult.status === 'failed') {
          clearPendingPaymentByReference(wompiConfig.reference);
        }
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
