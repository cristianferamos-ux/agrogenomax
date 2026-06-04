import { Route, Routes, useLocation, useParams } from 'react-router-dom';
import GanaderiaHome from './GanaderiaHome.jsx';
import AnimalFichaBasica from './animales/AnimalFichaBasica.jsx';
import AnimalGeneticaTab from './animales/AnimalGeneticaTab.jsx';
import AnimalPesajesTab from './animales/AnimalPesajesTab.jsx';
import AnimalReproduccionTab from './animales/AnimalReproduccionTab.jsx';
import AnimalTratamientosTab from './animales/AnimalTratamientosTab.jsx';
import AnimalVacunacionesTab from './animales/AnimalVacunacionesTab.jsx';
import GanaderiaBackLink from './components/GanaderiaBackLink.jsx';
import GanaderiaShell from './components/GanaderiaShell.jsx';
import PotrerosPage from './potreros/PotrerosPage.jsx';
import PrediosPage from './predios/PrediosPage.jsx';
import QrEntryPage from './qr/QrEntryPage.jsx';

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

function AnimalSubmodulePage({ title, children }) {
  const { id } = useParams();
  return (
    <div className="gan-panel">
      <GanaderiaBackLink to={`/ganaderia/animal/${id}`}>Volver a Ficha Animal</GanaderiaBackLink>
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Ficha Animal</span>
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}

export default function GanaderiaApp() {
  const location = useLocation();
  const isPublicQr = location.pathname.startsWith('/qr/');

  return (
    <GanaderiaShell>
      {isPublicQr ? (
        <QrEntryPage mode="manual" />
      ) : (
        <Routes>
          <Route index element={<GanaderiaHome />} />
          <Route path="predios" element={<PrediosPage />} />
          <Route path="potreros" element={<PotrerosPage />} />
          <Route path="animales" element={<QrEntryPage mode="manual" />} />
          <Route path="escanear-qr" element={<QrEntryPage mode="scan" />} />
          <Route path="animal/:id" element={<AnimalFichaBasica />} />
          <Route
            path="animal/:id/pesajes"
            element={
              <AnimalSubmodulePage title="Pesajes">
                <AnimalPesajesTab />
              </AnimalSubmodulePage>
            }
          />
          <Route
            path="animal/:id/vacunaciones"
            element={
              <AnimalSubmodulePage title="Vacunaciones">
                <AnimalVacunacionesTab />
              </AnimalSubmodulePage>
            }
          />
          <Route
            path="animal/:id/tratamientos"
            element={
              <AnimalSubmodulePage title="Tratamientos">
                <AnimalTratamientosTab />
              </AnimalSubmodulePage>
            }
          />
          <Route
            path="animal/:id/reproduccion"
            element={
              <AnimalSubmodulePage title="REPRODUCCIÓN">
                <AnimalReproduccionTab />
              </AnimalSubmodulePage>
            }
          />
          <Route path="proximamente/:modulo" element={<ComingSoon title="Módulo no disponible todavía" />} />
          <Route
            path="animal/:id/genetica"
            element={
              <AnimalSubmodulePage title="Genética">
                <AnimalGeneticaTab />
              </AnimalSubmodulePage>
            }
          />
        </Routes>
      )}
    </GanaderiaShell>
  );
}
