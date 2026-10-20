// Motor común de genética básica para Ganadería Inteligente.
// Cubre solo composición racial/pureza registrada (porcentajes 0-100). No
// implementa genealogía, genómica, ADN, mérito genético predictivo ni valor
// comercial. FASE 0: validación explícita de composición y manejo de nulos.

// Mismo texto que ya usa AnimalGeneticaTab.jsx real para lo que no está registrado.
export const ADVANCED_GENETIC_EMPTY = 'Información genética avanzada no registrada.';
export const UMBRAL_PUREZA_PCT = 99.5;

function porcentajeDe(raza) {
  const raw = raza?.porcentaje;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function formatPercent(value) {
  const number = value === null || value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString('es-CO', { maximumFractionDigits: 2 })}%` : '--';
}

// Mismo formato que ya usa AnimalFichaBasica.jsx: "NombreRaza XX% / OtraRaza YY%".
export function formatComposicionRacial(razas = []) {
  if (!Array.isArray(razas) || !razas.length) return 'Sin composicion racial registrada';
  return razas
    .map((raza) => `${raza.nombre_raza || `Raza ${raza.raza_id}`} ${formatPercent(raza.porcentaje)}`)
    .join(' / ');
}

/**
 * Valida una composición racial: cada porcentaje finito en [0, 100] y suma
 * 100 (± tolerancia). Devuelve { valida, suma, errores[] }.
 */
export function validarComposicionRacial(razas, { tolerancia = 0.01 } = {}) {
  if (!Array.isArray(razas) || razas.length === 0) return { valida: false, suma: null, errores: ['SIN_COMPOSICION'] };
  const errores = [];
  let suma = 0;
  razas.forEach((raza, i) => {
    const pct = porcentajeDe(raza);
    if (pct === null) errores.push(`PORCENTAJE_INVALIDO:${i}`);
    else if (pct < 0 || pct > 100) errores.push(`PORCENTAJE_FUERA_DE_RANGO:${i}`);
    else suma += pct;
  });
  if (!errores.length && Math.abs(suma - 100) > tolerancia) errores.push('SUMA_DISTINTA_DE_100');
  return { valida: errores.length === 0, suma: errores.some((e) => e.startsWith('PORCENTAJE')) ? null : suma, errores };
}

/** Raza con mayor porcentaje válido (empate: la primera). null si no hay porcentajes válidos. */
export function razaPrincipal(razas = []) {
  if (!Array.isArray(razas)) return null;
  let mejor = null;
  for (const raza of razas) {
    const pct = porcentajeDe(raza);
    if (pct === null || pct < 0 || pct > 100) continue;
    if (!mejor || pct > porcentajeDe(mejor)) mejor = raza;
  }
  return mejor;
}

export function porcentajePrincipal(razas = []) {
  const principal = razaPrincipal(razas);
  return principal ? porcentajeDe(principal) : null;
}

/** Puro: exactamente una raza registrada con porcentaje válido >= 99,5 %. */
export function esPuro(razas = []) {
  if (!Array.isArray(razas) || razas.length !== 1) return false;
  const pct = porcentajePrincipal(razas);
  return pct !== null && pct >= UMBRAL_PUREZA_PCT;
}
