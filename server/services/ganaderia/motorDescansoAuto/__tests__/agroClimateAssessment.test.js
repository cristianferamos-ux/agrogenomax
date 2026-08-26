// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial + operacional)
// §1/§2/§5/§6/§7/§11/§12/§24/§25/§26: clasificador agroclimático
// determinístico -- percentiles LOCALES cuando hay climatología,
// guardrail auxiliar ABSOLUTO solo cuando no la hay. FAVORABLE exige
// evidencia multivariable consistente, nunca una simple normalidad.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessAgroClimate,
  AGROCLIMATE_STATUS,
  LOCAL_CLIMATOLOGY_STATUS,
  PRECIPITACION_15D_UMBRAL_DEFICIT_MM,
  PRECIPITACION_30D_UMBRAL_DEFICIT_MM,
  HUMEDAD_SUELO_UMBRAL_BAJO_M3M3,
} from '../agroClimateAssessment.js';
import { PRECIPITACION_7D_UMBRAL_DEFICIT_MM } from '../../motorPastoreoAuto/pastureClimateEngine.js';
import { computeBreakpoints } from '../climatologyStatistics.js';

const HUMEDO_ADECUADO = HUMEDAD_SUELO_UMBRAL_BAJO_M3M3 + 0.1;
const HUMEDO_BAJO = HUMEDAD_SUELO_UMBRAL_BAJO_M3M3 - 0.05;
const TEMP_COMPATIBLE = 25;

// Distribución con separación clara entre NORMAL (10-25) y HIGH/VERY_HIGH
// (>=30/>=35) -- evita ambigüedad de bordes en los tests.
function climatologiaSintetica({
  precip7dNormal = [8, 10, 12, 15, 18, 20, 22, 24],
  precip30dNormal = [60, 70, 80, 90, 100, 110, 120, 130],
  sueloNormal = [0.20, 0.22, 0.24, 0.26, 0.28, 0.30, 0.32, 0.34],
  temp = [20, 22, 24, 26, 28, 30, 32],
} = {}) {
  return {
    precipitacion7dMm: computeBreakpoints(precip7dNormal),
    precipitacion15dMm: computeBreakpoints(precip7dNormal.map((v) => v * 2)),
    precipitacion30dMm: computeBreakpoints(precip30dNormal),
    humedadSueloSuperficial: computeBreakpoints(sueloNormal),
    humedadSueloSubsuperficial: computeBreakpoints(sueloNormal),
    temperaturaMediaC: computeBreakpoints(temp),
  };
}

// -----------------------------------------------------------------------
// §21 del hardening: SIN climatología local -> guardrail auxiliar
// ABSOLUTO, degrada la confianza SIEMPRE.
// -----------------------------------------------------------------------

test('sin climatología local: localClimatologyStatus = INSUFFICIENT_LOCAL_CLIMATOLOGY, confianza siempre degradada', () => {
  const result = assessAgroClimate({
    precipitacion7dMm: PRECIPITACION_7D_UMBRAL_DEFICIT_MM + 20,
    precipitacion30dMm: PRECIPITACION_30D_UMBRAL_DEFICIT_MM + 20,
    humedadSueloSuperficial: HUMEDO_ADECUADO,
    temperaturaMediaC: TEMP_COMPATIBLE,
  });
  assert.equal(result.localClimatologyStatus, LOCAL_CLIMATOLOGY_STATUS.INSUFFICIENT_LOCAL_CLIMATOLOGY);
  assert.equal(result.confidenceImpact, 'DEGRADE');
  assert.ok(result.appliedRules.includes('RULE_INSUFFICIENT_LOCAL_CLIMATOLOGY'));
});

test('guardrail auxiliar ABSOLUTO (sin climatología): déficit persistente por umbral fijo -> RESTRICTIVE', () => {
  const result = assessAgroClimate({
    precipitacion7dMm: PRECIPITACION_7D_UMBRAL_DEFICIT_MM - 2,
    precipitacion30dMm: PRECIPITACION_30D_UMBRAL_DEFICIT_MM - 5,
    humedadSueloSuperficial: HUMEDO_ADECUADO,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(result.appliedRules.includes('RULE_ABSOLUTE_GUARDRAIL_DROUGHT_PERSISTENT'));
  const reglasDecisionTerritorial = ['RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT', 'RULE_LOCAL_RECENT_PRECIP_DEFICIT', 'RULE_LOCAL_SOIL_MOISTURE_DEFICIT', 'RULE_RECENT_RAIN_AFTER_LOCAL_DROUGHT', 'RULE_LOCAL_ABOVE_NORMAL_MOISTURE', 'RULE_LOCAL_ABOVE_NORMAL_PRECIP'];
  assert.ok(!result.appliedRules.some((r) => reglasDecisionTerritorial.includes(r)));
});

test('guardrail auxiliar ABSOLUTO: humedad de suelo < 0.15 -> RESTRICTIVE (etiquetado explícitamente como guardrail, no como ley territorial)', () => {
  const result = assessAgroClimate({ humedadSueloSuperficial: HUMEDO_BAJO, humedadSueloSubsuperficial: HUMEDO_BAJO });
  assert.ok(result.appliedRules.includes('RULE_ABSOLUTE_GUARDRAIL_SOIL_MOISTURE_LOW'));
});

// -----------------------------------------------------------------------
// §5/§6/§7 del hardening: CON climatología local -- percentiles, nunca
// umbral absoluto.
// -----------------------------------------------------------------------

test('con climatología local: RULE_LOCAL_* reemplaza al guardrail absoluto -- nunca coexisten', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion15dMm: 32, precipitacion30dMm: 95,
    humedadSueloSuperficial: 0.27, humedadSueloSubsuperficial: 0.27, temperaturaMediaC: 26,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.localClimatologyStatus, LOCAL_CLIMATOLOGY_STATUS.AVAILABLE);
  assert.ok(!result.appliedRules.some((r) => r.startsWith('RULE_ABSOLUTE_GUARDRAIL')));
  assert.ok(result.appliedRules.some((r) => r.startsWith('RULE_LOCAL_')));
});

test('déficit persistente LOCAL (7d y 30d en el extremo bajo de su distribución) -> RESTRICTIVE', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 3, precipitacion30dMm: 40,
    humedadSueloSuperficial: 0.27,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(result.appliedRules.includes('RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT'));
});

// -----------------------------------------------------------------------
// SPRINT 3D8 (semantic final fix) §4: definición FORMAL de "persistente"
// vs "reciente" -- un déficit de 7d SOLO es persistente si se sostiene en
// 15d y/o 30d. Antes `precipitacion15dMm` se recibía como parámetro pero
// NUNCA se usaba -- la clasificación ignoraba por completo la ventana
// intermedia.
// -----------------------------------------------------------------------

test('test C: 7d LOW + 15d NORMAL + 30d NORMAL -> déficit RECIENTE, NUNCA persistente', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 3, precipitacion15dMm: 32, precipitacion30dMm: 95, // 7d bajo, 15d y 30d normales
    humedadSueloSuperficial: 0.27,
    climatologiaMensual: climatologia,
  });
  assert.notEqual(result.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(result.appliedRules.includes('RULE_LOCAL_RECENT_PRECIP_DEFICIT'));
  assert.ok(!result.appliedRules.includes('RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT'));
});

test('test D: 7d LOW + 15d LOW + 30d LOW -> déficit PERSISTENTE (RESTRICTIVE)', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 3, precipitacion15dMm: 6, precipitacion30dMm: 40,
    humedadSueloSuperficial: 0.27,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(result.appliedRules.includes('RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT'));
  assert.ok(!result.appliedRules.includes('RULE_LOCAL_RECENT_PRECIP_DEFICIT'));
});

test('7d LOW + 15d LOW + 30d NORMAL -> también PERSISTENTE (15d por sí solo sostiene el déficit, aunque 30d ya se recuperó)', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 3, precipitacion15dMm: 6, precipitacion30dMm: 95,
    humedadSueloSuperficial: 0.27,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(result.appliedRules.includes('RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT'));
});

test('RULE_LOCAL_ABOVE_NORMAL_PRECIP (precipitación) nunca se confunde con RULE_LOCAL_ABOVE_NORMAL_MOISTURE (suelo) -- nombres de regla propios por variable', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 135, // 30d muy alto -> evidencia FAVORABLE por precipitación
    humedadSueloSuperficial: 0.27, humedadSueloSubsuperficial: 0.27, // suelo normal, no en conflicto
    temperaturaMediaC: 26,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.FAVORABLE);
  assert.ok(result.appliedRules.includes('RULE_LOCAL_ABOVE_NORMAL_PRECIP'), 'la evidencia alta es de PRECIPITACIÓN, la regla debe nombrarla como tal');
  assert.ok(!result.appliedRules.includes('RULE_LOCAL_ABOVE_NORMAL_MOISTURE'), 'el suelo está NORMAL, no alto -- su regla de suelo-alto nunca debe aparecer');
});

test('déficit de humedad de suelo LOCAL (percentil bajo) -> RESTRICTIVE, aunque el valor absoluto sea "alto"', () => {
  const climatologia = climatologiaSintetica({ sueloNormal: [0.30, 0.32, 0.35, 0.38, 0.40, 0.42, 0.45] }); // potrero históricamente muy húmedo
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 95,
    humedadSueloSuperficial: 0.20, // absoluto "razonable", pero muy bajo para ESTE potrero
    humedadSueloSubsuperficial: 0.20,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.soilMoistureSignal, 'RESTRICTIVE');
  assert.ok(result.appliedRules.includes('RULE_LOCAL_SOIL_MOISTURE_DEFICIT'));
});

test('lluvia reciente tras sequía LOCAL -> NORMAL, nunca FAVORABLE (§13 consistencia multivariable)', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 200, // muy por encima de su distribución histórica (VERY_HIGH)
    precipitacion30dMm: 40, // 30d sigue deprimido (LOW/VERY_LOW)
    humedadSueloSuperficial: 0.27,
    climatologiaMensual: climatologia,
  });
  assert.notEqual(result.status, AGROCLIMATE_STATUS.FAVORABLE);
  assert.ok(result.appliedRules.includes('RULE_RECENT_RAIN_AFTER_LOCAL_DROUGHT'));
});

// -----------------------------------------------------------------------
// §5/§6 del hardening OPERACIONAL -- CORRECCIÓN CRÍTICA: FAVORABLE exige
// evidencia MULTIVARIABLE consistente, NUNCA una simple normalidad.
// -----------------------------------------------------------------------

test('condiciones NORMALES (ambas variables dentro de P25-P75) -> NORMAL, NUNCA FAVORABLE (bug corregido)', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 95, // ambos NORMAL (dentro de P25-P75 de la distribución sintética)
    humedadSueloSuperficial: 0.27, humedadSueloSubsuperficial: 0.27, // NORMAL
    temperaturaMediaC: 26,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.NORMAL, 'una lectura NORMAL en ambas variables NUNCA debe clasificarse como FAVORABLE');
});

test('FAVORABLE exige AL MENOS una variable genuinamente alta (P75+) Y la otra no en conflicto', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 135, // 30d claramente por encima de P75 (VERY_HIGH)
    humedadSueloSuperficial: 0.27, humedadSueloSubsuperficial: 0.27, // NORMAL, no en conflicto (no bajo)
    temperaturaMediaC: 26,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.FAVORABLE);
});

test('una sola variable alta NO basta si la otra está ausente (sin climatología para esa variable)', () => {
  const climatologia = climatologiaSintetica();
  const climatologiaSinSuelo = { ...climatologia, humedadSueloSuperficial: null, humedadSueloSubsuperficial: null };
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 135, // 30d muy alto
    humedadSueloSuperficial: 0.27, humedadSueloSubsuperficial: 0.27, // sin climatología para evaluar -- nivel indeterminado
    temperaturaMediaC: 26,
    climatologiaMensual: climatologiaSinSuelo,
  });
  assert.notEqual(result.status, AGROCLIMATE_STATUS.FAVORABLE, 'sin evidencia de la OTRA variable, no se puede confirmar consistencia multivariable');
});

// -----------------------------------------------------------------------
// §24 del hardening -- TEST DE TERRITORIALIDAD a nivel del clasificador
// completo: el MISMO valor absoluto produce RESULTADOS distintos según la
// climatología del potrero.
// -----------------------------------------------------------------------
test('§24 territorialidad: 0.20 m3/m3 es RESTRICTIVE en un potrero históricamente húmedo y contribuye a FAVORABLE en uno históricamente seco', () => {
  const climatologiaHumeda = climatologiaSintetica({ sueloNormal: [0.30, 0.32, 0.35, 0.38, 0.40, 0.42, 0.45] });
  const climatologiaSeca = climatologiaSintetica({ sueloNormal: [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14] });

  const inputComun = { precipitacion7dMm: 16, precipitacion30dMm: 95, humedadSueloSuperficial: 0.20, humedadSueloSubsuperficial: 0.20, temperaturaMediaC: 26 };

  const resultHumedo = assessAgroClimate({ ...inputComun, climatologiaMensual: climatologiaHumeda });
  const resultSeco = assessAgroClimate({ ...inputComun, climatologiaMensual: climatologiaSeca });

  assert.equal(resultHumedo.soilMoistureSignal, 'RESTRICTIVE');
  assert.equal(resultSeco.soilMoistureSignal, 'FAVORABLE');
  assert.notEqual(resultHumedo.status, resultSeco.status);
});

// -----------------------------------------------------------------------
// §2 del hardening operacional -- LIKE-FOR-LIKE: 7d actual NUNCA se
// compara contra la distribución de 30d, ni viceversa.
// -----------------------------------------------------------------------
test('§2 like-for-like: precipitación 7d actual se clasifica SOLO contra climatología 7d, 30d SOLO contra climatología 30d', () => {
  // Climatología 7d: rango bajo (5-25). Climatología 30d: rango alto (400-600).
  const climatologia = {
    precipitacion7dMm: computeBreakpoints([5, 10, 15, 20, 25]),
    precipitacion30dMm: computeBreakpoints([400, 450, 500, 550, 600]),
    humedadSueloSuperficial: computeBreakpoints([0.2, 0.25, 0.3]),
    humedadSueloSubsuperficial: computeBreakpoints([0.2, 0.25, 0.3]),
    temperaturaMediaC: computeBreakpoints([20, 25, 30]),
  };
  // Un valor de 500 (típico de la distribución de 30d) NUNCA debe llegar
  // como "precipitacion7dMm" y clasificarse como VERY_HIGH contra la
  // climatología de 7d (5-25) -- si eso ocurriera, dispararía
  // "RULE_LOCAL_ABOVE_NORMAL_MOISTURE" espuriamente. Se verifica pasando
  // el valor típico de 30d como precipitación 30d (su propia ventana) y
  // confirmando que el resultado usa esa distribución, no la de 7d.
  const result = assessAgroClimate({
    precipitacion7dMm: 15, // NORMAL para climatología 7d
    precipitacion30dMm: 500, // NORMAL para climatología 30d (sería VERY_HIGH si se comparara contra climatología 7d)
    humedadSueloSuperficial: 0.25, humedadSueloSubsuperficial: 0.25,
    climatologiaMensual: climatologia,
  });
  assert.equal(result.localAnomalies.precipitacion7dNivel, 'NORMAL');
  assert.equal(result.localAnomalies.precipitacion30dNivel, 'NORMAL');
  assert.notEqual(result.status, AGROCLIMATE_STATUS.FAVORABLE, 'ninguna variable está genuinamente alta EN SU PROPIA ventana -- nunca favorable por una comparación cruzada errónea');
});

// -----------------------------------------------------------------------
// §26 del hardening -- TEST DE NO-HARDCODE: ninguna regla autoritativa
// universal decide el status cuando hay climatología local.
// -----------------------------------------------------------------------
test('§26 no-hardcode: con climatología, el guardrail absoluto NUNCA aparece en appliedRules', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 3, precipitacion30dMm: 200, // valores que SÍ dispararían el guardrail absoluto (7d<10mm)
    humedadSueloSuperficial: HUMEDO_BAJO, // < 0.15 -- dispararía el guardrail absoluto de suelo
    climatologiaMensual: climatologia,
  });
  assert.ok(!result.appliedRules.includes('RULE_ABSOLUTE_GUARDRAIL_DROUGHT_PERSISTENT'));
  assert.ok(!result.appliedRules.includes('RULE_ABSOLUTE_GUARDRAIL_SOIL_MOISTURE_LOW'));
});

// -----------------------------------------------------------------------
// §8/§14 del hardening: temperatura -- SPECIES_PHYSIOLOGICAL_LIMIT es un
// guardrail de ESPECIE (legítimo con o sin climatología), distinto de
// LOCAL_CLIMATE_ANOMALY (percentil, informativo).
// -----------------------------------------------------------------------
test('calor extremo (fuera del límite fisiológico de especie) es restrictivo CON o SIN climatología local', () => {
  const climatologia = climatologiaSintetica();
  const sinClimatologia = assessAgroClimate({ temperaturaMediaC: 40 });
  const conClimatologia = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 95, humedadSueloSuperficial: 0.27, temperaturaMediaC: 40, climatologiaMensual: climatologia,
  });
  assert.equal(sinClimatologia.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.equal(conClimatologia.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(sinClimatologia.appliedRules.includes('RULE_SPECIES_HIGH_HEAT'));
  assert.ok(conClimatologia.appliedRules.includes('RULE_SPECIES_HIGH_HEAT'));
});

test('anomalía de temperatura LOCAL se registra como informativa cuando hay climatología, nunca decide el status por sí sola', () => {
  const climatologia = climatologiaSintetica();
  const result = assessAgroClimate({
    precipitacion7dMm: 16, precipitacion30dMm: 95, humedadSueloSuperficial: 0.27, temperaturaMediaC: 32, // extremo alto de SU distribución, pero dentro del límite de especie (15-35)
    climatologiaMensual: climatologia,
  });
  assert.notEqual(result.status, AGROCLIMATE_STATUS.RESTRICTIVE);
  assert.ok(result.localAnomalies.temperatura);
  assert.ok(result.appliedRules.includes('RULE_LOCAL_TEMPERATURE_ANOMALY_RECORDED'));
});

// -----------------------------------------------------------------------
// §11/§12 del hardening: radiación/humedad relativa -- registradas, nunca
// determinan el status.
// -----------------------------------------------------------------------
test('radiación y humedad relativa se registran pero nunca determinan el status por sí solas', () => {
  const conDatos = assessAgroClimate({ radiacionSolar: 500, humedadRelativaMediaPct: 70 });
  const sinDatos = assessAgroClimate({ radiacionSolar: null, humedadRelativaMediaPct: null });
  assert.equal(conDatos.status, sinDatos.status);
  assert.equal(conDatos.radiationSignal, 'RECORDED');
  assert.equal(sinDatos.radiationSignal, 'INSUFFICIENT_DATA');
});

test('appliedRules es siempre un array de códigos de regla explícitos (nunca un número/score)', () => {
  const result = assessAgroClimate({ precipitacion7dMm: 5, precipitacion30dMm: 10 });
  assert.ok(Array.isArray(result.appliedRules));
  for (const rule of result.appliedRules) {
    assert.equal(typeof rule, 'string');
    assert.match(rule, /^RULE_/);
  }
});

test('sin ningún dato usable (con o sin climatología) -> INSUFFICIENT_DATA, nunca inventa una clasificación', () => {
  const result = assessAgroClimate({
    precipitacion7dMm: null, precipitacion15dMm: null, precipitacion30dMm: null,
    humedadSueloSuperficial: null, humedadSueloSubsuperficial: null, temperaturaMediaC: null,
  });
  assert.equal(result.status, AGROCLIMATE_STATUS.INSUFFICIENT_DATA);
});
