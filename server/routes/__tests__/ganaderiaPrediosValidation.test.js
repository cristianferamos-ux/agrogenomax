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
  serializePredioSearchResult,
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
  assert.equal(result.areaDeclaradaHa, null);
  assert.equal(result.observaciones, null);
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

test('validateManualPredioBody: valida rangos de latitud/longitud/areaDeclaradaHa opcionales', () => {
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', latitud: 200 }),
    (e) => e.code === 'INVALID_LATITUD',
  );
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', longitud: -200 }),
    (e) => e.code === 'INVALID_LONGITUD',
  );
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', areaDeclaradaHa: -5 }),
    (e) => e.code === 'INVALID_AREA_DECLARADA_HA',
  );

  const result = validateManualPredioBody({
    mode: 'manual',
    nombrePredio: 'X',
    departamento: 'D',
    municipio: 'M',
    vereda: 'El Recreo',
    areaDeclaradaHa: 12.5,
    observaciones: 'Predio con acceso por la vía principal.',
    latitud: 1.35,
    longitud: -75.45,
  });
  assert.equal(result.areaDeclaradaHa, 12.5);
  assert.equal(result.observaciones, 'Predio con acceso por la vía principal.');
  assert.equal(result.latitud, 1.35);
  assert.equal(result.longitud, -75.45);
});

test('validateManualPredioBody: RECHAZA areaTotalHa (nombre legacy, ya no forma parte del contrato)', () => {
  assert.throws(
    () => validateManualPredioBody({ mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M', areaTotalHa: 5 }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

// ---------------------------------------------------------------------
// validateCatastroxSaveBody (§12)
// ---------------------------------------------------------------------

test('validateCatastroxSaveBody: acepta candidateId + nombrePersonalizado opcional', () => {
  const result = validateCatastroxSaveBody({ mode: 'catastrox', candidateId: 'pcand_abc', nombrePersonalizado: 'Mi finca' });
  assert.equal(result.candidateId, 'pcand_abc');
  assert.equal(result.nombrePersonalizado, 'Mi finca');
  assert.equal(result.areaDeclaradaHa, null);
  assert.equal(result.observaciones, null);
});

// SPRINT-3C2.5 §9: areaDeclaradaHa/observaciones SÍ son aceptados en modo
// catastrox (vienen del cliente, nunca de CatastroX).
test('validateCatastroxSaveBody: acepta areaDeclaradaHa + observaciones', () => {
  const result = validateCatastroxSaveBody({
    mode: 'catastrox',
    candidateId: 'pcand_abc',
    areaDeclaradaHa: 9.16,
    observaciones: 'Confirmado en visita de campo.',
  });
  assert.equal(result.areaDeclaradaHa, 9.16);
  assert.equal(result.observaciones, 'Confirmado en visita de campo.');
});

// SPRINT-3C1.1 §9 + SPRINT-3C2.5 §17: lista exacta pedida --
// organizacionId, organizacion_id, geometry, codigoPredial,
// codigo_predial, areaCatastralHa, areaCatastralM2, fuente,
// versionFuente, snapshot, departamento, municipio. El servidor es la
// única autoridad de estos campos; el modo catastrox nunca los toma del
// body, ni siquiera si llegan con el nombre "equivocado" (snake_case)
// esperando colarse por un allowlist laxo.
test('validateCatastroxSaveBody: RECHAZA cada campo prohibido individualmente (§17, lista exacta)', () => {
  const forbidden = [
    'organizacionId',
    'organizacion_id',
    'geometry',
    'codigoPredial',
    'codigo_predial',
    'areaCatastralHa',
    'areaCatastralM2',
    'fuente',
    'versionFuente',
    'snapshot',
    'departamento',
    'municipio',
    // nombres legacy/alternativos -- también deben quedar fuera del allowlist.
    'areaM2',
    'areaHa',
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
        areaCatastralHa: 99,
        areaCatastralM2: 999999,
        fuente: 'fabricado',
        versionFuente: '9999-99',
        snapshot: { fake: true },
        departamento: 'FALSO',
        municipio: 'FALSO',
      }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('validateCatastroxSaveBody: exige candidateId', () => {
  assert.throws(() => validateCatastroxSaveBody({ mode: 'catastrox' }), (e) => e.code === 'INVALID_CANDIDATE_ID');
});

// ---------------------------------------------------------------------
// serializePredioSearchResult (SPRINT-3C2.6, hardening): único punto de
// salida hacia el cliente para el resultado de una búsqueda -- el objeto
// interno `predio` (catastroxPredioLookup.js) lleva campos exclusivos de
// uso server-side (sector, sectorCodigoTecnico, veredaCodigoTecnico) que
// NUNCA deben llegar al frontend.
// ---------------------------------------------------------------------

function fullInternalPredioFixture() {
  return {
    codigoPredial: '186001000000000010001000000000',
    codigoAnterior: null,
    nombrePredio: 'Finca La Esperanza',
    departamento: 'Caquetá',
    municipio: 'Florencia',
    vereda: 'Florida Uno',
    sector: null,
    sectorCodigoTecnico: '01',
    veredaCodigoTecnico: null,
    areaCatastralM2: 50000,
    areaCatastralHa: 5,
    centroide: { lat: 1.35, lng: -75.45 },
    geometry: { type: 'MultiPolygon', coordinates: [] },
    fuente: 'catastrox_clean',
    versionFuente: null,
    fechaConsulta: '2026-08-18T00:00:00.000Z',
  };
}

test('serializePredioSearchResult: expone exactamente el contrato público acordado (12 campos)', () => {
  const result = serializePredioSearchResult(fullInternalPredioFixture());
  assert.deepEqual(Object.keys(result).sort(), [
    'areaCatastralHa',
    'areaCatastralM2',
    'centroide',
    'codigoAnterior',
    'codigoPredial',
    'departamento',
    'fuente',
    'geometry',
    'municipio',
    'nombrePredio',
    'vereda',
    'versionFuente',
  ].sort());
});

test('serializePredioSearchResult: NUNCA incluye sector, sectorCodigoTecnico ni veredaCodigoTecnico, aunque el objeto interno los traiga poblados', () => {
  const result = serializePredioSearchResult(fullInternalPredioFixture());
  assert.equal('sector' in result, false);
  assert.equal('sectorCodigoTecnico' in result, false);
  assert.equal('veredaCodigoTecnico' in result, false);
});

test('serializePredioSearchResult: campos públicos conservan sus valores reales sin transformación', () => {
  const fixture = fullInternalPredioFixture();
  const result = serializePredioSearchResult(fixture);
  assert.equal(result.nombrePredio, fixture.nombrePredio);
  assert.equal(result.vereda, fixture.vereda);
  assert.equal(result.areaCatastralHa, fixture.areaCatastralHa);
  assert.equal(result.codigoPredial, fixture.codigoPredial);
  assert.equal(result.versionFuente, null);
  assert.deepEqual(result.geometry, fixture.geometry);
});
