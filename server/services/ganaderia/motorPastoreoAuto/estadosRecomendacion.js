// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §18: estados explícitos del
// motor automático. READY y PARTIAL_CONTEXT nunca son errores HTTP (§18:
// "no convertir ausencia de clima en excepción fatal si el cálculo base
// aún puede hacerse") -- PARTIAL_CONTEXT viaja como campo `estado` en una
// respuesta 200, con nivelConfianza ya degradado. Los demás SÍ bloquean el
// cálculo -- se lanzan como errores semánticos (repositorio) con el mismo
// código como `error` HTTP.
export const ESTADO_RECOMENDACION = Object.freeze({
  READY: 'READY',
  INSUFFICIENT_FORAGE_DATA: 'INSUFFICIENT_FORAGE_DATA',
  NO_PRODUCTIVE_PROFILE: 'NO_PRODUCTIVE_PROFILE',
  NO_TECHNICAL_PARAMETERS: 'NO_TECHNICAL_PARAMETERS',
  PARTIAL_CONTEXT: 'PARTIAL_CONTEXT',
  CALCULATION_UNAVAILABLE: 'CALCULATION_UNAVAILABLE',
});
