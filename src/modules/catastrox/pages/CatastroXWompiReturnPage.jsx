import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import { getCatastroxPackage } from '../config/catastroxPackages.js';
import {
  fetchCatastroxLookupFullResult,
  getLastLookup,
  resolveLookupForRoute,
  saveLastLookup,
} from '../services/catastroxApi.js';
import {
  clearPendingPaymentByReference,
  evaluateWompiReturn,
  getPendingPaymentByReference,
  isPendingPaymentContextExpired,
  markPackageAsPaidByPurchaseKey,
  recoverPendingLikeContextForReference,
  verifyWompiTransaction,
} from '../services/catastroxPaymentService.js';

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
  const navigate = useNavigate();
  const hasRunRef = useRef(false);
  const [state, setState] = useState({
    status: 'loading',
    message: 'Verificando el pago aprobado con Wompi...',
    transaction: null,
    targetRoute: DEFAULT_TARGET_ROUTE,
  });

  const transactionId = searchParams.get('id') || searchParams.get('transaction_id') || '';

  const runVerification = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading', message: 'Verificando el pago aprobado con Wompi...' }));

    if (!transactionId) {
      setState({
        status: 'error',
        message: 'No se recibio el identificador de transaccion de Wompi.',
        transaction: null,
        targetRoute: DEFAULT_TARGET_ROUTE,
      });
      return;
    }

    // LOTE 019-B2 (Fase 3): orden correcto -- Wompi solo entrega `id` en el retorno,
    // asi que se verifica primero contra el backend para obtener la reference real,
    // y solo entonces se busca el contexto pendiente por esa reference. Nunca al
    // reves (buscar una unica clave global y fallar antes de consultar Wompi).
    let verifiedTransaction;
    let pending = null;

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
    pending = reference ? getPendingPaymentByReference(reference) : null;

    if (pending && isPendingPaymentContextExpired(pending)) {
      clearPendingPaymentByReference(reference);
      pending = null;
    }

    // Fase 5: recuperacion alternativa (ranura legada v1, o catastrox_purchases_v2)
    // cuando no sobrevive un registro vivo en catastrox_pending_payments_v2 -- nunca
    // desbloquea solo porque Wompi diga APPROVED, solo reconstruye los datos que
    // evaluateWompiReturn valida igual que si vinieran del pending original.
    if (!pending) {
      pending = recoverPendingLikeContextForReference(reference);
    }

    if (!pending) {
      setState({
        status: 'error',
        message:
          'No se pudo asociar esta transaccion a ninguna compra iniciada en este equipo. Vuelva a intentar la compra desde el paquete.',
        transaction: verifiedTransaction,
        targetRoute: DEFAULT_TARGET_ROUTE,
      });
      return;
    }

    const packageConfig = getCatastroxPackage(pending.packageId);
    if (!packageConfig) {
      setState({
        status: 'error',
        message: 'No se pudo determinar el paquete asociado a este pago.',
        transaction: verifiedTransaction,
        targetRoute: pending.targetRoute || DEFAULT_TARGET_ROUTE,
      });
      return;
    }

    // Ya estaba pagado con esta misma reference (p. ej. el callback en pagina del
    // widget ya lo proceso antes de que el usuario llegara aqui) -- salida
    // idempotente: no se reverifica contra evaluateWompiReturn ni se vuelve a
    // marcar, solo se recupera el predio y se redirige (Fase 4/6: no doble
    // procesamiento).
    if (pending.alreadyPaid) {
      const recoveredLookup = await recoverLookupForPending(pending);
      setState({
        status: 'approved',
        message: 'Pago ya estaba aprobado y registrado. Tus descargas siguen habilitadas para este predio.',
        transaction: verifiedTransaction,
        targetRoute: pending.targetRoute || DEFAULT_TARGET_ROUTE,
        hasLookup: Boolean(recoveredLookup),
      });
      return;
    }

    try {
      const decision = evaluateWompiReturn({ verifiedTransaction, pending });

      if (decision.outcome === 'pending') {
        setState({
          status: 'pending',
          message: `El pago quedo pendiente en Wompi (estado: ${verifiedTransaction.status || 'sin estado'}). Puede verificar nuevamente en unos minutos.`,
          transaction: verifiedTransaction,
          targetRoute: pending.targetRoute || DEFAULT_TARGET_ROUTE,
        });
        return;
      }

      if (decision.outcome === 'declined') {
        clearPendingPaymentByReference(reference);
        setState({
          status: 'error',
          message: `El pago no fue aprobado. Estado reportado por Wompi: ${verifiedTransaction.status || 'sin estado'}.`,
          transaction: verifiedTransaction,
          targetRoute: pending.targetRoute || DEFAULT_TARGET_ROUTE,
        });
        return;
      }

      if (decision.outcome === 'rejected') {
        const reasonMessage = {
          reference_mismatch: 'La referencia verificada por Wompi no coincide con la referencia esperada en CatastroX.',
          amount_mismatch: 'El monto verificado por Wompi no coincide con el paquete seleccionado.',
          currency_mismatch: 'La moneda verificada por Wompi no coincide con COP.',
        }[decision.reason] || 'No fue posible validar el pago con Wompi.';
        throw new Error(reasonMessage);
      }

      // decision.outcome === 'approved'
      const recoveredLookup = await recoverLookupForPending(pending);

      markPackageAsPaidByPurchaseKey({
        packageId: packageConfig.id,
        purchaseKey: pending.purchaseKey,
        routeId: pending.routeId,
        codigoPredial: pending.codigoPredial,
        transactionId: verifiedTransaction.id,
        reference: verifiedTransaction.reference,
        mode: 'wompi-sandbox-verified',
      });

      // Se elimina solo aqui, ya con el pago registrado y el lookup recuperado
      // (Fase 4/6: eliminar unicamente tras completar exitosamente).
      clearPendingPaymentByReference(reference);

      setState({
        status: 'approved',
        message: 'Pago aprobado. Tus descargas quedaron habilitadas para este predio.',
        transaction: verifiedTransaction,
        targetRoute: pending.targetRoute || DEFAULT_TARGET_ROUTE,
        hasLookup: Boolean(recoveredLookup),
      });
    } catch (error) {
      setState({
        status: 'error',
        message: error?.message || 'No fue posible verificar el pago con Wompi.',
        transaction: verifiedTransaction,
        targetRoute: pending?.targetRoute || DEFAULT_TARGET_ROUTE,
      });
    }
  }, [transactionId]);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    void runVerification();
  }, [runVerification]);

  useEffect(() => {
    if (state.status !== 'approved' || !state.targetRoute) return undefined;

    const timer = window.setTimeout(() => {
      navigate(state.targetRoute, { replace: true });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [state.status, state.targetRoute, navigate]);

  const handleRetryVerification = () => {
    void runVerification();
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
          <Link className="catastrox-button is-ghost" to="/catastrox/planes">
            Ver planes
          </Link>
        </div>
      </section>

      <CatastroXDisclaimer />
    </section>
  );
}
