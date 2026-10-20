// FASE 1B: tarjetas de indicadores de peso (último, anterior, diferencia,
// días, GMD, ganancia acumulada). Solo presenta el resumen que entrega la
// API; null se muestra como "Sin dato". Signo explícito (+/−): no depende
// solo del color.
import { kpisDePesajes } from './pesajesModel.js';

export default function HatoPesajesKpis({ resumen }) {
  return (
    <dl className="gan-pesajes-kpis" aria-label="Indicadores de peso">
      {kpisDePesajes(resumen).map((kpi) => (
        <div key={kpi.id} className="gan-pesajes-kpi" data-kpi={kpi.id}>
          <dt>{kpi.label}</dt>
          <dd>
            <strong>{kpi.valor}</strong>
            {kpi.detalle ? <span>{kpi.detalle}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
