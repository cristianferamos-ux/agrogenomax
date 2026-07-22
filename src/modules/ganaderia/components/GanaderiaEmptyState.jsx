import { ArrowRight, Beef } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function GanaderiaEmptyState() {
  return (
    <div className="gan-dash-empty">
      <span className="gan-dash-empty-icon">
        <Beef size={26} />
      </span>
      <h3>Aún no hay animales registrados</h3>
      <p>Registra tu primer animal para iniciar la trazabilidad.</p>
      <Link to="/ganaderia/animales" className="gan-dash-btn is-primary">
        Registrar animal <ArrowRight size={16} />
      </Link>
    </div>
  );
}
