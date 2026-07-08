// Motor comun de genetica basica para Ganaderia Inteligente.
// Cubre solo composicion racial/pureza registrada. No implementa genomica, ADN,
// merito genetico predictivo ni valor comercial — eso permanece fuera de alcance.

// Mismo texto que ya usa AnimalGeneticaTab.jsx real para lo que no esta registrado.
export const ADVANCED_GENETIC_EMPTY = 'Información genética avanzada no registrada.';

export function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString('es-CO', { maximumFractionDigits: 2 })}%` : '--';
}

// Mismo formato que ya usa AnimalFichaBasica.jsx: "NombreRaza XX% / OtraRaza YY%".
export function formatComposicionRacial(razas = []) {
  if (!razas.length) return 'Sin composicion racial registrada';
  return razas
    .map((raza) => `${raza.nombre_raza || `Raza ${raza.raza_id}`} ${formatPercent(raza.porcentaje)}`)
    .join(' / ');
}

export function razaPrincipal(razas = []) {
  if (!razas.length) return null;
  return razas.reduce((max, raza) => (Number(raza.porcentaje || 0) > Number(max?.porcentaje || 0) ? raza : max), razas[0]);
}

export function porcentajePrincipal(razas = []) {
  const principal = razaPrincipal(razas);
  return principal ? Number(principal.porcentaje || 0) : null;
}

export function esPuro(razas = []) {
  const porcentaje = porcentajePrincipal(razas);
  return razas.length === 1 && Number.isFinite(porcentaje) && porcentaje >= 99.5;
}
