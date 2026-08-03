// Corrección "lookup sin dependencia dura de gis.*": estas pruebas cubren
// (a) las funciones puras/inyectables que degradan una relación OPCIONAL
// ausente (gis.catastro_caqueta, gis.municipios_colombia,
// catastrox_clean.v_predios_enriquecidos, catastrox_clean.predios) a un
// resultado nulo en vez de lanzar, y (b) el endpoint POST /lookup completo,
// invocado directamente sobre su handler real (mismo router montado en
// server/index.js) con el Pool de catastroxDb.js sustituido por un doble de
// prueba -- nunca una conexión real, nunca datos reales, nunca Railway.
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

import { getConfig } from '../../config/env.js';
import { getCatastroxDbPool } from '../../catastroxDb.js';
import router, {
  isUndefinedRelationError,
  findMunicipioByPoint,
  findCleanPredioCandidatesByPoint,
} from '../catastrox.js';

function undefinedRelationError(relationName) {
  return Object.assign(new Error(`relation "${relationName}" does not exist`), { code: '42P01' });
}

function realConnectionError() {
  return Object.assign(new Error('connection refused'), { code: '08006' });
}

// ---------------------------------------------------------------------
// isUndefinedRelationError
// ---------------------------------------------------------------------

test('isUndefinedRelationError reconoce 42P01', () => {
  assert.equal(isUndefinedRelationError(undefinedRelationError('gis.catastro_caqueta')), true);
});

test('isUndefinedRelationError rechaza otros códigos y valores no-error', () => {
  assert.equal(isUndefinedRelationError(realConnectionError()), false);
  assert.equal(isUndefinedRelationError({ code: '28P01' }), false);
  assert.equal(isUndefinedRelationError(null), false);
  assert.equal(isUndefinedRelationError(undefined), false);
});

// ---------------------------------------------------------------------
// findMunicipioByPoint -- gis.municipios_colombia es la única fuente
// ---------------------------------------------------------------------

test('findMunicipioByPoint: gis.municipios_colombia ausente devuelve null, no lanza', async () => {
  const queryImpl = async () => {
    throw undefinedRelationError('gis.municipios_colombia');
  };
  const result = await findMunicipioByPoint(-75.505416, 1.328814, queryImpl);
  assert.equal(result, null);
});

test('findMunicipioByPoint: error real distinto de 42P01 se propaga', async () => {
  const queryImpl = async () => {
    throw realConnectionError();
  };
  await assert.rejects(
    () => findMunicipioByPoint(-75.505416, 1.328814, queryImpl),
    /connection refused/,
  );
});

test('findMunicipioByPoint: devuelve el municipio cuando la relación existe', async () => {
  const queryImpl = async () => ({
    rows: [{ mpcodigo: '18150', mpnombre: 'CARTAGENA DEL CHAIRA', depto: 'CAQUETA', gestor: 'IGAC' }],
  });
  const result = await findMunicipioByPoint(-75.505416, 1.328814, queryImpl);
  assert.deepEqual(result, {
    codigoMunicipio: '18150',
    municipio: 'CARTAGENA DEL CHAIRA',
    departamento: 'CAQUETA',
    gestorCatastral: 'IGAC',
  });
});

// ---------------------------------------------------------------------
// findCleanPredioCandidatesByPoint -- vista principal, tabla base fallback
// ---------------------------------------------------------------------

test('findCleanPredioCandidatesByPoint: usa v_predios_enriquecidos cuando existe (vista disponible)', async () => {
  let calls = 0;
  const queryImpl = async (sql) => {
    calls += 1;
    assert.match(sql, /catastrox_clean\.v_predios_enriquecidos/);
    return {
      rows: [
        {
          codigo_predial: '181500002000000300047000000000',
          zona: 'rural',
          municipio_nombre: 'CARTAGENA DEL CHAIRA',
          departamento_nombre: 'CAQUETA',
          fid: 1,
          priority_tier: 0,
        },
      ],
    };
  };
  const rows = await findCleanPredioCandidatesByPoint(-75.505416, 1.328814, queryImpl);
  assert.equal(calls, 1);
  assert.equal(rows[0].municipio_nombre, 'CARTAGENA DEL CHAIRA');
  assert.equal(rows[0].departamento_nombre, 'CAQUETA');
});

test('findCleanPredioCandidatesByPoint: cae a catastrox_clean.predios si la vista no existe (fallback a tabla base)', async () => {
  let calls = 0;
  const queryImpl = async (sql) => {
    calls += 1;
    if (calls === 1) {
      assert.match(sql, /catastrox_clean\.v_predios_enriquecidos/);
      throw undefinedRelationError('catastrox_clean.v_predios_enriquecidos');
    }
    assert.match(sql, /catastrox_clean\.predios\b/);
    return {
      rows: [
        {
          codigo_predial: '181500002000000300047000000000',
          zona: 'rural',
          municipio_nombre: 'CARTAGENA DEL CHAIRA',
          departamento_nombre: 'CAQUETA',
          fid: 1,
          priority_tier: 0,
        },
      ],
    };
  };
  const rows = await findCleanPredioCandidatesByPoint(-75.505416, 1.328814, queryImpl);
  assert.equal(calls, 2);
  assert.equal(rows[0].codigo_predial, '181500002000000300047000000000');
});

test('findCleanPredioCandidatesByPoint: ambas relaciones clean ausentes devuelve [], no lanza', async () => {
  const queryImpl = async () => {
    throw undefinedRelationError('catastrox_clean.predios');
  };
  const rows = await findCleanPredioCandidatesByPoint(-75.505416, 1.328814, queryImpl);
  assert.deepEqual(rows, []);
});

test('findCleanPredioCandidatesByPoint: error real distinto de 42P01 se propaga', async () => {
  const queryImpl = async () => {
    throw realConnectionError();
  };
  await assert.rejects(
    () => findCleanPredioCandidatesByPoint(-75.505416, 1.328814, queryImpl),
    /connection refused/,
  );
});

// ---------------------------------------------------------------------
// Endpoint POST /api/catastrox/lookup -- mismo router real montado en
// server/index.js, invocado directamente sobre su handler (sin servidor
// HTTP real, sin conexión real: el Pool de catastroxDb.js se sustituye por
// un doble de prueba antes de cada caso).
// ---------------------------------------------------------------------

getConfig();
const testPool = getCatastroxDbPool();
const lookupLayer = router.stack.find(
  (layer) => layer.route && layer.route.path === '/lookup' && layer.route.methods.post,
);
const lookupHandler = lookupLayer.route.stack[0].handle;

async function invokeLookup(queryImpl, body = { lat: 1.328814, lng: -75.505416 }) {
  testPool.query = queryImpl;
  const req = { body };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonBody = payload;
      return this;
    },
  };
  let forwardedError = null;
  const next = (error) => {
    forwardedError = error;
  };
  await lookupHandler(req, res, next);
  return { statusCode, jsonBody, forwardedError };
}

test('POST /lookup: gis.catastro_caqueta ausente (42P01) + catastrox_clean disponible -> 200, predio encontrado, gestor null', async () => {
  const { statusCode, jsonBody, forwardedError } = await invokeLookup(async (sql) => {
    if (/gis\.catastro_caqueta|gis\.municipios_colombia/.test(sql)) {
      throw undefinedRelationError('gis.catastro_caqueta');
    }
    if (/catastrox_clean\.v_predios_enriquecidos/.test(sql)) {
      return {
        rows: [
          {
            codigo_predial: '181500002000000300047000000000',
            zona: 'rural',
            municipio_nombre: 'CARTAGENA DEL CHAIRA',
            departamento_nombre: 'CAQUETA',
            fid: 42,
            priority_tier: 0,
          },
        ],
      };
    }
    return { rows: [] };
  });

  assert.equal(forwardedError, null);
  assert.equal(statusCode, 200);
  assert.equal(jsonBody.found, true);
  assert.equal(jsonBody.status, 'FOUND');
  assert.equal(jsonBody.canPurchase, true);
  assert.equal(jsonBody.municipio, 'CARTAGENA DEL CHAIRA');
  assert.equal(jsonBody.departamento, 'CAQUETA');
  assert.equal(jsonBody.gestor, null);
  assert.equal(jsonBody.predio.municipio, 'CARTAGENA DEL CHAIRA');
  assert.equal(jsonBody.predio.departamento, 'CAQUETA');
  assert.equal(jsonBody.predio.gestor, null);
  // Contrato público sin cambios: mismas claves de siempre presentes.
  for (const key of [
    'lookup_id',
    'routeId',
    'canonicalPredioId',
    'found',
    'status',
    'municipio',
    'departamento',
    'tipoZona',
    'gestor',
    'canPurchase',
    'commercialMessage',
    'legalNotice',
    'coverage',
    'predio',
  ]) {
    assert.ok(key in jsonBody, `falta la clave ${key} en el contrato público`);
  }
});

test('POST /lookup: gis.* y catastrox_clean ausentes -> 404, no 500', async () => {
  const { statusCode, jsonBody, forwardedError } = await invokeLookup(async () => {
    throw undefinedRelationError('gis.catastro_caqueta');
  });

  assert.equal(forwardedError, null);
  assert.equal(statusCode, 404);
  assert.equal(jsonBody.found, false);
  assert.equal(jsonBody.status, 'PENDIENTE_VALIDACION');
  assert.equal(jsonBody.canPurchase, false);
});

test('POST /lookup: error real de conexión/autenticación distinto de 42P01 -> se propaga (500 vía errorHandler)', async () => {
  const { statusCode, jsonBody, forwardedError } = await invokeLookup(async () => {
    throw realConnectionError();
  });

  assert.equal(statusCode, 200); // res.json() nunca se llamó -- no hay respuesta controlada
  assert.equal(jsonBody, null);
  assert.ok(forwardedError, 'el error real debe llegar a next(error) -> errorHandler -> 500');
  assert.equal(forwardedError.code, '08006');
  assert.equal(isUndefinedRelationError(forwardedError), false);
});
