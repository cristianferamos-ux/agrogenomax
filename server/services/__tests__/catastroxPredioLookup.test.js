// SPRINT-3C1-MIS-PREDIOS-API: pruebas unitarias del motor interno de
// búsqueda predial (server/services/catastroxPredioLookup.js). Mismo
// patrón de queryImpl inyectable que catastroxLookupByPoint.test.js /
// catastroxLookupByCode.test.js -- nunca una conexión real. No vuelve a
// probar la lógica ya cubierta en esos archivos (SQL de
// findCleanPredioCandidatesByPoint/findPredioByCadastralCode/
// resolvePredioDataForDelivery) -- solo la orquestación/normalización
// nueva de este módulo.
process.env.APP_ENV = 'test';
process.env.CATASTROX_DATASET_VERSION = '2026-01';
process.env.CATASTROX_DATABASE_URL = 'postgres://test:test@192.0.2.1:5432/never_connects';

import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../../config/env.js';
import {
  lookupPredioPorCoordenadas,
  lookupPredioPorCodigo,
  computeApproximateCentroid,
} from '../catastroxPredioLookup.js';

getConfig({ APP_ENV: 'test' }, {});

const SQUARE_RING = [
  [-75.5, 1.3],
  [-75.4, 1.3],
  [-75.4, 1.4],
  [-75.5, 1.4],
  [-75.5, 1.3],
];
const SQUARE_MULTIPOLYGON = { type: 'MultiPolygon', coordinates: [[SQUARE_RING]] };

function candidateRow(overrides = {}) {
  return {
    codigo_predial: '186001000000000010001000000000',
    zona: 'Rural',
    area_m2_exact: 50000,
    municipio_nombre: 'Florencia',
    departamento_nombre: 'Caquetá',
    fid: 1,
    priority_tier: 0,
    geometry_fingerprint: 'fp-1',
    ...overrides,
  };
}

function deliveryRow(overrides = {}) {
  return {
    codigo_predial: '186001000000000010001000000000',
    codigo_anterior: null,
    departamento_nombre: 'Caquetá',
    municipio_nombre: 'Florencia',
    zona: 'Rural',
    nombre_predio: 'Finca La Esperanza',
    direccion_real: null,
    vereda_nombre: 'El Recreo',
    barrio_nombre: null,
    sector_codigo: '01',
    manzana_codigo: null,
    area_terreno_m2: 50000,
    area_terreno_ha: 5,
    area_m2_exact: 50000,
    perimetro_m: 900,
    destino_economico_nombre: 'Agropecuario',
    uso_1_nombre: 'Pastos',
    uso_2_nombre: null,
    uso_3_nombre: null,
    numero_construcciones: 0,
    area_construida_m2: 0,
    tipos_construccion_resumen: null,
    fuente: 'catastrox_clean',
    fecha_proceso: '2026-01-01',
    geometry: JSON.stringify(SQUARE_MULTIPOLYGON),
    ...overrides,
  };
}

function byCodeRow(overrides = {}) {
  return {
    codigo_predial: '186001000000000010001000000000',
    codigo_anterior: null,
    municipio_dane: '18001',
    municipio_nombre: 'Florencia',
    departamento_nombre: 'Caquetá',
    zona: 'Rural',
    query_lat: 1.35,
    query_lng: -75.45,
    ...overrides,
  };
}

function buildQueryImpl({
  candidateRows = [candidateRow()],
  byCodeRows = [byCodeRow()],
  deliveryRow: deliveryRowValue = deliveryRow(),
} = {}) {
  return async (sql) => {
    if (sql.includes('with punto as')) {
      return { rows: candidateRows };
    }
    if (sql.includes('municipio_dane')) {
      return { rows: byCodeRows };
    }
    if (sql.includes('where p.codigo_predial = $1')) {
      return { rows: deliveryRowValue ? [deliveryRowValue] : [] };
    }
    throw new Error(`SQL inesperado en el test doble: ${sql.slice(0, 80)}`);
  };
}

// ---------------------------------------------------------------------
// computeApproximateCentroid
// ---------------------------------------------------------------------

test('computeApproximateCentroid: Polygon simple', () => {
  const centroid = computeApproximateCentroid({ type: 'Polygon', coordinates: [SQUARE_RING] });
  assert.ok(centroid);
  assert.ok(centroid.lat > 1.3 && centroid.lat < 1.4);
  assert.ok(centroid.lng > -75.5 && centroid.lng < -75.4);
});

test('computeApproximateCentroid: MultiPolygon', () => {
  const centroid = computeApproximateCentroid(SQUARE_MULTIPOLYGON);
  assert.ok(centroid);
});

test('computeApproximateCentroid: geometry inválida devuelve null', () => {
  assert.equal(computeApproximateCentroid(null), null);
  assert.equal(computeApproximateCentroid({ type: 'Point', coordinates: [1, 2] }), null);
});

// ---------------------------------------------------------------------
// lookupPredioPorCoordenadas
// ---------------------------------------------------------------------

test('lookupPredioPorCoordenadas: candidato único -> resolved con contrato normalizado completo', async () => {
  const queryImpl = buildQueryImpl();
  const result = await lookupPredioPorCoordenadas(1.35, -75.45, queryImpl);

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.predio.codigoPredial, '186001000000000010001000000000');
  assert.equal(result.predio.nombrePredio, 'Finca La Esperanza');
  assert.equal(result.predio.departamento, 'Caquetá');
  assert.equal(result.predio.municipio, 'Florencia');
  assert.equal(result.predio.areaHa, 5);
  assert.equal(result.predio.areaM2, 50000);
  assert.deepEqual(result.predio.geometry, SQUARE_MULTIPOLYGON);
  assert.ok(result.predio.centroide);
  assert.equal(result.predio.versionFuente, '2026-01');
  assert.ok(result.predio.fechaConsulta);
  // §3/§8: nunca debe filtrar campos internos.
  assert.equal(result.predio.organizacion_id, undefined);
  assert.equal(result.predio.wkt, undefined);
});

test('lookupPredioPorCoordenadas: sin candidatos -> not_found', async () => {
  const queryImpl = buildQueryImpl({ candidateRows: [] });
  const result = await lookupPredioPorCoordenadas(1.35, -75.45, queryImpl);
  assert.equal(result.outcome, 'not_found');
});

test('lookupPredioPorCoordenadas: dos candidatos mismo tier y distinto código -> ambiguous', async () => {
  const queryImpl = buildQueryImpl({
    candidateRows: [
      candidateRow({ priority_tier: 0, codigo_predial: 'AAA', geometry_fingerprint: 'fp-a' }),
      candidateRow({ priority_tier: 0, codigo_predial: 'BBB', geometry_fingerprint: 'fp-b' }),
    ],
  });
  const result = await lookupPredioPorCoordenadas(1.35, -75.45, queryImpl);
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.reason, 'REQUIRES_TECHNICAL_VALIDATION');
});

test('lookupPredioPorCoordenadas: candidato sin código predial de 30 dígitos -> not_found (nunca inventa identidad)', async () => {
  const queryImpl = buildQueryImpl({ candidateRows: [candidateRow({ codigo_predial: '123' })] });
  const result = await lookupPredioPorCoordenadas(1.35, -75.45, queryImpl);
  assert.equal(result.outcome, 'not_found');
});

// ---------------------------------------------------------------------
// lookupPredioPorCodigo
// ---------------------------------------------------------------------

test('lookupPredioPorCodigo: código de 30 dígitos válido -> resolved', async () => {
  const queryImpl = buildQueryImpl();
  const codigo = '186001000000000010001000000000';
  const result = await lookupPredioPorCodigo(codigo, queryImpl);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.predio.codigoPredial, codigo);
});

test('lookupPredioPorCodigo: formato inválido lanza con publicCode INVALID_CADASTRAL_CODE', async () => {
  await assert.rejects(
    () => lookupPredioPorCodigo('123', buildQueryImpl()),
    (error) => error.publicCode === 'INVALID_CADASTRAL_CODE',
  );
});

test('lookupPredioPorCodigo: sin resultados -> not_found', async () => {
  const queryImpl = async () => ({ rows: [] });
  const result = await lookupPredioPorCodigo('186001000000000010001000000000', queryImpl);
  assert.equal(result.outcome, 'not_found');
});

test('lookupPredioPorCodigo: múltiples filas con municipios distintos -> ambiguous', async () => {
  const queryImpl = async (sql) => {
    if (sql.includes('where codigo_predial = $1')) {
      return {
        rows: [
          { codigo_predial: 'X', codigo_anterior: null, municipio_dane: '1', municipio_nombre: 'A', departamento_nombre: 'D', zona: 'Rural', query_lat: 1, query_lng: -75 },
          { codigo_predial: 'X', codigo_anterior: null, municipio_dane: '1', municipio_nombre: 'B', departamento_nombre: 'D', zona: 'Rural', query_lat: 1, query_lng: -75 },
        ],
      };
    }
    return { rows: [] };
  };
  const result = await lookupPredioPorCodigo('186001000000000010001000000000', queryImpl);
  assert.equal(result.outcome, 'ambiguous');
});
