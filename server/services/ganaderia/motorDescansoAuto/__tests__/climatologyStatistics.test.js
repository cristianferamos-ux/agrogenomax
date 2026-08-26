// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial + operacional):
// pruebas puras de la capa de estadística climatológica.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePercentile,
  computeBreakpoints,
  computeTrailingSums,
  groupByCalendarMonth,
  buildMonthlyClimatology,
  classifyLevel,
  computeAnomaly,
  LEVEL,
} from '../climatologyStatistics.js';

test('computePercentile: mediana de una muestra impar', () => {
  assert.equal(computePercentile([1, 2, 3, 4, 5], 50), 3);
});

test('computePercentile: interpolación lineal estándar', () => {
  // [10,20,30,40] p25 -> rank = 0.25*3 = 0.75 -> 10 + 0.75*(20-10) = 17.5
  assert.equal(computePercentile([10, 20, 30, 40], 25), 17.5);
});

test('computeBreakpoints: ignora valores no finitos, calcula sampleSize correcto', () => {
  const bp = computeBreakpoints([10, null, 20, NaN, 30, undefined, 40, 50]);
  assert.equal(bp.sampleSize, 5);
  assert.equal(bp.p50, 30);
});

test('computeBreakpoints: sin valores -> null (nunca inventa una distribución)', () => {
  assert.equal(computeBreakpoints([]), null);
  assert.equal(computeBreakpoints([null, NaN]), null);
});

test('computeTrailingSums: suma ventana completa, null si la ventana no está completa (borde inicial)', () => {
  const sums = computeTrailingSums([10, 10, 10, 10, 10], 3);
  assert.equal(sums[0], null); // solo 1 día disponible
  assert.equal(sums[1], null); // solo 2 días disponibles
  assert.equal(sums[2], 30);
  assert.equal(sums[4], 30);
});

test('computeTrailingSums: un solo valor faltante invalida toda la ventana (nunca suma parcial silenciosa)', () => {
  const sums = computeTrailingSums([10, null, 10], 3);
  assert.equal(sums[2], null);
});

test('groupByCalendarMonth: agrupa por mes calendario, ignora valores no finitos', () => {
  const dates = ['2020-01-15', '2021-01-20', '2020-06-01', '2020-01-01'];
  const values = [5, 15, 100, NaN];
  const grupos = groupByCalendarMonth(dates, values);
  assert.deepEqual(grupos.get(1), [5, 15]);
  assert.deepEqual(grupos.get(6), [100]);
});

test('buildMonthlyClimatology: produce breakpoints para los 12 meses (null si un mes no tiene datos)', () => {
  const dates = ['2020-03-01', '2021-03-01', '2020-03-15'];
  const values = [10, 20, 30];
  const climatologia = buildMonthlyClimatology(dates, values);
  assert.equal(Object.keys(climatologia).length, 12);
  assert.ok(climatologia[3]);
  assert.equal(climatologia[3].sampleSize, 3);
  assert.equal(climatologia[1], null);
});

// -----------------------------------------------------------------------
// §5/§6 del hardening operacional: 5 NIVELES locales (VERY_LOW/LOW/NORMAL/
// HIGH/VERY_HIGH) -- distingue HIGH de VERY_HIGH para que "FAVORABLE"
// exija evidencia genuinamente alta, nunca una simple lectura NORMAL.
// -----------------------------------------------------------------------

const BREAKPOINTS_EJEMPLO = { p10: 5, p25: 10, p50: 20, p75: 30, p90: 35 };

test('classifyLevel: <=P10 -> VERY_LOW', () => {
  assert.equal(classifyLevel(3, BREAKPOINTS_EJEMPLO), LEVEL.VERY_LOW);
  assert.equal(classifyLevel(5, BREAKPOINTS_EJEMPLO), LEVEL.VERY_LOW);
});

test('classifyLevel: P10-P25 -> LOW', () => {
  assert.equal(classifyLevel(8, BREAKPOINTS_EJEMPLO), LEVEL.LOW);
});

test('classifyLevel: P25-P75 -> NORMAL (nunca HIGH, aunque esté cerca del límite)', () => {
  assert.equal(classifyLevel(20, BREAKPOINTS_EJEMPLO), LEVEL.NORMAL);
  assert.equal(classifyLevel(29, BREAKPOINTS_EJEMPLO), LEVEL.NORMAL);
});

test('classifyLevel: P75-P90 -> HIGH', () => {
  assert.equal(classifyLevel(30, BREAKPOINTS_EJEMPLO), LEVEL.HIGH);
  assert.equal(classifyLevel(34, BREAKPOINTS_EJEMPLO), LEVEL.HIGH);
});

test('classifyLevel: >=P90 -> VERY_HIGH', () => {
  assert.equal(classifyLevel(35, BREAKPOINTS_EJEMPLO), LEVEL.VERY_HIGH);
  assert.equal(classifyLevel(50, BREAKPOINTS_EJEMPLO), LEVEL.VERY_HIGH);
});

// -----------------------------------------------------------------------
// §24 del hardening -- TEST DE TERRITORIALIDAD explícito: el MISMO valor
// absoluto se clasifica DISTINTO según la distribución histórica local.
// -----------------------------------------------------------------------
test('§24 territorialidad: el mismo valor absoluto (0.20) es VERY_LOW en un potrero y VERY_HIGH en otro', () => {
  const climatologiaPotreroA = computeBreakpoints([0.30, 0.32, 0.35, 0.38, 0.40, 0.42, 0.45, 0.48, 0.50, 0.55]); // húmedo históricamente
  const climatologiaPotreroB = computeBreakpoints([0.02, 0.03, 0.05, 0.07, 0.09, 0.10, 0.12, 0.14, 0.16, 0.18]); // seco históricamente

  const valorActual = 0.20;
  const nivelA = classifyLevel(valorActual, climatologiaPotreroA);
  const nivelB = classifyLevel(valorActual, climatologiaPotreroB);

  assert.notEqual(nivelA, nivelB);
  assert.equal(nivelA, LEVEL.VERY_LOW);
  assert.equal(nivelB, LEVEL.VERY_HIGH);
});

test('§5/§6 del hardening: un valor NORMAL (P25-P75) nunca se confunde con HIGH/VERY_HIGH -- "favorable" exige evidencia genuina, no normalidad simple', () => {
  // Un potrero con humedad histórica P55 (dentro de lo normal) para un
  // valor actual de 0.20 -- debe ser NORMAL, nunca HIGH/VERY_HIGH.
  const climatologia = computeBreakpoints([0.15, 0.17, 0.18, 0.19, 0.20, 0.21, 0.22, 0.23, 0.25, 0.28]);
  const nivel = classifyLevel(0.20, climatologia);
  assert.equal(nivel, LEVEL.NORMAL);
  assert.notEqual(nivel, LEVEL.HIGH);
  assert.notEqual(nivel, LEVEL.VERY_HIGH);
});

// -----------------------------------------------------------------------
// §25 del hardening -- TEST ESTACIONAL: la misma serie con estacionalidad
// real produce climatologías DISTINTAS por mes.
// -----------------------------------------------------------------------
test('§25 estacionalidad: precipitación de un mes húmedo histórico vs. un mes seco histórico producen breakpoints distintos', () => {
  const dates = [];
  const values = [];
  for (let anio = 2001; anio <= 2020; anio += 1) {
    dates.push(`${anio}-01-15`); values.push(5 + (anio % 3)); // enero: históricamente seco
    dates.push(`${anio}-08-15`); values.push(150 + (anio % 5)); // agosto: históricamente lluvioso
  }
  const climatologia = buildMonthlyClimatology(dates, values);
  assert.ok(climatologia[1].p50 < climatologia[8].p50);

  // El mismo valor actual (80mm) es VERY_HIGH en enero pero VERY_LOW en
  // agosto -- la época del año importa.
  assert.equal(classifyLevel(80, climatologia[1]), LEVEL.VERY_HIGH);
  assert.equal(classifyLevel(80, climatologia[8]), LEVEL.VERY_LOW);
});

// -----------------------------------------------------------------------
// Anomalías -- nunca dividir por una normal cercana a cero.
// -----------------------------------------------------------------------
test('computeAnomaly: anomalyAbsolute siempre disponible, anomalyPct null si la mediana es ~0', () => {
  const breakpointsSecos = { p10: 0, p25: 0, p50: 0, p75: 2, p90: 5 };
  const anomalia = computeAnomaly(10, breakpointsSecos);
  assert.equal(anomalia.anomalyAbsolute, 10);
  assert.equal(anomalia.anomalyPct, null);
});

test('computeAnomaly: anomalyPct calculado cuando la mediana es significativa', () => {
  const breakpoints = { p10: 10, p25: 15, p50: 20, p75: 25, p90: 32 };
  const anomalia = computeAnomaly(27, breakpoints);
  assert.equal(anomalia.anomalyAbsolute, 7);
  assert.equal(anomalia.anomalyPct, 35);
  assert.equal(anomalia.level, LEVEL.HIGH);
});

test('computeAnomaly: valor no finito o sin breakpoints nunca lanza, devuelve nulls', () => {
  assert.deepEqual(computeAnomaly(NaN, { p10: 1, p25: 2, p50: 3, p75: 4, p90: 5 }), { anomalyAbsolute: null, anomalyPct: null, level: null });
  assert.deepEqual(computeAnomaly(10, null), { anomalyAbsolute: null, anomalyPct: null, level: null });
});
