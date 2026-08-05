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
import {
  getInvoiceStatusCopy,
  formatCopFromCents,
  getWompiReturnDeliveryCopy,
  isTerminalDeliveryStatus,
  resolveDeliveryPollTick,
  shouldStartDeliveryPolling,
} from '../utils/catastroxOrderStatusCopy.js';

const DEFAULT_TARGET_ROUTE = '/catastrox/planes';

// CATX-POSTPAYMENT-UX-001 (defecto A): el estado de entrega solo se
// consultaba UNA vez, justo después de confirmar el pago -- en ese
// instante el job de entrega casi siempre sigue QUEUED/GENERATING (se
// procesa de forma desacoplada, fire-and-forget, tras el pago), así que la
// pantalla quedaba congelada en "En proceso" para siempre, aunque el
// backend terminara segundos después.
const DELIVERY_POLL_INTERVAL_MS = 2000;
const DELIVERY_POLL_MAX_DURATION_MS = 30000;

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
  // true solo cuando los 30s de polling se agotaron sin llegar a un estado
  // terminal -- nunca se presenta como error (requisito 5): el job puede
  // seguir procesándose, solo dejamos de consultarlo automáticamente y
  // ofrecemos un botón para que el usuario lo haga cuando quiera.
  const [pollTimedOut, setPollTimedOut] = useState(false);
  // Espejo en ref del último deliveryInvoiceState conocido -- permite que
  // el efecto de polling (más abajo) lea el valor más reciente sin tener
  // que declarar deliveryInvoiceState como dependencia (eso reiniciaría el
  // temporizador de 30s en cada actualización de estado, no solo cuando
  // cambia realmente la orden que se está siguiendo).
  const deliveryInvoiceStateRef = useRef(null);
  // Evita que dos consultas de estado (dos ticks del polling, o un tick y
  // un refresco manual) viajen en paralelo -- "evitar requests duplicados"
  // del requisito funcional.
  const fetchInFlightRef = useRef(false);

  useEffect(() => {
    deliveryInvoiceStateRef.current = deliveryInvoiceState;
  }, [deliveryInvoiceState]);

  const transactionId = searchParams.get('id') || searchParams.get('transaction_id') || '';

  // Única vía de lectura del estado de entrega/factura -- usada tanto por
  // el chequeo inicial (dentro de runVerification) como por cada tick del
  // polling y por el refresco manual, para no duplicar la lógica de
  // búsqueda por orderToken en tres lugares distintos.
  const fetchDeliveryInvoiceState = useCallback(async (orderToken) => {
    if (!orderToken || fetchInFlightRef.current) return null;
    fetchInFlightRef.current = true;
    try {
      const result = await getMyOrders();
      if (!result.ok) return null;
      const match = result.orders.find((entry) => entry.orderToken === orderToken);
      return match ? { deliveryStatus: match.deliveryStatus, invoiceStatus: match.invoiceStatus } : null;
    } finally {
      fetchInFlightRef.current = false;
    }
  }, []);

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
      void fetchDeliveryInvoiceState(order.orderToken).then((next) => {
        if (next) setDeliveryInvoiceState(next);
      });
    }
  }, [transactionId, fetchDeliveryInvoiceState]);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    void runVerification();
  }, [runVerification]);

  // CATX-POSTPAYMENT-UX-001 (defecto A): polling controlado del estado de
  // entrega -- arranca únicamente después de que el pago quede APPROVED
  // (con un orderToken real), y se detiene solo: (a) al llegar a un
  // estado terminal, (b) al agotar 30s sin llegar a uno, o (c) al
  // desmontar el componente/cambiar de orden. Nunca reintenta el ENVÍO por
  // su cuenta -- exclusivamente relee el estado ya decidido por el
  // backend (fetchDeliveryInvoiceState -> GET /orders/mine).
  useEffect(() => {
    if (
      !shouldStartDeliveryPolling({
        paymentStatus: state.status,
        orderToken: state.orderToken,
        currentDeliveryStatus: deliveryInvoiceStateRef.current?.deliveryStatus,
      })
    ) {
      return undefined;
    }

    let cancelled = false;
    let elapsedMs = 0;
    const orderToken = state.orderToken;

    setPollTimedOut(false);

    const timerId = window.setInterval(() => {
      if (cancelled) return;
      elapsedMs += DELIVERY_POLL_INTERVAL_MS;

      // Chequeo de vencimiento ANTES de disparar la solicitud -- al minuto
      // exacto en que se agotan los 30s, ya no se envía una consulta más.
      const timeoutCheck = resolveDeliveryPollTick({ elapsedMs, maxDurationMs: DELIVERY_POLL_MAX_DURATION_MS });
      if (timeoutCheck.action === 'timeout') {
        window.clearInterval(timerId);
        setPollTimedOut(true);
        return;
      }

      void fetchDeliveryInvoiceState(orderToken).then((next) => {
        if (cancelled || !next) return;
        setDeliveryInvoiceState(next);

        const tickOutcome = resolveDeliveryPollTick({
          elapsedMs,
          maxDurationMs: DELIVERY_POLL_MAX_DURATION_MS,
          nextDeliveryStatus: next.deliveryStatus,
        });
        if (tickOutcome.action === 'stop') {
          window.clearInterval(timerId);
        }
      });
    }, DELIVERY_POLL_INTERVAL_MS);

    // Limpieza: se ejecuta al desmontar el componente Y cada vez que este
    // efecto vuelve a correr (cambio real de orderToken/status) -- nunca
    // deja un temporizador huérfano corriendo en segundo plano.
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [state.status, state.orderToken, fetchDeliveryInvoiceState]);

  const handleRetryVerification = () => {
    void runVerification();
  };

  // Refresco manual (requisito 5: "Actualizar estado" cuando el polling
  // vence) -- reutiliza la misma consulta que cada tick del polling, sin
  // reiniciar automáticamente el temporizador de 30s.
  const handleRefreshDeliveryStatus = async () => {
    if (!state.orderToken) return;
    const next = await fetchDeliveryInvoiceState(state.orderToken);
    if (next) {
      setDeliveryInvoiceState(next);
      if (isTerminalDeliveryStatus(next.deliveryStatus)) {
        setPollTimedOut(false);
      }
    }
  };

  // El PDF puede estar listo aunque el job de entrega haya quedado FAILED
  // (correo deshabilitado en este entorno -- ajuste obligatorio del plan
  // aprobado, ver EMAIL_PROVIDER_DISABLED en deliveryJobService.js): la
  // descarga se ofrece también en ese caso, nunca solo en SENT.
  const canDownloadDeliverable =
    state.orderToken && ['SENT', 'DELIVERED', 'FAILED'].includes(deliveryInvoiceState?.deliveryStatus);
  const canRetryDelivery = state.orderToken && deliveryInvoiceState?.deliveryStatus === 'FAILED';
  const isDeliveryTerminal = isTerminalDeliveryStatus(deliveryInvoiceState?.deliveryStatus);
  const deliveryStatusCopy = getWompiReturnDeliveryCopy(deliveryInvoiceState?.deliveryStatus);

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
      const next = await fetchDeliveryInvoiceState(state.orderToken);
      if (next) setDeliveryInvoiceState(next);
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
            <p><strong>Monto:</strong> {formatCopFromCents(state.transaction.amountInCents)}</p>
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
              <div className={`catastrox-inline-panel is-${deliveryStatusCopy.tone}`}>
                <strong>{deliveryStatusCopy.label}</strong>
                <span>{deliveryStatusCopy.message}</span>
              </div>
              <div className={`catastrox-inline-panel is-${getInvoiceStatusCopy(deliveryInvoiceState.invoiceStatus).tone}`}>
                <strong>{getInvoiceStatusCopy(deliveryInvoiceState.invoiceStatus).label}</strong>
                <span>{getInvoiceStatusCopy(deliveryInvoiceState.invoiceStatus).message}</span>
              </div>
              {/* Requisito 5: si el polling venció sin llegar a un estado
                  terminal, nunca se presenta como error -- solo se ofrece
                  actualizar manualmente. */}
              {!isDeliveryTerminal && pollTimedOut ? (
                <div className="catastrox-action-row">
                  <button type="button" className="catastrox-button is-secondary" onClick={handleRefreshDeliveryStatus}>
                    Actualizar estado
                  </button>
                </div>
              ) : null}
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
