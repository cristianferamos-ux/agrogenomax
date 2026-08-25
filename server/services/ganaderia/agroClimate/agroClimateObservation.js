// SPRINT-3D7.1-AGROCLIMA: modelo interno común (§8 del sprint) al que
// cada proveedor adapta sus campos. Puramente de datos -- ningún proveedor
// concreto importa de otro, todos convergen aquí.

export const AGRO_CLIMATE_SOURCES = Object.freeze({
  ERA5_LAND: 'ERA5_LAND',
  IDEAM: 'IDEAM',
});

// §7 del sprint: IDEAM advierte datos crudos/no validados -- 'raw'. ERA5-Land
// es un producto de reanálisis (modelo + asimilación de observaciones), no
// una medición directa -- 'reanalysis'. Ninguna de las dos etiquetas implica
// "exacto para este potrero" (§24: nunca prometer "clima exacto del potrero").
export const AGRO_CLIMATE_QUALITY = Object.freeze({
  REANALYSIS: 'reanalysis',
  RAW_OBSERVED: 'raw_observed',
});

// Estado agregado de la respuesta de refresh (§15 del sprint).
export const AGRO_CLIMATE_STATUS = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * Observación normalizada de un único proveedor (§8 del sprint). Todos los
 * campos numéricos son `null` cuando el proveedor no los entrega -- nunca
 * 0 como sustituto de "sin dato" (0 mm de lluvia es un valor real y
 * distinto de "no se pudo medir").
 */
export function buildAgroClimateObservation({
  source,
  observedFrom = null,
  observedUntil = null,
  lat = null,
  lng = null,
  precipitacion24hMm = null,
  precipitacion7dMm = null,
  precipitacion15dMm = null,
  precipitacion30dMm = null,
  temperaturaMediaC = null,
  temperaturaMinC = null,
  temperaturaMaxC = null,
  humedadRelativaMediaPct = null,
  humedadSueloSuperficial = null,
  humedadSueloSubsuperficial = null,
  radiacionSolar = null,
  vientoMedioMs = null,
  quality,
  metadata = {},
}) {
  return {
    source,
    observedFrom,
    observedUntil,
    lat,
    lng,
    precipitacion24hMm,
    precipitacion7dMm,
    precipitacion15dMm,
    precipitacion30dMm,
    temperaturaMediaC,
    temperaturaMinC,
    temperaturaMaxC,
    humedadRelativaMediaPct,
    humedadSueloSuperficial,
    humedadSueloSubsuperficial,
    radiacionSolar,
    vientoMedioMs,
    quality,
    metadata,
  };
}
