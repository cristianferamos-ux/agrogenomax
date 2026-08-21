// SPRINT-3D7-CAPACIDAD-PASTOREO: pruebas exactas de fórmulas (§33 del
// sprint) -- sin DB, sin HTTP. Valores del ejemplo canónico del sprint:
// biomasa fresca 2828.69 kg, MS 25%, utilización 50%, peso 450 kg,
// consumo 2.5% PV/día, 20 animales.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMateriaSecaTotalKg,
  computeMateriaSecaUtilizableKg,
  computeDemandaIndividualKgMsDia,
  computeDemandaDiariaLoteKgMs,
  computeDiasOcupacionEstimados,
  computeCapacidadAnimales,
  computeCapacidadPastoreoModoDias,
  computeCapacidadPastoreoModoAnimales,
  isResultadoExtremo,
} from '../capacidadPastoreoFormulas.js';

function closeTo(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: esperado ~${expected}, obtenido ${actual}`);
}

test('materia seca total: 2828.69 kg x 25% ~= 707.1725 kg (§33)', () => {
  closeTo(computeMateriaSecaTotalKg(2828.69, 25), 707.1725, 0.0001, 'materia seca total');
});

test('materia seca utilizable: 707.1725 x 50% ~= 353.58625 kg (§33)', () => {
  closeTo(computeMateriaSecaUtilizableKg(707.1725, 50), 353.58625, 0.0001, 'materia seca utilizable');
});

test('demanda individual: 450 kg x 2.5% ~= 11.25 kg MS/animal/día (§33)', () => {
  assert.equal(computeDemandaIndividualKgMsDia(450, 2.5), 11.25);
});

test('demanda diaria del lote: 11.25 x 20 animales = 225 kg MS/día (§33)', () => {
  assert.equal(computeDemandaDiariaLoteKgMs(11.25, 20), 225);
});

test('días de ocupación: 353.58625 / 225 ~= 1.57149 días (§33)', () => {
  closeTo(computeDiasOcupacionEstimados(353.58625, 225), 1.57149, 0.0001, 'días de ocupación');
});

test('modo inverso: 353.58625 / 11.25 ~= 31.43 -> 31 animales completos (floor, §33)', () => {
  const { capacidadDecimal, capacidadEntera } = computeCapacidadAnimales(353.58625, 11.25, 1);
  closeTo(capacidadDecimal, 31.43, 0.01, 'capacidad decimal');
  assert.equal(capacidadEntera, 31);
});

test('computeCapacidadPastoreoModoDias: cálculo completo con el ejemplo canónico del sprint', () => {
  const resultado = computeCapacidadPastoreoModoDias({
    biomasaFrescaKg: 2828.69,
    porcentajeMateriaSeca: 25,
    porcentajeUtilizacion: 50,
    consumoPctPesoVivo: 2.5,
    pesoVivoPromedioKg: 450,
    numeroAnimales: 20,
  });
  closeTo(resultado.materiaSecaTotalKg, 707.1725, 0.0001, 'materia seca total');
  closeTo(resultado.materiaSecaUtilizableKg, 353.58625, 0.0001, 'materia seca utilizable');
  assert.equal(resultado.demandaIndividualKgMsDia, 11.25);
  assert.equal(resultado.demandaDiariaLoteKgMs, 225);
  closeTo(resultado.diasOcupacionEstimados, 1.57149, 0.0001, 'días de ocupación');
  assert.equal(resultado.capacidadAnimalesPeriodo, null);
});

test('computeCapacidadPastoreoModoAnimales: cálculo completo, período objetivo de 1 día', () => {
  const resultado = computeCapacidadPastoreoModoAnimales({
    biomasaFrescaKg: 2828.69,
    porcentajeMateriaSeca: 25,
    porcentajeUtilizacion: 50,
    consumoPctPesoVivo: 2.5,
    pesoVivoPromedioKg: 450,
    periodoObjetivoDias: 1,
  });
  closeTo(resultado.materiaSecaTotalKg, 707.1725, 0.0001, 'materia seca total');
  closeTo(resultado.materiaSecaUtilizableKg, 353.58625, 0.0001, 'materia seca utilizable');
  assert.equal(resultado.capacidadAnimalesPeriodo, 31);
  closeTo(resultado.capacidadAnimalesDecimal, 31.43, 0.01, 'capacidad decimal');
  assert.equal(resultado.diasOcupacionEstimados, null);
  assert.equal(resultado.demandaDiariaLoteKgMs, null);
});

test('isResultadoExtremo: modo días -- advierte por debajo de 0.1 días y por encima de 3650 días', () => {
  assert.equal(isResultadoExtremo('dias_ocupacion', { diasOcupacionEstimados: 0.05 }), true);
  assert.equal(isResultadoExtremo('dias_ocupacion', { diasOcupacionEstimados: 5000 }), true);
  assert.equal(isResultadoExtremo('dias_ocupacion', { diasOcupacionEstimados: 1.57 }), false);
});

test('isResultadoExtremo: modo animales -- advierte con 0 animales o una cifra absurdamente alta', () => {
  assert.equal(isResultadoExtremo('capacidad_animales', { capacidadAnimalesPeriodo: 0 }), true);
  assert.equal(isResultadoExtremo('capacidad_animales', { capacidadAnimalesPeriodo: 200000 }), true);
  assert.equal(isResultadoExtremo('capacidad_animales', { capacidadAnimalesPeriodo: 31 }), false);
});
