import CatastroXStatusBadge from './CatastroXStatusBadge.jsx';
import { formatNumber } from '../utils/catastroxCalculations.js';

function formatText(value, fallback = 'Sin dato') {
  if (value === null || value === undefined || value === '') return fallback;
  return value;
}

function formatMetric(value, unit, decimals = 2) {
  if (!Number.isFinite(value) || value <= 0) return 'Sin dato';
  return `${formatNumber(value, decimals)} ${unit}`;
}

export default function CatastroXResultSummary({ predio, mode = 'free' }) {
  const rows =
    mode === 'free'
      ? [
          ['Municipio', formatText(predio.municipio)],
          ['Departamento', formatText(predio.departamento)],
          ['Estado predial', formatText(predio.estadoPredial)],
        ]
      : [
          ['Municipio', formatText(predio.municipio)],
          ['Departamento', formatText(predio.departamento)],
          ['Área total en hectáreas', formatMetric(predio.areaHa, 'ha')],
          ['Área total en m²', formatMetric(predio.areaM2, 'm²')],
          ['Perímetro', formatMetric(predio.perimetroM, 'm')],
          ['Código predial', formatText(predio.codigoPredial)],
          ['Código anterior', formatText(predio.codigoAnterior)],
          ['Estado predial', formatText(predio.estadoPredial)],
        ];

  return (
    <section className="catastrox-card">
      <div className="catastrox-section-heading">
        <span>{mode === 'free' ? 'Resultado gratuito' : 'Diagnóstico predial'}</span>
        <h2>{mode === 'free' ? 'Resumen inicial de su consulta' : 'Información habilitada por su plan'}</h2>
      </div>
      <CatastroXStatusBadge status={predio.estado} />
      <div className="catastrox-summary-grid">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className={label.includes('Código') ? 'catastrox-summary-item is-code' : 'catastrox-summary-item'}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
