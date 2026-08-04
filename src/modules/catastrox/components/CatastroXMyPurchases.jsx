import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getCatastroxPackage } from '../config/catastroxPackages.js';
import { downloadDeliverablePdf, getMyOrders, retryDeliveryForOrder } from '../services/catastroxPaymentService.js';
import { getDeliveryStatusCopy, getInvoiceStatusCopy, getPaymentStatusCopy } from '../utils/catastroxOrderStatusCopy.js';

// El PDF puede estar generado y disponible para descarga incluso con el job
// de entrega en FAILED (p. ej. correo deshabilitado en este entorno, ver
// deliveryJobService.js/EMAIL_PROVIDER_DISABLED -- ajuste obligatorio del
// plan aprobado: nunca ocultar que el archivo sí quedó listo). Por eso el
// botón de descarga se intenta también en FAILED, no solo en SENT.
const DOWNLOADABLE_DELIVERY_STATUSES = new Set(['SENT', 'DELIVERED', 'FAILED']);

/**
 * "Mis compras en este navegador" (Bloque 9 del pedido). Se apoya
 * exclusivamente en GET /orders/mine (sesión de recuperación HttpOnly) --
 * este componente nunca lee ni escribe la lista de órdenes en
 * localStorage/sessionStorage; cada montaje/actualización vuelve a
 * pedirla al backend.
 */
export default function CatastroXMyPurchases() {
  const [state, setState] = useState({ status: 'loading', orders: [] });
  const [actions, setActions] = useState({});

  async function load() {
    setState((current) => ({ ...current, status: 'loading' }));
    const result = await getMyOrders();
    if (!result.ok) {
      setState({ status: 'error', orders: [] });
      return;
    }
    setState({ status: 'ready', orders: result.orders });
  }

  useEffect(() => {
    void load();
  }, []);

  function setOrderAction(orderToken, patch) {
    setActions((current) => ({ ...current, [orderToken]: { ...current[orderToken], ...patch } }));
  }

  async function handleDownload(orderToken) {
    setOrderAction(orderToken, { downloading: true, message: null });
    const result = await downloadDeliverablePdf(orderToken);
    setOrderAction(orderToken, {
      downloading: false,
      message: result.ok ? null : result.message,
      tone: result.ok ? null : 'danger',
    });
  }

  async function handleRetry(orderToken) {
    setOrderAction(orderToken, { retrying: true, message: null });
    const result = await retryDeliveryForOrder(orderToken);
    setOrderAction(orderToken, {
      retrying: false,
      message: result.ok ? null : result.message,
      tone: result.ok ? null : 'danger',
    });
    if (result.ok) {
      await load();
    }
  }

  return (
    <section className="catastrox-card">
      <div className="catastrox-section-heading">
        <span>Historial en este navegador</span>
        <h2>Mis compras</h2>
      </div>
      <p className="catastrox-copy">
        Este listado se basa únicamente en la sesión de este navegador. Si borra las cookies o usa otro dispositivo, no
        aparecerá aquí.
      </p>

      <div className="catastrox-action-row">
        <button type="button" className="catastrox-button is-secondary" onClick={load} disabled={state.status === 'loading'}>
          <RefreshCw size={16} /> {state.status === 'loading' ? 'Cargando...' : 'Actualizar'}
        </button>
      </div>

      {state.status === 'error' ? (
        <div className="catastrox-inline-panel">
          <strong>No fue posible cargar su historial</strong>
          <span>Intente nuevamente en unos minutos.</span>
        </div>
      ) : null}

      {state.status === 'ready' && state.orders.length === 0 ? (
        <div className="catastrox-inline-panel">
          <strong>Sin compras registradas en este navegador</strong>
          <span>Cuando complete una compra, aparecerá en este listado.</span>
        </div>
      ) : null}

      {state.orders.length > 0 ? (
        <div className="catastrox-table">
          {state.orders.map((order) => {
            const pkg = getCatastroxPackage(order.packageId);
            const paymentCopy = getPaymentStatusCopy(order.paymentStatus);
            const deliveryCopy = getDeliveryStatusCopy(order.deliveryStatus, {
              paymentApproved: order.paymentStatus === 'APPROVED',
            });
            const invoiceCopy = getInvoiceStatusCopy(order.invoiceStatus);
            const orderAction = actions[order.orderToken] || {};
            const isApproved = order.paymentStatus === 'APPROVED';
            const canDownload = isApproved && DOWNLOADABLE_DELIVERY_STATUSES.has(order.deliveryStatus);
            const canRetry = isApproved && order.deliveryStatus === 'FAILED';

            return (
              <div key={order.orderToken}>
                <span>Paquete</span>
                <strong>{pkg?.label || order.packageId}</strong>
                <span>Predio</span>
                <strong>{order.codigoPredial || 'Sin código predial'}</strong>
                <span>Fecha</span>
                <strong>{order.createdAt ? new Date(order.createdAt).toLocaleDateString('es-CO') : '—'}</strong>
                <span>Pago</span>
                <strong className={`catastrox-status is-${paymentCopy.tone}`}>{paymentCopy.label}</strong>
                <span>Entregables</span>
                <strong className={`catastrox-status is-${deliveryCopy.tone}`}>{deliveryCopy.label}</strong>
                <span>Factura</span>
                <strong className={`catastrox-status is-${invoiceCopy.tone}`}>{invoiceCopy.label}</strong>
                {canDownload || canRetry ? (
                  <>
                    <span>Acciones</span>
                    <div className="catastrox-action-row">
                      {canDownload ? (
                        <button
                          type="button"
                          className="catastrox-button is-secondary"
                          onClick={() => handleDownload(order.orderToken)}
                          disabled={orderAction.downloading}
                        >
                          {orderAction.downloading ? 'Descargando...' : 'Descargar PDF'}
                        </button>
                      ) : null}
                      {canRetry ? (
                        <button
                          type="button"
                          className="catastrox-button is-secondary"
                          onClick={() => handleRetry(order.orderToken)}
                          disabled={orderAction.retrying}
                        >
                          {orderAction.retrying ? 'Reintentando...' : 'Reintentar envío'}
                        </button>
                      ) : null}
                    </div>
                    {orderAction.message ? (
                      <span className={`catastrox-status is-${orderAction.tone || 'warning'}`}>{orderAction.message}</span>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
