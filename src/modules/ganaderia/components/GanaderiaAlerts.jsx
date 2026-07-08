import { AlertTriangle } from 'lucide-react';

export default function GanaderiaAlerts() {
  return (
    <section className="gan-dash-section">
      <h2>Alertas inteligentes</h2>
      <div className="gan-dash-alert-list">
        <article className="gan-dash-alert-card">
          <span className="gan-dash-alert-icon">
            <AlertTriangle size={18} />
          </span>
          <div className="gan-dash-alert-body">
            <div className="gan-dash-alert-head">
              <strong>Sin alertas registradas todavía.</strong>
            </div>
            <span className="gan-dash-alert-action">
              Registre animales o escanee un QR para activar los módulos sanitarios y reproductivos.
            </span>
          </div>
        </article>
      </div>
    </section>
  );
}
