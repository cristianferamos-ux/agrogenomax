import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Package } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import CatastroXBuyerForm from '../components/CatastroXBuyerForm.jsx';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXDownloadMock from '../components/CatastroXDownloadMock.jsx';
import CatastroXMockMap from '../components/CatastroXMockMap.jsx';
import CatastroXOtpVerification from '../components/CatastroXOtpVerification.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXPurchaseSummary from '../components/CatastroXPurchaseSummary.jsx';
import CatastroXResultSummary from '../components/CatastroXResultSummary.jsx';
import CatastroXWhatsAppCTA from '../components/CatastroXWhatsAppCTA.jsx';
import {
  CATASTROX_PACKAGE_IDS,
  formatCatastroxPackagePrice,
  getCatastroxPackage,
} from '../config/catastroxPackages.js';
import { CATASTROX_STATUS } from '../data/catastroxMockData.js';
import { maskEmail } from '../utils/piiMasking.js';
import {
  hydrateLookupForDeliverables,
  isCatastroxAuditDownloadsAvailable,
  resolveLookupForRoute,
  saveLastLookup,
} from '../services/catastroxApi.js';
import {
  checkEntitlement,
  clearPendingPaymentByReference,
  createCustomer,
  downloadDeliverablePdf,
  getApprovedPurchaseRecordByKeys,
  getMyOrders,
  getPackageRank,
  getLookupPurchaseKey,
  getPurchasedPackageForLookup,
  readCatastroxLocalStorageJson,
  getUnlockedDownloadsForPackage,
  isPackageUnlockedForLookup,
  markPackageAsPaid,
  markPackageAsPaidByPurchaseKey,
  startPackageCheckout,
  verifyCustomerEmail,
} from '../services/catastroxPaymentService.js';
import {
  downloadCoordinatesZip,
  downloadDxf,
  downloadKml,
  downloadKmz,
  downloadPlanPdf,
  downloadShpZip,
} from '../utils/catastroxDeliverables.js';
import {
  executeCatastroxPackageDownloadDecision,
  resolveDeliverableDownloadErrorMessage,
  resolveDeliverableOrderTokenForPredio,
  shouldUseOfficialPdfDownload,
} from '../utils/catastroxDeliverableDownload.js';

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
  coords9377: {
    label: 'Descargar coordenadas',
    action: downloadCoordinatesZip,
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
  const [auditLookup, setAuditLookup] = useState(null);
  const [deliverableLookup, setDeliverableLookup] = useState(null);
  const [auditState, setAuditState] = useState(null);
  const [isLoadingAudit, setIsLoadingAudit] = useState(false);
  const [isHydratingDeliverables, setIsHydratingDeliverables] = useState(false);
  const [pendingPackageId, setPendingPackageId] = useState(null);
  const [, setPurchaseVersion] = useState(0);
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  // Fuente autoritativa de "¿está pagado?": null mientras no se resolvió una
  // respuesta del backend todavía (se usa el valor local de localStorage
  // solo como UX optimista mientras tanto), true/false una vez que
  // checkEntitlement() respondió -- el backend siempre gana sobre lo que
  // localStorage diga (corrige el defecto de cobro duplicado: localStorage
  // ya no es la fuente de verdad, ver informe de auditoría).
  const [entitlementState, setEntitlementState] = useState({ isPaid: null });
  // CATX-DELIVERABLE-CANONICAL-001: orderToken de la orden APROBADA real
  // (no auditoría) que corresponde a este predio -- única forma de
  // descargar el PDF OFICIAL ya generado/almacenado por el backend (mismo
  // blob que el correo y "Entrega y facturación"), en vez de regenerarlo en
  // el navegador. null mientras no se resuelve o no hay ninguna orden
  // aprobada para este predio.
  const [deliverableOrderToken, setDeliverableOrderToken] = useState(null);
  const [pdfDownloadState, setPdfDownloadState] = useState({});

  // Flujo de comprador/OTP/resumen (Bloque 2-10 del pedido) -- todo en
  // memoria de React, nunca en localStorage/sessionStorage. `purchaseFlowStep`
  // gobierna qué formulario se muestra ANTES de llamar a /checkout; Wompi
  // solo puede abrirse después de que este flujo llega a 'summary' y el
  // usuario confirma explícitamente (handleConfirmPurchase).
  const [purchaseFlowStep, setPurchaseFlowStep] = useState(null); // null | 'buyer_form' | 'otp' | 'summary'
  const [buyerInput, setBuyerInput] = useState(null);
  // R3/B6-26 + B6-26-ADJ-01: customerId nunca llega a este cliente --
  // verificationHandle (emitido por createCustomer) correlaciona el paso de
  // OTP con el comprador correcto; identityCapability (emitido por
  // verifyCustomerEmail tras un OTP válido) es la única credencial que
  // startPackageCheckout puede enviar al backend. Ambos solo en memoria de
  // React, igual que customerId antes -- nunca localStorage/sessionStorage.
  const [verificationHandle, setVerificationHandle] = useState(null);
  const [identityCapability, setIdentityCapability] = useState(null);
  const [devOtpCode, setDevOtpCode] = useState(null);
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [buyerFormError, setBuyerFormError] = useState(null);
  // Protección contra doble clic (Bloque 7): guard síncrono, no depende de
  // que el re-render de setState ya haya ocurrido antes del segundo clic.
  const checkoutInFlightRef = useRef(false);
  // purchaseAttemptId (revisión de seguridad, Bloque 3): un solo UUID por
  // intento de compra, generado al entrar al resumen final
  // (handleOtpVerified) y reutilizado mientras ese intento siga vivo
  // (doble clic, timeout, reintento) -- nunca regenerado por render.
  // resetPurchaseFlow() lo limpia; un intento voluntario nuevo genera uno
  // distinto la próxima vez que se llegue al resumen.
  const purchaseAttemptIdRef = useRef(null);

  function resetPurchaseFlow() {
    setPurchaseFlowStep(null);
    setBuyerInput(null);
    setVerificationHandle(null);
    setIdentityCapability(null);
    setDevOtpCode(null);
    setBuyerFormError(null);
    purchaseAttemptIdRef.current = null;
  }

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

  const auditAvailable = isCatastroxAuditDownloadsAvailable();
  const effectiveLookup = auditLookup || deliverableLookup || lookup;
  const predio = effectiveLookup.predio;
  const routeId = predio.routeId || predio.id;
  const purchasedPackage = getPurchasedPackageForLookup(effectiveLookup);
  const paidRank = getPackageRank(purchasedPackage?.packageId);
  const currentRank = getPackageRank(packageId);
  const isAuditUnlocked = Boolean(auditLookup);
  const localIsPaid = isPackageUnlockedForLookup({ lookup: effectiveLookup, packageId });
  // Mientras el backend no ha respondido (entitlementState.isPaid === null),
  // se muestra el valor local como adelanto de UX; en cuanto responde, su
  // valor manda siempre, sea true o false.
  const isPaid = entitlementState.isPaid === null ? localIsPaid : entitlementState.isPaid;
  const visibleDownloads = isAuditUnlocked
    ? buildDownloadsForPackage(packageId)
    : buildDownloadsForPackage(packageId).filter((download) =>
        getUnlockedDownloadsForPackage({ lookup: effectiveLookup, packageId }).includes(download.id),
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

  const ensureDeliverableLookup = async ({ useAuditEndpoint = false } = {}) => {
    const baseLookup = auditLookup || deliverableLookup || lookup;
    if (baseLookup?.predio?.projectedGeometry) {
      return baseLookup;
    }

    const hydratedLookup = await hydrateLookupForDeliverables(baseLookup, { useAuditEndpoint });
    setDeliverableLookup(hydratedLookup);
    saveLastLookup(hydratedLookup);
    return hydratedLookup;
  };

  useEffect(() => {
    const codigoPredial = predio.codigoPredial || predio.codigo || '';
    const canonicalPredioId = predio.canonicalPredioId || '';
    if (!codigoPredial && !canonicalPredioId) {
      // Sin identidad de predio no hay nada que consultar en backend -- se
      // mantiene el valor local como único disponible (mismo comportamiento
      // que antes de este cambio para este caso borde).
      return undefined;
    }

    let cancelled = false;

    checkEntitlement({ canonicalPredioId, codigoPredial, packageId }).then((result) => {
      if (cancelled || !result.ok) return;

      if (result.isPaid) {
        // Reconcilia la caché local (otras pantallas/tarjetas de paquete
        // siguen leyendo localStorage para UX instantánea) -- el backend ya
        // confirmó el derecho, así que sincronizarla aquí no es una
        // decisión de autorización, solo mantiene la caché al día.
        markPackageAsPaidByPurchaseKey({
          packageId: result.packageId || packageId,
          purchaseKey,
          routeId,
          codigoPredial,
          transactionId: null,
          reference: null,
          mode: 'wompi-sandbox-verified',
        });
      }

      setEntitlementState({ isPaid: result.isPaid });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predio.codigoPredial, predio.codigo, predio.canonicalPredioId, packageId, purchaseKey, routeId]);

  useEffect(() => {
    if (!isPaid || auditLookup || deliverableLookup?.predio?.projectedGeometry || lookup?.predio?.projectedGeometry) {
      return undefined;
    }

    let cancelled = false;

    void ensureDeliverableLookup({ useAuditEndpoint: false })
      .catch(() => {})
      .then((hydrated) => {
        if (cancelled || !hydrated) return;
        setDeliverableLookup((current) => current || hydrated);
      });

    return () => {
      cancelled = true;
    };
  }, [auditLookup, deliverableLookup, isPaid, lookup]);

  // CATX-DELIVERABLE-CANONICAL-001: resuelve el orderToken de la orden
  // APROBADA real para este predio -- nunca en modo auditoría (ahí no
  // existe ninguna orden real, ver handleEnableAuditDownloads). Si hay más
  // de una orden aprobada para el mismo predio (p. ej. una compra de rango
  // inferior seguida de una de rango superior), se prefiere la de mayor
  // rango -- coincide con el paquete cuyo PDF oficial realmente se generó
  // y almacenó (isPackageUnlockedForLookup/getPackageRank ya usan ese
  // mismo criterio de rango en esta misma pantalla).
  useEffect(() => {
    setDeliverableOrderToken(null);
    setPdfDownloadState({});

    if (!isPaid || isAuditUnlocked) {
      return undefined;
    }

    const codigoPredial = String(predio.codigoPredial || predio.codigo || '').trim();
    if (!codigoPredial) return undefined;

    let cancelled = false;

    void getMyOrders().then((result) => {
      if (cancelled || !result.ok) return;
      const orderToken = resolveDeliverableOrderTokenForPredio({ orders: result.orders, codigoPredial, requiredPackageId: packageId });
      if (orderToken) setDeliverableOrderToken(orderToken);
    });

    return () => {
      cancelled = true;
    };
  }, [isPaid, isAuditUnlocked, packageId, predio.codigoPredial, predio.codigo]);

  const handleEnableAuditDownloads = async () => {
    try {
      setIsLoadingAudit(true);
      setAuditState(null);
      const enrichedLookup = await ensureDeliverableLookup({ useAuditEndpoint: true });
      setAuditLookup(enrichedLookup);
      setAuditState({
        status: 'ready',
        message: enrichedLookup?.predio?.source === 'audit-local-clean'
          ? 'Modo auditoría local activo con motor avanzado CatastroX Clean. Descargas habilitadas solo para revisión en este equipo.'
          : 'Modo auditoría local activo. Descargas habilitadas solo para revisión en este equipo.',
      });
    } catch (error) {
      setAuditState({
        status: 'error',
        message: error?.message || 'No fue posible activar la auditoría local.',
      });
    } finally {
      setIsLoadingAudit(false);
    }
  };

  // CATX-DELIVERABLE-CANONICAL-001: descarga el blob OFICIAL ya generado y
  // almacenado por el backend (mismo mecanismo que "Mis compras" y la
  // sección "Entrega y facturación" del retorno Wompi) -- nunca recalcula
  // el PDF en el navegador. Solo se usa para la compra real (no
  // auditoría); handleDownload decide cuándo llamar esta función en vez de
  // `action` directamente.
  const handleOfficialPdfDownload = async () => {
    setPdfDownloadState({ downloading: true, message: null });
    if (!deliverableOrderToken) {
      setPdfDownloadState({
        downloading: false,
        message: resolveDeliverableDownloadErrorMessage('ORDER_NOT_FOUND'),
        tone: 'danger',
      });
      return;
    }
    const result = await downloadDeliverablePdf(deliverableOrderToken);
    setPdfDownloadState({
      downloading: false,
      message: result.ok ? null : resolveDeliverableDownloadErrorMessage(result.code),
      tone: result.ok ? null : 'danger',
    });
  };

  const handleDownload = async (action, fileType) => {
    const useAuditEndpoint = fileType === 'coords9377' ? false : isAuditUnlocked;

    // El botón "Descargar PDF" de una compra real (no auditoría) nunca debe
    // regenerar el archivo en el navegador -- descarga el mismo blob
    // oficial que correo/Entrega y facturación/Mis compras. El modo
    // auditoría local (sin orden real, sin pago) sigue usando `action`
    // (downloadPlanPdf, generador de navegador) porque no existe ningún
    // pedido en el backend del que descargar.
    if (shouldUseOfficialPdfDownload({ fileType, useAuditEndpoint })) {
      await executeCatastroxPackageDownloadDecision({
        fileType,
        useAuditEndpoint,
        deliverableOrderToken,
        officialDownload: handleOfficialPdfDownload,
        localDownload: action,
      });
      return;
    }

    try {
      if (packageId === CATASTROX_PACKAGE_IDS.PROFESIONAL && !isAuditUnlocked) {
        setIsHydratingDeliverables(true);
      }
      const source = await ensureDeliverableLookup({ useAuditEndpoint });
      const sourceWithPackage = {
        ...source,
        deliverablePackageId: packageId,
        predio: {
          ...(source?.predio || {}),
          deliverablePackageId: packageId,
        },
      };
      await action(sourceWithPackage);
    } catch (error) {
      const endpoint = useAuditEndpoint
        ? `/api/catastrox/audit/lookups/${encodeURIComponent(routeId)}/full-result`
        : `/api/catastrox/lookups/${encodeURIComponent(routeId)}/full-result`;
      console.error('[CatastroX download failure]', {
        packageId,
        fileType,
        lookupId: routeId,
        endpoint,
        status: error?.status || null,
        error,
      });
      const message = 'No fue posible preparar este archivo. Intenta nuevamente.';
      if (useAuditEndpoint) {
        setAuditState({ status: 'error', message });
      } else {
        setCheckoutState({ status: 'error', message });
      }
    } finally {
      setIsHydratingDeliverables(false);
    }
  };

  // Paso 5-6 del flujo (Bloque 2): abre el formulario del comprador. Nunca
  // crea customer/orden/checkout por este solo clic -- solo muestra la UI.
  const handleOpenBuyerForm = () => {
    setCheckoutState(null);
    setBuyerFormError(null);
    setPurchaseFlowStep('buyer_form');
  };

  // Paso 7-8 del flujo: crea o recupera el comprador y dispara el envío del
  // OTP. verificationHandle/buyerInput quedan solo en memoria (useState de
  // este componente) -- nunca en almacenamiento del navegador. Un envío
  // nuevo (registro inicial) nunca debe arrastrar una identityCapability de
  // un intento anterior distinto -- se limpia explícitamente.
  const handleBuyerFormSubmit = async (input) => {
    setIsCreatingCustomer(true);
    setBuyerFormError(null);
    const result = await createCustomer(input);
    setIsCreatingCustomer(false);

    if (!result.ok) {
      setBuyerFormError(result.message || 'No fue posible registrar sus datos.');
      return;
    }

    setBuyerInput(input);
    setVerificationHandle(result.verificationHandle);
    setIdentityCapability(null);
    setDevOtpCode(result.devOtpCode || null);
    setPurchaseFlowStep('otp');
  };

  // Reenvío de código (Bloque 4): reutiliza el mismo POST /customers
  // (resolveCustomerForVerification, Modelo B) -- el backend emite un
  // verificationHandle nuevo y genera/"envía" un código nuevo cada vez. Un
  // reenvío reinicia el paso de OTP -- cualquier identityCapability de un
  // intento anterior queda descartada, nunca se conserva junto a un handle
  // nuevo.
  const handleResendOtp = async () => {
    if (!buyerInput) return;
    const result = await createCustomer(buyerInput);
    if (result.ok) {
      if (result.verificationHandle) setVerificationHandle(result.verificationHandle);
      setIdentityCapability(null);
      setDevOtpCode(result.devOtpCode || null);
    }
  };

  // Paso 9-10: verifica el código. El código en sí nunca pasa por este
  // componente -- CatastroXOtpVerification lo mantiene en su propio estado
  // y lo descarta inmediatamente después del intento. Un OTP válido emite
  // identityCapability (R3/B6-26-ADJ-01) -- única credencial que
  // handleStartCheckout podrá enviar a /checkout; se guarda ANTES de que el
  // usuario pueda avanzar al resumen (handleOtpVerified, más abajo).
  const handleVerifyOtp = async (code) => {
    if (!verificationHandle) {
      return { ok: false, code: 'INVALID_VERIFICATION_REQUEST', message: 'Solicitud inválida.' };
    }
    const result = await verifyCustomerEmail({ verificationHandle, code });
    if (result.ok && result.identityCapability) {
      setIdentityCapability(result.identityCapability);
    }
    return result;
  };

  const handleOtpVerified = () => {
    // Se genera exactamente una vez por intento de compra, aquí -- el
    // único punto de entrada al resumen final. crypto.randomUUID() es
    // criptográficamente seguro (Web Crypto API nativa del navegador).
    purchaseAttemptIdRef.current = window.crypto.randomUUID();
    setPurchaseFlowStep('summary');
  };

  // Paso 11-12: única puerta de entrada a Wompi. Protección de doble clic
  // vía checkoutInFlightRef (guard síncrono) + deshabilitar el botón de
  // "Confirmar compra" (ver CatastroXPurchaseSummary, isSubmitting).
  //
  // Defecto corregido (revisión de seguridad): esta función ANTES sacaba
  // al usuario del resumen (setPurchaseFlowStep(null)) de inmediato, antes
  // de siquiera intentar /checkout. Si la llamada fallaba (por ejemplo,
  // CORS rechazando el origen), el usuario caía en la pantalla inicial
  // "Comprar" -- y al pulsarla de nuevo, handleOpenBuyerForm() reabría un
  // CatastroXBuyerForm en blanco, perdiendo visualmente su progreso aunque
  // verificationHandle/identityCapability siguieran vivos en memoria (efecto
  // percibido como "vuelve al formulario del comprador"). Ahora el resumen
  // permanece visible durante todo el intento; solo onOpened() (más abajo,
  // Wompi realmente abierto) saca al usuario del resumen.
  const handleConfirmPurchase = async () => {
    if (checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    try {
      await handleStartCheckout();
    } finally {
      checkoutInFlightRef.current = false;
    }
  };

  const handleStartCheckout = async () => {
    let opened = false;
    const watchdog = window.setTimeout(() => {
      if (!opened) {
        setIsStartingCheckout(false);
        setPendingPackageId(null);
        setCheckoutState({
          status: 'error',
          message: 'Wompi tardó demasiado en abrir. Revise los bloqueadores del navegador e intente nuevamente.',
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
        identityCapability,
        purchaseAttemptId: purchaseAttemptIdRef.current,
        targetRoute: `/catastrox/${pkg.routeSlug}/${routeId || predio.id}`,
        onCheckoutStart: (state) => setCheckoutState(state),
        onOpened: ({ checkout }) => {
          opened = true;
          window.clearTimeout(watchdog);
          setIsStartingCheckout(false);
          // Único punto donde el resumen se abandona: Wompi ya está abierto.
          setPurchaseFlowStep(null);
          setCheckoutState({
            status: 'wompi_started',
            message: 'Wompi fue abierto. Complete el pago para habilitar sus descargas.',
            reference: checkout.reference,
          });
        },
        onApproved: ({ transaction, checkout }) => {
          window.clearTimeout(watchdog);
          setIsStartingCheckout(false);
          setPendingPackageId(null);
          // El backend es la fuente de verdad después de completar la compra.
          resetPurchaseFlow();

          const resolvedReference = transaction?.reference || checkout.reference || null;
          const approvedPurchase = markPackageAsPaid({
            lookup,
            packageId: checkout.packageId || packageId,
            transactionId: transaction?.id || `wompi-${Date.now()}`,
            reference: resolvedReference,
            mode: 'wompi-sandbox',
          });

          if (resolvedReference) {
            clearPendingPaymentByReference(resolvedReference);
          }

          setCheckoutState({
            status: 'approved',
            message: 'Pago aprobado. Descargas habilitadas para este predio.',
            purchase: approvedPurchase,
            reference: resolvedReference,
          });
          setPurchaseVersion((value) => value + 1);
        },
        onRejected: ({ transaction, checkout, mappedResult }) => {
          window.clearTimeout(watchdog);
          setIsStartingCheckout(false);
          setPendingPackageId(null);

          if (!transaction) {
            setCheckoutState({
              status: 'cancelled',
              message: 'La ventana de Wompi fue cerrada o no retornó una transacción aprobada.',
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

      // startPackageCheckout puede devolver un error controlado antes de abrir
      // Wompi, por ejemplo LOOKUP_NOT_FOUND cuando la consulta predial expiró.
      // Se cancela el watchdog para impedir que sobrescriba el mensaje real del
      // backend con el mensaje genérico de espera de Wompi.
      if (checkoutResult?.status === 'error') {
        window.clearTimeout(watchdog);
        setIsStartingCheckout(false);
        setPendingPackageId(null);
        setCheckoutState({
          status: 'error',
          code: checkoutResult.code || null,
          message: checkoutResult.message || 'No fue posible iniciar el pago.',
        });
        return;
      }

      if (checkoutResult?.status === 'already_paid') {
        window.clearTimeout(watchdog);
        setIsStartingCheckout(false);
        setPendingPackageId(null);
        setPurchaseFlowStep(null);
        setCheckoutState({
          status: 'already_paid',
          message: checkoutResult.message || 'Este paquete ya fue adquirido para este predio.',
          purchase: checkoutResult.purchase || null,
        });
        return;
      }

      setIsStartingCheckout(false);

      void waitForWompiIframe().then((found) => {
        if (!found || opened) return;

        opened = true;
        window.clearTimeout(watchdog);
        setIsStartingCheckout(false);
        setPurchaseFlowStep(null);
        setCheckoutState((currentState) => ({
          ...(currentState || {}),
          status: 'wompi_started',
          message: 'Wompi está abierto. Complete el pago para habilitar sus descargas.',
          reference: currentState?.reference || checkoutResult?.checkout?.reference || null,
        }));
      });
    } catch (error) {
      window.clearTimeout(watchdog);
      console.error('[CatastroX Wompi] checkout failed', error);
      setIsStartingCheckout(false);
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
          <span className="catastrox-status is-danger">
            <AlertTriangle size={18} />
            {pkg.label}
          </span>
          <h1>Predio de gran extensión — revisión especializada requerida</h1>
          <p>
            La información consultada presenta características que requieren validación técnica, catastral y
            jurídica antes de generar entregables comerciales. Para continuar, comuníquese con el equipo de
            CatastroX y reciba asesoría personalizada.
          </p>
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
        <CatastroXResultSummary predio={predio} mode={isPaid || isAuditUnlocked ? 'paid' : 'free'} />
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

      {!isPaid && !isAuditUnlocked && purchaseFlowStep === 'buyer_form' ? (
        <CatastroXBuyerForm
          onSubmit={handleBuyerFormSubmit}
          onCancel={resetPurchaseFlow}
          isSubmitting={isCreatingCustomer}
          submitError={buyerFormError}
        />
      ) : null}

      {!isPaid && !isAuditUnlocked && purchaseFlowStep === 'otp' ? (
        <CatastroXOtpVerification
          maskedEmail={maskEmail(buyerInput?.email)}
          devOtpCode={devOtpCode}
          onVerify={handleVerifyOtp}
          onResend={handleResendOtp}
          onCancel={resetPurchaseFlow}
          onVerified={handleOtpVerified}
        />
      ) : null}

      {!isPaid && !isAuditUnlocked && purchaseFlowStep === 'summary' ? (
        <CatastroXPurchaseSummary
          buyerInput={buyerInput}
          packageLabel={pkg.label}
          packagePriceLabel={formatCatastroxPackagePrice(pkg.priceCop)}
          predioLabel={predio.codigoPredial || predio.codigo || predio.municipio || ''}
          onConfirm={handleConfirmPurchase}
          onCancel={resetPurchaseFlow}
          isSubmitting={isStartingCheckout}
          errorMessage={checkoutState?.status === 'error' ? checkoutState.message : null}
        />
      ) : null}

      {isPaid || isAuditUnlocked ? (
        <section className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>{isAuditUnlocked ? 'Modo auditoría local — no disponible en producción' : 'Descargas habilitadas'}</span>
            <h2>{isAuditUnlocked ? `${pkg.label} habilitado para auditoría` : `${pkg.label} habilitado`}</h2>
          </div>
          <div className="catastrox-success">
            <strong>{isAuditUnlocked ? 'Auditoría local activa' : 'Pago aprobado'}</strong>
            <span>
              {isAuditUnlocked
                ? 'Estas descargas son temporales para revisión local y no representan una compra real.'
                : includedMessage || `Se habilitaron las descargas de ${pkg.label.toLowerCase()} para este predio.`}
            </span>
          </div>
          <div className="catastrox-action-row">
            {visibleDownloads.map((item) => (
              <CatastroXDownloadMock
                key={item.id}
                label={
                  isHydratingDeliverables && packageId === CATASTROX_PACKAGE_IDS.PROFESIONAL
                    ? `${item.label}...`
                    : item.label
                }
                onClick={() => handleDownload(item.action, item.id)}
              />
            ))}
          </div>
          {!isAuditUnlocked && pdfDownloadState.message ? (
            <p className={`catastrox-copy is-${pdfDownloadState.tone || 'warning'}`}>{pdfDownloadState.message}</p>
          ) : null}
        </section>
      ) : purchaseFlowStep === null ? (
        <section className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Pago</span>
            <h2>Compre {pkg.label.toLowerCase()} para desbloquear sus entregables</h2>
          </div>
          <p className="catastrox-copy">
            Antes del pago aprobado no se habilitan descargas reales. Después del pago aprobado se activan únicamente los archivos incluidos en este paquete.
          </p>
          <div className="catastrox-action-row">
            <button type="button" className="catastrox-button" onClick={handleOpenBuyerForm} disabled={isStartingCheckout}>
              <Package size={18} />
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
      ) : null}
      {auditAvailable && !isAuditUnlocked ? (
        <section className="catastrox-card catastrox-audit-card">
          <div className="catastrox-section-heading">
            <span>Modo auditoría local — no disponible en producción</span>
            <h2>Auditar descargas sin abrir pagos</h2>
          </div>
          <p className="catastrox-copy">
            Herramienta temporal para validar entregables en localhost. No reemplaza el flujo seguro con pago aprobado.
          </p>
          {!isAuditUnlocked ? (
            <div className="catastrox-action-row">
              <button type="button" className="catastrox-button is-secondary" onClick={handleEnableAuditDownloads} disabled={isLoadingAudit}>
                {isLoadingAudit ? 'Cargando auditoría...' : 'Activar auditoría de descargas'}
              </button>
            </div>
          ) : (
            <div className="catastrox-action-row">
              {visibleDownloads.map((item) => (
                <CatastroXDownloadMock
                  key={`audit-${item.id}`}
                  label={`${item.label} audit`}
                  onClick={() => handleDownload(item.action, item.id)}
                />
              ))}
            </div>
          )}
          {auditState?.message ? (
            <div className={auditState.status === 'error' ? 'catastrox-inline-panel' : 'catastrox-success'}>
              <strong>{auditState.status === 'error' ? 'Auditoría no disponible' : 'Auditoría local activa'}</strong>
              <span>{auditState.message}</span>
            </div>
          ) : null}
        </section>
      ) : null}
      <CatastroXDisclaimer />
    </section>
  );
}
