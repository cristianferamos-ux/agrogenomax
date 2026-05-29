import { Route, Routes, useLocation } from 'react-router-dom';
import GanaderiaHome from './GanaderiaHome.jsx';
import AnimalFichaBasica from './animales/AnimalFichaBasica.jsx';
import GanaderiaShell from './components/GanaderiaShell.jsx';
import PotrerosPage from './potreros/PotrerosPage.jsx';
import PrediosPage from './predios/PrediosPage.jsx';
import QrEntryPage from './qr/QrEntryPage.jsx';

function ComingSoon({ title }) {
  return (
    <div className="gan-panel">
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Fase posterior</span>
        <h2>{title}</h2>
        <p>Este submódulo está reservado y no se implementa en Fase 1.</p>
      </div>
    </div>
  );
}

export default function GanaderiaApp() {
  const location = useLocation();
  const isPublicQr = location.pathname.startsWith('/qr/');

  return (
    <GanaderiaShell>
      {isPublicQr ? (
        <QrEntryPage />
      ) : (
        <Routes>
          <Route index element={<GanaderiaHome />} />
          <Route path="predios" element={<PrediosPage />} />
          <Route path="potreros" element={<PotrerosPage />} />
          <Route path="animales" element={<QrEntryPage />} />
          <Route path="escanear-qr" element={<QrEntryPage />} />
          <Route path="animal/:id" element={<AnimalFichaBasica />} />
          <Route path="proximamente/:modulo" element={<ComingSoon title="Módulo no disponible todavía" />} />
        </Routes>
      )}
    </GanaderiaShell>
  );
}
