// SPRINT-3D7.1-AGROCLIMA: pruebas numéricas de las fórmulas puras
// (§20/§21/§26 del sprint) -- sin red, sin DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRelativeHumidityFromDewPoint,
  computeWindSpeedFromComponents,
} from '../agroClimateFormulas.js';

test('RH: temperatura == dew point -> saturación (100%)', () => {
  const rh = computeRelativeHumidityFromDewPoint(20, 20);
  assert.ok(Math.abs(rh - 100) < 0.001);
});

test('RH: caso de referencia meteorológico (T=25°C, Td=15°C -> ~53.7%)', () => {
  // Valor de referencia calculado con la misma fórmula de Magnus-Tetens
  // (Alduchov & Eskridge 1996) usada por ECMWF/Copernicus.
  const rh = computeRelativeHumidityFromDewPoint(25, 15);
  assert.ok(rh > 53 && rh < 54.5, `esperado ~53.7%, obtenido ${rh}`);
});

test('RH: dew point mayor que la temperatura (ruido de redondeo) nunca excede 100%', () => {
  const rh = computeRelativeHumidityFromDewPoint(20, 20.5);
  assert.ok(rh <= 100);
});

test('RH: valores no finitos devuelven null, nunca NaN', () => {
  assert.equal(computeRelativeHumidityFromDewPoint(NaN, 10), null);
  assert.equal(computeRelativeHumidityFromDewPoint(10, undefined), null);
  assert.equal(computeRelativeHumidityFromDewPoint(10, null), null);
});

test('viento: sqrt(3^2+4^2) = 5 (triángulo 3-4-5, valor exacto)', () => {
  assert.equal(computeWindSpeedFromComponents(3, 4), 5);
});

test('viento: componentes negativas -- magnitud siempre positiva', () => {
  assert.equal(computeWindSpeedFromComponents(-3, -4), 5);
});

test('viento: componente cero en un eje -> magnitud = valor absoluto del otro eje', () => {
  assert.equal(computeWindSpeedFromComponents(0, 7), 7);
  assert.equal(computeWindSpeedFromComponents(-7, 0), 7);
});

test('viento: valores no finitos devuelven null', () => {
  assert.equal(computeWindSpeedFromComponents(NaN, 1), null);
  assert.equal(computeWindSpeedFromComponents(1, undefined), null);
});
