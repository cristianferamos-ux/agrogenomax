// Motor comun de edad para Ganaderia Inteligente.
// Extraido fielmente de AnimalPesajesTab.jsx (version mas completa existente).
// Funciones puras: sin React, sin window/document, sin ganaderiaApi.

export function todayISO() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

export function valueOf(row, aliases) {
  return aliases.map((key) => row?.[key]).find((value) => value !== undefined && value !== null) || '';
}

// Soporta fecha ISO, fecha AAAA-MM-DD, fecha con timestamp y objetos Date.
export function normalizeDateInput(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  return value ? String(value).slice(0, 10) : '';
}

export function parseNumericAge(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getFechaNacimientoRealAnimal(animal) {
  const explicit = normalizeDateInput(
    valueOf(animal, ['fecha_nacimiento', 'fechaNacimiento', 'nacimiento', 'fecha_nac', 'fechaNacimientoAnimal']),
  );
  if (explicit && !Number.isNaN(new Date(`${explicit}T00:00:00`).getTime())) return explicit;
  return '';
}

export function getFechaNacimientoEstimadaPorEdad(animal) {
  const months = parseNumericAge(valueOf(animal, ['edad_meses', 'age_months']));
  if (!Number.isFinite(months)) return '';
  const days = Math.round((months > 60 ? months / 30.44 : months) * 30.44);
  const estimated = new Date(`${todayISO()}T00:00:00`);
  estimated.setDate(estimated.getDate() - days);
  return estimated.toISOString().slice(0, 10);
}

// Fecha de nacimiento real si existe; si no, estimada a partir de edad_meses/age_months.
export function getFechaNacimiento(animal) {
  return getFechaNacimientoRealAnimal(animal) || getFechaNacimientoEstimadaPorEdad(animal);
}

function calendarMonthsAndDays(start, end) {
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  const anchor = new Date(start);
  anchor.setMonth(anchor.getMonth() + months);
  const remainingDays = Math.max(0, Math.round((end - anchor) / 86400000));
  return { months: Math.max(0, months), remainingDays };
}

// Edad exacta (dias, meses decimales y texto legible) evaluada en una fecha arbitraria
// (edad actual si se pasa hoy, o edad historica si se pasa la fecha de un pesaje).
export function calcularEdadEnFecha(fechaNacimiento, fechaEvaluacion) {
  const birth = normalizeDateInput(fechaNacimiento);
  const evaluation = normalizeDateInput(fechaEvaluacion);
  if (!birth || !evaluation) return null;
  const start = new Date(`${birth}T00:00:00`);
  const end = new Date(`${evaluation}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;

  const dias = Math.round((end - start) / 86400000);
  const { months, remainingDays } = calendarMonthsAndDays(start, end);
  const edadMesesDecimal = Number((months + remainingDays / 30.44).toFixed(2));

  let edadTexto;
  if (dias === 0) {
    edadTexto = '0 días';
  } else if (edadMesesDecimal < 2) {
    if (months <= 0) {
      edadTexto = dias === 1 ? '1 día' : `${dias} días`;
    } else if (remainingDays <= 0) {
      edadTexto = months === 1 ? '1 mes' : `${months} meses`;
    } else {
      const monthText = months === 1 ? '1 mes' : `${months} meses`;
      const dayText = remainingDays === 1 ? '1 día' : `${remainingDays} días`;
      edadTexto = `${monthText} y ${dayText}`;
    }
  } else {
    edadTexto = months === 1 ? '1 mes' : `${months} meses`;
  }

  return { dias, edadMesesDecimal, edadTexto };
}

// Edad actual en meses enteros. Soporta override explicito (edad_meses/age_months/edad/age)
// antes de calcular por fecha de nacimiento. Fallback profesional: null si no hay fecha.
export function obtenerEdadMeses(animal) {
  const explicitMonths = parseNumericAge(valueOf(animal, ['edad_meses', 'age_months']));
  if (Number.isFinite(explicitMonths)) return Math.max(0, Math.floor(explicitMonths));

  const edad = parseNumericAge(valueOf(animal, ['edad', 'age']));
  if (Number.isFinite(edad)) {
    return Math.max(0, Math.floor(edad > 60 ? edad / 30.44 : edad));
  }

  const birth = normalizeDateInput(valueOf(animal, ['fecha_nacimiento', 'fechaNacimiento', 'nacimiento', 'birth_date']));
  if (!birth) return null;
  const start = new Date(birth);
  const end = new Date(todayISO());
  if (Number.isNaN(start.getTime())) return null;
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : null;
}

// Etiqueta de edad lista para mostrar ("2 meses y 10 días", "20 meses"), con fallback '--'.
export function formatAgeLabel(animal, fallbackBirth = '', fallback = '--') {
  const birth = getFechaNacimientoRealAnimal(animal) || fallbackBirth || getFechaNacimientoEstimadaPorEdad(animal);
  const age = calcularEdadEnFecha(birth, todayISO());
  if (age) return age.edadTexto;
  const months = obtenerEdadMeses(animal);
  return Number.isFinite(months) ? `${formatNumber(months)} meses` : fallback;
}
