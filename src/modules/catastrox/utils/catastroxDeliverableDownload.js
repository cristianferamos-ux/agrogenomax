// CATX-DELIVERABLE-CANONICAL-001: lógica de decisión pura para la descarga
// del PDF oficial desde CatastroXPackagePage.jsx ("Descargas habilitadas").
// Vive en un archivo aparte (sin importar React/leaflet/nada del árbol de
// la página) a propósito -- CatastroXPackagePage.jsx importa
// CatastroXMockMap.jsx, que a su vez importa leaflet, una librería que
// accede a `window`/`document` a nivel de módulo; cargarla en node:test
// (incluso vía Vite ssrLoadModule) exige simular un DOM completo. Aislar
// esta lógica de negocio aquí la hace importable y probable directamente
// con node:test puro, sin ese costo.
import { getPackageRank } from '../services/catastroxPaymentService.js';

// La respuesta de error del backend para GET .../deliverable/download
// (server/routes/catastroxPayments.js) solo trae `code`, nunca `message`
// -- este mapa produce el mensaje claro que pide el requisito 2 del
// pedido, uno por cada código real que ese endpoint puede devolver
// (401/403/404); 409 no aplica a este endpoint específico (solo lo usa
// POST .../delivery/retry, sin relación con esta descarga), por eso no
// tiene una entrada propia aquí.
export function resolveDeliverableDownloadErrorMessage(code) {
  switch (code) {
    case 'SESSION_REQUIRED':
      return 'Tu sesión de compra expiró. Vuelve a verificar tu pago para poder descargar el PDF oficial.';
    case 'ORDER_ACCESS_DENIED':
      return 'Esta descarga no pertenece a tu sesión actual.';
    case 'DELIVERABLE_NOT_READY':
      return 'El PDF oficial todavía se está generando. Intenta de nuevo en unos segundos.';
    case 'ORDER_NOT_FOUND':
      return 'No se encontró una compra aprobada para este predio.';
    default:
      return 'No fue posible descargar el PDF oficial. Intenta nuevamente.';
  }
}

// Decide si un clic de descarga debe usar el endpoint oficial del backend
// (compra real) o el generador de navegador heredado (solo modo
// auditoría local, que nunca crea una orden real).
export function shouldUseOfficialPdfDownload({ fileType, useAuditEndpoint }) {
  return fileType === 'pdf' && !useAuditEndpoint;
}

export async function executeCatastroxPackageDownloadDecision({
  fileType,
  useAuditEndpoint,
  deliverableOrderToken,
  officialDownload,
  localDownload,
}) {
  if (shouldUseOfficialPdfDownload({ fileType, useAuditEndpoint })) {
    return {
      mode: 'official',
      result: await officialDownload(deliverableOrderToken),
    };
  }

  return {
    mode: 'local',
    result: await localDownload(),
  };
}

// Encuentra, entre las órdenes de la sesión (GET /orders/mine, ya ordenadas
// por created_at desc por el backend), la orden APROBADA compatible con el
// paquete que se está viendo -- mismo codigoPredial, estado APPROVED, y
// rango de paquete >= al paquete actual (nunca una orden de rango inferior:
// isPackageUnlockedForLookup/checkEntitlement ya garantizan que "isPaid"
// para requiredPackageId solo es true si existe una orden de rango >=, así
// que este mismo filtro aquí es una segunda verificación explícita --
// nunca confía únicamente en el estado optimista local de "isPaid"). Si hay
// varias órdenes compatibles (p. ej. una compra de rango inferior seguida
// de una de rango superior), se prefiere la de mayor rango -- y ante un
// empate de rango, la más reciente (orders ya viene ordenado por
// created_at desc, y reduce conserva el primer elemento -- el más
// reciente -- cuando ninguna candidata posterior tiene rango
// estrictamente mayor).
export function resolveDeliverableOrderTokenForPredio({ orders, codigoPredial, requiredPackageId = null }) {
  const normalizedCodigoPredial = String(codigoPredial || '').trim();
  if (!normalizedCodigoPredial || !Array.isArray(orders) || !orders.length) return null;

  const requiredRank = requiredPackageId ? getPackageRank(requiredPackageId) : null;
  const approvedMatches = orders.filter((order) => {
    if (order.paymentStatus !== 'APPROVED') return false;
    if (String(order.codigoPredial || '').trim() !== normalizedCodigoPredial) return false;
    if (requiredRank != null && getPackageRank(order.packageId) < requiredRank) return false;
    return true;
  });
  if (!approvedMatches.length) return null;

  const best = approvedMatches.reduce((current, candidate) =>
    getPackageRank(candidate.packageId) > getPackageRank(current.packageId) ? candidate : current,
  );
  return best.orderToken;
}
