// Utilidades puras de normalizacion para la biblioteca semantica urbana.
// Sin dependencias de Canvas, PDF ni base de datos: solo transforma valores ya obtenidos.

const EMPTY_TEXT_VALUES = new Set(['', 'NO DISPONIBLE', 'NO REGISTRA', 'NO ESPECIFICADO', 'NULL', 'UNDEFINED', 'N/A']);

export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function isEmptyValue(value) {
  const normalized = normalizeText(value).toUpperCase();
  return normalized === '' || EMPTY_TEXT_VALUES.has(normalized);
}

export function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

// Redondeo a un decimal para porcentajes (Fase 5, regla 2). Usa redondeo estandar,
// no trunca.
export function roundToOneDecimal(value) {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return 0;
  return Math.round(parsed * 10) / 10;
}

export function formatPercentage(value) {
  return `${roundToOneDecimal(value).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

// Cobertura = filas con valor util / total de filas. Devuelve 0-1.
export function calculateCoverage(nonNullCount, totalCount) {
  if (!totalCount || totalCount <= 0) return 0;
  return Math.max(0, Math.min(1, nonNullCount / totalCount));
}

export function formatCoveragePercentage(nonNullCount, totalCount) {
  return formatPercentage(calculateCoverage(nonNullCount, totalCount) * 100);
}
