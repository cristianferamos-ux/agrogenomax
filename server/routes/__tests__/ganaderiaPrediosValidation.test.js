// SPRINT-3C1-MIS-PREDIOS-API §6/§16/§23 (caso 7): pruebas unitarias puras
// de las funciones de validación de entrada del router (sin HTTP, sin
// DB). Cubren específicamente el requisito crítico §9/§23.7: geometry (o
// cualquier otro campo prohibido) enviado por el frontend debe ser
// RECHAZADO explícitamente, nunca ignorado en silencio ni aceptado.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCoordinatesBody,
  validateManualPredioBody,
  validateCatastroxSaveBody,
} from '../ganaderiaPredios.js';

// ---------------------------------------------------------------------
// validateCoordinatesBody (§6)
// ---------------------------------------------------------------------

test('validateCoordinatesBody: acepta coordenadas válidas', () => {
  const result = validateCoordinatesBody({ lat: 1.35, lng: -75.45 });
  assert.deepEqual(result, { lat: 1.35, lng: -75.45 });
});

test('validateCoordinatesBody: rechaza lat/lng no numéricos', () => {
  assert.throws(() => validateCoordinatesBody({ lat: 'abc', lng: -75.45 }), (e) => e.status === 400 && e.code === 'INVALID_COORDINATES');
  assert.throws(() => validateCoordinatesBody({}), (e) => e.status === 400);
});

test('validateCoordinatesBody: rechaza fuera de rango', () => {
  assert.throws(() => validateCoordinatesBody({ lat: 91, lng: 0 }), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => validateCoordinatesBody({ lat: -91, lng: 0 }), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => validateCoordinatesBody({ lat: 0, lng: 181 }), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => validateCoordinatesBody({ lat: 0, lng: -181 }), (e) => e.code === 'INVALID_COORDINATES');
});

test('validateCoordinatesBody: rechaza Infinity/NaN', () => {
  assert.throws(() => validateCoordinatesBody({ lat: Infinity, lng: 0 }));
  assert.throws(() => validateCoordinatesBody({ lat: NaN, lng: 0 }));
});

// ---------------------------------------------------------------------
// validateManualPredioBody (§16)
// ---------------------------------------------------------------------

test('validateManualPredioBody: acepta un body manual mínimo válido', () => {
  const result = validateManualPredioBody({ mode: 'manual', nombrePredio: 'Finca X', departamento: 'Caquetá', municipio: 'Florencia' });
  assert.equal(result.nombrePredio, 'Finca X');
  assert.equal(result.vereda, null);
  assert.equal(result.areaTotalHa, null);
});

test('validateManualPredioBody: RECHAZA geometry (§9/§16 -- nunca aceptar geometry del cliente)', () => {
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', geometry: { type: 'Polygon', coordinates: [] } }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('validateManualPredioBody: RECHAZA organizacionId/codigoPredial/fuente inyectados', () => {
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', organizacionId: 'org-b' }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', codigoPredial: '1'.repeat(30) }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', fuente: 'catastrox_clean' }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
});

test('validateManualPredioBody: exige nombrePredio/departamento/municipio', () => {
  assert.throws(() => validateManualPredioBody({ mode: 'manual', departamento: 'D', municipio: 'M' }), (e) => e.code === 'INVALID_NOMBRE_PREDIO');
  assert.throws(() => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', municipio: 'M' }), (e) => e.code === 'INVALID_DEPARTAMENTO');
  assert.throws(() => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D' }), (e) => e.code === 'INVALID_MUNICIPIO');
});

test('validateManualPredioBody: valida rangos de latitud/longitud/areaTotalHa opcionales', () => {
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', latitud: 200 }),
    (e) => e.code === 'INVALID_LATITUD',
  );
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', longitud: -200 }),
    (e) => e.code === 'INVALID_LONGITUD',
  );
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', areaTotalHa: -5 }),
    (e) => e.code === 'INVALID_AREA_TOTAL_HA',
  );

  const result = validateManualPredioBody({
    mode: 'manual',
    nombrePredio: 'X',
    departamento: 'D',
    municipio: 'M',
    vereda: 'El Recreo',
    areaTotalHa: 12.5,
    latitud: 1.35,
    longitud: -75.45,
  });
  assert.equal(result.areaTotalHa, 12.5);
  assert.equal(result.latitud, 1.35);
  assert.equal(result.longitud, -75.45);
});

// ---------------------------------------------------------------------
// validateCatastroxSaveBody (§12)
// ---------------------------------------------------------------------

test('validateCatastroxSaveBody: acepta candidateId + nombrePersonalizado opcional', () => {
  const result = validateCatastroxSaveBody({ mode: 'catastrox', candidateId: 'pcand_abc', nombrePersonalizado: 'Mi finca' });
  assert.equal(result.candidateId, 'pcand_abc');
  assert.equal(result.nombrePersonalizado, 'Mi finca');
});

// SPRINT-3C1.1 §9: lista exacta pedida -- organizacionId, organizacion_id,
// geometry, codigoPredial, codigo_predial, areaM2, areaHa, fuente,
// snapshot. El servidor es la única autoridad de estos campos; el modo
// catastrox nunca los toma del body, ni siquiera si llegan con el nombre
// "equivocado" (snake_case) esperando colarse por un allowlist laxo.
test('validateCatastroxSaveBody: RECHAZA cada campo prohibido individualmente (§9, lista exacta)', () => {
  const forbidden = [
    'organizacionId',
    'organizacion_id',
    'geometry',
    'codigoPredial',
    'codigo_predial',
    'areaM2',
    'areaHa',
    'fuente',
    'snapshot',
    'areaCatastral',
  ];
  for (const key of forbidden) {
    assert.throws(
      () => validateCatastroxSaveBody({ mode: 'catastrox', candidateId: 'pcand_abc', [key]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo prohibido "${key}"`,
    );
  }
});

test('validateCatastroxSaveBody: RECHAZA todos los campos prohibidos combinados en un solo body (caso realista de payload malicioso)', () => {
  assert.throws(
    () =>
      validateCatastroxSaveBody({
        mode: 'catastrox',
        candidateId: 'pcand_abc',
        organizacionId: 'org-ajeno',
        organizacion_id: 'org-ajeno',
        geometry: { type: 'Polygon', coordinates: [] },
        codigoPredial: '1'.repeat(30),
        codigo_predial: '1'.repeat(30),
        areaM2: 999999,
        areaHa: 99,
        fuente: 'fabricado',
        snapshot: { fake: true },
      }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('validateCatastroxSaveBody: exige candidateId', () => {
  assert.throws(() => validateCatastroxSaveBody({ mode: 'catastrox' }), (e) => e.code === 'INVALID_CANDIDATE_ID');
});
