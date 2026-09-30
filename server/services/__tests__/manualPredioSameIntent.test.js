// SPRINT-3D10.7: igualdad semántica de un predio manual
// (isSameManualPredio) -- decide CASE B (retry idempotente) vs CASE C
// (409 CLIENT_OPERATION_ID_REUSED) en createManualPredioIdempotente.
// Prueba pura, sin DB. `fila` imita la fila de agx.predios tal como la
// devuelve pg (numeric como string); `value` imita la salida de
// validateManualPredioBody.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameManualPredio } from '../ganaderia/prediosRepository.js';

function fila(overrides = {}) {
  return {
    predio_id: '41',
    nombre_predio: 'La Esperanza',
    departamento: 'Caquetá',
    municipio: 'Florencia',
    vereda: 'El Caraño',
    area_total_ha: '12.5',
    observaciones: 'Lindero norte con quebrada.',
    latitud: '1.61438',
    longitud: '-75.60623',
    codigo_predial: null,
    tiene_geometria: false,
    ...overrides,
  };
}

function value(overrides = {}) {
  return {
    nombrePredio: 'La Esperanza',
    departamento: 'Caquetá',
    municipio: 'Florencia',
    vereda: 'El Caraño',
    areaDeclaradaHa: 12.5,
    observaciones: 'Lindero norte con quebrada.',
    latitud: 1.61438,
    longitud: -75.60623,
    clientOperationId: '3f2b8c1e-9a4d-4c7b-8e21-5d6f7a8b9c0d',
    ...overrides,
  };
}

test('mismo predio manual -> true (numeric de pg como string vs number)', () => {
  assert.equal(isSameManualPredio(fila(), value()), true);
});

test("'12.5' (pg) vs 12.5 -> true", () => {
  assert.equal(isSameManualPredio(fila({ area_total_ha: '12.5' }), value({ areaDeclaradaHa: 12.5 })), true);
});

for (const [campoFila, campoValue, distinto] of [
  ['nombre_predio', 'nombrePredio', 'La Esperanza 2'],
  ['departamento', 'departamento', 'Putumayo'],
  ['municipio', 'municipio', 'Morelia'],
  ['vereda', 'vereda', 'Otra'],
  ['observaciones', 'observaciones', 'Otra nota'],
]) {
  test(`${campoValue} distinto -> false`, () => {
    assert.equal(isSameManualPredio(fila(), value({ [campoValue]: distinto })), false);
    assert.equal(isSameManualPredio(fila({ [campoFila]: distinto }), value()), false);
  });
}

test('diferencia solo en mayúsculas -> false (comparación case-sensitive)', () => {
  assert.equal(isSameManualPredio(fila(), value({ nombrePredio: 'la esperanza' })), false);
  assert.equal(isSameManualPredio(fila(), value({ municipio: 'FLORENCIA' })), false);
});

for (const [campoFila, campoValue, distinto] of [
  ['area_total_ha', 'areaDeclaradaHa', 12.51],
  ['latitud', 'latitud', 1.61439],
  ['longitud', 'longitud', -75.60624],
]) {
  test(`${campoValue} numérico distinto (sin tolerancia) -> false`, () => {
    assert.equal(isSameManualPredio(fila(), value({ [campoValue]: distinto })), false);
  });

  test(`${campoValue}: null/null -> true; null vs valor en ambas direcciones -> false`, () => {
    assert.equal(isSameManualPredio(fila({ [campoFila]: null }), value({ [campoValue]: null })), true);
    assert.equal(isSameManualPredio(fila({ [campoFila]: null }), value()), false);
    assert.equal(isSameManualPredio(fila(), value({ [campoValue]: null })), false);
  });
}

for (const [campoFila, campoValue] of [
  ['vereda', 'vereda'],
  ['observaciones', 'observaciones'],
]) {
  test(`${campoValue}: null/null -> true; null vs valor en ambas direcciones -> false`, () => {
    assert.equal(isSameManualPredio(fila({ [campoFila]: null }), value({ [campoValue]: null })), true);
    assert.equal(isSameManualPredio(fila({ [campoFila]: null }), value()), false);
    assert.equal(isSameManualPredio(fila(), value({ [campoValue]: null })), false);
  });
}

test('fila con codigo_predial (no manual) -> false aunque el resto coincida', () => {
  assert.equal(isSameManualPredio(fila({ codigo_predial: '18001000100010001000' }), value()), false);
});

test('fila con geometría (no manual) -> false aunque el resto coincida', () => {
  assert.equal(isSameManualPredio(fila({ tiene_geometria: true }), value()), false);
});

test('metadata distinta (predio_id, fechas, estado, archivo, propietario, organización, operación) no afecta -> true', () => {
  const conMetadata = fila({
    predio_id: '999',
    organizacion_id: '11111111-1111-4111-8111-111111111111',
    fecha_creacion: new Date('2020-01-01T00:00:00.000Z'),
    fecha_actualizacion: new Date('2026-09-29T00:00:00.000Z'),
    estado: 'ARCHIVADO',
    archivado_at: new Date('2026-09-29T00:00:00.000Z'),
    motivo_archivado: 'prueba',
    propietario: 'Alguien',
    client_operation_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
  });
  assert.equal(isSameManualPredio(conMetadata, value({ clientOperationId: '00000000-1111-4222-8333-444444444444' })), true);
});

test('no muta los argumentos (Object.freeze)', () => {
  const row = Object.freeze(fila());
  const incoming = Object.freeze(value());
  assert.equal(isSameManualPredio(row, incoming), true);
  assert.deepEqual(row, fila());
  assert.deepEqual(incoming, value());
});
