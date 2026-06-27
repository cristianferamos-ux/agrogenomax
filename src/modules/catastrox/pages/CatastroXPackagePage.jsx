import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Wallet } from 'lucide-react';
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
import { resolveLookupForRoute } from '../services/catastroxApi.js';
import {
  canSimulateCatastroxPayment,
  getPackageRank,
  getPurchasedPackageForLookup,
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
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>{pkg.label}</span>
          <h1>No hay una consulta activa para este predio</h1>
          <p>Vuelva a buscar su predio para habilitar la compra de este paquete.</p>
        </div>
        <CatastroXPageActions
          actions={[
            { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
            { label: 'Ver paquetes', to: '/catastrox/planes', tone: 'ghost' },
            { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          ]}
        />
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
  const canSimulate = canSimulateCatastroxPayment();

  const navigationActions = useMemo(() => {
    const actions = [
      { label: 'Volver al resultado', to: `/catastrox/resultado/${routeId}`, tone: 'ghost' },
      { label: 'Comparar paquetes', to: '/catastrox/planes', tone: 'secondary' },
      { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
    ];
    return actions;
  }, [routeId]);

  const handleStartCheckout = async () => {
    try {
      setIsStartingCheckout(true);
      setPendingPackageId(packageId);
      const result = await startPackageCheckout({ packageId, lookup });
      setCheckoutState(result);
      if (result.status === 'redirect' && result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
      }
      if (result.status === 'already_paid') {
        setPurchaseVersion((value) => value + 1);
      }
    } catch (error) {
      setCheckoutState({
        status: 'error',
        message: error instanceof Error ? error.message : 'No fue posible iniciar el pago.',
      });
    } finally {
      setIsStartingCheckout(false);
    }
  };

  const handleSimulatePayment = () => {
    const simulated = markPackageAsPaid({
      lookup,
      packageId,
      transactionId: `sim-${Date.now()}`,
    });
    setPendingPackageId(null);
    setCheckoutState({
      status: 'approved',
      message: 'Pago aprobado en modo local de prueba.',
      purchase: simulated,
    });
    setPurchaseVersion((value) => value + 1);
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
                {checkoutState.status === 'simulation_available'
                  ? 'Modo local de pruebas'
                  : checkoutState.status === 'pending_configuration'
                    ? 'Wompi listo para integración'
                    : checkoutState.status === 'error'
                      ? 'No fue posible iniciar el pago'
                      : 'Estado del pago'}
              </strong>
              <span>{checkoutState.message}</span>
            </div>
          ) : null}
          {pendingPackageId === packageId && checkoutState?.status !== 'approved' ? (
            <p className="catastrox-copy">
              Antes del pago aprobado no se habilitan descargas reales.
            </p>
          ) : null}
          {canSimulate && checkoutState?.status === 'simulation_available' ? (
            <div className="catastrox-action-row">
              <button type="button" className="catastrox-button is-secondary" onClick={handleSimulatePayment}>
                <CheckCircle2 size={18} />
                Simular pago aprobado
              </button>
            </div>
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
