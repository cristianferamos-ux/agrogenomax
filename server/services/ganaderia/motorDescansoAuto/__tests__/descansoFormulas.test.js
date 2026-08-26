// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico): pruebas unitarias de
// las fórmulas puras del motor de descanso.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAjustePresionDias,
  computeRangoDescansoDias,
  computeFechaSalidaEstimada,
  computeFechasReingreso,
  resolveCondicionesReentrada,
  resolveNivelConfianzaDescanso,
  CONDICION_REENTRADA,
} from '../descansoFormulas.js';
import { AGROCLIMATE_STATUS } from '../agroClimateAssessment.js';

const BASELINE_HUMIDICOLA = { restDaysMinReference: 25, restDaysTypicalReference: 30, restDaysMaxReference: 35 };

// -----------------------------------------------------------------------
// §6 del guardrail de presión de pastoreo (arquitectura preparada).
// -----------------------------------------------------------------------

test('remanente proyectado por encima del objetivo (caso normal) no ajusta el descanso', () => {
  const { deltaDias, aplicado } = computeAjustePresionDias({ remanenteProyectadoKg: 1200, remanenteObjetivoKg: 1000 });
  assert.equal(deltaDias, 0);
  assert.equal(aplicado, false);
});

test('guardrail: remanente proyectado por DEBAJO del objetivo aumenta el descanso (caso defensivo, nunca ocurre en v1 si el motor se respeta)', () => {
  const { deltaDias, aplicado } = computeAjustePresionDias({ remanenteProyectadoKg: 800, remanenteObjetivoKg: 1000 });
  assert.ok(deltaDias > 0);
  assert.equal(aplicado, true);
});

test('valores no finitos de remanente nunca ajustan el descanso', () => {
  const { deltaDias, aplicado } = computeAjustePresionDias({ remanenteProyectadoKg: NaN, remanenteObjetivoKg: 1000 });
  assert.equal(deltaDias, 0);
  assert.equal(aplicado, false);
});

// -----------------------------------------------------------------------
// §1/§14 del hardening: rango DINÁMICO -- el baseline SIEMPRE atraviesa el
// ajuste agroclimático, nunca se devuelve tal cual sin pasar por el
// status.
// -----------------------------------------------------------------------

test('NORMAL mantiene exactamente el baseline (sin evidencia suficiente para desviarse)', () => {
  const rango = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.NORMAL, deltaPresionDias: 0 });
  assert.deepEqual(rango, { diasDescansoMin: 25, diasDescansoMax: 35, diasDescansoRecomendado: 30 });
});

test('INSUFFICIENT_DATA mantiene el baseline (nunca inventa una desviación sin evidencia)', () => {
  const rango = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.INSUFFICIENT_DATA, deltaPresionDias: 0 });
  assert.deepEqual(rango, { diasDescansoMin: 25, diasDescansoMax: 35, diasDescansoRecomendado: 30 });
});

test('FAVORABLE nunca reduce min/max -- el recomendado se orienta hacia la parte baja/media, nunca por debajo del mínimo', () => {
  const rango = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.FAVORABLE, deltaPresionDias: 0 });
  assert.equal(rango.diasDescansoMin, 25);
  assert.equal(rango.diasDescansoMax, 35);
  assert.ok(rango.diasDescansoRecomendado >= rango.diasDescansoMin);
  assert.ok(rango.diasDescansoRecomendado < 30, 'debe orientarse hacia abajo del típico original (30)');
});

test('RESTRICTIVE extiende el rango completo hacia arriba (ancho constante), nunca lo angosta', () => {
  const rango = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.RESTRICTIVE, deltaPresionDias: 0 });
  assert.ok(rango.diasDescansoMin > 25);
  assert.ok(rango.diasDescansoMax > 35);
  assert.equal(rango.diasDescansoMax - rango.diasDescansoMin, 10);
});

test('SEVERELY_RESTRICTIVE extiende más que RESTRICTIVE', () => {
  const restrictivo = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.RESTRICTIVE, deltaPresionDias: 0 });
  const severo = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.SEVERELY_RESTRICTIVE, deltaPresionDias: 0 });
  assert.ok(severo.diasDescansoMin > restrictivo.diasDescansoMin);
});

test('el resultado siempre es un entero (nunca "30.00 días")', () => {
  const rango = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.FAVORABLE, deltaPresionDias: 0 });
  assert.ok(Number.isInteger(rango.diasDescansoMin));
  assert.ok(Number.isInteger(rango.diasDescansoMax));
  assert.ok(Number.isInteger(rango.diasDescansoRecomendado));
});

test('test de no rigidez: el mismo baseline produce rangos DISTINTOS según el status agroclimático', () => {
  const normal = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.NORMAL, deltaPresionDias: 0 });
  const favorable = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.FAVORABLE, deltaPresionDias: 0 });
  const restrictivo = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.RESTRICTIVE, deltaPresionDias: 0 });
  const severo = computeRangoDescansoDias({ baseline: BASELINE_HUMIDICOLA, agroClimateStatus: AGROCLIMATE_STATUS.SEVERELY_RESTRICTIVE, deltaPresionDias: 0 });

  const recomendados = new Set([normal.diasDescansoRecomendado, favorable.diasDescansoRecomendado, restrictivo.diasDescansoRecomendado, severo.diasDescansoRecomendado]);
  assert.ok(recomendados.size >= 3, 'el motor NUNCA debe devolver siempre el mismo número sin importar la condición climática');
});

// -----------------------------------------------------------------------
// Fechas.
// -----------------------------------------------------------------------

test('fecha_salida_estimada = fecha_inicio_pastoreo + dias_ocupacion_recomendados', () => {
  assert.equal(computeFechaSalidaEstimada('2026-09-01', 5), '2026-09-06');
});

test('fecha_salida_estimada usa floor de días de ocupación (nunca redondea hacia arriba)', () => {
  assert.equal(computeFechaSalidaEstimada('2026-09-01', 5.9), '2026-09-06');
});

test('fecha_salida_estimada respeta el cambio de mes', () => {
  assert.equal(computeFechaSalidaEstimada('2026-09-28', 5), '2026-10-03');
});

test('fechas de reingreso = fecha_salida_estimada + dias_descanso_{min,max,recomendado}', () => {
  const fechas = computeFechasReingreso('2026-09-06', { diasDescansoMin: 25, diasDescansoMax: 35, diasDescansoRecomendado: 30 });
  assert.deepEqual(fechas, {
    fechaReingresoMin: '2026-10-01',
    fechaReingresoMax: '2026-10-11',
    fechaReingresoRecomendada: '2026-10-06',
  });
});

// -----------------------------------------------------------------------
// Condiciones de reentrada -- referencia regional, nunca umbral exacto.
// -----------------------------------------------------------------------

test('siempre incluye la condición de confirmar con nuevo aforo', () => {
  const condiciones = resolveCondicionesReentrada({ referenceEntryHeightCm: null });
  assert.equal(condiciones.length, 1);
  assert.equal(condiciones[0].codigo, CONDICION_REENTRADA.CONFIRMAR_NUEVO_AFORO);
});

test('con altura de entrada regional documentada, agrega la condición de referencia (no exigencia exacta)', () => {
  const condiciones = resolveCondicionesReentrada({ referenceEntryHeightCm: 30 });
  const codigos = condiciones.map((c) => c.codigo);
  assert.ok(codigos.includes(CONDICION_REENTRADA.ALTURA_ENTRADA_REFERENCIA));
  assert.ok(codigos.includes(CONDICION_REENTRADA.CONFIRMAR_NUEVO_AFORO));
  const alturaCondicion = condiciones.find((c) => c.codigo === CONDICION_REENTRADA.ALTURA_ENTRADA_REFERENCIA);
  assert.equal(alturaCondicion.detalle.referenceEntryHeightCm, 30);
});

// -----------------------------------------------------------------------
// Confianza -- reglas explícitas, nunca scoring opaco.
// -----------------------------------------------------------------------

test('confianza ALTA: contexto fresco, climatología territorial confirmada (sin degradación agroclimática), recomendación reciente, sin guardrail', () => {
  const nivel = resolveNivelConfianzaDescanso({
    agroClimateFreshness: 'AGROCLIMATE_FRESH',
    agroClimateConfidenceImpact: 'NONE',
    recomendacionEdadDias: 1,
    ajustePresionAplicado: false,
  });
  assert.equal(nivel, 'ALTA');
});

test('contexto AGING degrada la confianza (nunca ALTA sin contexto fresco)', () => {
  const nivel = resolveNivelConfianzaDescanso({
    agroClimateFreshness: 'AGROCLIMATE_AGING',
    agroClimateConfidenceImpact: 'NONE',
    recomendacionEdadDias: 1,
    ajustePresionAplicado: false,
  });
  assert.equal(nivel, 'MEDIA');
});

test('sin contexto agroclimático (o sin climatología local, §21 del hardening territorial) degrada la confianza', () => {
  const nivel = resolveNivelConfianzaDescanso({
    agroClimateFreshness: 'NO_AGROCLIMATE_CONTEXT',
    agroClimateConfidenceImpact: 'DEGRADE',
    recomendacionEdadDias: 1,
    ajustePresionAplicado: false,
  });
  assert.equal(nivel, 'BAJA');
});

test('múltiples degradaciones acumulan pero nunca bajan de BAJA', () => {
  const nivel = resolveNivelConfianzaDescanso({
    agroClimateFreshness: 'AGROCLIMATE_STALE',
    agroClimateConfidenceImpact: 'DEGRADE',
    recomendacionEdadDias: 90,
    ajustePresionAplicado: true,
  });
  assert.equal(nivel, 'BAJA');
});

// -----------------------------------------------------------------------
// SPRINT 3D8 (semantic final fix) §1: `climatologyGenerated`/cacheHit/
// cacheMiss son estados OPERACIONALES/UX -- NUNCA pueden participar en el
// cálculo del nivel de confianza. Confianza depende EXCLUSIVAMENTE de
// evidencia (freshness, calidad/cobertura de climatología vía
// agroClimateConfidenceImpact, antigüedad de la recomendación, guardrail
// de presión) -- nunca de si el dato se acaba de generar o se leyó de
// caché.
// -----------------------------------------------------------------------

test('test A (semantic fix): climatología recién generada vs. climatología idéntica leída de caché -> MISMO nivel_confianza', () => {
  const paramsBase = {
    agroClimateFreshness: 'AGROCLIMATE_FRESH',
    agroClimateConfidenceImpact: 'NONE',
    recomendacionEdadDias: 1,
    ajustePresionAplicado: false,
  };
  const nivelReciénGenerada = resolveNivelConfianzaDescanso({ ...paramsBase, climatologyGenerated: true });
  const nivelDesdeCache = resolveNivelConfianzaDescanso({ ...paramsBase, climatologyGenerated: false });
  assert.equal(nivelReciénGenerada, nivelDesdeCache, 'newlyGenerated=true vs. loadedFromCache=true deben producir el MISMO nivel_confianza');
  assert.equal(nivelReciénGenerada, 'ALTA');
});

test('test F (semantic fix): resolveNivelConfianzaDescanso NUNCA lee climatologyGenerated/cacheHit/cacheMiss -- ni siquiera si vienen en el objeto de entrada', () => {
  const nivelConFlagsFalsos = resolveNivelConfianzaDescanso({
    agroClimateFreshness: 'AGROCLIMATE_FRESH',
    agroClimateConfidenceImpact: 'NONE',
    recomendacionEdadDias: 1,
    ajustePresionAplicado: false,
    // Flags operacionales/UX deliberadamente contradictorios -- si el
    // cálculo los leyera, produciría un resultado distinto según cuál
    // "gane"; la firma real de la función ni siquiera los destructura.
    climatologyGenerated: true,
    cacheHit: false,
    cacheMiss: true,
  });
  assert.equal(nivelConFlagsFalsos, 'ALTA');
});
