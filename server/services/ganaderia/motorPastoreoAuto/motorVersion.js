// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §15: versión del motor
// automático -- cada recomendación histórica persiste esta cadena tal cual
// (agx.potrero_recomendaciones_pastoreo.motor_version), nunca se
// reinterpreta silenciosamente bajo reglas de una versión posterior.
// Cambiar las reglas de pastureClimateEngine.js o de las categorías del
// catálogo sin agregar una versión nueva rompe la trazabilidad histórica.
export const MOTOR_VERSION = 'pastoreo-auto-v1';
