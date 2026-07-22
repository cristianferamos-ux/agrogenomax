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
  SHADOW_REASON_CODE,
  CROSS_SOURCE_RELATION_STATUS,
  MAX_ALTERNATE_CANDIDATES,
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
  'alternateSource',
  'alternateCodeCount',
  'alternateRecordCount',
  'alternateCandidates',
  'alternateCandidatesTruncated',
  'crossSourceProbeTruncated',
  'relationStatus',
]);

const CODE_LEGACY_UNCLASSIFIED = '999999999999999999999999999998';

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
      assert.ok(!/^lat$|^lng$|coord/i.test(key), `la clave "${key}" sugiere una coordenada`);
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

describe('catastroxResolverShadow — divergencia legacy/clean, contrato POR CODIGO (V1.1)', () => {
  function probeReturning(result) {
    return async () => result;
  }

  function probeCallCounting(result) {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return result;
    };
    fn.getCallCount = () => calls;
    return fn;
  }

  const LEGACY_INPUT_BASE = {
    lookupId: 'cx-v11c-1',
    codigoPredial: CODE_LEGACY_UNCLASSIFIED,
    currentSource: 'legacy',
    currentSourceRecordId: '11732',
    lat: 1.5,
    lng: -75.5,
  };

  // 1. Un codigo con una fila
  test('1) un codigo con una sola fila -> alternateCodeCount=1, alternateRecordCount=1, sourceRecordIds con un elemento', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }],
        totalCodeCount: 1,
        totalRecordCount: 1,
        queryResultTruncated: false,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.SOURCE_CODE_DIVERGENCE);
    assert.equal(result.record.alternateCodeCount, 1);
    assert.equal(result.record.alternateRecordCount, 1);
    assert.deepEqual([...result.record.alternateCandidates], [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }]);
    assert.equal(result.record.crossSourceProbeTruncated, false);
    assert.equal(result.record.resolutionStatus, null);
  });

  // 2. Un codigo con varias filas
  test('2) un unico codigo con varias filas fisicas -> alternateCodeCount=1 pero alternateRecordCount=cantidad de filas, todas agrupadas en sourceRecordIds', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['20', '10', '15'] }],
        totalCodeCount: 1,
        totalRecordCount: 3,
        queryResultTruncated: false,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.alternateCodeCount, 1);
    assert.equal(result.record.alternateRecordCount, 3);
    assert.equal(result.record.alternateCandidates.length, 1);
    // ordenados deterministicamente (numericamente, al ser fids)
    assert.deepEqual([...result.record.alternateCandidates[0].sourceRecordIds], ['10', '15', '20']);
    assert.notEqual(result.record.relationStatus, CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES);
  });

  // 3. Dos codigos con varias filas
  test('3) dos codigos distintos, cada uno con varias filas -> alternateCodeCount=2, cada candidato conserva todos sus sourceRecordIds', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [
          { codigoPredial: '999000000000000000000000000002', sourceRecordIds: ['21', '20'] },
          { codigoPredial: '999000000000000000000000000001', sourceRecordIds: ['11', '10', '12'] },
        ],
        totalCodeCount: 2,
        totalRecordCount: 5,
        queryResultTruncated: false,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.alternateCodeCount, 2);
    assert.equal(result.record.alternateRecordCount, 5);
    assert.deepEqual([...result.record.alternateCandidates], [
      { codigoPredial: '999000000000000000000000000001', sourceRecordIds: ['10', '11', '12'] },
      { codigoPredial: '999000000000000000000000000002', sourceRecordIds: ['20', '21'] },
    ]);
  });

  // 4. Identificadores repetidos
  test('4) identificadores tecnicos repetidos dentro del mismo codigo se deduplican', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [
          { codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['10', '10', '20', '20', '20'] },
        ],
        relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.deepEqual([...result.record.alternateCandidates[0].sourceRecordIds], ['10', '20']);
  });

  // 5. Orden SQL diferente
  test('5) el mismo conjunto de codigos/identificadores en distinto orden de llegada produce telemetria identica', async () => {
    const shadowA = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [
          { codigoPredial: '999000000000000000000000000002', sourceRecordIds: ['20', '21'] },
          { codigoPredial: '999000000000000000000000000001', sourceRecordIds: ['12', '10'] },
        ],
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });
    const shadowB = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [
          { codigoPredial: '999000000000000000000000000001', sourceRecordIds: ['10', '12'] },
          { codigoPredial: '999000000000000000000000000002', sourceRecordIds: ['21', '20'] },
        ],
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });

    const resultA = await shadowA.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    const resultB = await shadowB.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.deepEqual([...resultA.record.alternateCandidates], [...resultB.record.alternateCandidates]);
  });

  // 6. Ningun uso de MIN(fid)
  test('6) el sondeo real no usa MIN(fid), MAX(fid) ni ninguna seleccion arbitraria de un unico identificador', () => {
    const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');
    // Se excluyen las lineas de comentario (// ...), que documentan a
    // proposito por que NO se usa MIN/MAX, para no generar un falso positivo
    // contra el propio texto explicativo.
    const codeOnly = routesSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(!/min\s*\(\s*p?\.?fid\s*\)/i.test(codeOnly), 'no debe usar MIN(fid)');
    assert.ok(!/max\s*\(\s*p?\.?fid\s*\)/i.test(codeOnly), 'no debe usar MAX(fid)');
    assert.ok(/array_agg\s*\(\s*fid/i.test(codeOnly), 'debe agrupar todos los fid con array_agg');
  });

  // 7. Conteo de codigos correcto
  test('7) alternateCodeCount refleja el totalCodeCount real informado por el sondeo, no solo lo devuelto en el arreglo', async () => {
    const rawCandidates = Array.from({ length: 5 }, (_, i) => ({
      codigoPredial: `99900000000000000000000000${String(i).padStart(4, '0')}`,
      sourceRecordIds: [String(i)],
    }));
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: rawCandidates,
        totalCodeCount: 5,
        totalRecordCount: 5,
        queryResultTruncated: false,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });
    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.alternateCodeCount, 5);
  });

  // 8. Conteo de registros correcto
  test('8) alternateRecordCount refleja el totalRecordCount real informado por el sondeo (suma de filas, no de codigos)', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [
          { codigoPredial: '999000000000000000000000000001', sourceRecordIds: ['1', '2', '3'] },
          { codigoPredial: '999000000000000000000000000002', sourceRecordIds: ['4'] },
        ],
        totalCodeCount: 2,
        totalRecordCount: 4,
        queryResultTruncated: false,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });
    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.alternateCodeCount, 2);
    assert.equal(result.record.alternateRecordCount, 4);
  });

  // 9. Limite SQL alcanzado
  test('9) queryResultTruncated=true fuerza relationStatus=MULTIPLE_CLEAN_CODES y marca crossSourceProbeTruncated, aunque el sondeo autoreporte otra cosa', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }],
        totalCodeCount: 250,
        totalRecordCount: 400,
        queryResultTruncated: true,
        // Inconsistencia deliberada: el sondeo dice DIFFERENT_CODE, pero el
        // propio truncamiento demuestra que hay mas de un codigo — el modulo
        // debe corregirlo, nunca confiar ciegamente.
        relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.relationStatus, CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES);
    assert.equal(result.record.crossSourceProbeTruncated, true);
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.SOURCE_CODE_DIVERGENCE);
    assert.equal(result.record.resolutionStatus, null);
  });

  // 10. Conteo total mayor que resultados devueltos
  test('10) alternateCodeCount puede ser mayor que la cantidad de candidatos almacenados en el registro', async () => {
    const rawCandidates = Array.from({ length: 15 }, (_, i) => ({
      codigoPredial: `99900000000000000000000000${String(i).padStart(4, '0')}`,
      sourceRecordIds: [String(i)],
    }));
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: rawCandidates,
        totalCodeCount: 250,
        totalRecordCount: 250,
        queryResultTruncated: true,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });
    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.alternateCodeCount, 250);
    assert.ok(result.record.alternateCandidates.length < result.record.alternateCodeCount);
    assert.equal(result.record.alternateCandidates.length, MAX_ALTERNATE_CANDIDATES);
    assert.equal(result.record.crossSourceProbeTruncated, true);
  });

  // 11. Truncamiento de telemetria a 10 codigos
  test('11) mas de MAX_ALTERNATE_CANDIDATES codigos (sin truncamiento SQL) activa alternateCandidatesTruncated=true en la capa de telemetria', async () => {
    const manyCandidates = Array.from({ length: MAX_ALTERNATE_CANDIDATES + 3 }, (_, i) => ({
      codigoPredial: `99900000000000000000000000${String(i).padStart(4, '0')}`,
      sourceRecordIds: [String(i)],
    }));
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: manyCandidates,
        totalCodeCount: manyCandidates.length,
        totalRecordCount: manyCandidates.length,
        queryResultTruncated: false, // el SQL devolvio todo; el truncamiento es solo de telemetria
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });
    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.crossSourceProbeTruncated, false);
    assert.equal(result.record.alternateCandidatesTruncated, true);
    assert.equal(result.record.alternateCandidates.length, MAX_ALTERNATE_CANDIDATES);
    assert.equal(result.record.alternateCodeCount, manyCandidates.length);
  });

  // 12. Ninguna seleccion oficial
  test('12) ningun candidato ni identificador se elige como "el" oficial; no existen campos singulares', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [
          { codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531', '2532'] },
          { codigoPredial: CODE_MATERIAL_CONFLICT, sourceRecordIds: ['1230'] },
        ],
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.codigoPredial, CODE_LEGACY_UNCLASSIFIED);
    assert.ok(!('alternateCodigoPredial' in result.record));
    assert.ok(!('alternateSourceRecordId' in result.record));
    assert.ok(!('sourceRecordId' in result.record.alternateCandidates[0]));
  });

  // 13. Arreglos profundamente inmutables
  test('13) alternateCandidates y cada sourceRecordIds estan profundamente congelados', async () => {
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531', '2532'] }],
        relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.throws(() => { result.record.alternateCandidates.push({ codigoPredial: 'x', sourceRecordIds: [] }); }, TypeError);
    assert.throws(() => { result.record.alternateCandidates[0].codigoPredial = 'INTRUSO'; }, TypeError);
    assert.throws(() => { result.record.alternateCandidates[0].sourceRecordIds.push('999'); }, TypeError);
    assert.throws(() => { result.record.alternateCandidates[0].sourceRecordIds[0] = 'INTRUSO'; }, TypeError);
  });

  // 14. Los tres casos forenses conservan SOURCE_CODE_DIVERGENCE
  test('14) los tres codigos del diagnostico forense conservan SOURCE_CODE_DIVERGENCE bajo el contrato por codigo', async () => {
    // Formas confirmadas por consulta de solo lectura real (array_agg + count/sum
    // over(), ver FASE 6 / informe): los tres puntos tienen mas de un
    // codigo_predial clean distinto, cada uno con exactamente un fid en esta
    // muestra real.
    const forensicCases = [
      {
        legacyCodigo: '185920002000000020343000000000',
        alternateCandidates: [
          { codigoPredial: '185920002000000020113000000000', sourceRecordIds: ['22967'] },
          { codigoPredial: '185920002000000020343000000000', sourceRecordIds: ['23548'] },
        ],
      },
      {
        legacyCodigo: '187530001000000390053000000000',
        alternateCandidates: [
          { codigoPredial: '187530001000000390052000000000', sourceRecordIds: ['35104'] },
          { codigoPredial: '187530001000000390053000000000', sourceRecordIds: ['35174'] },
        ],
      },
      {
        legacyCodigo: '185920001000000110195000000000',
        alternateCandidates: [
          { codigoPredial: '185920001000000110000000000000', sourceRecordIds: ['23606'] },
          { codigoPredial: '185920001000000110195000000000', sourceRecordIds: ['23631'] },
          { codigoPredial: '185920601000000040004000000000', sourceRecordIds: ['68610'] },
        ],
      },
    ];

    for (const { legacyCodigo, alternateCandidates } of forensicCases) {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({
          found: true,
          alternateSource: 'clean',
          alternateCandidates,
          totalCodeCount: alternateCandidates.length,
          totalRecordCount: alternateCandidates.length,
          queryResultTruncated: false,
          relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
        }),
      });
      const result = await shadow.evaluateLookupInShadow({
        lookupId: `cx-forensic-${legacyCodigo}`,
        codigoPredial: legacyCodigo,
        currentSource: 'legacy',
        currentSourceRecordId: '1',
        lat: 1.5,
        lng: -75.5,
      });
      assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.SOURCE_CODE_DIVERGENCE);
      assert.equal(result.record.resolutionStatus, null);
      assert.equal(result.record.errorCode, null);
      assert.equal(result.record.alternateCodeCount, alternateCandidates.length);
    }
  });

  // 15. La muestra conserva los conteos esperados (verificacion estructural
  // reducida; la validacion literal de 47+3+10/0/0 sobre las 60 consultas
  // reales se ejecuta en FASE 6 contra el servidor real, ver informe).
  test('15) el resumen agrega evaluaciones de politica y divergencias como resultados "clasificables" separados de NOT_APPLICABLE', async () => {
    let probeCalls = 0;
    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: async () => {
        probeCalls += 1;
        return {
          found: true,
          alternateSource: 'clean',
          alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }],
          totalCodeCount: 1,
          totalRecordCount: 1,
          queryResultTruncated: false,
          relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE,
        };
      },
    });

    await shadow.evaluateLookupInShadow({ lookupId: 'cx-15a', codigoPredial: CODE_EXACT_NONE, currentSource: 'clean', currentSourceRecordId: '101' });
    await shadow.evaluateLookupInShadow({ lookupId: 'cx-15b', codigoPredial: CODE_MATERIAL_CONFLICT, currentSource: 'legacy', currentSourceRecordId: '202' });
    await shadow.evaluateLookupInShadow({ lookupId: 'cx-15c', codigoPredial: CODE_LEGACY_UNCLASSIFIED, currentSource: 'legacy', currentSourceRecordId: '303', lat: 1.1, lng: -75.1 });
    const notApplicableResult = await shadow.evaluateLookupInShadow({ lookupId: 'cx-15d', codigoPredial: CODE_NOT_CLASSIFIED, currentSource: 'clean', currentSourceRecordId: '404' });

    assert.equal(notApplicableResult.outcome, SHADOW_OUTCOME.NOT_APPLICABLE);
    assert.equal(probeCalls, 1);

    const summary = shadow.getShadowSummary();
    assert.equal(summary.totalEvaluations, 3);
    assert.equal(summary.byComparisonStatus[COMPARISON_STATUS.SOURCE_CODE_DIVERGENCE], 1);
  });

  // FASE 2 (cierre reproducible V1.1): reproduce exactamente la relacion
  // aritmetica que produce crossSourceCleanProbe cuando el limite operativo
  // de la consulta SQL (CROSS_SOURCE_PROBE_QUERY_LIMIT=200) se alcanza: 250
  // codigos distintos existen en total, pero la consulta solo puede devolver
  // 200 filas (una por codigo, por el LIMIT). totalCodeCount se calculo con
  // count(*) over() ANTES del LIMIT, por lo que sigue siendo 250 aunque
  // returnedCodeCount sea 200 — exactamente el mismo calculo que hace
  // routes.js: queryResultTruncated = totalCodeCount > returnedCodeCount.
  test('FASE2) limite SQL de 200 alcanzado con 250 codigos reales: returnedCodeCount=200, totalCodeCount=250 se preserva, queryResultTruncated=true', async () => {
    const returnedCodeCount = 200;
    const totalCodeCount = 250;
    const returnedRows = Array.from({ length: returnedCodeCount }, (_, i) => ({
      codigoPredial: `99900000000000000000000000${String(i).padStart(4, '0')}`,
      sourceRecordIds: [String(i)],
    }));
    // Misma formula que routes.js: queryResultTruncated = totalCodeCount > returnedCodeCount.
    const queryResultTruncated = totalCodeCount > returnedRows.length;
    assert.equal(queryResultTruncated, true);

    const shadow = createCatastroxResolverShadow({
      enabled: true,
      candidateProvider: providerReturning(ONLY_CANDIDATE),
      crossSourceProbe: probeReturning({
        found: true,
        alternateSource: 'clean',
        alternateCandidates: returnedRows,
        totalCodeCount,
        totalRecordCount: totalCodeCount,
        queryResultTruncated,
        relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
      }),
    });

    const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
    assert.equal(result.record.alternateCodeCount, 250);
    assert.equal(result.record.crossSourceProbeTruncated, true);
    // La telemetria conserva solo 10 codigos en el bufer, pero el conteo total sigue siendo 250.
    assert.equal(result.record.alternateCandidates.length, MAX_ALTERNATE_CANDIDATES);
    assert.equal(result.record.alternateCandidatesTruncated, true);
    assert.equal(result.record.relationStatus, CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES);
    assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.SOURCE_CODE_DIVERGENCE);
  });

  // Cobertura adicional heredada (SAME_CODE, NO_CLEAN_MATCH, errores del
  // sondeo, flag apagado, sin unhandledRejection, reasonCodes sin duplicados)
  // — sigue siendo relevante bajo el nuevo contrato por codigo.
  describe('casos adicionales de la maquina de estados', () => {
    test('SAME_CODE -> NOT_APPLICABLE (el codigo, por definicion de esta rama, no esta clasificado)', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({
          found: true,
          alternateSource: 'clean',
          alternateCandidates: [{ codigoPredial: CODE_LEGACY_UNCLASSIFIED, sourceRecordIds: ['999'] }],
          totalCodeCount: 1,
          totalRecordCount: 1,
          queryResultTruncated: false,
          relationStatus: CROSS_SOURCE_RELATION_STATUS.SAME_CODE,
        }),
      });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      assert.equal(result.outcome, SHADOW_OUTCOME.NOT_APPLICABLE);
      assert.deepEqual(shadow.getShadowEvaluations(), []);
    });

    test('NO_CLEAN_MATCH -> NOT_APPLICABLE', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({ found: false, alternateSource: null, alternateCandidates: [], totalCodeCount: 0, totalRecordCount: 0, queryResultTruncated: false, relationStatus: CROSS_SOURCE_RELATION_STATUS.NO_CLEAN_MATCH }),
      });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      assert.equal(result.outcome, SHADOW_OUTCOME.NOT_APPLICABLE);
      assert.deepEqual(shadow.getShadowEvaluations(), []);
    });

    test('crossSourceProbe que lanza -> EVALUATION_ERROR aislado con errorCode CROSS_SOURCE_PROBE_ERROR', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: async () => { throw new Error('fallo simulado de sondeo cruzado'); },
      });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.EVALUATION_ERROR);
      assert.equal(result.record.errorCode, SHADOW_ERROR_CODE.CROSS_SOURCE_PROBE_ERROR);
      assert.equal(result.record.resolutionStatus, null);
    });

    test('relationStatus=PROBE_ERROR devuelto (sin lanzar) tambien produce EVALUATION_ERROR aislado, incluso si queryResultTruncated=true', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({ found: false, alternateSource: null, alternateCandidates: [], queryResultTruncated: true, relationStatus: CROSS_SOURCE_RELATION_STATUS.PROBE_ERROR }),
      });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      assert.equal(result.record.comparisonStatus, COMPARISON_STATUS.EVALUATION_ERROR);
      assert.equal(result.record.errorCode, SHADOW_ERROR_CODE.CROSS_SOURCE_PROBE_ERROR);
    });

    test('con enabled=false, crossSourceProbe jamas se invoca', async () => {
      const probe = probeCallCounting({ found: true, alternateSource: 'clean', alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }], relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE });
      const shadow = createCatastroxResolverShadow({ enabled: false, candidateProvider: providerReturning(ONLY_CANDIDATE), crossSourceProbe: probe });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      assert.equal(result.outcome, SHADOW_OUTCOME.NO_OP);
      assert.equal(probe.getCallCount(), 0);
    });

    test('routes.js reutiliza las variables lat/lng ya parseadas, nunca vuelve a leer req.body dentro del disparo asincrono', () => {
      const routesSource = readFileSync(ROUTES_SOURCE_PATH, 'utf8');
      const scheduleBlocks = routesSource.split('scheduleResolverShadowEvaluation(resolverShadow,').slice(1);
      assert.ok(scheduleBlocks.length >= 1);
      for (const block of scheduleBlocks) {
        const snippet = block.slice(0, 300);
        assert.ok(!/req\.body/.test(snippet), 'el disparador no debe releer req.body');
      }
    });

    test('reasonCodes de un registro de divergencia nunca contienen duplicados', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({ found: true, alternateSource: 'clean', alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }], relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE }),
      });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      const codes = [...result.record.reasonCodes];
      assert.equal(codes.length, new Set(codes).size);
    });

    test('un crossSourceProbe que rechaza, disparado via scheduleResolverShadowEvaluation, no produce unhandledRejection', async () => {
      let unhandled = null;
      const onUnhandledRejection = (reason) => { unhandled = reason; };
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const shadow = createCatastroxResolverShadow({
          enabled: true,
          candidateProvider: providerReturning(ONLY_CANDIDATE),
          crossSourceProbe: async () => { throw new Error('rechazo simulado del sondeo cruzado'); },
        });
        scheduleResolverShadowEvaluation(shadow, LEGACY_INPUT_BASE);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(unhandled, null);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });

    test('coordenadas y geometria nunca aparecen en un registro de divergencia (regresion)', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({ found: true, alternateSource: 'clean', alternateCandidates: [{ codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] }], relationStatus: CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE }),
      });
      const result = await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      const keys = Object.keys(result.record);
      assert.deepEqual(new Set(keys), ALLOWED_RECORD_KEYS);
      assert.ok(!keys.some((k) => /^lat$|^lng$|coord/i.test(k)));
      const serialized = JSON.stringify(result.record).toLowerCase();
      for (const forbidden of ['geojson', 'polygon', 'multipolygon', 'point(', 'wkt', 'wkb']) {
        assert.ok(!serialized.includes(forbidden));
      }
    });

    test('getShadowEvaluations() expone el mismo arreglo completo de candidatos que el endpoint local', async () => {
      const shadow = createCatastroxResolverShadow({
        enabled: true,
        candidateProvider: providerReturning(ONLY_CANDIDATE),
        crossSourceProbe: probeReturning({
          found: true,
          alternateSource: 'clean',
          alternateCandidates: [
            { codigoPredial: CODE_EXACT_NONE, sourceRecordIds: ['2531'] },
            { codigoPredial: CODE_MATERIAL_CONFLICT, sourceRecordIds: ['1230', '1231'] },
          ],
          relationStatus: CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES,
        }),
      });
      await shadow.evaluateLookupInShadow(LEGACY_INPUT_BASE);
      const exposed = shadow.getShadowEvaluations();
      assert.equal(exposed.length, 1);
      assert.equal(exposed[0].alternateCandidates.length, 2);
      assert.deepEqual(new Set(Object.keys(exposed[0])), ALLOWED_RECORD_KEYS);
    });
  });
});
