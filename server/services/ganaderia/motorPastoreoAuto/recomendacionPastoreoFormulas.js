// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: fórmulas puras del motor
// automático -- sin dependencias de DB/HTTP. Reutiliza EXACTAMENTE las
// mismas fórmulas físicas de capacidadPastoreoFormulas.js (3D7, "Modo
// técnico") para materia seca total/utilizable -- el motor automático
// 3D7.2 no cambia esa física, solo automatiza de dónde salen
// porcentaje_materia_seca/porcentaje_utilizacion (categoría + pastura+
// clima en vez de digitación manual, §1 del sprint).
//
// Modo soportado en v1: SOLO "días de ocupación" (numeroAnimales conocido
// -> días estimados). El modo inverso (días objetivo -> capacidad de
// animales) queda explícitamente fuera de alcance (§6 del sprint: "Para
// modo inverso futuro: días objetivo").
//
// HARDENING RONDA 4 -- corrección de FCM (la ronda 3 tenía un bug real: usaba
// litros/día directamente como FCM, que NO es lo que la ecuación NRC (2001)
// pide). FCM (4% fat-corrected milk) = 0.4×leche_kg + 15×grasa_kg (Gaines &
// Davidson 1923, refinado Gaines 1928 -- ver fuentesTecnicas.js
// GAINES_1923_FCM). Requiere %grasa real, que el productor puede no conocer
// -- por eso es un input OPCIONAL:
// - Si el cliente aporta %grasa: se ejecuta la ecuación NRC (2001) COMPLETA
//   y correcta (dmiModel='NRC_2001_DAIRY_DMI', sourceType='DIRECT').
// - Si NO la aporta: NUNCA se inventa un %grasa ni se ejecuta una ecuación
//   FCM falsa -- se usa el mismo perfil %PV genérico que cualquier otra
//   categoría (dmiModel='GENERIC_LACTATING_PROFILE'), y la confianza queda
//   topada en MEDIA como máximo (nunca ALTA sin FCM real).
//
// HARDENING RONDA 3 (vigente): ternero al pie NUNCA suma una constante fija
// -- degrada confianza y expone una limitación explícita en vez de fingir
// precisión.
import {
  computeMateriaSecaTotalKg,
  computeMateriaSecaUtilizableKg,
  computeDemandaIndividualKgMsDia,
  computeDemandaDiariaLoteKgMs,
  computeDiasOcupacionEstimados,
} from '../capacidadPastoreoFormulas.js';

// -----------------------------------------------------------------------
// NRC (2001) -- ecuación de predicción de DMI de vacas lactantes (hardening
// §1/§3/ronda4). DMI (kg/d) = (0.372×FCM + 0.0968×BW^0.75) × [1 − e^(−0.192×(WOL+3.67))]
// Verificada contra fuentes secundarias (ScienceDirect/NCBI, ver
// fuentesTecnicas.js NRC_2001_DAIRY_DMI). FCM = leche 4% grasa (kg/d) --
// NUNCA el volumen de leche crudo.
// -----------------------------------------------------------------------

// Densidad estándar de la leche bovina (kg por litro) -- conversión FÍSICA
// documentada (no un coeficiente zootécnico), usada SOLO para pasar
// litros/día (unidad capturada al productor) a kg/día (unidad que exige la
// ecuación) -- nunca usada como sustituto de FCM (hardening ronda 4 §6).
export const DENSIDAD_LECHE_KG_POR_LITRO = 1.03;
export const DENSIDAD_LECHE_FUENTE = 'DENSIDAD_ESTANDAR_1.03_KG_L';

// Fórmula de leche corregida al 4% de grasa (FCM) -- Gaines & Davidson
// (1923), refinada por Gaines (1928). Ver fuentesTecnicas.js GAINES_1923_FCM.
const FCM_COEF_LECHE = 0.4;
const FCM_COEF_GRASA = 15;

/**
 * FCM (4% fat-corrected milk, kg/d) -- Gaines & Davidson (1923). NUNCA se
 * sustituye por el volumen de leche crudo (hardening ronda 4 §1/§3).
 */
export function computeFcmKgDia(milkKgDia, grasaPct) {
  const milkFatKgDia = milkKgDia * (grasaPct / 100);
  return FCM_COEF_LECHE * milkKgDia + FCM_COEF_GRASA * milkFatKgDia;
}

const NRC2001_COEF_FCM = 0.372;
const NRC2001_COEF_BW = 0.0968;
const NRC2001_EXP_BW = 0.75;
const NRC2001_COEF_WOL = 0.192;
const NRC2001_OFFSET_WOL = 3.67;

/**
 * DMI individual de una vaca lactante según NRC (2001), ecuación COMPLETA y
 * correcta (hardening ronda 4) -- requiere %grasa real para calcular FCM.
 * WOL (semana de lactancia) = diasEnLeche ÷ 7 (hardening ronda 4 §2 --
 * explícito, con test dedicado). Devuelve el detalle completo auditable
 * (§7 del hardening: milkKgDayUsed, fcmKgDay, weeksOfLactation, etc.) --
 * nunca solo el número final.
 */
export function computeDemandaIndividualLecheNrc2001({ pesoPromedioKg, litrosPromedioVacaDia, diasEnLeche, grasaLechePct }) {
  const milkKgDayUsed = litrosPromedioVacaDia * DENSIDAD_LECHE_KG_POR_LITRO;
  const milkFatKgDay = milkKgDayUsed * (grasaLechePct / 100);
  const fcmKgDay = computeFcmKgDia(milkKgDayUsed, grasaLechePct);
  const weeksOfLactation = diasEnLeche / 7;
  const bwTerm = NRC2001_COEF_BW * Math.pow(pesoPromedioKg, NRC2001_EXP_BW);
  const factorLactancia = 1 - Math.exp(-NRC2001_COEF_WOL * (weeksOfLactation + NRC2001_OFFSET_WOL));
  const predictedDmiKgDay = (NRC2001_COEF_FCM * fcmKgDay + bwTerm) * factorLactancia;

  return {
    milkInputLitersDay: litrosPromedioVacaDia,
    milkKgDayUsed,
    milkDensityOrConversionSource: DENSIDAD_LECHE_FUENTE,
    milkFatPct: grasaLechePct,
    milkFatKgDay,
    fcmKgDay,
    daysInMilk: diasEnLeche,
    weeksOfLactation,
    bwKg: pesoPromedioKg,
    predictedDmiKgDay,
    equationSource: 'NRC_2001_DAIRY_DMI',
    dmiModelSourceType: 'DIRECT',
  };
}

// -----------------------------------------------------------------------
// Hardening ronda 5 -- corrige un bug real detectado en el primer preview
// de producción (POTRERO 1, Novillas de levante): "remanente proyectado"
// era literalmente un alias de "remanente objetivo" (materiaSecaTotalKg -
// materiaSecaUtilizableKg), un concepto DISTINTO. Se separan explícitamente
// 5 conceptos, ninguno alias del otro:
//   A. materiaSecaTotalKg          -- ya existía.
//   B. materiaSecaUtilizableKg     -- ya existía.
//   C. remanenteObjetivoKg         = A - B (reserva PLANEADA, nunca pastoreada
//                                    según el %utilización -- lo que el
//                                    motor pretendía dejar).
//   D. diasOcupacionRecomendados   = floor(diasOcupacionEstimados) -- manejo
//                                    conservador (§3 del hotfix): nunca
//                                    redondear hacia arriba un día que
//                                    consumiría más MS de la utilizable.
//   E. consumoProyectadoKg         = demandaDiariaLoteKgMs × diasOcupacionRecomendados
//                                    (consumo REAL esperado durante los días
//                                    realmente recomendados, no los exactos
//                                    antes de redondear).
//   F. remanenteProyectadoKg       = materiaSecaTotalKg - consumoProyectadoKg
//                                    (lo que FÍSICAMENTE queda en el potrero
//                                    al retirar el lote -- por el floor,
//                                    siempre >= remanenteObjetivoKg, nunca
//                                    igual salvo que diasOcupacionEstimados
//                                    sea un entero exacto).
// -----------------------------------------------------------------------
// SPRINT-3D9.3 -- núcleo compartido PLAN/REAL: la ecuación física en sí
// (consumo = demanda x días; remanente = total - consumo) es IDÉNTICA en
// ambos casos -- lo único que difiere es CÓMO se resuelve `diasConsumo`
// (floor de un entero-objetivo para PLAN, fracción exacta de exposición
// real para REAL). Extraído para que ninguno de los dos sea una fórmula
// paralela -- ver computeRemnantDerivatives (PLAN, sin cambios de
// comportamiento) y computeConsumoYRemanenteReal (REAL, nuevo) más abajo.
function computeConsumoYRemanenteCore({
  materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasConsumo,
}) {
  const consumoProyectadoKg = demandaDiariaLoteKgMs * diasConsumo;
  const remanenteObjetivoKg = materiaSecaTotalKg - materiaSecaUtilizableKg;
  const remanenteProyectadoKg = materiaSecaTotalKg - consumoProyectadoKg;
  return {
    consumoProyectadoKg,
    remanenteObjetivoKg,
    remanenteProyectadoKg,
  };
}

export function computeRemnantDerivatives({
  materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasOcupacionEstimados,
}) {
  const diasOcupacionRecomendados = Math.floor(diasOcupacionEstimados);
  const derivados = computeConsumoYRemanenteCore({
    materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasConsumo: diasOcupacionRecomendados,
  });
  return {
    diasOcupacionRecomendados,
    ...derivados,
  };
}

// SPRINT-3D9.3 -- REAL pressure: `fraccionDiaReal` (permanencia real en
// horas / 24) se usa EXACTA, nunca floor -- un ciclo de pocas horas debe
// producir un consumo estimado proporcional a esa fracción, nunca 0 (que
// sería el resultado de reutilizar computeRemnantDerivatives sin
// cambios) ni 1 día completo inventado. Mismo núcleo que PLAN
// (computeConsumoYRemanenteCore) -- misma ecuación, entrada distinta.
export function computeConsumoYRemanenteReal({
  materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, fraccionDiaReal,
}) {
  return computeConsumoYRemanenteCore({
    materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasConsumo: fraccionDiaReal,
  });
}

/**
 * Cálculo completo del motor automático (§7 del sprint, hardening rondas
 * 3/4/5) -- toma biomasaFrescaKg (de la ficha real), los parámetros ya
 * resueltos server-side (categoría + pastura/clima), numeroAnimales/
 * pesoPromedioKg (inputs mínimos, §6) y, para vacas en producción:
 * - si grasaLechePct está disponible: ejecuta NRC (2001) completo (DIRECT).
 * - si NO: usa el perfil %PV genérico de la categoría (consumoPctPesoVivo,
 *   igual que cualquier otra categoría) -- NUNCA inventa un %grasa
 *   (hardening ronda 4 §5). `dmiModel` documenta cuál de los dos corrió.
 * terneroAlPie NUNCA suma demanda individual en v1 -- ver `limitaciones`.
 */
export function computeRecomendacionPastoreo({
  biomasaFrescaKg,
  materiaSecaPct,
  utilizacionPct,
  consumoPctPesoVivo,
  pesoPromedioKg,
  numeroAnimales,
  esCategoriaLeche = false,
  litrosPromedioVacaDia = null,
  diasEnLeche = null,
  grasaLechePct = null,
  terneroAlPie = null,
}) {
  const materiaSecaTotalKg = computeMateriaSecaTotalKg(biomasaFrescaKg, materiaSecaPct);
  const materiaSecaUtilizableKg = computeMateriaSecaUtilizableKg(materiaSecaTotalKg, utilizacionPct);

  const usaEcuacionCompleta = esCategoriaLeche
    && typeof grasaLechePct === 'number' && Number.isFinite(grasaLechePct) && grasaLechePct > 0;

  let demandaIndividualKgMsDia;
  let dmiDetalle = null;
  let dmiModel = null;
  if (usaEcuacionCompleta) {
    dmiDetalle = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg, litrosPromedioVacaDia, diasEnLeche, grasaLechePct });
    demandaIndividualKgMsDia = dmiDetalle.predictedDmiKgDay;
    dmiModel = 'NRC_2001_DAIRY_DMI';
  } else {
    // Hardening ronda 4 §5: sin %grasa real, NUNCA se ejecuta una ecuación
    // FCM falsa -- perfil %PV genérico (misma fórmula que el resto de
    // categorías, consumoPctPesoVivo viene del catálogo).
    demandaIndividualKgMsDia = computeDemandaIndividualKgMsDia(pesoPromedioKg, consumoPctPesoVivo);
    dmiModel = esCategoriaLeche ? 'GENERIC_LACTATING_PROFILE' : null;
  }

  // Hardening ronda 3 §4: terneroAlPie NUNCA altera la demanda -- sin
  // evidencia suficiente para un coeficiente por animal/edad/peso.
  const demandaDiariaLoteKgMs = computeDemandaDiariaLoteKgMs(demandaIndividualKgMsDia, numeroAnimales);

  const diasOcupacionEstimados = computeDiasOcupacionEstimados(materiaSecaUtilizableKg, demandaDiariaLoteKgMs);

  // Hardening ronda 5: derivados de remanente/consumo proyectado -- ver
  // computeRemnantDerivatives arriba. Se calculan aquí incluso si
  // diasOcupacionEstimados resulta no-finito/negativo (guardrail de
  // CALCULATION_UNAVAILABLE vive en el repositorio, después de esta
  // llamada) -- no rompen, solo producen valores no-finitos que nunca
  // llegan a persistirse/responderse en ese caso.
  const remnant = computeRemnantDerivatives({
    materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasOcupacionEstimados,
  });

  return {
    materiaSecaTotalKg,
    materiaSecaUtilizableKg,
    demandaIndividualKgMsDia,
    demandaDiariaLoteKgMs,
    diasOcupacionEstimados,
    diasOcupacionRecomendados: remnant.diasOcupacionRecomendados,
    consumoProyectadoKg: remnant.consumoProyectadoKg,
    remanenteObjetivoKg: remnant.remanenteObjetivoKg,
    remanenteProyectadoKg: remnant.remanenteProyectadoKg,
    terneroAlPieDemandaIncluida: false,
    dmiModel,
    dmiDetalle,
  };
}

// -----------------------------------------------------------------------
// Nivel de confianza (§9 del sprint, hardening §5/§6 + ronda 3 §4 + ronda 4
// §5) -- reglas documentadas, nunca scoring opaco. Se parte de ALTA y se
// degrada un nivel por cada condición que no se cumple, sin bajar de BAJA.
// -----------------------------------------------------------------------
const NIVELES = ['ALTA', 'MEDIA', 'BAJA'];
const FICHA_STALE_DIAS = 60;

function degradar(nivelActual) {
  const idx = NIVELES.indexOf(nivelActual);
  return NIVELES[Math.min(idx + 1, NIVELES.length - 1)];
}

/**
 * Reglas de confianza (§9 del sprint original + hardening §5/§6 + ronda 3
 * §4 + ronda 4 §5):
 * 1. Sin contexto agroclimático disponible -> degrada un nivel.
 * 2. Ficha productiva con más de FICHA_STALE_DIAS de antigüedad -> degrada.
 * 3. dryMatterSource === 'FALLBACK' -> degrada.
 * 4. categoriaFuenteTipo === 'FALLBACK' (p.ej. receptoras) -> degrada.
 * 5. terneroAlPie === true (demanda NO cuantificada) -> degrada.
 * 6. usaPerfilGenericoLeche === true (sin %grasa real, NRC 2001 no corrió)
 *    -> TOPE duro en MEDIA, nunca ALTA (hardening ronda 4 §5) -- se aplica
 *    DESPUÉS de las degradaciones anteriores, nunca las revierte.
 * El piso es siempre BAJA.
 */
export function resolveNivelConfianza({
  tieneContexto, fichaEdadDias, dryMatterSource, categoriaFuenteTipo, terneroAlPie, usaPerfilGenericoLeche,
}) {
  let nivel = 'ALTA';
  if (!tieneContexto) nivel = degradar(nivel);
  if (typeof fichaEdadDias === 'number' && fichaEdadDias > FICHA_STALE_DIAS) nivel = degradar(nivel);
  if (dryMatterSource === 'FALLBACK') nivel = degradar(nivel);
  if (categoriaFuenteTipo === 'FALLBACK') nivel = degradar(nivel);
  if (terneroAlPie === true) nivel = degradar(nivel);
  if (usaPerfilGenericoLeche === true && nivel === 'ALTA') nivel = 'MEDIA';
  return nivel;
}

export { FICHA_STALE_DIAS };
