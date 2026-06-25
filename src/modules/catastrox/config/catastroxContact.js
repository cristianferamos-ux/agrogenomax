export const CATASTROX_WHATSAPP_NUMBER = '57XXXXXXXXXX';

const COMMERCIAL_STATUS_LABELS = {
  SIN_COBERTURA_CATASTRAL: 'Requiere validación técnica',
  PENDIENTE_VALIDACION: 'Cobertura pendiente de validación',
  SIN_INDIVIDUALIZACION_CATASTRAL: 'Zona sin individualización catastral',
  REVISION_ESPECIAL: 'Revisión especial requerida',
  POSIBLE_PREDIO_FISCAL: 'Predio de gran extensión',
  PREDIO_FISCAL: 'Predio de gran extensión',
  INCONSISTENCIA_CARTOGRAFICA: 'Zona sin individualización catastral',
  NO_PREDIO_INDIVIDUALIZADO: 'Zona sin individualización catastral',
  PREDIO_IDENTIFICADO: 'Predio identificado',
};

function formatArea(areaHa) {
  const parsed = Number(areaHa);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'Sin dato';
  return `${parsed.toFixed(2)} ha`;
}

function formatValue(value, fallback = 'Sin dato') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).trim() || fallback;
}

export function getCatastroXCommercialStatus(status) {
  return COMMERCIAL_STATUS_LABELS[status] || formatValue(status);
}

export function buildCatastroXWhatsAppUrl({
  status,
  municipio,
  departamento,
  lat,
  lng,
  areaHa,
}) {
  const commercialStatus = getCatastroXCommercialStatus(status);
  const caseType =
    status === 'REVISION_ESPECIAL'
      ? 'Predio de gran extensión'
      : status === 'SIN_COBERTURA_CATASTRAL'
        ? 'Cobertura catastral no disponible'
        : status === 'PENDIENTE_VALIDACION'
          ? 'Cobertura pendiente de validación'
          : status === 'SIN_INDIVIDUALIZACION_CATASTRAL' || status === 'NO_PREDIO_INDIVIDUALIZADO'
            ? 'Zona sin individualización catastral'
            : 'Revisión técnica';
  const closingLine =
    status === 'REVISION_ESPECIAL'
      ? 'Quiero validar este predio de gran extensión antes de emitir diagnóstico o plano predial.'
      : 'Quiero revisar si requiere actualización catastral, validación técnica o levantamiento topográfico.';

  const message = [
    'Hola, necesito asesoría sobre un predio consultado en CatastroX.',
    '',
    `Estado: ${formatValue(commercialStatus)}`,
    `Municipio: ${formatValue(municipio)}`,
    `Departamento: ${formatValue(departamento)}`,
    `Latitud: ${formatValue(lat)}`,
    `Longitud: ${formatValue(lng)}`,
    `Área aproximada: ${formatArea(areaHa)}`,
    `Tipo de caso: ${caseType}`,
    '',
    closingLine,
  ].join('\n');

  return `https://wa.me/${CATASTROX_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}
