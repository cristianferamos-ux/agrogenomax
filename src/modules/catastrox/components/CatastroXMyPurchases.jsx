import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getCatastroxPackage } from '../config/catastroxPackages.js';
import { getMyOrders } from '../services/catastroxPaymentService.js';
import { getDeliveryStatusCopy, getInvoiceStatusCopy, getPaymentStatusCopy } from '../utils/catastroxOrderStatusCopy.js';

/**
 * "Mis compras en este navegador" (Bloque 9 del pedido). Se apoya
 * exclusivamente en GET /orders/mine (sesión de recuperación HttpOnly) --
 * este componente nunca lee ni escribe la lista de órdenes en
 * localStorage/sessionStorage; cada montaje/actualización vuelve a
 * pedirla al backend.
 */
export default function CatastroXMyPurchases() {
  const [state, setState] = useState({ status: 'loading', orders: [] });

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
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
