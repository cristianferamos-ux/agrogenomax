// DEMO / LEGACY -- NO es regla Business.
// Adaptadores de edad para la Cuenta Demo y la UI huérfana legacy
// (animales/*Tab.jsx), que trabajan con filas de forma libre (alias de
// campos). Corregido en FASE 0: edad_meses / edad SIEMPRE son meses (se
// eliminó la heurística "más de 60 = días", BUG-01). Las fechas se tratan
// como fechas calendario (engine/fechas.js). El motor Business es
// engine/edad.js.
import { aFechaISO, diasEntre, fechaHoyLocal, mesesYDiasEntre, sumarDias, sumarMeses } from '../fechas.js';

export function todayISO() {
  return fechaHoyLocal();
}

export function valueOf(row, aliases) {
  return aliases.map((key) => row?.[key]).find((value) => value !== undefined && value !== null) || '';
}

export function normalizeDateInput(value) {
  return aFechaISO(value) || '';
}

export function parseNumericAge(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getFechaNacimientoRealAnimal(animal) {
  return normalizeDateInput(
    valueOf(animal, ['fecha_nacimiento', 'fechaNacimiento', 'nacimiento', 'fecha_nac', 'fechaNacimientoAnimal']),
  );
}

/** Fecha de nacimiento estimada restando `edad_meses` MESES a hoy (BUG-01: nunca se interpreta como días). */
export function getFechaNacimientoEstimadaPorEdad(animal, hoy = todayISO()) {
  const months = parseNumericAge(valueOf(animal, ['edad_meses', 'age_months']));
  if (!Number.isFinite(months) || months < 0) return '';
  const completos = Math.floor(months);
  const dias = Math.round((months - completos) * 30.4375);
  return sumarDias(sumarMeses(hoy, -completos), -dias) || '';
}

export function getFechaNacimiento(animal) {
  return getFechaNacimientoRealAnimal(animal) || getFechaNacimientoEstimadaPorEdad(animal);
}

export function calcularEdadEnFecha(fechaNacimiento, fechaEvaluacion) {
  const birth = normalizeDateInput(fechaNacimiento);
  const evaluation = normalizeDateInput(fechaEvaluacion);
  const md = birth && evaluation ? mesesYDiasEntre(birth, evaluation) : null;
  if (!md) return null;

  const dias = diasEntre(birth, evaluation);
  const months = md.meses;
  const remainingDays = md.dias;
  const edadMesesDecimal = months + remainingDays / 30.4375;

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

/** Meses completos de edad. `edad_meses` / `edad` SIEMPRE se leen como meses (BUG-01). */
export function obtenerEdadMeses(animal, hoy = todayISO()) {
  const explicitMonths = parseNumericAge(valueOf(animal, ['edad_meses', 'age_months', 'edad', 'age']));
  if (Number.isFinite(explicitMonths)) return Math.max(0, Math.floor(explicitMonths));
  const birth = getFechaNacimientoRealAnimal(animal);
  if (!birth) return null;
  return mesesYDiasEntre(birth, hoy)?.meses ?? null;
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : null;
}

export function formatAgeLabel(animal, fallbackBirth = '', fallback = '--') {
  const birth = getFechaNacimientoRealAnimal(animal) || fallbackBirth || getFechaNacimientoEstimadaPorEdad(animal);
  const age = calcularEdadEnFecha(birth, todayISO());
  if (age) return age.edadTexto;
  const months = obtenerEdadMeses(animal);
  return Number.isFinite(months) ? `${formatNumber(months)} meses` : fallback;
}
