import { ArrowRight, QrCode } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function GanaderiaHeader() {
  return (
    <header className="gan-dash-header">
      <div>
        <span className="gan-dash-badge">Módulo activo</span>
        <h1>Ganadería Inteligente</h1>
        <p>Gestión integral del hato, reproducción, sanidad, producción y trazabilidad.</p>
      </div>
      <div className="gan-dash-header-actions">
        <Link to="/ganaderia/animales" className="gan-dash-btn is-primary">
          Registrar animal <ArrowRight size={16} />
        </Link>
        <Link to="/ganaderia/escanear-qr" className="gan-dash-btn is-outline">
          <QrCode size={16} /> Escanear QR
        </Link>
      </div>
    </header>
  );
}
