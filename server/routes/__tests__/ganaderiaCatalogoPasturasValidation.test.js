// SPRINT-3D6-FICHA-PRODUCTIVA: pruebas unitarias puras de
// validateCreatePasturaPersonalizadaBody (sin HTTP, sin DB). §9 del
// sprint: organizacionId/alcance/activo/pasturaId NUNCA aceptados del
// cliente -- siempre fijados en el repositorio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCreatePasturaPersonalizadaBody } from '../ganaderiaCatalogoPasturas.js';

test('validateCreatePasturaPersonalizadaBody: acepta un body mínimo válido', () => {
  const result = validateCreatePasturaPersonalizadaBody({ nombreComun: 'Pasto X', tipo: 'graminea' });
  assert.equal(result.nombreComun, 'Pasto X');
  assert.equal(result.tipo, 'graminea');
  assert.equal(result.nombreCientifico, null);
  assert.equal(result.genero, null);
  assert.equal(result.especie, null);
  assert.equal(result.cultivar, null);
});

test('validateCreatePasturaPersonalizadaBody: RECHAZA organizacionId/alcance/activo/pasturaId inyectados', () => {
  for (const forbiddenKey of ['organizacionId', 'alcance', 'activo', 'pasturaId']) {
    assert.throws(
      () => validateCreatePasturaPersonalizadaBody({ nombreComun: 'X', tipo: 'graminea', [forbiddenKey]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('validateCreatePasturaPersonalizadaBody: exige nombreComun y tipo válido', () => {
  assert.throws(() => validateCreatePasturaPersonalizadaBody({ tipo: 'graminea' }), (e) => e.code === 'INVALID_NOMBRE_COMUN');
  assert.throws(() => validateCreatePasturaPersonalizadaBody({ nombreComun: '   ', tipo: 'graminea' }), (e) => e.code === 'INVALID_NOMBRE_COMUN');
  assert.throws(() => validateCreatePasturaPersonalizadaBody({ nombreComun: 'X', tipo: 'shp' }), (e) => e.code === 'INVALID_TIPO');
  assert.throws(() => validateCreatePasturaPersonalizadaBody({ nombreComun: 'X' }), (e) => e.code === 'INVALID_TIPO');
});

test('validateCreatePasturaPersonalizadaBody: acepta los 4 tipos aprobados', () => {
  for (const tipo of ['graminea', 'leguminosa', 'mezcla', 'otra']) {
    const result = validateCreatePasturaPersonalizadaBody({ nombreComun: 'X', tipo });
    assert.equal(result.tipo, tipo);
  }
});

test('validateCreatePasturaPersonalizadaBody: campos opcionales respetan longitud máxima', () => {
  assert.throws(
    () => validateCreatePasturaPersonalizadaBody({ nombreComun: 'X', tipo: 'graminea', nombreCientifico: 'a'.repeat(201) }),
    (e) => e.code === 'INVALID_NOMBRE_CIENTIFICO',
  );
  assert.throws(
    () => validateCreatePasturaPersonalizadaBody({ nombreComun: 'X', tipo: 'graminea', genero: 'a'.repeat(121) }),
    (e) => e.code === 'INVALID_GENERO',
  );
});
