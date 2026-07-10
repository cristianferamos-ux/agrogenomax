import CatastroXStatusBadge from './CatastroXStatusBadge.jsx';
import { formatNumber } from '../utils/catastroxCalculations.js';
import { getVeredaDisplay } from '../utils/veredaDisplay.js';

function formatText(value, fallback = 'Sin dato') {
  if (value === null || value === undefined || value === '') return fallback;
  return value;
}

function formatMetric(value, unit, decimals = 2) {
  if (!Number.isFinite(value) || value <= 0) return 'Sin dato';
  return `${formatNumber(value, decimals)} ${unit}`;
}

export default function CatastroXResultSummary({ predio, mode = 'free' }) {
  const veredaDisplay = getVeredaDisplay(
    predio?.veredaNombre ||
      predio?.vereda_nombre ||
      predio?.vereda ||
      predio?.nombreVereda ||
      predio?.nombre_vereda,
  );

  function handlePackageScroll() {
    if (mode !== 'free') return;
    document.getElementById('catastrox-packages')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  const rows =
    mode === 'free'
      ? [
          ['Municipio', formatText(predio.municipio)],
          ['Departamento', formatText(predio.departamento)],
        ]
      : [
          ['Municipio', formatText(predio.municipio)],
          ['Departamento', formatText(predio.departamento)],
          [veredaDisplay.label, veredaDisplay.value],
          ...(veredaDisplay.isCadastralCode
            ? [[veredaDisplay.secondaryLabel, veredaDisplay.secondaryValue]]
            : []),
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
        <span>{mode === 'free' ? 'Resultado gratuito' : 'Paquete habilitado'}</span>
        <h2>{mode === 'free' ? 'Resumen inicial de su consulta' : 'Información habilitada por su paquete'}</h2>
      </div>
      <CatastroXStatusBadge status={predio.estado} />
      <div className="catastrox-summary-grid">
        {rows.map(([label, value, type]) => (
          <div
            key={label}
            className={[
              label.includes('Código') ? 'catastrox-summary-item is-code' : 'catastrox-summary-item',
              type === 'cta' ? 'is-cta' : '',
            ].filter(Boolean).join(' ')}
            role={type === 'cta' ? 'button' : undefined}
            tabIndex={type === 'cta' ? 0 : undefined}
            onClick={type === 'cta' ? handlePackageScroll : undefined}
            onKeyDown={type === 'cta'
              ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handlePackageScroll();
                }
              }
              : undefined}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {mode !== 'free' && veredaDisplay.isCadastralCode ? (
        <p className="catastrox-summary-note">{veredaDisplay.note}</p>
      ) : null}
      {mode === 'free' ? (
        <button type="button" className="catastrox-result-cta" onClick={handlePackageScroll}>
          <span>Estado del predio</span>
          <strong>¿Quieres conocer el área total, descargar el plano digital o abrir tu predio en Google Earth?</strong>
          <small>Ver paquetes disponibles</small>
        </button>
      ) : null}
    </section>
  );
}
