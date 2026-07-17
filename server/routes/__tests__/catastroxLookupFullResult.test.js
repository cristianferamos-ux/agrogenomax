import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __clearLookupStateForTests,
  __getLookupPreviewForTests,
  buildLookupFullResultPayload,
  rememberAdvancedLookupPreview,
  rememberCleanLookupPreviewFromPoint,
} from '../catastrox.js';

// Regresion para CX-LOGIC-001: /lookups/:lookupId/full-result podia servir,
// sin advertencia, una fila distinta a la que la busqueda por coordenadas
// identifico originalmente, cuando existian filas duplicadas por
// codigo_predial en catastrox_clean.predios. Todos los identificadores,
// codigos y geometrias usados aqui son sinteticos.

const SYNTHETIC_CODE = '999999999999999999999999999999'; // 30 digitos, sintetico
const OTHER_SYNTHETIC_CODE = '888888888888888888888888888888'; // 30 digitos, sintetico
const SYNTHETIC_POINT = { lat: 1.111111, lng: -75.111111 };
const SYNTHETIC_GEOMETRY = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };

function makeCleanRow(overrides = {}) {
  return {
    codigo_predial: SYNTHETIC_CODE,
    codigo_anterior: null,
    municipio_dane: '18000',
    municipio_nombre: 'MUNICIPIO-SINTETICO',
    departamento_nombre: 'DEPARTAMENTO-SINTETICO',
    zona: 'rural',
    nombre_predio: null,
    direccion_real: null,
    vereda_nombre: null,
    area_terreno_m2: 1000,
    area_terreno_ha: 0.1,
    area_m2_exact: 1000,
    perimetro_m: 400,
    geometry_fingerprint: 'hash-generico',
    geometry: SYNTHETIC_GEOMETRY,
    projected_geometry: SYNTHETIC_GEOMETRY,
    ...overrides,
  };
}

// Router simulado por contenido de SQL: no depende de pg/express, solo
// distingue que constante de consulta (definida dentro de
// buildLookupFullResultPayload) se esta ejecutando, por un fragmento
// literal exclusivo de cada una.
function createMockQuery({ fid = () => ({ rows: [] }), code = () => ({ rows: [] }), point = () => ({ rows: [] }), legacy = () => ({ rows: [] }) } = {}) {
  return async (sql, params) => {
    if (sql.includes('where fid = $1')) return fid(params);
    if (sql.includes('where p.codigo_predial = $1')) return code(params);
    if (sql.includes('order by p.area_terreno_m2 asc nulls last')) return point(params, sql);
    if (sql.includes('from gis.catastro_caqueta c')) return legacy(params);
    throw new Error(`Query no reconocida por el mock: ${sql.slice(0, 60)}...`);
  };
}

test('A. una busqueda por coordenadas clean conserva el fid seleccionado en el preview', () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-fid-persist';

  // Llama exactamente a la misma funcion productiva que router.post('/lookup')
  // invoca tras findCleanPredioByPoint() -- no reconstruye la logica de
  // persistencia dentro del test, para que este test no pueda pasar si
  // rememberCleanLookupPreviewFromPoint dejara de conservar el fid.
  const cleanPredio = { codigo_predial: SYNTHETIC_CODE, zona: 'urbano', fid: 42 };
  rememberCleanLookupPreviewFromPoint(lookupId, cleanPredio, SYNTHETIC_POINT.lat, SYNTHETIC_POINT.lng);

  const stored = __getLookupPreviewForTests(lookupId);
  assert.equal(stored.fid, '42');
  assert.equal(stored.codigoPredial, SYNTHETIC_CODE);
  assert.deepEqual(stored.queryPoint, SYNTHETIC_POINT);
  assert.equal(stored.searchType, undefined, 'una busqueda por punto no debe fijar searchType="code"');
});

test('B. full-result por punto entrega siempre la fila fid=B sin importar el orden de las filas SQL', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-order-independence';
  // La busqueda inicial identifico la fila B (p.ej. porque cubre el punto).
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, { queryPoint: SYNTHETIC_POINT, fid: 'FID-B' });

  const filaA = makeCleanRow({ municipio_nombre: 'MUNI-A', zona: 'rural', geometry_fingerprint: 'hash-A' });
  const filaB = makeCleanRow({ municipio_nombre: 'MUNI-B', zona: 'urbano', geometry_fingerprint: 'hash-B' });

  for (const rows of [[filaA, filaB], [filaB, filaA]]) {
    const queryImpl = createMockQuery({
      fid: () => ({ rows: [{ fid: 'FID-B', codigo_predial: SYNTHETIC_CODE, geometry_fingerprint: 'hash-B' }] }),
      code: () => ({ rows }),
    });

    const result = await buildLookupFullResultPayload(lookupId, queryImpl);
    assert.equal(result.errorStatus, null);
    assert.equal(result.payload.predio.municipio, 'MUNI-B', `orden de filas SQL no debe cambiar el resultado (rows=${JSON.stringify(rows.map((r) => r.municipio_nombre))})`);
  }
});

test('B2. dos fid distintos con geometry_fingerprint identico bajo el mismo codigo_predial responden 409 en ambos ordenes, nunca FOUND', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-fingerprint-collision';
  // La busqueda inicial selecciono la fila B (fid original).
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, { queryPoint: SYNTHETIC_POINT, fid: 'FID-B' });

  const filaA = makeCleanRow({
    municipio_nombre: 'MUNICIPIO-A',
    direccion_real: 'DIRECCION-SINTETICA-A',
    geometry_fingerprint: 'hash-identico',
  });
  const filaB = makeCleanRow({
    municipio_nombre: 'MUNICIPIO-B',
    direccion_real: 'DIRECCION-SINTETICA-B',
    geometry_fingerprint: 'hash-identico',
  });

  for (const rows of [[filaA, filaB], [filaB, filaA]]) {
    const queryImpl = createMockQuery({
      fid: () => ({ rows: [{ fid: 'FID-B', codigo_predial: SYNTHETIC_CODE, geometry_fingerprint: 'hash-identico' }] }),
      code: () => ({ rows }),
    });

    const result = await buildLookupFullResultPayload(lookupId, queryImpl);
    assert.equal(result.errorStatus, 409, `rows=${JSON.stringify(rows.map((r) => r.municipio_nombre))}`);
    assert.equal(result.payload.status, 'REQUIRES_TECHNICAL_VALIDATION');
    assert.notEqual(result.payload.found, true);
    assert.notEqual(result.payload?.predio?.municipio, 'MUNICIPIO-A');
    assert.notEqual(result.payload?.predio?.municipio, 'MUNICIPIO-B');
  }
});

test('C. si el fid resuelve a un codigo_predial distinto del preview, no responde FOUND silenciosamente', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-cross-check';
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, { queryPoint: SYNTHETIC_POINT, fid: 'FID-STALE' });

  const queryImpl = createMockQuery({
    fid: () => ({ rows: [{ fid: 'FID-STALE', codigo_predial: OTHER_SYNTHETIC_CODE, geometry_fingerprint: 'hash-other' }] }),
    code: () => ({ rows: [makeCleanRow({ codigo_predial: OTHER_SYNTHETIC_CODE, geometry_fingerprint: 'hash-other' })] }),
  });

  const result = await buildLookupFullResultPayload(lookupId, queryImpl);
  assert.equal(result.errorStatus, 409);
  assert.equal(result.payload.status, 'REQUIRES_TECHNICAL_VALIDATION');
  assert.notEqual(result.payload.found, true);
});

test('D1. preview sin fid (compatibilidad) usa reseleccion espacial deterministica en vez de rows[0]', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-no-fid-spatial';
  // Preview "antiguo": mismo shape que antes del fix, sin fid.
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, { queryPoint: SYNTHETIC_POINT });

  let codeQueryCalled = false;
  let pointSql = '';
  const queryImpl = createMockQuery({
    code: () => {
      codeQueryCalled = true;
      return { rows: [makeCleanRow({ municipio_nombre: 'NUNCA-DEBE-SERVIRSE' })] };
    },
    point: (_params, sql) => {
      pointSql = sql;
      return { rows: [makeCleanRow({ municipio_nombre: 'MUNI-ESPACIAL' })] };
    },
  });

  const result = await buildLookupFullResultPayload(lookupId, queryImpl);
  assert.equal(result.errorStatus, null);
  assert.equal(result.payload.predio.municipio, 'MUNI-ESPACIAL');
  assert.equal(codeQueryCalled, false, 'sin fid, no debe consultarse por codigo_predial en absoluto');
  assert.match(
    pointSql,
    /ST_SetSRID\(\s*ST_Transform\(\s*ST_SetSRID\(ST_Point\(\$1, \$2\), 4326\),[\s\S]*?\)\s*,\s*9377\s*\)/,
    'el punto transformado debe conservar SRID 9377 antes de ST_Covers',
  );
});

test('D2. preview sin fid y sin queryPoint nunca responde FOUND con una fila arbitraria', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-no-fid-no-point';
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, {}); // sin queryPoint, sin fid

  let codeQueryCalled = false;
  const queryImpl = createMockQuery({
    code: () => {
      codeQueryCalled = true;
      return { rows: [makeCleanRow({ municipio_nombre: 'NUNCA-DEBE-SERVIRSE' })] };
    },
  });

  const result = await buildLookupFullResultPayload(lookupId, queryImpl);
  assert.equal(result.errorStatus, 404);
  assert.equal(result.payload.status, 'FULL_RESULT_UNAVAILABLE');
  assert.notEqual(result.payload.found, true);
  assert.equal(codeQueryCalled, false, 'sin fid ni queryPoint, no debe consultarse por codigo_predial en absoluto');
});

test('E. busqueda por codigo con filas contradictorias sigue devolviendo 409 en ambos ordenes (sin regresion)', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-code-branch-regression';
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, {
    queryPoint: SYNTHETIC_POINT,
    searchType: 'code',
    queriedCode: SYNTHETIC_CODE,
  });

  const filaA = makeCleanRow({ municipio_nombre: 'MUNI-A', zona: 'rural', geometry_fingerprint: 'hash-A' });
  const filaB = makeCleanRow({ municipio_nombre: 'MUNI-B', zona: 'urbano', geometry_fingerprint: 'hash-B' });

  for (const rows of [[filaA, filaB], [filaB, filaA]]) {
    const queryImpl = createMockQuery({ code: () => ({ rows }) });
    const result = await buildLookupFullResultPayload(lookupId, queryImpl);
    assert.equal(result.errorStatus, 409);
    assert.equal(result.payload.status, 'REQUIRES_TECHNICAL_VALIDATION');
  }
});

test('E2. busqueda por codigo con candidatos coherentes sigue resolviendo normalmente (sin regresion)', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-code-branch-resolved';
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, {
    queryPoint: SYNTHETIC_POINT,
    searchType: 'code',
    queriedCode: SYNTHETIC_CODE,
  });

  const filaUnica = makeCleanRow({ municipio_nombre: 'MUNI-UNICA' });
  const queryImpl = createMockQuery({ code: () => ({ rows: [filaUnica] }) });

  const result = await buildLookupFullResultPayload(lookupId, queryImpl);
  assert.equal(result.errorStatus, null);
  assert.equal(result.payload.predio.municipio, 'MUNI-UNICA');
});

test('CX-LOGIC-002 E. disponibilidad: identidad incompleta con geometria invalida/valida no alterna entre FOUND y FULL_RESULT_UNAVAILABLE', async () => {
  __clearLookupStateForTests();
  const lookupId = 'cx-test-availability-incomplete-identity';
  rememberAdvancedLookupPreview(lookupId, SYNTHETIC_CODE, {
    queryPoint: SYNTHETIC_POINT,
    searchType: 'code',
    queriedCode: SYNTHETIC_CODE,
  });

  // Identidad incompleta (territorio y huella ausentes en ambas filas):
  // una con geometria estructuralmente invalida, otra valida.
  const filaGeometriaInvalida = makeCleanRow({
    municipio_dane: null,
    municipio_nombre: null,
    departamento_nombre: null,
    zona: null,
    geometry_fingerprint: null,
    geometry: null,
  });
  const filaGeometriaValida = makeCleanRow({
    municipio_dane: null,
    municipio_nombre: null,
    departamento_nombre: null,
    zona: null,
    geometry_fingerprint: null,
    geometry: SYNTHETIC_GEOMETRY,
  });

  const outcomes = [];
  for (const rows of [[filaGeometriaInvalida, filaGeometriaValida], [filaGeometriaValida, filaGeometriaInvalida]]) {
    const queryImpl = createMockQuery({ code: () => ({ rows }) });
    const result = await buildLookupFullResultPayload(lookupId, queryImpl);
    outcomes.push(result.payload.status);
    // El resultado seguro (ambiguo) nunca debe presentarse como FOUND ni
    // como FULL_RESULT_UNAVAILABLE -- debe ser el mismo estado de
    // revision tecnica en ambos ordenes.
    assert.equal(result.errorStatus, 409);
    assert.equal(result.payload.status, 'REQUIRES_TECHNICAL_VALIDATION');
    assert.notEqual(result.payload.found, true);
  }
  assert.deepEqual(outcomes, ['REQUIRES_TECHNICAL_VALIDATION', 'REQUIRES_TECHNICAL_VALIDATION']);
});
