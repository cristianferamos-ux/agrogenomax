// SPRINT-3D7-CAPACIDAD-PASTOREO: fórmulas puras de la primera capa de
// decisión ganadera del potrero (§8-§17 del sprint). Sin dependencias de
// DB/HTTP -- exclusivamente aritmética, testeable sin fixtures de
// integración. El repositorio (potreroCapacidadPastoreoRepository.js) es
// el único llamador autoritativo: SIEMPRE toma biomasaFrescaKg de la
// ficha productiva real (agx.potrero_fichas_productivas.biomasa_total_kg),
// nunca de un valor enviado por el cliente.
//
// Separación DATO MEDIDO / PARÁMETRO TÉCNICO / RESULTADO CALCULADO (§1
// del sprint) -- estas funciones solo producen RESULTADOS CALCULADOS a
// partir de DATOS MEDIDOS (biomasaFrescaKg, pesoVivoPromedioKg,
// numeroAnimales) y PARÁMETROS TÉCNICOS (porcentajeMateriaSeca,
// porcentajeUtilizacion, consumoPctPesoVivo) explícitos.

// ---------------------------------------------------------------------
// Guardrails técnicos (§29 del sprint) -- evitan errores de digitación,
// NUNCA afirmaciones zootécnicas. Si se cambian, reportar en el handoff
// (§29: "Revisar y justificar").
// ---------------------------------------------------------------------
export const MAX_PESO_VIVO_PROMEDIO_KG = 2000;
export const MAX_NUMERO_ANIMALES = 100000;
export const MAX_PERIODO_OBJETIVO_DIAS = 365;
export const MAX_CONSUMO_PCT_PESO_VIVO = 10;

// Umbrales de advertencia sobre el RESULTADO (§30 del sprint) -- nunca
// bloquean el cálculo, solo agregan una advertencia neutral. Distintos
// de los guardrails de entrada de arriba: un resultado puede salir
// extremo incluso con todos los parámetros dentro de rango (p.ej. una
// utilización muy baja combinada con una demanda muy alta).
export const DIAS_OCUPACION_ADVERTENCIA_MIN = 0.1;
export const DIAS_OCUPACION_ADVERTENCIA_MAX = 3650; // ~10 años -- "absurdamente alto"
export const CAPACIDAD_ANIMALES_ADVERTENCIA_MAX = 100000;

/**
 * materia_seca_total_kg = biomasa_fresca_kg * (porcentaje_materia_seca / 100).
 * §8 del sprint.
 */
export function computeMateriaSecaTotalKg(biomasaFrescaKg, porcentajeMateriaSeca) {
  return biomasaFrescaKg * (porcentajeMateriaSeca / 100);
}

/**
 * materia_seca_utilizable_kg = materia_seca_total_kg * (porcentaje_utilizacion / 100).
 * §10 del sprint.
 */
export function computeMateriaSecaUtilizableKg(materiaSecaTotalKg, porcentajeUtilizacion) {
  return materiaSecaTotalKg * (porcentajeUtilizacion / 100);
}

/**
 * demanda_individual_kg_ms_dia = peso_vivo_promedio_kg * (consumo_pct_peso_vivo / 100).
 * §14 del sprint.
 */
export function computeDemandaIndividualKgMsDia(pesoVivoPromedioKg, consumoPctPesoVivo) {
  return pesoVivoPromedioKg * (consumoPctPesoVivo / 100);
}

/**
 * demanda_diaria_lote_kg_ms = demanda_individual_kg_ms_dia * numero_animales.
 * §15 del sprint.
 */
export function computeDemandaDiariaLoteKgMs(demandaIndividualKgMsDia, numeroAnimales) {
  return demandaIndividualKgMsDia * numeroAnimales;
}

/**
 * dias_ocupacion_estimados = materia_seca_utilizable_kg / demanda_diaria_lote_kg_ms.
 * §16 del sprint -- precisión completa, nunca redondeado silenciosamente
 * como resultado principal.
 */
export function computeDiasOcupacionEstimados(materiaSecaUtilizableKg, demandaDiariaLoteKgMs) {
  return materiaSecaUtilizableKg / demandaDiariaLoteKgMs;
}

/**
 * Modo inverso (§17 del sprint): capacidad de animales para un período
 * objetivo. Devuelve tanto el valor decimal (auditoría interna) como el
 * entero conservador (floor -- "animales completos").
 */
export function computeCapacidadAnimales(materiaSecaUtilizableKg, demandaIndividualKgMsDia, periodoObjetivoDias) {
  const capacidadDecimal = materiaSecaUtilizableKg / (demandaIndividualKgMsDia * periodoObjetivoDias);
  return {
    capacidadDecimal,
    capacidadEntera: Math.floor(capacidadDecimal),
  };
}

/**
 * Cálculo completo, modo "días de ocupación" (§19 modo A del sprint):
 * el usuario conoce numeroAnimales y quiere saber cuántos días puede
 * dejar el lote en el potrero.
 */
export function computeCapacidadPastoreoModoDias({
  biomasaFrescaKg,
  porcentajeMateriaSeca,
  porcentajeUtilizacion,
  consumoPctPesoVivo,
  pesoVivoPromedioKg,
  numeroAnimales,
}) {
  const materiaSecaTotalKg = computeMateriaSecaTotalKg(biomasaFrescaKg, porcentajeMateriaSeca);
  const materiaSecaUtilizableKg = computeMateriaSecaUtilizableKg(materiaSecaTotalKg, porcentajeUtilizacion);
  const demandaIndividualKgMsDia = computeDemandaIndividualKgMsDia(pesoVivoPromedioKg, consumoPctPesoVivo);
  const demandaDiariaLoteKgMs = computeDemandaDiariaLoteKgMs(demandaIndividualKgMsDia, numeroAnimales);
  const diasOcupacionEstimados = computeDiasOcupacionEstimados(materiaSecaUtilizableKg, demandaDiariaLoteKgMs);

  return {
    materiaSecaTotalKg,
    materiaSecaUtilizableKg,
    demandaIndividualKgMsDia,
    demandaDiariaLoteKgMs,
    diasOcupacionEstimados,
    capacidadAnimalesPeriodo: null,
    capacidadAnimalesDecimal: null,
  };
}

/**
 * Cálculo completo, modo "cantidad de animales" (§19 modo B del
 * sprint): el usuario conoce periodoObjetivoDias y quiere saber cuántos
 * animales soporta el potrero en ese período.
 */
export function computeCapacidadPastoreoModoAnimales({
  biomasaFrescaKg,
  porcentajeMateriaSeca,
  porcentajeUtilizacion,
  consumoPctPesoVivo,
  pesoVivoPromedioKg,
  periodoObjetivoDias,
}) {
  const materiaSecaTotalKg = computeMateriaSecaTotalKg(biomasaFrescaKg, porcentajeMateriaSeca);
  const materiaSecaUtilizableKg = computeMateriaSecaUtilizableKg(materiaSecaTotalKg, porcentajeUtilizacion);
  const demandaIndividualKgMsDia = computeDemandaIndividualKgMsDia(pesoVivoPromedioKg, consumoPctPesoVivo);
  const { capacidadDecimal, capacidadEntera } = computeCapacidadAnimales(
    materiaSecaUtilizableKg,
    demandaIndividualKgMsDia,
    periodoObjetivoDias,
  );

  return {
    materiaSecaTotalKg,
    materiaSecaUtilizableKg,
    demandaIndividualKgMsDia,
    demandaDiariaLoteKgMs: null,
    diasOcupacionEstimados: null,
    capacidadAnimalesPeriodo: capacidadEntera,
    capacidadAnimalesDecimal: capacidadDecimal,
  };
}

/**
 * Advertencia neutral sobre resultado extremo (§30 del sprint) -- NUNCA
 * oculta ni recalcula el resultado, solo señala que vale la pena
 * revisar los parámetros ingresados.
 */
export function isResultadoExtremo(modo, resultado) {
  if (modo === 'dias_ocupacion') {
    return (
      resultado.diasOcupacionEstimados < DIAS_OCUPACION_ADVERTENCIA_MIN
      || resultado.diasOcupacionEstimados > DIAS_OCUPACION_ADVERTENCIA_MAX
    );
  }
  return (
    resultado.capacidadAnimalesPeriodo === 0
    || resultado.capacidadAnimalesPeriodo > CAPACIDAD_ANIMALES_ADVERTENCIA_MAX
  );
}
