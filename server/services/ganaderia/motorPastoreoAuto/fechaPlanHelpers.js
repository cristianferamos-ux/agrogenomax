// SPRINT-3D10.4 FASE 3 §10/§11 -- aritmética de fechas del PLAN (fecha
// prevista de ingreso + fecha de salida estimada). Puro, sin DB/HTTP,
// deliberadamente SEPARADO de cargaAutomaticaFormulas.js (ese módulo "no
// debe conocer fechas", ver 3D10.4 FASE 2 §9/§13).
//
// Aritmética en milisegundos UTC (Date.UTC), nunca Date local -- evita por
// construcción cualquier problema de zona horaria/DST al sumar días de
// calendario completos (UTC no tiene DST ni offset variable). PLAN usa
// fechas de calendario (date, sin hora) -- nunca un timestamp con hora
// inventada; REAL (ingreso_real_at/salida_real_at) es un dominio
// completamente distinto que este módulo no toca.

const FECHA_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Valida y descompone una fecha de calendario real en formato YYYY-MM-DD
 * (rechaza formato incorrecto Y fechas inexistentes como 2026-02-30 --
 * round-trip contra los componentes UTC).
 */
export function parseFechaCalendario(valor) {
  if (typeof valor !== 'string' || !FECHA_ISO_PATTERN.test(valor)) {
    throw Object.assign(new Error(`Fecha inválida (se espera YYYY-MM-DD): ${String(valor)}`), { code: 'INPUT_INVALID', field: 'fecha' });
  }
  const [year, month, day] = valor.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const fecha = new Date(timestamp);
  if (fecha.getUTCFullYear() !== year || fecha.getUTCMonth() !== month - 1 || fecha.getUTCDate() !== day) {
    throw Object.assign(new Error(`Fecha de calendario inexistente: ${valor}`), { code: 'INPUT_INVALID', field: 'fecha' });
  }
  return { year, month, day, timestamp };
}

/**
 * fechaSalidaEstimada = fechaIngresoPrevista + diasPermanencia (días de
 * calendario completos). Suma en milisegundos UTC -- correcto en fin de
 * mes, fin de año, febrero y años bisiestos por construcción (el motor de
 * fechas de JS ya normaliza el desborde de días/meses en UTC).
 */
export function computeFechaSalidaEstimada(fechaIngresoPrevistaIso, diasPermanencia) {
  if (typeof diasPermanencia !== 'number' || !Number.isFinite(diasPermanencia) || diasPermanencia <= 0) {
    throw Object.assign(new Error(`diasPermanencia debe ser un número finito positivo (recibido: ${String(diasPermanencia)}).`), { code: 'INPUT_INVALID', field: 'diasPermanencia' });
  }
  const { timestamp } = parseFechaCalendario(fechaIngresoPrevistaIso);
  const salida = new Date(timestamp + diasPermanencia * MS_POR_DIA);
  const yyyy = String(salida.getUTCFullYear()).padStart(4, '0');
  const mm = String(salida.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(salida.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
