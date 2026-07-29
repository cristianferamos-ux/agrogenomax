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

// Texto EXACTO requerido para el único modo de fallo real hoy
// (SERVER_SIDE_GENERATION_NOT_IMPLEMENTED, ver deliveryJobService.js) --
// nunca se muestra "enviado" para una orden en este estado.
const DELIVERY_NOT_IMPLEMENTED_MESSAGE =
  'Pago aprobado. Estamos preparando la generación y entrega de los archivos. ' +
  'El sistema de envío automático aún no está disponible en este entorno. ' +
  'Conserva la referencia de tu orden y contacta soporte.';

export function getDeliveryStatusCopy(status, { paymentApproved = false } = {}) {
  switch (status) {
    case 'DELIVERED':
      return { label: 'Entregados', message: 'Los archivos fueron entregados a su correo.', tone: 'success' };
    case 'SENT':
      return { label: 'Enviados', message: 'Los archivos fueron enviados a su correo.', tone: 'success' };
    case 'SENDING':
      return { label: 'Envío en proceso', message: 'El envío de los archivos está en curso.', tone: 'warning' };
    case 'READY':
      return { label: 'Archivos listos', message: 'Los archivos están listos, en espera de envío.', tone: 'warning' };
    case 'GENERATING':
      return { label: 'Generando archivos', message: 'Estamos generando los archivos de su compra.', tone: 'warning' };
    case 'QUEUED':
      return { label: 'En cola para generación', message: 'Su solicitud está en cola para generarse.', tone: 'warning' };
    case 'FAILED':
      return { label: 'Error de generación/envío', message: DELIVERY_NOT_IMPLEMENTED_MESSAGE, tone: 'warning' };
    case 'EXPIRED':
      return { label: 'Ventana de entrega expirada', message: 'Contacte soporte para reactivar la entrega.', tone: 'danger' };
    case 'WAITING_FOR_PAYMENT':
    case 'NOT_STARTED':
    default:
      return {
        label: paymentApproved ? 'Pendiente de generación' : 'Pendiente de aprobación del pago',
        message: paymentApproved
          ? 'Su pago fue aprobado; la generación de archivos todavía no ha comenzado.'
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
      return { label: 'Factura no disponible todavía', message: 'La facturación electrónica todavía no ha sido solicitada.', tone: 'warning' };
  }
}
