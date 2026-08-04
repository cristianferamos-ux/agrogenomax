import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import { getCatastroxPackage, getCatastroxPackageRoute } from '../config/catastroxPackages.js';
import {
  fetchCatastroxLookupFullResult,
  getLastLookup,
  resolveLookupForRoute,
  saveLastLookup,
} from '../services/catastroxApi.js';
import {
  clearPendingPaymentByReference,
  downloadDeliverablePdf,
  getMyOrders,
  getPendingPaymentByReference,
  isPendingPaymentContextExpired,
  markPackageAsPaidByPurchaseKey,
  recoverPendingLikeContextForReference,
  retryDeliveryForOrder,
  verifyWompiTransaction,
} from '../services/catastroxPaymentService.js';
import { getDeliveryStatusCopy, getInvoiceStatusCopy } from '../utils/catastroxOrderStatusCopy.js';

const DEFAULT_TARGET_ROUTE = '/catastrox/planes';

export async function recoverLookupForPending(pending) {
  if (!pending?.routeId) return null;

  const inMemory = resolveLookupForRoute(pending.routeId) || getLastLookup();
  if (inMemory) return inMemory;

  try {
    const rehydrated = await fetchCatastroxLookupFullResult(pending.routeId);
    if (rehydrated) {
      saveLastLookup(rehydrated);
    }
    return rehydrated;
  } catch {
    // El paquete puede seguir mostrando descargas via purchaseKey aunque el
    // predio no se pueda re-hidratar de inmediato; CatastroXPackagePage ya
    // maneja routeId+purchaseKey como llave de recuperacion de respaldo.
    return null;
  }
}

export default function CatastroXWompiReturnPage() {
  const [searchParams] = useSearchParams();
  const hasRunRef = useRef(false);
  const [state, setState] = useState({
    status: 'loading',
    message: 'Verificando el pago aprobado con Wompi...',
    transaction: null,
    targetRoute: DEFAULT_TARGET_ROUTE,
  });
  // Estado honesto de entrega/factura (Bloque 8): se completa aparte, vía
  // GET /orders/mine (la única fuente que expone estos dos campos) -- nunca
  // se afirma "enviado"/"facturado" mientras esto siga en null.
  const [deliveryInvoiceState, setDeliveryInvoiceState] = useState(null);
  const [deliveryAction, setDeliveryAction] = useState({});

  const transactionId = searchParams.get('id') || searchParams.get('transaction_id') || '';

  const runVerification = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading', message: 'Verificando el pago aprobado con Wompi...' }));
    setDeliveryInvoiceState(null);

    if (!transactionId) {
      setState({
        status: 'error',
        message: 'No se recibio el identificador de transaccion de Wompi.',
        transaction: null,
        targetRoute: DEFAULT_TARGET_ROUTE,
      });
      return;
    }

    // Wompi solo entrega `id` en el retorno -- se verifica primero contra el
    // backend para obtener la reference real y, sobre todo, el resultado ya
    // persistido y validado server-to-side (verifiedTransaction.order,
    // server/routes/catastroxPayments.js: reference/monto/moneda ya fueron
    // cruzados contra la orden ahí, no aquí). Este componente ya NO decide
    // "¿aprobado?" -- solo refleja lo que el backend diga.
    let verifiedTransaction;

    try {
      verifiedTransaction = await verifyWompiTransaction(transactionId);
    } catch (error) {
      setState({
        status: 'error',
        message: error?.message || 'No fue posible verificar el pago con Wompi.',
        transaction: null,
        targetRoute: DEFAULT_TARGET_ROUTE,
      });
      return;
    }

    const reference = verifiedTransaction.reference || '';

    // `pending` es contexto de UX puramente local (a qué ruta volver, qué
    // routeId usar para re-hidratar el mapa) -- puede faltar por completo
    // (localStorage vacío/perdido, otro navegador, otro equipo) sin que eso
    // impida reconocer un pago aprobado: la fuente de verdad ya es
    // verifiedTransaction.order.
    let pending = reference ? getPendingPaymentByReference(reference) : null;
    if (pending && isPendingPaymentContextExpired(pending)) {
      clearPendingPaymentByReference(reference);
      pending = null;
    }
    if (!pending) {
      pending = recoverPendingLikeContextForReference(reference);
    }

    const order = verifiedTransaction.order;

    if (!order) {
      setState({
        status: 'error',
        message:
          'No fue posible asociar esta transacción a una orden registrada. Vuelve a intentar la compra desde el paquete.',
        transaction: verifiedTransaction,
        targetRoute: pending?.targetRoute || DEFAULT_TARGET_ROUTE,
      });
      return;
    }

    const packageConfig = getCatastroxPackage(order.packageId);
    const fallbackTargetRoute = packageConfig
      ? getCatastroxPackageRoute(order.packageId, pending?.routeId)
      : DEFAULT_TARGET_ROUTE;
    const targetRoute = pending?.targetRoute || fallbackTargetRoute;

    if (order.status === 'PENDING' || order.status === 'CREATED') {
      setState({
        status: 'pending',
        message: `El pago quedo pendiente en Wompi (estado: ${verifiedTransaction.status || 'sin estado'}). Puede verificar nuevamente en unos minutos.`,
        transaction: verifiedTransaction,
        targetRoute,
      });
      return;
    }

    if (order.status !== 'APPROVED') {
      if (reference) clearPendingPaymentByReference(reference);
      setState({
        status: 'error',
        message: `El pago no fue aprobado. Estado reportado: ${verifiedTransaction.status || order.status}.`,
        transaction: verifiedTransaction,
        targetRoute,
      });
      return;
    }

    // order.status === 'APPROVED': ya validado y persistido en backend
    // (idempotente -- llegar aquí de nuevo con la misma transacción, por
    // recarga o doble intento, solo vuelve a leer el mismo resultado, nunca
    // reaprueba). Recuperar el lookup y sincronizar la caché local son
    // pasos de UX, no de autorización.
    const recoveredLookup = pending ? await recoverLookupForPending(pending) : null;

    if (pending?.purchaseKey) {
      markPackageAsPaidByPurchaseKey({
        packageId: order.packageId,
        purchaseKey: pending.purchaseKey,
        routeId: pending.routeId,
        codigoPredial: pending.codigoPredial,
        transactionId: verifiedTransaction.id,
        reference: verifiedTransaction.reference,
        mode: 'wompi-sandbox-verified',
      });
    }

    if (reference) clearPendingPaymentByReference(reference);

    setState({
      status: 'approved',
      message: 'Pago aprobado. Tus descargas quedaron habilitadas para este predio.',
      transaction: verifiedTransaction,
      targetRoute,
      hasLookup: Boolean(recoveredLookup),
      orderToken: order.orderToken || null,
    });
    setDeliveryAction({});

    // Estado honesto de entrega/factura (Bloque 8): se busca por
    // orderToken en el historial de la sesión -- GET /orders/mine es la
    // única vía que expone estos dos campos, /verify no los incluye a
    // propósito (endpoint deliberadamente mínimo). Un fallo aquí nunca
    // debe alterar el estado "approved" ya fijado arriba.
    if (order.orderToken) {
      void getMyOrders().then((result) => {
        if (!result.ok) return;
        const match = result.orders.find((entry) => entry.orderToken === order.orderToken);
        if (match) {
          setDeliveryInvoiceState({ deliveryStatus: match.deliveryStatus, invoiceStatus: match.invoiceStatus });
        }
      });
    }
  }, [transactionId]);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    void runVerification();
  }, [runVerification]);

  const handleRetryVerification = () => {
    void runVerification();
  };

  // El PDF puede estar listo aunque el job de entrega haya quedado FAILED
  // (correo deshabilitado en este entorno -- ajuste obligatorio del plan
  // aprobado, ver EMAIL_PROVIDER_DISABLED en deliveryJobService.js): la
  // descarga se ofrece también en ese caso, nunca solo en SENT.
  const canDownloadDeliverable =
    state.orderToken && ['SENT', 'DELIVERED', 'FAILED'].includes(deliveryInvoiceState?.deliveryStatus);
  const canRetryDelivery = state.orderToken && deliveryInvoiceState?.deliveryStatus === 'FAILED';

  const handleDownloadDeliverable = async () => {
    if (!state.orderToken) return;
    setDeliveryAction({ downloading: true, message: null });
    const result = await downloadDeliverablePdf(state.orderToken);
    setDeliveryAction({
      downloading: false,
      message: result.ok ? null : result.message,
      tone: result.ok ? null : 'danger',
    });
  };

  const handleRetryDelivery = async () => {
    if (!state.orderToken) return;
    setDeliveryAction({ retrying: true, message: null });
    const result = await retryDeliveryForOrder(state.orderToken);
    setDeliveryAction({
      retrying: false,
      message: result.ok ? null : result.message,
      tone: result.ok ? null : 'danger',
    });
    if (result.ok) {
      const refreshed = await getMyOrders();
      if (refreshed.ok) {
        const match = refreshed.orders.find((entry) => entry.orderToken === state.orderToken);
        if (match) {
          setDeliveryInvoiceState({ deliveryStatus: match.deliveryStatus, invoiceStatus: match.invoiceStatus });
        }
      }
    }
  };

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Retorno de pago Wompi</span>
        <h1>{state.status === 'approved' ? 'Pago verificado en CatastroX' : 'Verificando transaccion'}</h1>
        <p>{state.message}</p>
      </div>

      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Estado</span>
          <h2>
            {state.status === 'approved'
              ? 'Pago aprobado y verificado'
              : state.status === 'pending'
                ? 'Pago pendiente en Wompi'
                : 'Validacion del pago'}
          </h2>
        </div>

        <div
          className={
            state.status === 'approved'
              ? 'catastrox-success'
              : 'catastrox-inline-panel'
          }
        >
          <strong>
            {state.status === 'approved' ? (
              <>
                <CheckCircle2 size={18} /> Pago aprobado
              </>
            ) : state.status === 'loading' ? (
              <>
                <Loader2 size={18} /> Verificando
              </>
            ) : (
              <>
                <ShieldAlert size={18} /> {state.status === 'pending' ? 'Pendiente' : 'Validacion pendiente o rechazada'}
              </>
            )}
          </strong>
          <span>{state.message}</span>
        </div>

        {state.transaction ? (
          <div className="catastrox-copy">
            <p><strong>Transaccion:</strong> {state.transaction.id}</p>
            <p><strong>Referencia:</strong> {state.transaction.reference}</p>
            <p><strong>Monto:</strong> {state.transaction.amountInCents} {state.transaction.currency}</p>
            <p><strong>Estado:</strong> {state.transaction.status}</p>
          </div>
        ) : null}

        {state.status === 'pending' ? (
          <div className="catastrox-action-row">
            <button type="button" className="catastrox-button is-secondary" onClick={handleRetryVerification}>
              Verificar nuevamente
            </button>
          </div>
        ) : null}

        <div className="catastrox-action-row">
          <Link className="catastrox-button" to={state.targetRoute || DEFAULT_TARGET_ROUTE}>
            Volver al paquete <ArrowRight size={18} />
          </Link>
          <Link className="catastrox-button is-ghost" to="/catastrox/mis-compras">
            Mis compras
          </Link>
          <Link className="catastrox-button is-ghost" to="/catastrox/planes">
            Ver planes
          </Link>
        </div>
      </section>

      {state.status === 'approved' ? (
        <section className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Entrega y facturación</span>
            <h2>Estado real de sus entregables</h2>
          </div>
          {deliveryInvoiceState ? (
            <>
              <div className={`catastrox-inline-panel is-${getDeliveryStatusCopy(deliveryInvoiceState.deliveryStatus, { paymentApproved: true }).tone}`}>
                <strong>{getDeliveryStatusCopy(deliveryInvoiceState.deliveryStatus, { paymentApproved: true }).label}</strong>
                <span>{getDeliveryStatusCopy(deliveryInvoiceState.deliveryStatus, { paymentApproved: true }).message}</span>
              </div>
              <div className={`catastrox-inline-panel is-${getInvoiceStatusCopy(deliveryInvoiceState.invoiceStatus).tone}`}>
                <strong>{getInvoiceStatusCopy(deliveryInvoiceState.invoiceStatus).label}</strong>
                <span>{getInvoiceStatusCopy(deliveryInvoiceState.invoiceStatus).message}</span>
              </div>
              {canDownloadDeliverable || canRetryDelivery ? (
                <div className="catastrox-action-row">
                  {canDownloadDeliverable ? (
                    <button
                      type="button"
                      className="catastrox-button is-secondary"
                      onClick={handleDownloadDeliverable}
                      disabled={deliveryAction.downloading}
                    >
                      {deliveryAction.downloading ? 'Descargando...' : 'Descargar PDF'}
                    </button>
                  ) : null}
                  {canRetryDelivery ? (
                    <button
                      type="button"
                      className="catastrox-button is-secondary"
                      onClick={handleRetryDelivery}
                      disabled={deliveryAction.retrying}
                    >
                      {deliveryAction.retrying ? 'Reintentando...' : 'Reintentar envío'}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {deliveryAction.message ? (
                <p className={`catastrox-copy is-${deliveryAction.tone || 'warning'}`}>{deliveryAction.message}</p>
              ) : null}
            </>
          ) : (
            <p className="catastrox-copy">Consultando estado de entrega y facturación...</p>
          )}
        </section>
      ) : null}

      <CatastroXDisclaimer />
    </section>
  );
}
