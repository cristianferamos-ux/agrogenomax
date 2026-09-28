// SPRINT-3D10.4 FASE 3 §10/§11 -- pruebas puras de la aritmética de
// fechas del PLAN (fechaIngresoPrevista + diasPermanencia ->
// fechaSalidaEstimada). Sin DB/HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFechaCalendario, computeFechaSalidaEstimada } from '../fechaPlanHelpers.js';

test('parseFechaCalendario acepta una fecha real y descompone año/mes/día', () => {
  const r = parseFechaCalendario('2026-09-10');
  assert.equal(r.year, 2026);
  assert.equal(r.month, 9);
  assert.equal(r.day, 10);
});

test('parseFechaCalendario rechaza formato incorrecto', () => {
  for (const invalida of ['10-09-2026', '2026/09/10', '2026-9-10', 'no-es-fecha', '', null, undefined, 123]) {
    assert.throws(() => parseFechaCalendario(invalida), (e) => e.code === 'INPUT_INVALID');
  }
});

test('parseFechaCalendario rechaza fechas de calendario inexistentes (30 de febrero, mes 13)', () => {
  assert.throws(() => parseFechaCalendario('2026-02-30'), (e) => e.code === 'INPUT_INVALID');
  assert.throws(() => parseFechaCalendario('2026-13-01'), (e) => e.code === 'INPUT_INVALID');
  assert.throws(() => parseFechaCalendario('2026-04-31'), (e) => e.code === 'INPUT_INVALID');
});

test('computeFechaSalidaEstimada: caso simple dentro del mismo mes', () => {
  assert.equal(computeFechaSalidaEstimada('2026-09-10', 3), '2026-09-13');
});

test('computeFechaSalidaEstimada: fin de mes (30 días, septiembre -> octubre)', () => {
  assert.equal(computeFechaSalidaEstimada('2026-09-29', 3), '2026-10-02');
});

test('computeFechaSalidaEstimada: fin de año (diciembre -> enero del año siguiente)', () => {
  assert.equal(computeFechaSalidaEstimada('2026-12-30', 3), '2027-01-02');
});

test('computeFechaSalidaEstimada: febrero en año NO bisiesto (2027) -- 28 días', () => {
  assert.equal(computeFechaSalidaEstimada('2027-02-27', 3), '2027-03-02');
});

test('computeFechaSalidaEstimada: febrero en año BISIESTO (2028) -- 29 días', () => {
  assert.equal(computeFechaSalidaEstimada('2028-02-27', 3), '2028-03-01');
  // Confirma que 2028 es reconocido como bisiesto (29 de febrero existe).
  assert.equal(computeFechaSalidaEstimada('2028-02-28', 1), '2028-02-29');
});

test('computeFechaSalidaEstimada: solo admite 2 o 3 días en el contrato v1, pero el helper en sí es genérico (no asume la política)', () => {
  assert.equal(computeFechaSalidaEstimada('2026-09-10', 2), '2026-09-12');
  assert.equal(computeFechaSalidaEstimada('2026-09-10', 3), '2026-09-13');
});

test('computeFechaSalidaEstimada rechaza diasPermanencia inválido (<=0, NaN, no numérico)', () => {
  for (const invalido of [0, -1, NaN, null, undefined, 'tres']) {
    assert.throws(() => computeFechaSalidaEstimada('2026-09-10', invalido), (e) => e.code === 'INPUT_INVALID');
  }
});

test('computeFechaSalidaEstimada rechaza fechaIngresoPrevista inválida', () => {
  assert.throws(() => computeFechaSalidaEstimada('fecha-invalida', 3), (e) => e.code === 'INPUT_INVALID');
});

test('computeFechaSalidaEstimada nunca usa timestamp/hora -- siempre retorna YYYY-MM-DD puro', () => {
  const salida = computeFechaSalidaEstimada('2026-09-10', 3);
  assert.match(salida, /^\d{4}-\d{2}-\d{2}$/);
});
