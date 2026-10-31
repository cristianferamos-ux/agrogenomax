import { Navigate, Route, Routes } from 'react-router-dom';
import GanaderiaBackLink from './components/GanaderiaBackLink.jsx';
import GanaderiaShell from './components/GanaderiaShell.jsx';
import HatoDetallePage from './hato/HatoDetallePage.jsx';
import HatoEscanearQrPage from './hato/HatoEscanearQrPage.jsx';
import HatoListaPage from './hato/HatoListaPage.jsx';
import HatoQrResolverPage from './hato/HatoQrResolverPage.jsx';
import HatoRegistroPage from './hato/HatoRegistroPage.jsx';
import { GanaderiaOfflineProvider } from './offline/GanaderiaOfflineProvider.jsx';
import OfflineStatusBar from './offline/OfflineStatusBar.jsx';
import OfflineSyncPage from './offline/OfflineSyncPage.jsx';
import PrediosPage from './predios/PrediosPage.jsx';

function ComingSoon({ title }) {
  return (
    <div className="gan-panel">
      <GanaderiaBackLink />
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Fase posterior</span>
        <h2>{title}</h2>
        <p>Este submódulo está reservado para una fase posterior.</p>
      </div>
    </div>
  );
}

// SPRINT-3D11.SECURITY-LEGACY: las páginas legacy de animales/QR/potreros
// (QrEntryPage, AnimalesListPage, AnimalFichaBasica y pestañas,
// PotrerosPage) consumían /api/animales, /api/qr, /api/predios,
// /api/potreros, etc., ya desmontados del backend. Sus rutas quedan como
// redirecciones -- nunca vuelven a montar esas páginas. Los potreros
// vigentes se registran desde la tarjeta de cada predio (PrediosPage).
//
// SPRINT-3D11.2: /ganaderia/animales es el módulo nuevo (hato/, solo
// /api/ganaderia/animales). Los ids legacy no se traducen: animal/*,
// animales/listado redirigen a la lista nueva.
//
// SPRINT-3D11.3 (R1): escanear-qr y qr/:valor (token o código de chapeta)
// montan el flujo QR de hato/ (solo /api/ganaderia/qr y
// /api/ganaderia/animales/:id/qr). FASE 3B: qr (sin valor) es la URL limpia
// del resolver: token en memoria o cookie HttpOnly, nunca en la ruta.
//
// SPRINT-3D11.3 (R1): offline-first -- GanaderiaOfflineProvider (copia
// local + sincronización automática), indicador siempre visible y
// /ganaderia/sincronizacion (preparar dispositivo, conflictos).
export default function GanaderiaApp() {
  return (
    <GanaderiaOfflineProvider>
      <GanaderiaShell>
        <OfflineStatusBar />
        <Routes>
          <Route index element={<Navigate to="/ganaderia/dashboard" replace />} />
          <Route path="predios" element={<PrediosPage />} />
          <Route path="potreros" element={<Navigate to="/ganaderia/predios" replace />} />
          <Route path="animales" element={<HatoListaPage />} />
          <Route path="animales/nuevo" element={<HatoRegistroPage />} />
          <Route path="animales/listado" element={<Navigate to="/ganaderia/animales" replace />} />
          <Route path="animales/:animalId" element={<HatoDetallePage />} />
          <Route path="animales/*" element={<Navigate to="/ganaderia/animales" replace />} />
          <Route path="escanear-qr" element={<HatoEscanearQrPage />} />
          <Route path="qr" element={<HatoQrResolverPage />} />
          <Route path="qr/:valor" element={<HatoQrResolverPage />} />
          <Route path="sincronizacion" element={<OfflineSyncPage />} />
          <Route path="animal/*" element={<Navigate to="/ganaderia/animales" replace />} />
          <Route path="proximamente/:modulo" element={<ComingSoon title="Módulo no disponible todavía" />} />
        </Routes>
      </GanaderiaShell>
    </GanaderiaOfflineProvider>
  );
}
