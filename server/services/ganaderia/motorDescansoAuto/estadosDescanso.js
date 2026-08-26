// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico) §22: estados
// explícitos del motor de descanso. READY, PARTIAL_CONTEXT y
// STALE_AGROCLIMATE_CONTEXT nunca son errores HTTP -- viajan como campo
// `estado` en una respuesta 200, con nivelConfianza ya degradado. Los
// demás SÍ bloquean el cálculo -- se lanzan como errores semánticos
// (repositorio) con el mismo código como `error` HTTP.
export const ESTADO_DESCANSO = Object.freeze({
  READY: 'READY',
  NO_GRAZING_RECOMMENDATION: 'NO_GRAZING_RECOMMENDATION',
  NO_PASTURE_PROFILE: 'NO_PASTURE_PROFILE',
  NO_AGROCLIMATE_CONTEXT: 'NO_AGROCLIMATE_CONTEXT',
  STALE_AGROCLIMATE_CONTEXT: 'STALE_AGROCLIMATE_CONTEXT',
  PARTIAL_CONTEXT: 'PARTIAL_CONTEXT',
  REST_UNAVAILABLE: 'REST_UNAVAILABLE',
});

// §22 del hardening: condición dinámica -- nunca "READY_TO_GRAZE" solo por
// paso del tiempo (§15). REENTRY_WINDOW_ESTIMATED siempre acompaña un
// resultado calculado (nunca "listo", siempre "ventana estimada").
// REASSESSMENT_RECOMMENDED se agrega cuando ya existía una recomendación
// previa y la nueva estimación difiere de forma significativa (§21/§28).
export const WINDOW_CONDITION = Object.freeze({
  REENTRY_WINDOW_ESTIMATED: 'REENTRY_WINDOW_ESTIMATED',
  REASSESSMENT_RECOMMENDED: 'REASSESSMENT_RECOMMENDED',
});
