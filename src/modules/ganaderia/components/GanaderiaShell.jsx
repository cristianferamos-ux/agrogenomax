import { isCloudflareWithoutLocalApi } from '../api/ganaderiaApi.js';
import GanaderiaSidebar from './GanaderiaSidebar.jsx';

export default function GanaderiaShell({ children }) {
  return (
    <div className="gan-dash-shell">
      <GanaderiaSidebar />
      <main className="gan-dash-main gan-dash-main-operativo">
        <header className="gan-dash-registered-header">
          <span className="gan-dash-badge">Cuenta real</span>
          <h1>AgroGenomaX Ganadería Inteligente</h1>
          <p>Gestiona tu hato con trazabilidad QR, control productivo, sanidad y decisiones inteligentes por animal.</p>
        </header>
        {isCloudflareWithoutLocalApi() ? (
          <div className="gan-demo-banner">
            El servicio de datos de tu cuenta no está disponible temporalmente. Intenta nuevamente más tarde.
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
