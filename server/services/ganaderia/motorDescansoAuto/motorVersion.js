// SPRINT-3D8-DESCANSO-REENTRADA: versión del motor de descanso -- cada
// recomendación histórica persiste esta cadena tal cual
// (agx.potrero_recomendaciones_descanso.motor_version), nunca se
// reinterpreta silenciosamente bajo reglas de una versión posterior.
// Cambiar los baselines de pasturaDescansoBaselineEngine.js o las reglas
// climáticas/de presión de descansoFormulas.js sin agregar una versión
// nueva rompe la trazabilidad histórica.
export const MOTOR_VERSION = 'descanso-v1';
