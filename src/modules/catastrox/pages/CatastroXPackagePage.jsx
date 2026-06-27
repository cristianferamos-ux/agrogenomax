import { useMemo, useState } from 'react';
import { ArrowRight, Wallet } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXDownloadMock from '../components/CatastroXDownloadMock.jsx';
import CatastroXMockMap from '../components/CatastroXMockMap.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXResultSummary from '../components/CatastroXResultSummary.jsx';
import CatastroXWhatsAppCTA from '../components/CatastroXWhatsAppCTA.jsx';
import {
  CATASTROX_PACKAGE_IDS,
  formatCatastroxPackagePrice,
  getCatastroxPackage,
} from '../config/catastroxPackages.js';
import { CATASTROX_STATUS } from '../data/catastroxMockData.js';
import { resolveLookupForRoute, saveLastLookup } from '../services/catastroxApi.js';
import {
  getApprovedPurchaseRecordByKeys,
  getPackageRank,
  getLookupPurchaseKey,
  getPurchasedPackageForLookup,
  readCatastroxLocalStorageJson,
  getUnlockedDownloadsForPackage,
  isPackageUnlockedForLookup,
  markPackageAsPaid,
  startPackageCheckout,
} from '../services/catastroxPaymentService.js';
import {
  downloadDxf,
  downloadKml,
  downloadKmz,
  downloadPlanPdf,
  downloadShpZip,
} from '../utils/catastroxDeliverables.js';

const PACKAGE_PAGE_COPY = {
  [CATASTROX_PACKAGE_IDS.BASICO]: {
    heading: 'Conozca el área y descargue su plano predial digital.',
    includesTitle: 'Entregables del paquete básico',
  },
  [CATASTROX_PACKAGE_IDS.PLUS]: {
    heading: 'Descargue el PDF y lleve el predio a Google Earth o al celular.',
    includesTitle: 'Entregables del paquete plus',
  },
  [CATASTROX_PACKAGE_IDS.PROFESIONAL]: {
    heading: 'Descargue archivos técnicos para GIS y flujos de AutoCAD/Civil 3D.',
    includesTitle: 'Entregables del paquete profesional',
  },
};

const REQUIRES_ADVISOR_STATES = new Set([
  CATASTROX_STATUS.FISCAL,
  CATASTROX_STATUS.INCONSISTENCIA,
  CATASTROX_STATUS.REVISION_ESPECIAL,
  CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL,
]);

const DOWNLOAD_BUTTONS = {
  pdf: {
    label: 'Descargar PDF',
    action: downloadPlanPdf,
  },
  kml: {
    label: 'Descargar KML',
    action: downloadKml,
  },
  kmz: {
    label: 'Descargar KMZ',
    action: downloadKmz,
  },
  shp: {
    label: 'Descargar SHP',
    action: downloadShpZip,
  },
  dxf: {
    label: 'Descargar DXF',
    action: downloadDxf,
  },
};

function buildDownloadsForPackage(packageId) {
  const pkg = getCatastroxPackage(packageId);
  if (!pkg) return [];
  return pkg.downloads.map((downloadId) => {
    return {
      id: downloadId,
      ...DOWNLOAD_BUTTONS[downloadId],
    };
  });
}

function hasWompiIframe() {
  if (typeof document === 'undefined') {
    return false;
  }

  return Array.from(document.querySelectorAll('iframe')).some((iframe) => {
    const src = iframe.getAttribute('src') || '';
    return src.includes('checkout.wompi.co') || src.includes('wompi.co/p/');
  });
}

function waitForWompiIframe({ timeoutMs = 8000, intervalMs = 150 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const timer = window.setInterval(() => {
      if (hasWompiIframe()) {
        window.clearInterval(timer);
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

function buildCheckoutContextStorageKeys({ purchaseKey, routeId, predioId }) {
  return [
    purchaseKey ? `catastrox:checkout-context:${purchaseKey}` : null,
    routeId ? `catastrox:checkout-context:${routeId}` : null,
    predioId ? `catastrox:checkout-context:${predioId}` : null,
  ].filter(Boolean);
}

function saveCheckoutRecoveryContext(context) {
  if (typeof window === 'undefined') return;

  for (const storageKey of buildCheckoutContextStorageKeys(context)) {
    window.localStorage.setItem(storageKey, JSON.stringify(context));
  }
}

function readCheckoutRecoveryContext({ purchaseKey, routeId, predioId }) {
  for (const storageKey of buildCheckoutContextStorageKeys({ purchaseKey, routeId, predioId })) {
    const context = readCatastroxLocalStorageJson(storageKey);
    if (context) {
      return context;
    }
  }

  return null;
}

export default function CatastroXPackagePage({ packageId }) {
  const { id } = useParams();
  const lookup = resolveLookupForRoute(id);
  const pkg = getCatastroxPackage(packageId);
  const [checkoutState, setCheckoutState] = useState(null);
  const [pendingPackageId, setPendingPackageId] = useState(null);
  const [, setPurchaseVersion] = useState(0);
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);

  if (!pkg) {
    return null;
  }

  if (!lookup) {
    const routeId = String(id || '').trim();
    const predioId = routeId.startsWith('real-') ? routeId.replace(/^real-/, '') : routeId;
    const purchaseKey = routeId ? `catastrox_purchase_${routeId}` : '';
    const recoveryContext = readCheckoutRecoveryContext({ purchaseKey, routeId, predioId });
    const approvedPurchase = getApprovedPurchaseRecordByKeys({
      purchaseKey,
      routeId,
      predioId,
      codigoPredial: recoveryContext?.codigoPredial || '',
    });
    const verifyUrl =
      `/catastrox/pagos/wompi/verificar?packageId=${encodeURIComponent(packageId)}` +
      `&purchaseKey=${encodeURIComponent(recoveryContext?.purchaseKey || purchaseKey)}` +
      `&routeId=${encodeURIComponent(recoveryContext?.routeId || routeId)}` +
      `&predioId=${encodeURIComponent(recoveryContext?.predioId || predioId)}` +
      `&codigoPredial=${encodeURIComponent(recoveryContext?.codigoPredial || '')}`;
    const fallbackActions = approvedPurchase?.paid
      ? [
          { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
          recoveryContext?.resultPath
            ? { label: 'Volver al resultado', to: recoveryContext.resultPath, tone: 'ghost' }
            : null,
          { label: 'Verificar pago', to: verifyUrl, tone: 'ghost' },
        ].filter(Boolean)
      : [
          { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
          { label: 'Ver paquetes', to: '/catastrox/planes', tone: 'ghost' },
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
        ];

    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>{pkg.label}</span>
          <h1>No hay una consulta activa para este predio</h1>
          <p>
            {approvedPurchase?.paid
              ? 'Pago aprobado registrado. Falta cargar nuevamente la consulta del predio para generar los archivos.'
              : 'Vuelva a buscar su predio para habilitar la compra de este paquete.'}
          </p>
        </div>
        <CatastroXPageActions actions={fallbackActions} />
      </section>
    );
  }

  const predio = lookup.predio;
  const routeId = predio.routeId || predio.id;
  const purchasedPackage = getPurchasedPackageForLookup(lookup);
  const paidRank = getPackageRank(purchasedPackage?.packageId);
  const currentRank = getPackageRank(packageId);
  const isPaid = isPackageUnlockedForLookup({ lookup, packageId });
  const visibleDownloads = buildDownloadsForPackage(packageId).filter((download) =>
    getUnlockedDownloadsForPackage({ lookup, packageId }).includes(download.id),
  );
  const hasHigherPackage = paidRank > currentRank;
  const unlockedPackage = purchasedPackage ? getCatastroxPackage(purchasedPackage.packageId) : null;
  const packageCopy = PACKAGE_PAGE_COPY[packageId];
  const requiresAdvisor = REQUIRES_ADVISOR_STATES.has(predio.estado);
  const purchaseKey = getLookupPurchaseKey(lookup);
  const manualVerifyUrl =
    `/catastrox/pagos/wompi/verificar?packageId=${encodeURIComponent(packageId)}` +
    `&purchaseKey=${encodeURIComponent(purchaseKey)}` +
    `&routeId=${encodeURIComponent(routeId)}` +
    `&predioId=${encodeURIComponent(predio.id || '')}` +
    `&codigoPredial=${encodeURIComponent(predio.codigoPredial || predio.codigo || '')}`;

  const navigationActions = useMemo(() => {
    const actions = [
      { label: 'Volver al resultado', to: `/catastrox/resultado/${routeId}`, tone: 'ghost' },
      { label: 'Comparar paquetes', to: '/catastrox/planes', tone: 'secondary' },
      { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
    ];
    return actions;
  }, [routeId]);

  const handleStartCheckout = async () => {
    let opened = false;
    const watchdog = window.setTimeout(() => {
      if (!opened) {
        setIsStartingCheckout(false);
        setPendingPackageId(null);
        setCheckoutState({
          status: 'error',
          message: 'Wompi tardo demasiado en abrir. Revise bloqueadores, consola del navegador o intente nuevamente.',
        });
      }
    }, 20000);

    try {
      setIsStartingCheckout(true);
      setPendingPackageId(packageId);
      setCheckoutState(null);
      saveCheckoutRecoveryContext({
        packageId,
        packageSlug: pkg.routeSlug,
        purchaseKey,
        routeId,
        predioId: predio.id || '',
        codigoPredial: predio.codigoPredial || predio.codigo || '',
        returnPath: `/catastrox/${pkg.routeSlug}/${routeId || predio.id}`,
        resultPath: routeId ? `/catastrox/resultado/${routeId}` : null,
        createdAt: new Date().toISOString(),
        predioSnapshot: lookup,
      });
      saveLastLookup(lookup);
      const checkoutResult = await startPackageCheckout({
        packageId,
        lookup,
        onCheckoutStart: (state) => setCheckoutState(state),
        onOpened: ({ checkout }) => {
          opened = true;
          window.clearTimeout(watchdog);
          setIsStartingCheckout(false);
          setCheckoutState({
            status: 'wompi_started',
            message: 'Wompi fue abierto. Complete el pago para habilitar sus descargas.',
            reference: checkout.reference,
          });
        },
        onApproved: ({ transaction, checkout }) => {
          setIsStartingCheckout(false);
          setPendingPackageId(null);

          const approvedPurchase = markPackageAsPaid({
            lookup,
            packageId: checkout.packageId || packageId,
            transactionId: transaction?.id || `wompi-${Date.now()}`,
            reference: transaction?.reference || checkout.reference || null,
            mode: 'wompi-sandbox',
          });

          setCheckoutState({
            status: 'approved',
            message: 'Pago aprobado. Descargas habilitadas para este predio.',
            purchase: approvedPurchase,
            reference: transaction?.reference || checkout.reference,
          });
          setPurchaseVersion((value) => value + 1);
        },
        onRejected: ({ transaction, checkout, mappedResult }) => {
          setIsStartingCheckout(false);
          setPendingPackageId(null);

          if (!transaction) {
            setCheckoutState({
              status: 'cancelled',
              message: 'La ventana de Wompi fue cerrada o no retorno una transaccion aprobada.',
              reference: checkout?.reference,
            });
            return;
          }

          setCheckoutState({
            status: mappedResult?.status || 'failed',
            message: `Pago no aprobado por Wompi. Estado: ${transaction.status || 'sin estado'}.`,
            reference: transaction?.reference || checkout?.reference,
          });
        },
        onError: (error) => {
          window.clearTimeout(watchdog);
          setIsStartingCheckout(false);
          setPendingPackageId(null);
          setCheckoutState({
            status: 'error',
            message: error?.message || 'No fue posible abrir Wompi.',
          });
        },
      });

      setIsStartingCheckout(false);

      waitForWompiIframe().then((found) => {
        if (found) {
          setIsStartingCheckout(false);
          setCheckoutState((currentState) => ({
            ...(currentState || {}),
            status: 'wompi_started',
            message: 'Wompi esta abierto. Complete el pago para habilitar sus descargas.',
            reference: currentState?.reference || checkoutResult?.checkout?.reference || null,
          }));
        }
      });
    } catch (error) {
      window.clearTimeout(watchdog);
      console.error('[CatastroX Wompi] checkout failed', error);
      setPendingPackageId(null);
      setCheckoutState({
        status: 'error',
        message: error?.message || 'No fue posible abrir Wompi.',
      });
    } finally {
      if (!opened) {
        setIsStartingCheckout(false);
      }
    }
  };

  const includedMessage =
    hasHigherPackage && unlockedPackage
      ? packageId === CATASTROX_PACKAGE_IDS.BASICO
        ? `Este paquete está incluido en el ${unlockedPackage.label} activo para este predio. Este paquete incluye el PDF.`
        : `Este paquete está incluido en el ${unlockedPackage.label} activo para este predio.`
      : null;

  if (requiresAdvisor) {
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>{pkg.label}</span>
          <h1>Este caso requiere revisión técnica antes de vender entregables</h1>
          <p>La compra del paquete queda suspendida hasta que un asesor valide la situación predial y técnica de este caso.</p>
        </div>
        <CatastroXPageActions actions={navigationActions} />
        <CatastroXResultSummary predio={predio} mode="free" />
        <CatastroXWhatsAppCTA
          lookup={lookup}
          status={lookup.status || predio.estado}
          municipio={predio.municipio}
          departamento={predio.departamento}
          queryPoint={lookup.queryPoint || predio.queryPoint}
          areaHa={predio.areaHa}
        />
        <CatastroXDisclaimer />
      </section>
    );
  }

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>{pkg.label} — {formatCatastroxPackagePrice(pkg.priceCop)}</span>
        <h1>{pkg.title}</h1>
        <p>{packageCopy.heading}</p>
      </div>
      <CatastroXPageActions actions={navigationActions} />
      <div className="catastrox-two-col">
        <CatastroXResultSummary predio={predio} mode={isPaid ? 'paid' : 'free'} />
        <CatastroXMockMap predio={predio} />
      </div>

      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Incluye</span>
          <h2>{packageCopy.includesTitle}</h2>
        </div>
        <p className="catastrox-copy">{pkg.description}</p>
        <ul className="catastrox-list">
          {pkg.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </section>

      {!isPaid ? (
        <section className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Pago</span>
            <h2>Compre {pkg.label.toLowerCase()} para desbloquear sus entregables</h2>
          </div>
          <p className="catastrox-copy">
            Antes del pago aprobado no se habilitan descargas reales. Después del pago aprobado se activan únicamente los archivos incluidos en este paquete.
          </p>
          <div className="catastrox-action-row">
            <button type="button" className="catastrox-button" onClick={handleStartCheckout} disabled={isStartingCheckout}>
              <Wallet size={18} />
              {isStartingCheckout ? 'Abriendo Wompi...' : `Comprar ${pkg.label}`}
            </button>
            <Link className="catastrox-button is-ghost" to="/catastrox/planes">
              Ver otros paquetes <ArrowRight size={18} />
            </Link>
          </div>
          {checkoutState?.message ? (
            <div className={checkoutState.status === 'error' ? 'catastrox-inline-panel' : 'catastrox-success'}>
              <strong>
                {checkoutState.status === 'wompi_started'
                  ? 'Pago iniciado con Wompi'
                  : checkoutState.status === 'pending'
                    ? 'Pago pendiente'
                    : checkoutState.status === 'failed' || checkoutState.status === 'cancelled'
                      ? 'Pago no aprobado'
                    : checkoutState.status === 'error'
                      ? 'No fue posible iniciar el pago'
                      : 'Estado del pago'}
              </strong>
              <span>{checkoutState.message}</span>
            </div>
          ) : null}
          {checkoutState?.status === 'wompi_started' ? (
            <div className="catastrox-inline-panel">
              <strong>Verificacion manual disponible</strong>
              <span>Si Wompi te deja en la pagina del comprobante, copia el ID de la URL y verifica tu pago aqui.</span>
              <Link className="catastrox-button is-ghost" to={manualVerifyUrl}>
                Verificar pago manualmente <ArrowRight size={18} />
              </Link>
            </div>
          ) : null}
          {pendingPackageId === packageId && checkoutState?.status !== 'approved' ? (
            <p className="catastrox-copy">
              Antes del pago aprobado no se habilitan descargas reales.
            </p>
          ) : null}
        </section>
      ) : (
        <section className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Descargas habilitadas</span>
            <h2>{pkg.label} habilitado</h2>
          </div>
          <div className="catastrox-success">
            <strong>Pago aprobado</strong>
            <span>
              {includedMessage || `Se habilitaron las descargas de ${pkg.label.toLowerCase()} para este predio.`}
            </span>
          </div>
          <div className="catastrox-action-row">
            {visibleDownloads.map((item) => (
              <CatastroXDownloadMock key={item.id} label={item.label} onClick={() => item.action(lookup)} />
            ))}
          </div>
        </section>
      )}
      <CatastroXDisclaimer />
    </section>
  );
}
