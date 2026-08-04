// Copys de estado honestos (Bloque 8/9 del pedido) -- fuente única
// compartida por CatastroXMyPurchases, CatastroXPackagePage y
// CatastroXWompiReturnPage, para que ninguna pantalla afirme "enviado" o
// "facturado" cuando el backend todavía no lo confirmó de verdad.

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
