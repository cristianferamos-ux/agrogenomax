import { Navigate, Route, Routes } from 'react-router-dom';
import GanaderiaBackLink from './components/GanaderiaBackLink.jsx';
import GanaderiaShell from './components/GanaderiaShell.jsx';
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
// redirecciones/placeholder -- nunca vuelven a montar esas páginas. Los
// potreros vigentes se registran desde la tarjeta de cada predio
// (PrediosPage, /api/ganaderia/predios/:predioId/potreros).
export default function GanaderiaApp() {
  return (
    <GanaderiaShell>
      <Routes>
        <Route index element={<Navigate to="/ganaderia/dashboard" replace />} />
        <Route path="predios" element={<PrediosPage />} />
        <Route path="potreros" element={<Navigate to="/ganaderia/predios" replace />} />
        <Route path="animales" element={<ComingSoon title="Animales: módulo en preparación" />} />
        <Route path="animales/*" element={<Navigate to="/ganaderia/animales" replace />} />
        <Route path="escanear-qr" element={<Navigate to="/ganaderia/animales" replace />} />
        <Route path="animal/*" element={<Navigate to="/ganaderia/animales" replace />} />
        <Route path="proximamente/:modulo" element={<ComingSoon title="Módulo no disponible todavía" />} />
      </Routes>
    </GanaderiaShell>
  );
}
