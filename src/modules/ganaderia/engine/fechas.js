// FASE 0 -- helpers PUROS de fecha calendario para el motor ganadero.
//
// Los eventos ganaderos (pesajes, vacunas, partos, ordeños) son fechas
// calendario sin hora: se representan SIEMPRE como 'YYYY-MM-DD' y se comparan
// como número de día (Date.UTC solo como aritmética de calendario), nunca
// como instantes locales/UTC, para que la zona horaria del navegador no mueva
// un día. Ninguna función lee el reloj salvo fechaHoyLocal(), que es el único
// punto de borde y recibe `now` inyectable.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_DIA = 86400000;

function partes(iso) {
  const m = ISO_DATE.exec(iso);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function diasDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/** true si `iso` es una fecha calendario real 'YYYY-MM-DD' (rechaza 2025-02-30). */
export function esFechaISOValida(iso) {
  if (typeof iso !== 'string') return false;
  const p = partes(iso);
  if (!p) return false;
  const [anio, mes, dia] = p;
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasDelMes(anio, mes);
}

/**
 * Normaliza a 'YYYY-MM-DD' o null. Acepta 'YYYY-MM-DD', un ISO con hora (toma
 * los 10 primeros caracteres tal cual vienen) o un Date (componentes LOCALES).
 */
export function aFechaISO(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value !== 'string' || value.length < 10) return null;
  const iso = value.slice(0, 10);
  return esFechaISOValida(iso) ? iso : null;
}

/** Número de día absoluto (entero) de una fecha calendario; null si inválida. */
export function numeroDeDia(value) {
  const iso = aFechaISO(value);
  if (!iso) return null;
  const [anio, mes, dia] = partes(iso);
  return Date.UTC(anio, mes - 1, dia) / MS_DIA;
}

/** Días calendario de `desde` a `hasta` (puede ser negativo); null si alguna es inválida. */
export function diasEntre(desde, hasta) {
  const a = numeroDeDia(desde);
  const b = numeroDeDia(hasta);
  return a === null || b === null ? null : b - a;
}

export function sumarDias(value, dias) {
  const n = numeroDeDia(value);
  if (n === null || !Number.isInteger(dias)) return null;
  return new Date((n + dias) * MS_DIA).toISOString().slice(0, 10);
}

/** Suma meses de calendario; el día se acota al último día del mes destino (31-ene + 1 mes = 28/29-feb). */
export function sumarMeses(value, meses) {
  const iso = aFechaISO(value);
  if (!iso || !Number.isInteger(meses)) return null;
  const [anio, mes, dia] = partes(iso);
  const total = anio * 12 + (mes - 1) + meses;
  const nuevoAnio = Math.floor(total / 12);
  const nuevoMes = (total % 12) + 1;
  const nuevoDia = Math.min(dia, diasDelMes(nuevoAnio, nuevoMes));
  return `${nuevoAnio}-${String(nuevoMes).padStart(2, '0')}-${String(nuevoDia).padStart(2, '0')}`;
}

/**
 * Diferencia de calendario `desde` -> `hasta` (hasta >= desde): meses completos
 * y días restantes. Un mes se completa al alcanzar el mismo día del mes (o el
 * último día si el mes destino es más corto). null si hasta < desde.
 */
export function mesesYDiasEntre(desde, hasta) {
  const a = aFechaISO(desde);
  const b = aFechaISO(hasta);
  if (!a || !b || diasEntre(a, b) < 0) return null;
  const [ya, ma] = partes(a);
  const [yb, mb] = partes(b);
  let meses = (yb - ya) * 12 + (mb - ma);
  if (diasEntre(sumarMeses(a, meses), b) < 0) meses -= 1;
  return { meses, dias: diasEntre(sumarMeses(a, meses), b) };
}

/**
 * Meses transcurridos en decimal: meses completos de calendario + fracción
 * del mes en curso (días restantes / días del período mensual en curso).
 * Sin redondeo (redondear solo al presentar).
 */
export function mesesDecimalesEntre(desde, hasta) {
  const md = mesesYDiasEntre(desde, hasta);
  if (!md) return null;
  const inicioPeriodo = sumarMeses(desde, md.meses);
  const largoPeriodo = diasEntre(inicioPeriodo, sumarMeses(desde, md.meses + 1));
  return md.meses + md.dias / largoPeriodo;
}

/** ÚNICO punto que lee el reloj: fecha calendario LOCAL de `now`. */
export function fechaHoyLocal(now = new Date()) {
  return aFechaISO(now);
}
