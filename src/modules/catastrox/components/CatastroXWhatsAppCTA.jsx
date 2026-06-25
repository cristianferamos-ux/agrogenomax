import { MessageCircleMore } from 'lucide-react';
import { buildCatastroXWhatsAppUrl, getCatastroXCommercialStatus } from '../config/catastroxContact.js';

function cleanText(value, fallback = 'Sin dato') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).trim() || fallback;
}

function hasSpecializedCoverage(departamento) {
  return ['Caquetá', 'Huila'].includes(cleanText(departamento, ''));
}

export default function CatastroXWhatsAppCTA({
  lookup,
  status,
  municipio,
  departamento,
  queryPoint,
  areaHa,
}) {
  const lat = queryPoint?.lat ?? lookup?.queryPoint?.lat ?? lookup?.predio?.queryPoint?.lat ?? null;
  const lng = queryPoint?.lng ?? lookup?.queryPoint?.lng ?? lookup?.predio?.queryPoint?.lng ?? null;
  const commercialStatus = getCatastroXCommercialStatus(status);
  const specializedCoverage = hasSpecializedCoverage(departamento);
  const whatsappUrl = buildCatastroXWhatsAppUrl({
    status,
    municipio,
    departamento,
    lat,
    lng,
    areaHa,
  });

  return (
    <article className="catastrox-card is-danger">
      <div className="catastrox-section-heading">
        <span>Acompañamiento técnico</span>
        <h2>Este caso requiere revisión técnica antes de emitir su diagnóstico predial</h2>
      </div>
      <p className="catastrox-copy">
        Este caso requiere revisión técnica antes de emitir un diagnóstico predial. Un asesor puede validar la cobertura catastral, la ubicación y la ruta técnica más conveniente.
      </p>
      <p className="catastrox-copy">
        Estado: <strong>{cleanText(commercialStatus)}</strong> | Municipio: <strong>{cleanText(municipio)}</strong> | Departamento: <strong>{cleanText(departamento)}</strong>
      </p>
      <section className="catastrox-inline-panel">
        <strong>Cobertura técnica especializada</strong>
        <p className="catastrox-copy">
          {specializedCoverage
            ? 'Actualmente contamos con acompañamiento técnico especializado para Huila y Caquetá.'
            : 'Actualmente no contamos con cobertura técnica especializada en esta zona. Sin embargo, usted puede solicitar orientación inicial para conocer las alternativas disponibles.'}
        </p>
      </section>
      <div className="catastrox-action-row">
        <a className="catastrox-button is-danger" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
          <MessageCircleMore size={18} />
          {specializedCoverage ? 'Hablar con un asesor' : 'Solicitar orientación'}
        </a>
      </div>
    </article>
  );
}
