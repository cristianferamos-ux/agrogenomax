// SPRINT-3D6-FICHA-PRODUCTIVA: pruebas unitarias puras de validateCreateFichaBody
// (sin HTTP, sin DB). Cubre: campos prohibidos (§15 -- areaHa/biomasaTotalKg/
// tipoCobertura/nombrePrincipal/organizacionId/predioId/potreroId nunca
// aceptados del cliente), límite técnico de aforo (§19), especies vacías/
// malformadas, numeroMuestras/fechaAforo/observaciones/porcentajeEstimado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCreateFichaBody } from '../ganaderiaPotreroFichaProductiva.js';

const UNA_ESPECIE = [{ pasturaId: '1' }];

test('validateCreateFichaBody: acepta un body mínimo válido (una especie, sin opcionales)', () => {
  const result = validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500 });
  assert.deepEqual(result.especies, [{ pasturaId: '1', porcentajeEstimado: null }]);
  assert.equal(result.aforoPromedioGM2, 500);
  assert.equal(result.numeroMuestras, null);
  assert.equal(result.fechaAforo, null);
  assert.equal(result.observaciones, null);
  assert.equal(result.nombrePersonalizado, null);
});

test('validateCreateFichaBody: RECHAZA campos no permitidos (areaHa, biomasaTotalKg, tipoCobertura, nombrePrincipal, organizacionId, predioId, potreroId)', () => {
  for (const forbiddenKey of ['areaHa', 'biomasaTotalKg', 'tipoCobertura', 'nombrePrincipal', 'organizacionId', 'predioId', 'potreroId']) {
    assert.throws(
      () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, [forbiddenKey]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('validateCreateFichaBody: exige al menos una especie', () => {
  assert.throws(
    () => validateCreateFichaBody({ especies: [], aforoPromedioGM2: 500 }),
    (e) => e.status === 400 && e.code === 'EMPTY_ESPECIES',
  );
  assert.throws(
    () => validateCreateFichaBody({ aforoPromedioGM2: 500 }),
    (e) => e.status === 400 && e.code === 'EMPTY_ESPECIES',
  );
});

test('validateCreateFichaBody: rechaza especies con campos no permitidos o pasturaId inválido', () => {
  assert.throws(
    () => validateCreateFichaBody({ especies: [{ pasturaId: '1', organizacionId: 'x' }], aforoPromedioGM2: 500 }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
  assert.throws(
    () => validateCreateFichaBody({ especies: [{ pasturaId: 'abc' }], aforoPromedioGM2: 500 }),
    (e) => e.code === 'INVALID_ESPECIES',
  );
});

test('validateCreateFichaBody: porcentajeEstimado debe estar en (0, 100]', () => {
  assert.throws(
    () => validateCreateFichaBody({ especies: [{ pasturaId: '1', porcentajeEstimado: 0 }], aforoPromedioGM2: 500 }),
    (e) => e.code === 'INVALID_PORCENTAJE',
  );
  assert.throws(
    () => validateCreateFichaBody({ especies: [{ pasturaId: '1', porcentajeEstimado: 101 }], aforoPromedioGM2: 500 }),
    (e) => e.code === 'INVALID_PORCENTAJE',
  );
  const result = validateCreateFichaBody({ especies: [{ pasturaId: '1', porcentajeEstimado: 100 }], aforoPromedioGM2: 500 });
  assert.equal(result.especies[0].porcentajeEstimado, 100);
});

test('validateCreateFichaBody: aforoPromedioGM2 debe ser > 0 y <= máximo técnico (10000 g/m², §19 del sprint)', () => {
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 0 }),
    (e) => e.code === 'INVALID_AFORO',
  );
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: -5 }),
    (e) => e.code === 'INVALID_AFORO',
  );
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 10001 }),
    (e) => e.code === 'AFORO_TOO_HIGH',
  );
  const result = validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 10000 });
  assert.equal(result.aforoPromedioGM2, 10000);
});

test('validateCreateFichaBody: numeroMuestras debe ser entero >= 1', () => {
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, numeroMuestras: 0 }),
    (e) => e.code === 'INVALID_NUMERO_MUESTRAS',
  );
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, numeroMuestras: 1.5 }),
    (e) => e.code === 'INVALID_NUMERO_MUESTRAS',
  );
  const result = validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, numeroMuestras: 5 });
  assert.equal(result.numeroMuestras, 5);
});

test('validateCreateFichaBody: fechaAforo debe tener formato YYYY-MM-DD', () => {
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, fechaAforo: '01-08-2026' }),
    (e) => e.code === 'INVALID_FECHA_AFORO',
  );
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, fechaAforo: '2026-99-99' }),
    (e) => e.code === 'INVALID_FECHA_AFORO',
  );
  const result = validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, fechaAforo: '2026-08-01' });
  assert.equal(result.fechaAforo, '2026-08-01');
});

test('validateCreateFichaBody: observaciones respeta el límite de longitud', () => {
  const tooLong = 'a'.repeat(2001);
  assert.throws(
    () => validateCreateFichaBody({ especies: UNA_ESPECIE, aforoPromedioGM2: 500, observaciones: tooLong }),
    (e) => e.code === 'INVALID_OBSERVACIONES',
  );
});
