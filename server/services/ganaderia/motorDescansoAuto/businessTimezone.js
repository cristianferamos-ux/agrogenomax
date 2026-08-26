// HOTFIX 3D8.1 -- AUTOMATIC GRAZING START: fecha_inicio_pastoreo YA NO es
// un input del cliente -- AgroGenomaX asume que el pastoreo inicia en la
// fecha LOCAL actual del NEGOCIO (America/Bogota), nunca la fecha del
// navegador del cliente (nunca autoritativa) ni UTC directo (America/Bogota
// es UTC-5 todo el año, sin horario de verano -- tomar `new
// Date().toISOString().slice(0, 10)` puede adelantarse un día completo
// frente al calendario real de Colombia entre las 19:00 y las 23:59 hora
// Bogotá).
export const BUSINESS_TIMEZONE = 'America/Bogota';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Fecha calendario (YYYY-MM-DD) del NEGOCIO -- extrae year/month/day vía
 * `formatToParts` (nunca arma la cadena por posición de separador de un
 * locale, que puede variar entre builds ICU de Node).
 */
export function resolveFechaHoyNegocio(now = new Date()) {
  const partes = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}
