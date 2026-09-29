// SPRINT-3D10.6: igualdad semántica de una medición de residual real
// (isSameResidualMeasurement) -- decide CASE B (retry idempotente) vs
// CASE C (409 RESIDUAL_YA_REGISTRADO) en registrarResidualReal. Prueba
// pura, sin DB. `existing` imita la fila vigente serializada (aforo como
// lo devuelve pg: string numeric -> Number; medicionRealAt como Date).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameResidualMeasurement } from '../potreroCicloResidualRealRepository.js';

function existente(overrides = {}) {
  return {
    residualId: '41',
    version: 1,
    numeroMuestras: 8,
    aforoPromedioGM2: 250,
    medicionRealAt: new Date('2026-09-20T13:30:00.000Z'),
    observacion: null,
    biomasaFrescaTotalKg: 5000,
    horasDesdeSalida: 4,
    materiaSecaPctAplicado: 22,
    materiaSecaFuente: 'FICHA_BASE_REAL',
    remanenteMedidoKgMs: 1100,
    remanenteEstimadoKgMsCongelado: 1000,
    errorAbsolutoKg: 100,
    errorPorcentual: 0.1,
    snapshotLoteRealId: '7',
    descansoEstimadoOrigenId: '9',
    createdAt: new Date('2026-09-20T15:00:00.000Z'),
    ...overrides,
  };
}

function entrante(overrides = {}) {
  return {
    numeroMuestras: 8,
    aforoPromedioGM2: 250,
    medicionRealAt: new Date('2026-09-20T13:30:00.000Z'),
    observacion: undefined,
    ...overrides,
  };
}

// ---- IGUALES ----

test('iguales: aforo persistido como string numeric "250" vs 250', () => {
  assert.equal(isSameResidualMeasurement(existente({ aforoPromedioGM2: '250' }), entrante({ aforoPromedioGM2: 250 })), true);
});

test('iguales: aforo decimal persistido "250.5" vs 250.5 -- comparación exacta sin tolerancia', () => {
  assert.equal(isSameResidualMeasurement(existente({ aforoPromedioGM2: '250.5' }), entrante({ aforoPromedioGM2: 250.5 })), true);
});

test('iguales: mismo instante expresado en Z y en -05:00', () => {
  const existing = existente({ medicionRealAt: new Date('2026-09-20T13:30:00.000Z') });
  const incoming = entrante({ medicionRealAt: new Date('2026-09-20T08:30:00.000-05:00') });
  assert.equal(isSameResidualMeasurement(existing, incoming), true);
});

test('iguales: observación undefined (entrante) vs null (persistida)', () => {
  assert.equal(isSameResidualMeasurement(existente({ observacion: null }), entrante({ observacion: undefined })), true);
});

test('iguales: observación con el mismo texto exacto', () => {
  assert.equal(isSameResidualMeasurement(existente({ observacion: 'lluvia previa' }), entrante({ observacion: 'lluvia previa' })), true);
});

test('iguales: derivados, contexto congelado y metadata distintos no afectan la igualdad', () => {
  const existing = existente({
    residualId: '999',
    version: 3,
    biomasaFrescaTotalKg: 1,
    horasDesdeSalida: 99,
    materiaSecaPctAplicado: null,
    materiaSecaFuente: null,
    remanenteMedidoKgMs: null,
    remanenteEstimadoKgMsCongelado: null,
    errorAbsolutoKg: null,
    errorPorcentual: null,
    snapshotLoteRealId: null,
    descansoEstimadoOrigenId: null,
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
  });
  assert.equal(isSameResidualMeasurement(existing, entrante()), true);
});

// ---- DISTINTOS ----

test('distintos: 1 ms de diferencia en medicionRealAt', () => {
  const incoming = entrante({ medicionRealAt: new Date('2026-09-20T13:30:00.001Z') });
  assert.equal(isSameResidualMeasurement(existente(), incoming), false);
});

test('distintos: numeroMuestras diferente', () => {
  assert.equal(isSameResidualMeasurement(existente(), entrante({ numeroMuestras: 9 })), false);
});

test('distintos: aforo diferente', () => {
  assert.equal(isSameResidualMeasurement(existente(), entrante({ aforoPromedioGM2: 250.0001 })), false);
});

test('distintos: observación "a" vs "a " -- sin trim adicional', () => {
  assert.equal(isSameResidualMeasurement(existente({ observacion: 'a' }), entrante({ observacion: 'a ' })), false);
});

test('distintos: observación "" vs null', () => {
  assert.equal(isSameResidualMeasurement(existente({ observacion: null }), entrante({ observacion: '' })), false);
  assert.equal(isSameResidualMeasurement(existente({ observacion: '' }), entrante({ observacion: undefined })), false);
});

test('distintos: observación nueva sobre una vigente sin observación', () => {
  assert.equal(isSameResidualMeasurement(existente({ observacion: null }), entrante({ observacion: 'nota' })), false);
});
