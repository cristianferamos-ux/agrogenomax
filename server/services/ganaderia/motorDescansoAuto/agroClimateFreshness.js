// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial) §17: frescura del
// contexto agroclimático -- evaluación EXPLÍCITA, nunca implícita. Un
// snapshot viejo no debe sostener una recomendación de confianza alta,
// aunque exista.
//
// SOURCE-AWARE (§17 del hardening territorial): las fuentes tienen
// latencias DISTINTAS -- ERA5-Land tiene un rezago operativo documentado
// de ~145h/~6 días (ver era5LandProvider.js, cabecera). IDEAM es
// observación de estación, con rezago típicamente menor. Tratar TODA
// observación con la misma ventana ciega penaliza injustamente a IDEAM
// (más reciente) y es demasiado laxo para ERA5-Land. Ventanas
// documentadas como regla de ingeniería propia:
//   - ERA5_LAND: FRESH <=10 días (mismo orden de magnitud del rezago de
//     ~6 días ya documentado + margen), AGING <=30 días (mismo orden que
//     la ventana de precipitación de 30 días que el motor climático usa
//     como señal más larga).
//   - IDEAM: observación de estación, rezago esperado mucho menor --
//     FRESH <=3 días, AGING <=10 días.
//   - Sin fuente_principal conocida: se aplica la ventana MÁS
//     CONSERVADORA (ERA5_LAND) -- nunca se asume la más laxa por defecto.
export const AGROCLIMATE_FRESHNESS = Object.freeze({
  FRESH: 'AGROCLIMATE_FRESH',
  AGING: 'AGROCLIMATE_AGING',
  STALE: 'AGROCLIMATE_STALE',
  NONE: 'NO_AGROCLIMATE_CONTEXT',
});

export const FRESHNESS_WINDOWS_BY_SOURCE = Object.freeze({
  ERA5_LAND: Object.freeze({ freshMaxDias: 10, agingMaxDias: 30 }),
  IDEAM: Object.freeze({ freshMaxDias: 3, agingMaxDias: 10 }),
});
const DEFAULT_WINDOW = FRESHNESS_WINDOWS_BY_SOURCE.ERA5_LAND;

// Retrocompatibilidad de nombres ya usados por otros módulos/tests --
// corresponden a la ventana por defecto (ERA5_LAND).
export const FRESHNESS_FRESH_MAX_DIAS = DEFAULT_WINDOW.freshMaxDias;
export const FRESHNESS_AGING_MAX_DIAS = DEFAULT_WINDOW.agingMaxDias;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * `referenciaFecha` es la fecha de mayor confianza disponible del snapshot
 * -- se prioriza `sourceObservedUntil` (último dato REAL de la fuente)
 * sobre `createdAt` (fecha de registro del snapshot en el sistema, que
 * puede ser posterior al dato real). `fuentePrincipal` ('ERA5_LAND' |
 * 'IDEAM' | otro/ausente) selecciona la ventana de frescura correcta para
 * ESA fuente -- sin fuente conocida, se aplica la ventana más
 * conservadora (nunca la más laxa por defecto).
 */
export function assessAgroClimateFreshness({ createdAt, sourceObservedUntil, fuentePrincipal } = {}) {
  if (!createdAt && !sourceObservedUntil) {
    return { freshness: AGROCLIMATE_FRESHNESS.NONE, edadDias: null };
  }

  const referencia = sourceObservedUntil ?? createdAt;
  const timestamp = new Date(referencia).getTime();
  if (!Number.isFinite(timestamp)) {
    return { freshness: AGROCLIMATE_FRESHNESS.NONE, edadDias: null };
  }

  const ventana = FRESHNESS_WINDOWS_BY_SOURCE[fuentePrincipal] ?? DEFAULT_WINDOW;
  const edadDias = (Date.now() - timestamp) / MS_POR_DIA;
  if (edadDias <= ventana.freshMaxDias) {
    return { freshness: AGROCLIMATE_FRESHNESS.FRESH, edadDias };
  }
  if (edadDias <= ventana.agingMaxDias) {
    return { freshness: AGROCLIMATE_FRESHNESS.AGING, edadDias };
  }
  return { freshness: AGROCLIMATE_FRESHNESS.STALE, edadDias };
}
