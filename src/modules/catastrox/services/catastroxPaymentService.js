import {
  CATASTROX_PACKAGE_IDS,
  getCatastroxPackage,
  getCatastroxPackageRank,
} from '../config/catastroxPackages.js';

const PURCHASE_STORAGE_KEY = 'catastrox_purchases_v2';
const LEGACY_STORAGE_KEYS = [
  'catastrox_purchases',
  'catastrox_paid_packages',
  'catastrox_package_purchases',
];
const ENV = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};
const WOMPI_PUBLIC_KEY = ENV.VITE_WOMPI_PUBLIC_KEY || '';
const WOMPI_CHECKOUT_URL = ENV.VITE_WOMPI_CHECKOUT_URL || '';

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isLocalhost() {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
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

function readPurchaseStore() {
  const store = readJsonStorage(PURCHASE_STORAGE_KEY);
  return store || {};
}

function writePurchaseStore(store) {
  if (!isBrowser()) return;
  window.localStorage.setItem(PURCHASE_STORAGE_KEY, JSON.stringify(store));
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
  if (!WOMPI_CHECKOUT_URL || !WOMPI_PUBLIC_KEY) {
    return null;
  }

  const url = new URL(WOMPI_CHECKOUT_URL);
  url.searchParams.set('packageId', packageId);
  url.searchParams.set('publicKey', WOMPI_PUBLIC_KEY);

  if (lookup?.routeId) {
    url.searchParams.set('routeId', lookup.routeId);
  }

  if (lookup?.predio?.codigoPredial) {
    url.searchParams.set('codigoPredial', lookup.predio.codigoPredial);
  }

  return url.toString();
}

export async function startPackageCheckout({ packageId, lookup }) {
  const currentPurchase = getPurchasedPackageForLookup(lookup);

  if (getPackageRank(currentPurchase?.packageId) >= getPackageRank(packageId)) {
    return {
      status: 'already_paid',
      message: 'Este paquete ya está habilitado para el predio consultado.',
      purchase: currentPurchase,
    };
  }

  const checkoutUrl = buildCheckoutUrl({ packageId, lookup });
  if (checkoutUrl) {
    return {
      status: 'redirect',
      checkoutUrl,
      message: 'Se abrirá Wompi para completar el pago del paquete seleccionado.',
    };
  }

  if (isLocalhost()) {
    return {
      status: 'simulation_available',
      message: 'Modo local de pruebas habilitado. Simule un pago aprobado para desbloquear únicamente este paquete en este predio.',
    };
  }

  return {
    status: 'pending_configuration',
    message: 'La integración real con Wompi está pendiente de configuración para este entorno.',
  };
}

export function markPackageAsPaid({ packageId, lookup, transactionId }) {
  const purchaseKey = getLookupPurchaseKey(lookup);
  const store = readPurchaseStore();
  const existingPurchase = store[purchaseKey];
  const existingRank = getPackageRank(existingPurchase?.packageId);
  const requestedRank = getPackageRank(packageId);
  const effectivePackageId = existingRank > requestedRank ? existingPurchase.packageId : packageId;
  const routeId = lookup?.routeId || lookup?.predio?.routeId || lookup?.predio?.id || null;
  const codigoPredial = lookup?.predio?.codigoPredial || lookup?.predio?.codigo || null;

  const record = {
    purchaseKey,
    routeId,
    codigoPredial,
    packageId: effectivePackageId,
    paid: true,
    transactionId: transactionId || `local-${Date.now()}`,
    paidAt: new Date().toISOString(),
    mode: WOMPI_CHECKOUT_URL && WOMPI_PUBLIC_KEY ? 'wompi' : 'local-simulated',
  };

  store[purchaseKey] = record;
  writePurchaseStore(store);
  return record;
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

export function canSimulateCatastroxPayment() {
  return isLocalhost() && !buildCheckoutUrl({ packageId: CATASTROX_PACKAGE_IDS.BASICO, lookup: null });
}
