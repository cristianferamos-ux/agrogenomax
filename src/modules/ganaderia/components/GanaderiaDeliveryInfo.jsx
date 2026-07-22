import { Truck } from 'lucide-react';
import { entregaProvisionalTexto, entregaTexto, entregaTiempos } from '../data/ganaderiaPlans.js';

export default function GanaderiaDeliveryInfo() {
  return (
    <article className="gan-rules-card gan-delivery-card">
      <span className="gan-rules-icon">
        <Truck size={20} />
      </span>
      <h3>Tiempos de entrega</h3>
      <p>{entregaTexto}</p>

      <div className="gan-delivery-table">
        {entregaTiempos.map((row) => (
          <div key={row.tipo} className="gan-delivery-row">
            <strong>{row.tipo}</strong>
            <span>Ciudades principales: {row.principales}</span>
            <span>Otras ciudades: {row.otras}</span>
          </div>
        ))}
      </div>

      <p className="gan-rules-note">{entregaProvisionalTexto}</p>
    </article>
  );
}
