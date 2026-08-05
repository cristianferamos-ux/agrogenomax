// Copys de estado honestos (Bloque 8/9 del pedido) -- fuente única
// compartida por CatastroXMyPurchases, CatastroXPackagePage y
// CatastroXWompiReturnPage, para que ninguna pantalla afirme "enviado" o
// "facturado" cuando el backend todavía no lo confirmó de verdad.

// CATX-POSTPAYMENT-UX-001 (defecto B): los montos de orden que llegan del
// backend (state.transaction.amountInCents, order.expectedAmountInCents,
// etc.) están en CENTAVOS -- mostrarlos crudos ("3990000 COP") es el
// defecto reportado. Única utilidad de formateo para toda vista que
// muestre el monto de una orden (retorno Wompi, verificación manual, y
// cualquier vista futura de compras/comprobantes) -- misma convención de
// salida ($<monto> COP) que formatCatastroxPackagePrice en
// catastroxPackages.js (que ya formatea priceCop, un valor en pesos
// enteros, no en centavos -- unidades distintas, por eso no se comparte
// una sola función entre ambos, pero el estilo de salida es idéntico).
// Nunca toca el valor real enviado a Wompi ni el almacenado en base de
// datos -- es puramente de presentación.
export function formatCopFromCents(value) {
  const cents = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(cents)) {
    return 'Monto no disponible';
  }

  const pesos = cents / 100;
  // Intl.NumberFormat('es-CO') sin opciones explícitas ya usa punto como
  // separador de miles, coma como decimal, y omite decimales cuando el
  // valor es un entero (no hay que calcular "hasFraction" a mano).
  return `$${new Intl.NumberFormat('es-CO').format(pesos)} COP`;
}

export function getPaymentStatusCopy(status) {
  switch (status) {
    case 'APPROVED':
      return { label: 'Pago aprobado', tone: 'success' };
    case 'CREATED':
    case 'PENDING':
      return { label: 'Pago pendiente', tone: 'warning' };
    case 'DECLINED':
      return { label: 'Pago rechazado', tone: 'danger' };
    case 'VOIDED':
      return { label: 'Pago anulado', tone: 'danger' };
    case 'ERROR':
      return { label: 'Error de verificación del pago', tone: 'danger' };
    case 'EXPIRED':
      return { label: 'Pago expirado', tone: 'danger' };
    default:
      return { label: 'Estado desconocido', tone: 'warning' };
  }
}

// Textos EXACTOS requeridos por el pedido (CATX-DELIVERY-001) para los 4
// estados de entrega que el usuario final debe ver. El backend usa el enum
// completo de catastrox_delivery_job_status (9 valores, ver
// server/services/catastrox/deliveryJobService.js) -- aquí se colapsa a los
// 4 pedidos: QUEUED->PENDING, GENERATING/READY/SENDING->PROCESSING,
// SENT->SENT, FAILED->FAILED. DELIVERED/EXPIRED no los usa el pipeline
// actual pero quedan mapeados de forma razonable (no eliminados del enum).
const PENDING_MESSAGE = 'Estamos preparando tus archivos.';
const PROCESSING_MESSAGE = 'Generando tu diagnóstico predial.';
const SENT_MESSAGE = 'Entregable enviado al correo y disponible para descarga.';
const FAILED_MESSAGE = 'No fue posible completar el envío. Puedes reintentar o contactar soporte.';

export function getDeliveryStatusCopy(status, { paymentApproved = false } = {}) {
  switch (status) {
    case 'SENT':
    case 'DELIVERED':
      return { label: 'Entregado', message: SENT_MESSAGE, tone: 'success' };
    case 'SENDING':
    case 'READY':
    case 'GENERATING':
      return { label: 'En proceso', message: PROCESSING_MESSAGE, tone: 'warning' };
    case 'QUEUED':
      return { label: 'En preparación', message: PENDING_MESSAGE, tone: 'warning' };
    case 'FAILED':
      return { label: 'Envío no completado', message: FAILED_MESSAGE, tone: 'warning' };
    case 'EXPIRED':
      return { label: 'Ventana de entrega expirada', message: 'Contacte soporte para reactivar la entrega.', tone: 'danger' };
    case 'WAITING_FOR_PAYMENT':
    case 'NOT_STARTED':
    default:
      return {
        label: paymentApproved ? 'Pendiente de generación' : 'Pendiente de aprobación del pago',
        message: paymentApproved
          ? PENDING_MESSAGE
          : 'La generación de archivos comienza únicamente después de un pago aprobado.',
        tone: 'warning',
      };
  }
}

// CATX-POSTPAYMENT-UX-001 (defecto A): estados de catastrox_delivery_job_status
// que representan un desenlace FINAL -- una vez alcanzado uno, dejar de
// consultar el backend (detener el polling de CatastroXWompiReturnPage.jsx)
// tiene sentido. Exportado como función pura (no un Set importado
// directamente) para que tanto el componente como sus pruebas puedan usar
// la misma regla sin repetirla.
const TERMINAL_DELIVERY_STATUSES = new Set(['SENT', 'DELIVERED', 'FAILED', 'EXPIRED']);

export function isTerminalDeliveryStatus(status) {
  return TERMINAL_DELIVERY_STATUSES.has(status);
}

// Decide, de forma pura (sin timers/DOM/red), si conviene iniciar el
// polling de estado de entrega -- extraído para poder probar la regla
// exacta sin montar el componente (este proyecto no tiene un harness de
// pruebas de componentes React; toda la lógica de decisión se prueba como
// función pura, siguiendo el mismo patrón que recoverLookupForPending en
// CatastroXWompiReturnPage.jsx).
export function shouldStartDeliveryPolling({ paymentStatus, orderToken, currentDeliveryStatus } = {}) {
  if (paymentStatus !== 'approved' || !orderToken) return false;
  if (currentDeliveryStatus && isTerminalDeliveryStatus(currentDeliveryStatus)) return false;
  return true;
}

// Decide qué hacer en UN tick del polling -- 'timeout' si ya se agotó el
// tiempo máximo (requisito: nunca presentar esto como error, solo dejar de
// consultar automáticamente); 'stop' si el nuevo estado ya es terminal;
// 'continue' en cualquier otro caso (seguir esperando el próximo tick).
export function resolveDeliveryPollTick({ elapsedMs, maxDurationMs, nextDeliveryStatus = null } = {}) {
  if (elapsedMs >= maxDurationMs) {
    return { action: 'timeout' };
  }
  if (nextDeliveryStatus && isTerminalDeliveryStatus(nextDeliveryStatus)) {
    return { action: 'stop' };
  }
  return { action: 'continue' };
}

// Copy exacto pedido (requisito 3/4 de CATX-POSTPAYMENT-UX-001) para la
// pantalla de retorno Wompi -- distinto del texto genérico de
// getDeliveryStatusCopy (que sigue usándolo CatastroXMyPurchases/
// CatastroXPackagePage sin cambios, fuera del alcance de este defecto).
// FAILED reutiliza el texto genérico tal cual porque ya coincide
// (label "Envío no completado" + mensaje amigable ya existían).
export function getWompiReturnDeliveryCopy(status) {
  if (status === 'SENT' || status === 'DELIVERED') {
    return { label: 'Entrega completada', message: 'Tu diagnóstico predial está disponible.', tone: 'success' };
  }
  return getDeliveryStatusCopy(status, { paymentApproved: true });
}

export function getInvoiceStatusCopy(status) {
  switch (status) {
    case 'ISSUED':
      return { label: 'Factura emitida', message: 'La factura electrónica fue emitida.', tone: 'success' };
    case 'PENDING':
      return { label: 'Factura en proceso', message: 'La factura electrónica está en proceso de emisión.', tone: 'warning' };
    case 'FAILED':
      return { label: 'Error al emitir factura', message: 'No fue posible emitir la factura todavía. Contacte soporte.', tone: 'warning' };
    case 'CANCELLED':
      return { label: 'Factura cancelada', message: 'La solicitud de factura fue cancelada.', tone: 'danger' };
    case 'NOT_REQUESTED':
    default:
      return {
        label: 'Factura no disponible todavía',
        message: 'Facturación electrónica pendiente de integración con el operador autorizado.',
        tone: 'warning',
      };
  }
}
