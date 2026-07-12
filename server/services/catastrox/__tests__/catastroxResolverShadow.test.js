import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import {
  createCatastroxResolverShadow,
  validateResolutionMatrixShape,
  loadResolutionMatrixFromFile,
  SHADOW_OUTCOME,
  COMPARISON_STATUS,
  SHADOW_ERROR_CODE,
  MATRIX_ERROR_CODE,
} from '../catastroxResolverShadow.js';
import { REASON_CODE } from '../catastroxResolutionPolicy.js';
import { isLocalSocketRequest, scheduleResolverShadowEvaluation } from '../../../routes/catastrox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.join(__dirname, '..', '..', '..', 'data', 'catastrox', 'catastroxDuplicateResolutionMatrix.v1.json');
const MODULE_SOURCE_PATH = path.join(__dirname, '..', 'catastroxResolverShadow.js');
const ROUTES_SOURCE_PATH = path.join(__dirname, '..', '..', '..', 'routes', 'catastrox.js');
const REAL_MATRIX = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));

const CODE_EXACT_NONE = '180940001000000050045000000000';
const CODE_MINIMAL_VARIATION = '180940001000000090035000000000';
const CODE_MATERIAL_CONFLICT = '180290001000000110038000000000';
const CODE_SEPARATE = '182470001000000069999000000000';
const CODE_ZONE_NORMALIZATION = '180940003000000080005000000000';
const CODE_MANZANA_ZERO = '182470100000001380012000000000';
const CODE_NOT_CLASSIFIED = '999999999999999999999999999999';

function makeClock(start = 1000) {
  let t = start;
  return () => (t += 1);
}

function providerReturning(candidates) {
  return async () => candidates;
}

function callCountingProvider(candidates) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return candidates;
  };
  fn.getCallCount = () => calls;
  return fn;
}

const ONLY_CANDIDATE = [{ source: 'clean', sourceRecordId: '101' }];
const TWO_CANDIDATES = [
  { source: 'clean', sourceRecordId: '202' },
  { source: 'clean', sourceRecordId: '101' },
];

const ALLOWED_RECORD_KEYS = new Set([
  'timestamp',
  'matrixVersion',
  'lookupId',
  'codigoPredial',
  'currentSource',
  'currentSourceRecordId',
  'resolutionStatus',
  'candidateSelectionStatus',
  'policySelectedTechnicalKey',
  'comparisonStatus',
  'reasonCodes',
  'evaluationMs',
  'errorCode',
]);

describe('catastroxResolverShadow — createCatastroxResolverShadow', () => {
  // 1. Flag desactivado: cero consultas
  test('1) enabled=false -> NO_OP inmediato, cero llamadas a candidateProvider, cero telemetria', async () => {
    const provider = callCountingProvider(ONLY_CANDIDATE);
    const shadow = createCatastroxResolverShadow({ enabled: false, candidateProvider: provider });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-1',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.outcome, SHADOW_OUTCOME.NO_OP);
    assert.equal(provider.getCallCount(), 0);
    assert.deepEqual(shadow.getShadowEvaluations(), []);
  });

  // 2. Código no clasificado
  test('2) codigoPredial ausente de la matriz -> NOT_APPLICABLE, sin llamar al proveedor ni registrar telemetria', async () => {
    const provider = callCountingProvider(ONLY_CANDIDATE);
    const shadow = createCatastroxResolverShadow({ enabled: true, candidateProvider: provider });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-2',
      codigoPredial: CODE_NOT_CLASSIFIED,
      currentSource: 'clean',
      currentSourceRecordId: '1',
    });

    assert.equal(result.outcome, SHADOW_OUTCOME.NOT_APPLICABLE);
    assert.equal(provider.getCallCount(), 0);
    assert.deepEqual(shadow.getShadowEvaluations(), []);
  });

  // 3. Exacto con candidatos válidos
  test('3) EXACT + NONE con candidatos validos -> EVALUATED, resolutionStatus AUTO_RESOLVED', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(TWO_CANDIDATES),
      clock: makeClock(),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-3',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.outcome, SHADOW_OUTCOME.EVALUATED);
    assert.equal(result.record.resolutionStatus, 'AUTO_RESOLVED');
    assert.equal(result.record.policySelectedTechnicalKey, 'clean::101');
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.MATCH);
    assert.equal(result.record.errorCode, null);
  });

  // 4. Variación mínima -> PENDING_POLICY
  test('4) MINIMAL_VARIATION -> comparisonStatus PENDING_POLICY, sin representante tecnico', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(TWO_CANDIDATES),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-4',
      codigoPredial: CODE_MINIMAL_VARIATION,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.record.resolutionStatus, 'PENDING_POLICY');
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.PENDING_POLICY);
    assert.equal(result.record.policySelectedTechnicalKey, null);
  });

  // 5. Conflicto material -> bloqueo observado
  test('5) MATERIAL_CONFLICT -> comparisonStatus CURRENT_FLOW_WOULD_BE_BLOCKED', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-5',
      codigoPredial: CODE_MATERIAL_CONFLICT,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.record.resolutionStatus, 'BLOCKED_REVIEW');
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.CURRENT_FLOW_WOULD_BE_BLOCKED);
  });

  // 6. Geometría separada
  test('6) SEPARATE -> tambien CURRENT_FLOW_WOULD_BE_BLOCKED', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-6',
      codigoPredial: CODE_SEPARATE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.record.resolutionStatus, 'BLOCKED_REVIEW');
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.CURRENT_FLOW_WOULD_BE_BLOCKED);
  });

  // 7. Error contractual aislado
  test('7) EXACT + NONE con candidates=[] -> error contractual capturado, nunca lanzado', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning([]),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-7',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.outcome, SHADOW_OUTCOME.EVALUATED);
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.EVALUATION_ERROR);
    assert.equal(result.record.errorCode, SHADOW_ERROR_CODE.RESOLVER_CONTRACT_ERROR);
    assert.equal(result.record.resolutionStatus, null);
  });

  // 8. Error del proveedor aislado
  test('8) candidateProvider que rechaza -> error aislado, evaluateLookupInShadow no lanza', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: async () => {
        throw new Error('conexion PostGIS caida (simulada)');
      },
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-8',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.outcome, SHADOW_OUTCOME.EVALUATED);
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.EVALUATION_ERROR);
    assert.equal(result.record.errorCode, SHADOW_ERROR_CODE.CANDIDATE_PROVIDER_ERROR);
  });

  // 9. Búfer limitado a 200
  test('9) el bufer nunca supera maxEntries=200 y descarta los mas antiguos primero', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      maxEntries: 200,
    });

    for (let i = 0; i < 205; i += 1) {
      await shadow.evaluateLookupInShadow({
        lookupId: `cx-buffer-${i}`,
        codigoPredial: CODE_EXACT_NONE,
        currentSource: 'clean',
        currentSourceRecordId: '101',
      });
    }

    const evaluations = shadow.getShadowEvaluations();
    assert.equal(evaluations.length, 200);
    assert.equal(evaluations[0].lookupId, 'cx-buffer-5');
    assert.equal(evaluations[evaluations.length - 1].lookupId, 'cx-buffer-204');
  });

  // 10. Limpieza del búfer
  test('10) clearShadowEvaluations vacia el bufer y reinicia el resumen', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    await shadow.evaluateLookupInShadow({
      lookupId: 'cx-10',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    assert.equal(shadow.getShadowEvaluations().length, 1);

    shadow.clearShadowEvaluations();
    assert.deepEqual(shadow.getShadowEvaluations(), []);
    assert.equal(shadow.getShadowSummary().totalEvaluations, 0);
  });

  // 11. Resumen por estado
  test('11) getShadowSummary agrega por comparisonStatus y resolutionStatus', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    await shadow.evaluateLookupInShadow({
      lookupId: 'cx-11a',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    await shadow.evaluateLookupInShadow({
      lookupId: 'cx-11b',
      codigoPredial: CODE_MATERIAL_CONFLICT,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    await shadow.evaluateLookupInShadow({
      lookupId: 'cx-11c',
      codigoPredial: CODE_MINIMAL_VARIATION,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    const summary = shadow.getShadowSummary();
    assert.equal(summary.totalEvaluations, 3);
    assert.equal(summary.byComparisonStatus[COMPARISON_STATUS.MATCH], 1);
    assert.equal(summary.byComparisonStatus[COMPARISON_STATUS.CURRENT_FLOW_WOULD_BE_BLOCKED], 1);
    assert.equal(summary.byComparisonStatus[COMPARISON_STATUS.PENDING_POLICY], 1);
    assert.equal(summary.byResolutionStatus.AUTO_RESOLVED, 1);
    assert.equal(summary.byResolutionStatus.BLOCKED_REVIEW, 1);
    assert.equal(summary.byResolutionStatus.PENDING_POLICY, 1);
    assert.equal(summary.errors, 0);
    assert.equal(summary.matrixCounts.total, 549);
  });

  // 12. No almacenar coordenadas
  test('12) el registro de telemetria nunca contiene claves de coordenadas', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    const { record } = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-12',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    const keys = Object.keys(record);
    assert.deepEqual(new Set(keys), ALLOWED_RECORD_KEYS);
    for (const key of keys) {
      assert.ok(!/lat|lng|coord/i.test(key), `la clave "${key}" sugiere una coordenada`);
    }
  });

  // 13. No almacenar geometría (ni otros datos prohibidos: direccion, barrio, nombre, propietario)
  test('13) el registro de telemetria nunca contiene geometria ni otros datos personales/identificables', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    const { record } = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-13',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    const keys = Object.keys(record);
    assert.deepEqual(new Set(keys), ALLOWED_RECORD_KEYS);
    for (const key of keys) {
      assert.ok(
        !/geom|address|direccion|barrio|nombre|owner|propietario/i.test(key),
        `la clave "${key}" sugiere un dato prohibido`,
      );
    }
  });

  // 14. No mutar entrada
  test('14) evaluateLookupInShadow no muta el objeto de entrada ni el arreglo del proveedor', async () => {
    const input = Object.freeze({
      lookupId: 'cx-14',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    const candidates = [{ source: 'clean', sourceRecordId: '101' }];
    const snapshotCandidates = JSON.parse(JSON.stringify(candidates));

    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: async () => candidates,
    });

    await shadow.evaluateLookupInShadow(input);

    assert.deepEqual(JSON.parse(JSON.stringify(input)), {
      lookupId: 'cx-14',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    assert.deepEqual(candidates, snapshotCandidates);
  });

  // 15. Evaluación independiente del orden
  test('15) el orden de los candidatos devueltos por el proveedor no cambia la seleccion', async () => {
    const orderA = [
      { source: 'clean', sourceRecordId: '202' },
      { source: 'clean', sourceRecordId: '101' },
    ];
    const orderB = [
      { source: 'clean', sourceRecordId: '101' },
      { source: 'clean', sourceRecordId: '202' },
    ];

    const shadowA = createCatastroxResolverShadow({ enabled: true, candidateProvider: async () => orderA });
    const shadowB = createCatastroxResolverShadow({ enabled: true, candidateProvider: async () => orderB });

    const resultA = await shadowA.evaluateLookupInShadow({
      lookupId: 'cx-15a',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    const resultB = await shadowB.evaluateLookupInShadow({
      lookupId: 'cx-15b',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(resultA.record.policySelectedTechnicalKey, resultB.record.policySelectedTechnicalKey);
    assert.equal(resultA.record.comparisonStatus, resultB.record.comparisonStatus);
  });

  // 16. Fuente legacy marcada SOURCE_NOT_COMPARABLE
  test('16) currentSource=legacy -> SOURCE_NOT_COMPARABLE aunque la politica resuelva AUTO_RESOLVED', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-16',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'legacy',
      currentSourceRecordId: '458821',
    });

    assert.equal(result.record.resolutionStatus, 'AUTO_RESOLVED');
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.SOURCE_NOT_COMPARABLE);
  });

  // 17. Fuente clean comparable
  test('17) currentSource=clean es comparable: coincide en MATCH y difiere en DIFFERENT_TECHNICAL_REPRESENTATIVE', async () => {
    const shadowMatch = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });
    const matchResult = await shadowMatch.evaluateLookupInShadow({
      lookupId: 'cx-17a',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    assert.equal(matchResult.record.comparisonStatus, COMPARISON_STATUS.MATCH);

    const shadowDiff = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });
    const diffResult = await shadowDiff.evaluateLookupInShadow({
      lookupId: 'cx-17b',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '999-otro-fid',
    });
    assert.equal(diffResult.record.comparisonStatus, COMPARISON_STATUS.DIFFERENT_TECHNICAL_REPRESENTATIVE);
  });

  // 18. Modo desactivado no altera respuesta
  test('18) con enabled=false, multiples llamadas jamas afectan el bufer ni el resumen', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: false,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await shadow.evaluateLookupInShadow({
        lookupId: `cx-18-${i}`,
        codigoPredial: CODE_EXACT_NONE,
        currentSource: 'clean',
        currentSourceRecordId: '101',
      });
      assert.equal(result.outcome, SHADOW_OUTCOME.NO_OP);
    }

    assert.equal(shadow.getShadowSummary().totalEvaluations, 0);
    assert.deepEqual(shadow.getShadowEvaluations(), []);
  });

  // 19. Matriz con 549 códigos únicos
  test('19) la matriz productiva contiene exactamente 549 codigos unicos y no vacios', () => {
    const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
    const codes = Object.keys(matrix.entries);
    assert.equal(codes.length, 549);
    assert.equal(new Set(codes).size, 549);
    assert.ok(codes.every((code) => typeof code === 'string' && code.trim().length > 0));
  });

  // 20. Conteos 351/47/151/0
  test('20) los conteos de la matriz coinciden exactamente con 351/47/151/0/549', () => {
    const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
    assert.deepEqual(matrix.counts, {
      AUTO_RESOLVED: 351,
      PENDING_POLICY: 47,
      BLOCKED_REVIEW: 151,
      BLOCKED_CRITICAL: 0,
      total: 549,
    });
  });

  // 21. Los dos casos reclasificados no son críticos
  test('21) los dos casos reclasificados quedan como MATERIAL_CONFLICT, nunca TERRITORIAL_CRITICAL', () => {
    const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
    for (const code of [CODE_ZONE_NORMALIZATION, CODE_MANZANA_ZERO]) {
      const entry = matrix.entries[code];
      assert.equal(entry.geometryStatus, 'MATERIAL_CONFLICT');
      assert.notEqual(entry.attributeStatus, 'TERRITORIAL_CRITICAL');
    }
    assert.equal(matrix.counts.BLOCKED_CRITICAL, 0);
  });

  // 22. Reason codes sin duplicados
  test('22) reasonCodes del registro de telemetria nunca contiene duplicados', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-22',
      codigoPredial: CODE_ZONE_NORMALIZATION,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    const codes = result.record.reasonCodes;
    assert.equal(codes.length, new Set(codes).size);
    assert.ok(codes.includes(REASON_CODE.ZONE_NORMALIZATION_SUSPECT));
    assert.ok(!codes.includes(REASON_CODE.NORMALIZATION_SUSPECT));
  });

  // 23. No se escribe en disco
  test('23) el modulo de sombra no invoca ninguna funcion de escritura en disco', () => {
    const source = readFileSync(MODULE_SOURCE_PATH, 'utf8');
    assert.ok(source.includes('readFileSync'));
    assert.ok(!/writeFileSync|appendFileSync|createWriteStream|fs\.promises\.writeFile|fs\.write\(/.test(source));
  });

  // 24. No se ejecutan SQL de escritura
  test('24) el modulo de sombra no contiene sentencias SQL propias (toda consulta se inyecta via candidateProvider)', () => {
    const source = readFileSync(MODULE_SOURCE_PATH, 'utf8');
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\s+(INTO|TABLE|FROM)?/i.test(source));
    assert.ok(!source.includes('pg'));
    assert.ok(!source.toLowerCase().includes('select '));
  });
});

describe('catastroxResolverShadow — guardas de seguridad local (isLocalSocketRequest)', () => {
  function fakeReq({ remoteAddress, host, xForwardedFor, xForwardedHost } = {}) {
    return {
      socket: { remoteAddress },
      headers: {
        ...(host !== undefined ? { host } : {}),
        ...(xForwardedFor !== undefined ? { 'x-forwarded-for': xForwardedFor } : {}),
        ...(xForwardedHost !== undefined ? { 'x-forwarded-host': xForwardedHost } : {}),
      },
      hostname: host,
    };
  }

  // 1. IPv4 localhost permitido
  test('1) 127.0.0.1 (IPv4 localhost) es aceptado', () => {
    assert.equal(isLocalSocketRequest(fakeReq({ remoteAddress: '127.0.0.1' })), true);
  });

  // 2. IPv6 localhost permitido
  test('2) ::1 (IPv6 localhost) es aceptado', () => {
    assert.equal(isLocalSocketRequest(fakeReq({ remoteAddress: '::1' })), true);
  });

  // 3. IPv4 mapeado en IPv6 permitido
  test('3) ::ffff:127.0.0.1 (IPv4 mapeado en IPv6) es aceptado', () => {
    assert.equal(isLocalSocketRequest(fakeReq({ remoteAddress: '::ffff:127.0.0.1' })), true);
  });

  // 4. Dirección remota externa rechazada
  test('4) una direccion remota externa es rechazada', () => {
    assert.equal(isLocalSocketRequest(fakeReq({ remoteAddress: '203.0.113.5' })), false);
  });

  // 5. Host: localhost con dirección externa rechazado
  test('5) Host: localhost no compensa una direccion remota externa', () => {
    const req = fakeReq({ remoteAddress: '203.0.113.5', host: 'localhost' });
    assert.equal(isLocalSocketRequest(req), false);
  });

  // 6. X-Forwarded-For: 127.0.0.1 con dirección externa rechazado
  test('6) X-Forwarded-For: 127.0.0.1 no compensa una direccion remota externa', () => {
    const req = fakeReq({ remoteAddress: '203.0.113.5', xForwardedFor: '127.0.0.1', xForwardedHost: 'localhost' });
    assert.equal(isLocalSocketRequest(req), false);
  });

  // 7. DELETE externo rechazado
  test('7) la ruta DELETE usa la misma guarda isLocalSocketRequest, por lo que una solicitud externa tambien queda rechazada', () => {
    const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');
    const deleteRouteIndex = routesSource.indexOf("router.delete('/audit/resolver-shadow'");
    assert.ok(deleteRouteIndex >= 0, 'la ruta DELETE /audit/resolver-shadow debe existir');
    const deleteRouteBlock = routesSource.slice(deleteRouteIndex, deleteRouteIndex + 400);
    assert.ok(deleteRouteBlock.includes('isLocalSocketRequest(req)'));
    assert.ok(!deleteRouteBlock.includes('isLocalAuditRequest(req)'));
    // La guarda en si misma ya rechaza direcciones externas (ver caso 4).
    assert.equal(isLocalSocketRequest(fakeReq({ remoteAddress: '203.0.113.5' })), false);
  });

  // 8. El rechazo no expone telemetria
  test('8) en GET y DELETE, la guarda se evalua antes de tocar cualquier telemetria de la sombra', () => {
    const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');

    const getRouteIndex = routesSource.indexOf("router.get('/audit/resolver-shadow'");
    const getRouteEnd = routesSource.indexOf('\n});', getRouteIndex);
    const getRouteBlock = routesSource.slice(getRouteIndex, getRouteEnd);
    const getGuardIndex = getRouteBlock.indexOf('isLocalSocketRequest(req)');
    const getSummaryIndex = getRouteBlock.indexOf('getShadowSummary()');
    const getEvaluationsIndex = getRouteBlock.indexOf('getShadowEvaluations()');
    assert.ok(getGuardIndex >= 0 && getSummaryIndex >= 0 && getEvaluationsIndex >= 0);
    assert.ok(getGuardIndex < getSummaryIndex, 'la guarda debe evaluarse antes de leer el resumen');
    assert.ok(getGuardIndex < getEvaluationsIndex, 'la guarda debe evaluarse antes de leer las evaluaciones');

    const deleteRouteIndex = routesSource.indexOf("router.delete('/audit/resolver-shadow'");
    const deleteRouteEnd = routesSource.indexOf('\n});', deleteRouteIndex);
    const deleteRouteBlock = routesSource.slice(deleteRouteIndex, deleteRouteEnd);
    const deleteGuardIndex = deleteRouteBlock.indexOf('isLocalSocketRequest(req)');
    const clearIndex = deleteRouteBlock.indexOf('clearShadowEvaluations()');
    assert.ok(deleteGuardIndex >= 0 && clearIndex >= 0);
    assert.ok(deleteGuardIndex < clearIndex, 'la guarda debe evaluarse antes de limpiar el bufer');

    // La respuesta de rechazo en si misma nunca incluye evaluations/summary.
    const rejectionBodyMatch = routesSource.slice(getRouteIndex, getRouteIndex + 400).match(/res\.status\(404\)\.json\(\{[\s\S]*?\}\);/);
    assert.ok(rejectionBodyMatch, 'debe existir un cuerpo de rechazo 404 explicito');
    assert.ok(!rejectionBodyMatch[0].includes('evaluations'));
    assert.ok(!rejectionBodyMatch[0].includes('summary'));
  });
});

describe('catastroxResolverShadow — matriz: validacion de arranque y degradacion segura (FASE 2)', () => {
  // 9. La matriz real de produccion pasa la validacion de arranque
  test('9) validateResolutionMatrixShape acepta la matriz real de produccion sin lanzar', () => {
    assert.doesNotThrow(() => validateResolutionMatrixShape(REAL_MATRIX));
  });

  // 10. Cantidad de entradas distinta de 549
  test('10) rechaza una matriz con una cantidad de entradas distinta de 549', () => {
    const bad = JSON.parse(JSON.stringify(REAL_MATRIX));
    delete bad.entries[Object.keys(bad.entries)[0]];
    assert.throws(() => validateResolutionMatrixShape(bad));
  });

  // 11. Conteos declarados que no coinciden
  test('11) rechaza una matriz cuyos counts declarados no coinciden con las entradas', () => {
    const bad = JSON.parse(JSON.stringify(REAL_MATRIX));
    bad.counts.AUTO_RESOLVED += 1;
    assert.throws(() => validateResolutionMatrixShape(bad));
  });

  // 12. geometryStatus/attributeStatus desconocido
  test('12) rechaza una entrada con geometryStatus o attributeStatus desconocido', () => {
    const badGeometry = JSON.parse(JSON.stringify(REAL_MATRIX));
    const firstCode = Object.keys(badGeometry.entries)[0];
    badGeometry.entries[firstCode].geometryStatus = 'NOT_A_REAL_STATUS';
    assert.throws(() => validateResolutionMatrixShape(badGeometry));

    const badAttribute = JSON.parse(JSON.stringify(REAL_MATRIX));
    const secondCode = Object.keys(badAttribute.entries)[0];
    badAttribute.entries[secondCode].attributeStatus = 'NOT_A_REAL_ATTRIBUTE';
    assert.throws(() => validateResolutionMatrixShape(badAttribute));
  });

  // 13. Campo no permitido en una entrada (ej. coordenadas filtradas por error)
  test('13) rechaza una entrada con un campo no permitido (ej. lat/lng filtrados por error)', () => {
    const bad = JSON.parse(JSON.stringify(REAL_MATRIX));
    const firstCode = Object.keys(bad.entries)[0];
    bad.entries[firstCode].lat = 1.23;
    assert.throws(() => validateResolutionMatrixShape(bad));
  });

  // 14. Archivo inexistente
  test('14) loadResolutionMatrixFromFile con archivo inexistente devuelve {ok:false} sin lanzar', () => {
    const result = loadResolutionMatrixFromFile(path.join(os.tmpdir(), 'no-existe-catastrox-matrix.json'));
    assert.equal(result.ok, false);
    assert.equal(result.matrix, null);
    assert.equal(result.error.code, MATRIX_ERROR_CODE.MATRIX_LOAD_ERROR);
  });

  // 15. JSON invalido
  test('15) loadResolutionMatrixFromFile con JSON invalido devuelve {ok:false} sin lanzar, sin volcar contenido', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'catastrox-matrix-test-'));
    const filePath = path.join(dir, 'matriz-invalida.json');
    writeFileSync(filePath, '{ esto no es JSON valido', 'utf8');
    try {
      const result = loadResolutionMatrixFromFile(filePath);
      assert.equal(result.ok, false);
      assert.equal(result.matrix, null);
      assert.equal(result.error.code, MATRIX_ERROR_CODE.MATRIX_LOAD_ERROR);
      assert.ok(!result.error.message.includes('esto no es JSON'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 16. Degradacion segura: matriz invalida -> sombra desactivada, sin consultas, error visible
  test('16) con matrixResult invalido, la sombra queda enabled=false, NO_OP siempre y expone errorCode', async () => {
    let providerCalls = 0;
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: async () => {
        providerCalls += 1;
        return [];
      },
      matrixResult: {
        ok: false,
        matrix: null,
        error: { code: MATRIX_ERROR_CODE.MATRIX_LOAD_ERROR, message: 'matriz invalida (prueba)' },
      },
    });

    const result = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-16',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    assert.equal(result.outcome, SHADOW_OUTCOME.NO_OP);
    assert.equal(providerCalls, 0);

    const summary = shadow.getShadowSummary();
    assert.equal(summary.enabled, false);
    assert.equal(summary.matrixError.code, MATRIX_ERROR_CODE.MATRIX_LOAD_ERROR);
    assert.equal(summary.matrixVersion, null);
    assert.equal(summary.matrixCounts, null);
  });

  // 17. createCatastroxResolverShadow nunca lanza, incluso con matrixResult invalido
  // (garantiza que /lookup y el resto de rutas sigan arrancando sin excepcion)
  test('17) createCatastroxResolverShadow no lanza excepcion con un matrixResult invalido', () => {
    assert.doesNotThrow(() => {
      createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: async () => [],
        matrixResult: { ok: false, matrix: null, error: { code: 'X', message: 'x' } },
      });
    });
  });
});

describe('catastroxResolverShadow — disparo asincrono desde /lookup (FASE 3)', () => {
  // 18. scheduleResolverShadowEvaluation retorna sincronamente
  test('18) scheduleResolverShadowEvaluation retorna de inmediato, antes de que la evaluacion sombra corra', async () => {
    const order = [];
    const slowShadow = {
      evaluateLookupInShadow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('shadow-evaluated');
        return { outcome: SHADOW_OUTCOME.EVALUATED };
      },
    };

    const returnValue = scheduleResolverShadowEvaluation(slowShadow, { codigoPredial: 'x' });
    order.push('response-already-sent');

    assert.equal(returnValue, undefined);
    assert.deepEqual(order, ['response-already-sent']);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(order, ['response-already-sent', 'shadow-evaluated']);
  });

  // 19. Proveedor lento no retrasa el disparo
  test('19) un proveedor artificialmente lento no bloquea ni retrasa scheduleResolverShadowEvaluation', async () => {
    const startedAt = Date.now();
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return [{ source: 'clean', sourceRecordId: '101' }];
      },
    });

    scheduleResolverShadowEvaluation(shadow, {
      lookupId: 'cx-19',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });
    const elapsedAfterSchedule = Date.now() - startedAt;

    assert.ok(elapsedAfterSchedule < 20, 'scheduleResolverShadowEvaluation debe retornar casi instantaneamente');
  });

  // 20. Proveedor que lanza sincronamente no genera unhandledRejection
  test('20) un proveedor que lanza sincronamente no produce unhandledRejection', async () => {
    let unhandled = null;
    const onUnhandledRejection = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: () => {
          throw new Error('fallo sincronico simulado del proveedor');
        },
      });

      scheduleResolverShadowEvaluation(shadow, {
        lookupId: 'cx-20',
        codigoPredial: CODE_EXACT_NONE,
        currentSource: 'clean',
        currentSourceRecordId: '101',
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(unhandled, null);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  // 21. Proveedor que rechaza la promesa no genera unhandledRejection
  test('21) un proveedor que rechaza su promesa no produce unhandledRejection', async () => {
    let unhandled = null;
    const onUnhandledRejection = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: async () => {
          throw new Error('rechazo asincronico simulado del proveedor');
        },
      });

      scheduleResolverShadowEvaluation(shadow, {
        lookupId: 'cx-21',
        codigoPredial: CODE_EXACT_NONE,
        currentSource: 'clean',
        currentSourceRecordId: '101',
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(unhandled, null);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  // 22. Nunca se usa await sobre evaluateLookupInShadow dentro de routes.js
  test('22) routes.js jamas espera (await) la evaluacion sombra ni retorna su resultado', () => {
    const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');
    assert.ok(!/await\s+[\w.]*evaluateLookupInShadow/.test(routesSource));
    assert.ok(!/return\s+[\w.]*evaluateLookupInShadow/.test(routesSource));
    assert.ok(!/res\.\w+\([^)]*evaluateLookupInShadow/.test(routesSource));
  });

  // 23. scheduleResolverShadowEvaluation se dispara despues de res.json en ambas ramas de /lookup
  test('23) en ambas ramas de /lookup, scheduleResolverShadowEvaluation ocurre despues de res.json(...)', () => {
    const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');
    const lookupRouteIndex = routesSource.indexOf("router.post('/lookup'");
    assert.ok(lookupRouteIndex >= 0);

    const scheduleCalls = [];
    const scheduleRegex = /scheduleResolverShadowEvaluation\(resolverShadow,/g;
    let match;
    while ((match = scheduleRegex.exec(routesSource)) !== null) {
      scheduleCalls.push(match.index);
    }
    assert.equal(scheduleCalls.length, 2, 'se esperan exactamente dos disparos dentro de /lookup (legacy y clean)');

    for (const scheduleIndex of scheduleCalls) {
      const precedingSource = routesSource.slice(lookupRouteIndex, scheduleIndex);
      const lastResJsonIndex = precedingSource.lastIndexOf('res.json(');
      assert.ok(lastResJsonIndex >= 0, 'debe existir un res.json(...) antes de cada disparo');
      // Ninguna mutacion de res, lookupId ni del objeto de respuesta entre res.json y el disparo.
      const between = precedingSource.slice(lastResJsonIndex);
      assert.ok(!/res\s*=|lookupId\s*=|res\.json\([^)]*evaluateLookupInShadow/.test(between));
    }
  });
});

describe('catastroxResolverShadow — privacidad (FASE 5)', () => {
  // 24. Grep de privacidad sobre ambos archivos productivos del modo sombra
  test('24) ni catastroxResolverShadow.js ni routes.js contienen escrituras a disco, SQL de escritura, ni console.log (metodo HTTP DELETE excluido)', () => {
    const shadowSource = readFileSync(MODULE_SOURCE_PATH, 'utf8');
    const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');

    for (const [label, source] of [['catastroxResolverShadow.js', shadowSource], ['routes/catastrox.js', routesSource]]) {
      assert.ok(!/writeFile|appendFile/i.test(source), `${label} no debe escribir en disco`);
      assert.ok(!/console\.log/.test(source), `${label} no debe usar console.log`);
      assert.ok(!/\bINSERT\s+INTO\b/i.test(source), `${label} no debe contener INSERT INTO`);
      assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(source), `${label} no debe contener UPDATE ... SET`);
      assert.ok(!/\bDELETE\s+FROM\b/i.test(source), `${label} no debe contener la sentencia SQL DELETE FROM`);
    }

    // El metodo HTTP DELETE (router.delete(...)) es legitimo y distinto de la
    // sentencia SQL "DELETE FROM" verificada arriba.
    assert.ok(routesSource.includes("router.delete('/audit/resolver-shadow'"));
  });

  // 25. La telemetria nunca contiene lat/lng, GeoJSON ni WKT/WKB
  test('25) un registro de telemetria real no contiene lat, lng, geojson ni WKT/WKB', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: async () => [{ source: 'clean', sourceRecordId: '101' }],
    });

    const { record } = await shadow.evaluateLookupInShadow({
      lookupId: 'cx-25',
      codigoPredial: CODE_EXACT_NONE,
      currentSource: 'clean',
      currentSourceRecordId: '101',
    });

    const serialized = JSON.stringify(record).toLowerCase();
    for (const forbidden of ['"lat"', '"lng"', 'geojson', 'polygon', 'multipolygon', 'point(']) {
      assert.ok(!serialized.includes(forbidden), `el registro no debe contener "${forbidden}"`);
    }
  });
});
