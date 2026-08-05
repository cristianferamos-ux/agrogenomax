import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Search, ShieldAlert } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import {
  getCatastroxPackage,
  getCatastroxPackageRoute,
} from '../config/catastroxPackages.js';
import {
  markPackageAsPaid,
  normalizeCatastroxPackageId,
  readCatastroxLocalStorageJson,
  verifyWompiTransaction,
} from '../services/catastroxPaymentService.js';
import { saveLastLookup } from '../services/catastroxApi.js';
import { formatCopFromCents } from '../utils/catastroxOrderStatusCopy.js';

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

export default function CatastroXWompiVerifyPage() {
  const [searchParams] = useSearchParams();
  const [manualTransactionId, setManualTransactionId] = useState(
    searchParams.get('transactionId') || searchParams.get('id') || '',
  );
  const [state, setState] = useState({
    status: 'idle',
    message: 'Pegue o confirme el ID de la transaccion y verifique el pago para habilitar sus descargas.',
    transaction: null,
    hasRestoredLookup: false,
    returnPath: null,
  });

  const packageId = normalizeCatastroxPackageId(searchParams.get('packageId'));
  const purchaseKey = searchParams.get('purchaseKey') || '';
  const predioId = searchParams.get('predioId') || '';
  const codigoPredial = searchParams.get('codigoPredial') || '';
  const expectedReference = searchParams.get('reference') || '';
  const routeId = normalizeRouteId({
    routeId: searchParams.get('routeId'),
    predioId,
    purchaseKey,
  });
  const packageConfig = getCatastroxPackage(packageId);
  const recoveryContext = useMemo(() => {
    const storageKeys = [
      purchaseKey ? `catastrox:checkout-context:${purchaseKey}` : null,
      routeId ? `catastrox:checkout-context:${routeId}` : null,
      predioId ? `catastrox:checkout-context:${predioId}` : null,
    ].filter(Boolean);

    for (const storageKey of storageKeys) {
      const context = readCatastroxLocalStorageJson(storageKey);
      if (context) {
        return context;
      }
    }

    return null;
  }, [purchaseKey, routeId, predioId]);
  const targetRoute = useMemo(() => {
    const targetRouteId = routeId || recoveryContext?.routeId || (predioId ? `real-${predioId}` : null);
    if (!packageConfig || !targetRouteId) {
      return '/catastrox/planes';
    }

    return recoveryContext?.returnPath || getCatastroxPackageRoute(packageConfig.id, targetRouteId);
  }, [packageConfig, routeId, recoveryContext, predioId]);

  const handleVerify = async () => {
    const transactionId = String(manualTransactionId || '').trim();

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

    setState({
      status: 'loading',
      message: 'Verificando el pago aprobado con Wompi...',
      transaction: null,
    });

    try {
      const transaction = await verifyWompiTransaction(transactionId);
      const expectedAmount = Number(packageConfig.priceCop) * 100;
      const isApproved =
        transaction.status === 'APPROVED' &&
        Number(transaction.amountInCents) === expectedAmount &&
        transaction.currency === 'COP';

      if (!isApproved) {
        throw new Error(
          `El pago no fue aprobado. Estado reportado por Wompi: ${transaction.status || 'sin estado'}.`,
        );
      }

      if (expectedReference && transaction.reference !== expectedReference) {
        throw new Error('La referencia verificada por Wompi no coincide con la referencia esperada en CatastroX.');
      }

      if (!purchaseKey) {
        throw new Error('No se recibio una purchaseKey valida para este predio.');
      }

      let hasRestoredLookup = false;
      if (recoveryContext?.predioSnapshot) {
        saveLastLookup(recoveryContext.predioSnapshot);
        hasRestoredLookup = true;
      }

      markPackageAsPaid({
        packageId: packageConfig.id,
        purchaseKey,
        predioId,
        routeId,
        codigoPredial,
        transactionId: transaction.id,
        reference: transaction.reference,
        mode: 'wompi-sandbox-verified',
      });

      setState({
        status: 'approved',
        message: hasRestoredLookup
          ? 'Pago aprobado. Descargas habilitadas para este predio.'
          : 'Pago aprobado y registrado. Para cargar el plano y los archivos técnicos, vuelva a consultar el predio. No tendra que pagar de nuevo.',
        transaction,
        hasRestoredLookup,
        returnPath: hasRestoredLookup ? targetRoute : null,
      });
    } catch (error) {
      setState({
        status: 'error',
        message: error?.message || 'No fue posible verificar el pago con Wompi.',
        transaction: null,
        hasRestoredLookup: false,
        returnPath: null,
      });
    }
  };

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Verificar pago Wompi</span>
        <h1>Validacion manual del pago</h1>
        <p>{state.message}</p>
      </div>

      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Wompi Sandbox</span>
          <h2>Verifique y habilite las descargas del predio</h2>
        </div>

        <label className="catastrox-field">
          <span>ID de transaccion Wompi</span>
          <input
            type="text"
            value={manualTransactionId}
            onChange={(event) => setManualTransactionId(event.target.value)}
            placeholder="Ej: 12122050-1782587542-25238"
          />
        </label>

        <div className="catastrox-action-row">
          <button
            type="button"
            className="catastrox-button"
            onClick={handleVerify}
            disabled={state.status === 'loading'}
          >
            <Search size={18} />
            {state.status === 'loading' ? 'Verificando pago...' : 'Verificar pago'}
          </button>
          {state.hasRestoredLookup ? (
            <Link className="catastrox-button is-ghost" to={targetRoute}>
              Volver al paquete <ArrowRight size={18} />
            </Link>
          ) : (
            <Link className="catastrox-button is-ghost" to="/catastrox/planes">
              Volver a paquetes <ArrowRight size={18} />
            </Link>
          )}
        </div>

        <div className={state.status === 'approved' ? 'catastrox-success' : 'catastrox-inline-panel'}>
          <strong>
            {state.status === 'approved' ? (
              <>
                <CheckCircle2 size={18} /> Pago aprobado
              </>
            ) : (
              <>
                <ShieldAlert size={18} /> Verificacion requerida
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

        {state.status === 'approved' && state.hasRestoredLookup ? (
          <div className="catastrox-action-row">
            <Link className="catastrox-button" to={state.returnPath || targetRoute}>
              Volver a descargas <ArrowRight size={18} />
            </Link>
          </div>
        ) : null}
        {state.status === 'approved' && !state.hasRestoredLookup ? (
          <div className="catastrox-action-row">
            <Link className="catastrox-button" to="/catastrox/buscar">
              Buscar predio <ArrowRight size={18} />
            </Link>
            <Link className="catastrox-button is-ghost" to="/catastrox/planes">
              Volver a paquetes
            </Link>
          </div>
        ) : null}
      </section>

      <CatastroXDisclaimer />
    </section>
  );
}
