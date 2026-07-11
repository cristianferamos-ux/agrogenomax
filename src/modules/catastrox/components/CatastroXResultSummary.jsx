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

function isUrbanZona(predio) {
  return /urbano/i.test(String(predio?.tipoZona || predio?.zona || ''));
}

// Regla 6.5: predios urbanos con area < 10.000 m2 muestran solo m2; >= 10.000 m2 muestran
// m2 como principal y ha como complementaria. Rural conserva ha + m2 por separado.
function buildAreaRows(predio) {
  if (isUrbanZona(predio)) {
    const areaRows = [['Área total', formatMetric(predio.areaM2, 'm²')]];
    if (Number(predio.areaM2) >= 10000) {
      areaRows.push(['Área total (ha)', formatMetric(predio.areaHa, 'ha')]);
    }
    return areaRows;
  }
  return [
    ['Área total en hectáreas', formatMetric(predio.areaHa, 'ha')],
    ['Área total en m²', formatMetric(predio.areaM2, 'm²')],
  ];
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
          // Regla 6.2: vereda no se muestra para predios urbanos.
          ...(isUrbanZona(predio) ? [] : [[veredaDisplay.label, veredaDisplay.value]]),
          ...(!isUrbanZona(predio) && veredaDisplay.isCadastralCode
            ? [[veredaDisplay.secondaryLabel, veredaDisplay.secondaryValue]]
            : []),
          ...buildAreaRows(predio),
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
      {mode !== 'free' && !isUrbanZona(predio) && veredaDisplay.isCadastralCode ? (
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
