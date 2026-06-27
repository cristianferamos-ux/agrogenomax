import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import {
  getCatastroxPackage,
  getCatastroxPackageRoute,
} from '../config/catastroxPackages.js';
import { resolveLookupForRoute } from '../services/catastroxApi.js';
import {
  getCatastroxExpectedAmountInCents,
  markPackageAsPaid,
  markPackageAsPaidByPurchaseKey,
  normalizeCatastroxPackageId,
  verifyWompiTransaction,
} from '../services/catastroxPaymentService.js';

function normalizeRouteId({ routeId, predioId, purchaseKey }) {
  const directRouteId = String(routeId || '').trim();
  if (directRouteId) {
    return directRouteId;
  }

  const rawPredioId = String(predioId || '').trim();
  if (rawPredioId.startsWith('real-') || rawPredioId === 'no-found' || rawPredioId === 'sin-predio') {
    return rawPredioId;
  }

  if (/^\d+$/.test(rawPredioId)) {
    return `real-${rawPredioId}`;
  }

  const rawPurchaseKey = String(purchaseKey || '').trim();
  const routeMatch = rawPurchaseKey.match(/(real-\d+|no-found|sin-predio)$/);
  return routeMatch?.[1] || '';
}

export default function CatastroXWompiReturnPage() {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState({
    status: 'loading',
    message: 'Verificando el pago aprobado con Wompi...',
    transaction: null,
  });

  const transactionId = searchParams.get('id') || searchParams.get('transaction_id') || '';
  const expectedReference = searchParams.get('reference') || '';
  const purchaseKey = searchParams.get('purchaseKey') || '';
  const predioId = searchParams.get('predioId') || '';
  const codigoPredial = searchParams.get('codigoPredial') || '';
  const routeId = normalizeRouteId({
    routeId: searchParams.get('routeId'),
    predioId,
    purchaseKey,
  });
  const packageId = normalizeCatastroxPackageId(searchParams.get('packageId'));
  const packageConfig = getCatastroxPackage(packageId);
  const targetRoute = useMemo(() => {
    if (!packageConfig || !routeId) {
      return '/catastrox/planes';
    }

    return getCatastroxPackageRoute(packageConfig.id, routeId);
  }, [packageConfig, routeId]);

  useEffect(() => {
    let cancelled = false;

    async function runVerification() {
      if (!transactionId) {
        setState({
          status: 'error',
          message: 'No se recibio el identificador de transaccion de Wompi.',
          transaction: null,
        });
        return;
      }

      if (!packageConfig) {
        setState({
          status: 'error',
          message: 'No se pudo determinar el paquete asociado a este pago.',
          transaction: null,
        });
        return;
      }

      try {
        const verifiedTransaction = await verifyWompiTransaction(transactionId);

        if (verifiedTransaction.status !== 'APPROVED') {
          throw new Error(`El pago no fue aprobado. Estado reportado por Wompi: ${verifiedTransaction.status || 'sin estado'}.`);
        }

        if (expectedReference && verifiedTransaction.reference !== expectedReference) {
          throw new Error('La referencia verificada por Wompi no coincide con la referencia esperada en CatastroX.');
        }

        const expectedAmountInCents = getCatastroxExpectedAmountInCents(packageConfig.id);
        if (Number(verifiedTransaction.amountInCents) !== Number(expectedAmountInCents)) {
          throw new Error('El monto verificado por Wompi no coincide con el paquete seleccionado.');
        }

        if (verifiedTransaction.currency !== 'COP') {
          throw new Error('La moneda verificada por Wompi no coincide con COP.');
        }

        const lookup = routeId ? resolveLookupForRoute(routeId) : null;

        if (lookup) {
          markPackageAsPaid({
            lookup,
            packageId: packageConfig.id,
            transactionId: verifiedTransaction.id,
            reference: verifiedTransaction.reference,
            mode: 'wompi-sandbox-verified',
          });
        } else if (purchaseKey) {
          markPackageAsPaidByPurchaseKey({
            packageId: packageConfig.id,
            purchaseKey,
            routeId: routeId || null,
            codigoPredial: codigoPredial || null,
            transactionId: verifiedTransaction.id,
            reference: verifiedTransaction.reference,
            mode: 'wompi-sandbox-verified',
          });
        } else {
          throw new Error('No se encontro un purchaseKey valido para habilitar las descargas de este predio.');
        }

        if (!cancelled) {
          setState({
            status: 'approved',
            message: 'Pago aprobado. Tus descargas quedaron habilitadas para este predio.',
            transaction: verifiedTransaction,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error?.message || 'No fue posible verificar el pago con Wompi.',
            transaction: null,
          });
        }
      }
    }

    void runVerification();

    return () => {
      cancelled = true;
    };
  }, [transactionId, expectedReference, purchaseKey, routeId, codigoPredial, packageConfig]);

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
          <h2>{state.status === 'approved' ? 'Pago aprobado y verificado' : 'Validacion del pago'}</h2>
        </div>

        <div className={state.status === 'approved' ? 'catastrox-success' : 'catastrox-inline-panel'}>
          <strong>
            {state.status === 'approved' ? (
              <>
                <CheckCircle2 size={18} /> Pago aprobado
              </>
            ) : (
              <>
                <ShieldAlert size={18} /> Validacion pendiente o rechazada
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

        <div className="catastrox-action-row">
          <Link className="catastrox-button" to={targetRoute}>
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
