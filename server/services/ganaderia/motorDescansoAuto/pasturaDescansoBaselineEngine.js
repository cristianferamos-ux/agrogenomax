// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico): baseline FISIOLÓGICO
// de referencia (rest_days_min/typical/max + altura de entrada/salida) por
// especie/cultivar de pastura -- mismo patrón de lookup determinístico que
// motorPastoreoAuto/pastureClimateEngine.js, sin dependencias de DB/HTTP.
//
// REGLA DURA DEL HARDENING (§2/§3/§4 del sprint de hardening): este
// baseline es un GUARDRAIL/REFERENCIA REGIONAL, NUNCA la respuesta final.
// La ventana de descanso real la decide agroClimateAssessment.js +
// descansoFormulas.js sobre este baseline -- este módulo NUNCA calcula
// días finales.
//
// §4 del hardening: NO existe fallback universal inventado. Si la pastura
// no tiene un perfil regional específico con evidencia real, este módulo
// devuelve `null` -- el repositorio traduce eso en el estado
// NO_PASTURE_PROFILE (bloquea el cálculo, nunca inventa un rango
// genérico). "Preferir no recomendar automáticamente antes que inventar
// un descanso universal" (§4).
import { getFuenteTecnicaDescanso } from './fuentesTecnicasDescanso.js';

// Único baseline con evidencia regional real de v1 -- Urochloa/Brachiaria
// humidicola cv. Llanero, Piedemonte de los Llanos Orientales de Colombia
// (AGROSAVIA, Rincón et al. 2018). sourceType PASTURE_SPECIFIC_REGIONAL
// (§3 del hardening) -- explícitamente NO universalizable a todo Colombia
// ni a otros cultivares/regiones (ver `limitaciones`).
const PASTURA_DESCANSO_ESPECIFICA = [
  {
    patrones: ['brachiaria humidicola', 'urochloa humidicola'],
    restDaysMinReference: 25,
    restDaysTypicalReference: 30,
    restDaysMaxReference: 35,
    referenceEntryHeightCm: 30,
    referenceExitHeightCm: 15,
    sourceType: 'PASTURE_SPECIFIC_REGIONAL',
    fuenteTecnica: 'RINCON_2018_HUMIDICOLA_LLANERO',
    fuenteTecnicaAltura: 'CIAT_2025_MANEJO_HUMIDICOLA',
    metadata: {
      region: 'Piedemonte de los Llanos Orientales de Colombia (Meta/Vichada)',
      sistemaProductivo: 'Ganadería de carne, pastoreo rotacional, suelo ácido de baja fertilidad',
      cultivar: 'Llanero (CIAT 6133) -- altura de referencia documentada para cv. Tully (CIAT 679), ver fuenteTecnicaAltura',
      fuente: 'RINCON_2018_HUMIDICOLA_LLANERO',
      limitaciones: [
        'Referencia regional -- NO universalizable a todo Colombia ni a otras condiciones edafoclimáticas.',
        'El rango 25-35 días es el margen de incertidumbre del sprint sobre un punto medio documentado (30 días), no un segundo experimento con esos extremos exactos.',
        'La altura de entrada/salida proviene de un cultivar (Tully) distinto al registrado genéricamente en el catálogo de pasturas -- tratado como referencia de la misma especie, no como dato medido en este potrero.',
      ],
    },
  },
];

function normalizarNombre(valor) {
  if (typeof valor !== 'string') return '';
  return valor
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function resolvePasturaDescansoEspecifica(nombreComun, nombreCientifico) {
  const comun = normalizarNombre(nombreComun);
  const cientifico = normalizarNombre(nombreCientifico);
  if (!comun && !cientifico) return null;
  return PASTURA_DESCANSO_ESPECIFICA.find((entry) => entry.patrones.some(
    (patron) => (comun && comun.includes(patron)) || (cientifico && cientifico.includes(patron)),
  )) ?? null;
}

/**
 * Resuelve el baseline fisiológico de referencia (§3/§4 del hardening) a
 * partir de los nombres de la pastura de la ficha. Devuelve `null` -- NUNCA
 * un fallback inventado -- si no existe un perfil regional específico con
 * evidencia real. El repositorio traduce `null` en NO_PASTURE_PROFILE.
 */
export function resolvePasturaDescansoBaseline(nombresPastura) {
  const especifica = resolvePasturaDescansoEspecifica(nombresPastura?.nombreComun, nombresPastura?.nombreCientifico);
  if (!especifica) return null;

  return {
    restDaysMinReference: especifica.restDaysMinReference,
    restDaysTypicalReference: especifica.restDaysTypicalReference,
    restDaysMaxReference: especifica.restDaysMaxReference,
    referenceEntryHeightCm: especifica.referenceEntryHeightCm,
    referenceExitHeightCm: especifica.referenceExitHeightCm,
    sourceType: especifica.sourceType,
    fuenteTecnica: especifica.fuenteTecnica,
    fuenteTecnicaDetalle: getFuenteTecnicaDescanso(especifica.fuenteTecnica),
    fuenteTecnicaAltura: especifica.fuenteTecnicaAltura,
    fuenteTecnicaAlturaDetalle: getFuenteTecnicaDescanso(especifica.fuenteTecnicaAltura),
    metadata: especifica.metadata,
  };
}

export { PASTURA_DESCANSO_ESPECIFICA };
