import {
  doesCatastroxPackageSatisfy,
  getCatastroxPackage,
  getCatastroxPackageRank,
} from '../config/catastroxPackages.js';

const PURCHASE_STORAGE_KEY = 'catastrox_paid_packages';
const WOMPI_PUBLIC_KEY = String(import.meta.env.VITE_WOMPI_PUBLIC_KEY || import.meta.env.VITE_CATASTROX_WOMPI_PUBLIC_KEY || '').trim();
const WOMPI_CHECKOUT_URL = String(import.meta.env.VITE_CATASTROX_WOMPI_CHECKOUT_URL || '').trim();

function isLocalhost() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

function readPurchaseStore() {
  if (typeof window === 'undefined') return {};

  const raw = window.localStorage?.getItem(PURCHASE_STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePurchaseStore(store) {
  if (typeof window === 'undefined') return;
  window.localStorage?.setItem(PURCHASE_STORAGE_KEY, JSON.stringify(store));
}

function buildRouteIdFromLookup(lookup) {
  return lookup?.routeId || lookup?.predio?.routeId || lookup?.predio?.id || null;
}

function buildCheckoutUrl({ packageId, routeId }) {
  const url = new URL(WOMPI_CHECKOUT_URL);
  url.searchParams.set('packageId', packageId);
  url.searchParams.set('routeId', routeId);
  if (WOMPI_PUBLIC_KEY) {
    url.searchParams.set('publicKey', WOMPI_PUBLIC_KEY);
  }
  return url.toString();
}

export function getPurchasedPackageForLookup(routeId) {
  if (!routeId) return null;
  const store = readPurchaseStore();
  return store[String(routeId)] || null;
}

export function markPackageAsPaid({ routeId, packageId, transactionId }) {
  if (!routeId) {
    throw new Error('routeId es obligatorio para registrar el pago.');
  }

  const pkg = getCatastroxPackage(packageId);
  if (!pkg) {
    throw new Error(`Paquete desconocido: ${packageId}.`);
  }

  const store = readPurchaseStore();
  const current = store[String(routeId)] || null;

  const nextRecord =
    current && getCatastroxPackageRank(current.packageId) > getCatastroxPackageRank(packageId)
      ? {
          ...current,
          transactionId: current.transactionId || transactionId || `local-${Date.now()}`,
          source: current.source || 'wompi',
        }
      : {
          routeId: String(routeId),
          packageId,
          transactionId: transactionId || `local-${Date.now()}`,
          paidAt: new Date().toISOString(),
          source: isLocalhost() ? 'localhost-simulado' : 'wompi',
        };

  store[String(routeId)] = nextRecord;
  writePurchaseStore(store);
  return nextRecord;
}

export function canSimulateCatastroxPayment() {
  return isLocalhost();
}

export function isCatastroxPackageUnlocked(routeId, requiredPackageId) {
  const purchase = getPurchasedPackageForLookup(routeId);
  if (!purchase) return false;
  return doesCatastroxPackageSatisfy(requiredPackageId, purchase.packageId);
}

export async function startPackageCheckout({ packageId, lookup }) {
  const pkg = getCatastroxPackage(packageId);
  if (!pkg) {
    throw new Error(`Paquete desconocido: ${packageId}.`);
  }

  const routeId = buildRouteIdFromLookup(lookup);
  if (!routeId) {
    throw new Error('No fue posible identificar la consulta para iniciar el pago.');
  }

  const current = getPurchasedPackageForLookup(routeId);
  if (current && doesCatastroxPackageSatisfy(packageId, current.packageId)) {
    return {
      status: 'already_paid',
      routeId,
      packageId: current.packageId,
      purchase: current,
    };
  }

  if (WOMPI_CHECKOUT_URL) {
    return {
      status: 'redirect',
      routeId,
      packageId,
      checkoutUrl: buildCheckoutUrl({ packageId, routeId }),
    };
  }

  if (canSimulateCatastroxPayment()) {
    return {
      status: 'simulation_available',
      routeId,
      packageId,
      message: 'Modo local: puede simular el pago aprobado mientras se conecta Wompi real.',
    };
  }

  return {
    status: 'pending_configuration',
    routeId,
    packageId,
    message: 'La integración real con Wompi está lista para conectarse, pero aún no se ha configurado en este entorno.',
  };
}
