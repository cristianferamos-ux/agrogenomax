// Servicio de "modo sombra" del resolver de duplicados catastrales.
//
// Ejecuta la politica de resolucion (catastroxResolutionPolicy.js) en paralelo
// al flujo real de /lookup, unicamente con fines de observacion. Este servicio
// nunca tiene autoridad sobre la respuesta que ya se envio al cliente: no la
// modifica, no la retrasa y cualquier error queda aislado dentro de este modulo.
//
// No importa Express, no abre conexiones a PostgreSQL y no depende de
// audit_outputs/ en tiempo de ejecucion: la clasificacion se carga una sola vez
// desde el archivo productivo versionado
// server/data/catastrox/catastroxDuplicateResolutionMatrix.v1.json. El acceso a
// PostGIS (candidateProvider) se inyecta desde quien instancia el servicio, para
// que este modulo se pueda probar por completo sin base de datos real.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  resolveCatastroxDuplicate,
  GEOMETRY_STATUS,
  ATTRIBUTE_STATUS,
  RESOLUTION_STATUS,
  CatastroxResolverContractError,
} from './catastroxResolutionPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.join(__dirname, '..', '..', 'data', 'catastrox', 'catastroxDuplicateResolutionMatrix.v1.json');
const EXPECTED_MATRIX_ENTRY_COUNT = 549;
const ALLOWED_MATRIX_ENTRY_KEYS = new Set(['geometryStatus', 'attributeStatus', 'reasonCodes']);
const VALID_GEOMETRY_STATUSES = new Set(Object.values(GEOMETRY_STATUS));
const VALID_ATTRIBUTE_STATUSES = new Set(Object.values(ATTRIBUTE_STATUS));

export const SHADOW_OUTCOME = Object.freeze({
  NO_OP: 'NO_OP',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  EVALUATED: 'EVALUATED',
});

export const COMPARISON_STATUS = Object.freeze({
  MATCH: 'MATCH',
  DIFFERENT_TECHNICAL_REPRESENTATIVE: 'DIFFERENT_TECHNICAL_REPRESENTATIVE',
  SOURCE_NOT_COMPARABLE: 'SOURCE_NOT_COMPARABLE',
  PENDING_POLICY: 'PENDING_POLICY',
  CURRENT_FLOW_WOULD_BE_BLOCKED: 'CURRENT_FLOW_WOULD_BE_BLOCKED',
  EVALUATION_ERROR: 'EVALUATION_ERROR',
});

export const SHADOW_ERROR_CODE = Object.freeze({
  RESOLVER_CONTRACT_ERROR: 'RESOLVER_CONTRACT_ERROR',
  RESOLVER_VALIDATION_ERROR: 'RESOLVER_VALIDATION_ERROR',
  CANDIDATE_PROVIDER_ERROR: 'CANDIDATE_PROVIDER_ERROR',
});

export const MATRIX_ERROR_CODE = Object.freeze({
  MATRIX_LOAD_ERROR: 'MATRIX_LOAD_ERROR',
});

// Replica en miniatura, solo para validacion de arranque, la misma precedencia
// de catastroxResolutionPolicy.js (sin invocar candidateProvider ni requerir
// candidatos): permite verificar que los "counts" declarados en el archivo de
// la matriz coinciden con lo que las propias entradas implican, sin acoplar la
// validacion de arranque a I/O externo.
function classifyResolutionStatusForValidation(geometryStatus, attributeStatus) {
  if (attributeStatus === ATTRIBUTE_STATUS.TERRITORIAL_CRITICAL) return RESOLUTION_STATUS.BLOCKED_CRITICAL;
  if (geometryStatus === GEOMETRY_STATUS.MATERIAL_CONFLICT || geometryStatus === GEOMETRY_STATUS.SEPARATE) return RESOLUTION_STATUS.BLOCKED_REVIEW;
  if (attributeStatus === ATTRIBUTE_STATUS.COMMERCIAL_SENSITIVE) return RESOLUTION_STATUS.BLOCKED_REVIEW;
  if (
    geometryStatus === GEOMETRY_STATUS.MINIMAL_VARIATION
    || attributeStatus === ATTRIBUTE_STATUS.COMPLEMENTARY
    || attributeStatus === ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT
  ) return RESOLUTION_STATUS.PENDING_POLICY;
  if (geometryStatus === GEOMETRY_STATUS.EXACT && attributeStatus === ATTRIBUTE_STATUS.NONE) return RESOLUTION_STATUS.AUTO_RESOLVED;
  throw new Error('combinacion no contemplada');
}

// Valida la forma y coherencia interna de la matriz. Lanza un Error con un
// mensaje corto y generico (nunca incluye codigos prediales, conteos parciales
// ni ningun dato de la matriz) si algo no cumple el contrato productivo.
export function validateResolutionMatrixShape(matrix) {
  if (!matrix || typeof matrix !== 'object') throw new Error('forma de matriz invalida');
  if (typeof matrix.version !== 'string' || matrix.version.trim() === '') throw new Error('version de matriz ausente');
  if (!matrix.entries || typeof matrix.entries !== 'object' || Array.isArray(matrix.entries)) {
    throw new Error('entries de matriz ausente o invalido');
  }

  const codes = Object.keys(matrix.entries);
  if (codes.length !== EXPECTED_MATRIX_ENTRY_COUNT) throw new Error('cantidad de entradas de matriz invalida');
  if (new Set(codes).size !== codes.length) throw new Error('codigos de matriz duplicados');
  if (codes.some((code) => !code || !code.trim())) throw new Error('codigo de matriz vacio');

  const computedCounts = { AUTO_RESOLVED: 0, PENDING_POLICY: 0, BLOCKED_REVIEW: 0, BLOCKED_CRITICAL: 0 };

  for (const code of codes) {
    const entry = matrix.entries[code];
    if (!entry || typeof entry !== 'object') throw new Error('entrada de matriz invalida');

    const entryKeys = Object.keys(entry);
    if (entryKeys.some((key) => !ALLOWED_MATRIX_ENTRY_KEYS.has(key))) {
      throw new Error('entrada de matriz contiene un campo no permitido');
    }
    if (!VALID_GEOMETRY_STATUSES.has(entry.geometryStatus)) throw new Error('geometryStatus desconocido en matriz');
    if (!VALID_ATTRIBUTE_STATUSES.has(entry.attributeStatus)) throw new Error('attributeStatus desconocido en matriz');
    if (!Array.isArray(entry.reasonCodes)) throw new Error('reasonCodes de matriz invalido');

    computedCounts[classifyResolutionStatusForValidation(entry.geometryStatus, entry.attributeStatus)] += 1;
  }

  const declaredCounts = matrix.counts;
  if (!declaredCounts || typeof declaredCounts !== 'object') throw new Error('counts de matriz ausente');
  const countsMatch = ['AUTO_RESOLVED', 'PENDING_POLICY', 'BLOCKED_REVIEW', 'BLOCKED_CRITICAL']
    .every((key) => declaredCounts[key] === computedCounts[key]);
  if (!countsMatch || declaredCounts.total !== codes.length) {
    throw new Error('counts de matriz no coinciden con las entradas');
  }
}

// Carga y valida la matriz desde disco. Nunca lanza: cualquier fallo (archivo
// ausente, JSON invalido, forma incoherente) se captura y se resume en un
// codigo de error corto y seguro, sin registrar la matriz completa ni datos de
// predios en ningun log. Esta tolerancia es exclusiva de la carga/validacion
// de este archivo de datos, no de errores de sintaxis del codigo productivo.
export function loadResolutionMatrixFromFile(matrixPath) {
  try {
    const raw = JSON.parse(readFileSync(matrixPath, 'utf8'));
    validateResolutionMatrixShape(raw);
    return { ok: true, matrix: raw, error: null };
  } catch {
    return {
      ok: false,
      matrix: null,
      error: {
        code: MATRIX_ERROR_CODE.MATRIX_LOAD_ERROR,
        message: 'La matriz de clasificacion no supero la validacion de arranque.',
      },
    };
  }
}

// Se carga una unica vez al importar el modulo (archivo estatico versionado, no
// una consulta en tiempo de ejecucion ni una lectura de audit_outputs/).
const DEFAULT_MATRIX_RESULT = loadResolutionMatrixFromFile(MATRIX_PATH);

function classifyShadowError(error) {
  if (error instanceof CatastroxResolverContractError) return SHADOW_ERROR_CODE.RESOLVER_CONTRACT_ERROR;
  if (error instanceof TypeError || error instanceof RangeError) return SHADOW_ERROR_CODE.RESOLVER_VALIDATION_ERROR;
  return SHADOW_ERROR_CODE.CANDIDATE_PROVIDER_ERROR;
}

function technicalKeyOf(source, sourceRecordId) {
  if (!source || sourceRecordId === null || sourceRecordId === undefined || sourceRecordId === '') return null;
  return `${source}::${sourceRecordId}`;
}

// Deriva el estado de comparacion entre lo que el flujo real de /lookup ya
// devolvio (currentSource + currentSourceRecordId) y lo que decidiria la
// politica V1 sobre la misma matriz. Nunca influye en la respuesta real; es
// puramente observacional.
function computeComparisonStatus({ currentSource, currentSourceRecordId, policyResult }) {
  if (policyResult.resolutionStatus === RESOLUTION_STATUS.PENDING_POLICY) {
    return COMPARISON_STATUS.PENDING_POLICY;
  }
  if (
    policyResult.resolutionStatus === RESOLUTION_STATUS.BLOCKED_REVIEW
    || policyResult.resolutionStatus === RESOLUTION_STATUS.BLOCKED_CRITICAL
  ) {
    return COMPARISON_STATUS.CURRENT_FLOW_WOULD_BE_BLOCKED;
  }
  // A partir de aqui, resolutionStatus solo puede ser AUTO_RESOLVED. La matriz
  // se construyo exclusivamente a partir de catastrox_clean.predios, y los
  // candidatos que evalua la politica son siempre de source='clean' (nunca se
  // mezclan candidatos legacy y clean dentro de una misma clase equivalente).
  // Por eso una seleccion actual proveniente de la fuente legacy nunca es
  // comparable contra el representante tecnico elegido por la politica.
  if (currentSource !== 'clean') {
    return COMPARISON_STATUS.SOURCE_NOT_COMPARABLE;
  }

  const selected = policyResult.selectedCandidate;
  const policyKey = selected ? technicalKeyOf(selected.source, selected.sourceRecordId) : null;
  const currentKey = technicalKeyOf(currentSource, currentSourceRecordId);

  if (policyKey && currentKey && policyKey === currentKey) {
    return COMPARISON_STATUS.MATCH;
  }
  return COMPARISON_STATUS.DIFFERENT_TECHNICAL_REPRESENTATIVE;
}

/**
 * Crea una instancia del servicio de modo sombra.
 *
 * @param {object} options
 * @param {boolean} options.enabled - si es false, evaluateLookupInShadow es NO_OP
 *   inmediato y jamas invoca candidateProvider ni el resolver.
 * @param {(codigoPredial: string) => Promise<Array<{source:string, sourceRecordId:string}>>} options.candidateProvider
 *   - inyectado; en produccion consulta unicamente identificadores tecnicos de
 *   catastrox_clean.predios. En pruebas se sustituye por un stub sin PostGIS.
 * @param {number} [options.maxEntries=200] - tamano maximo del bufer circular de
 *   telemetria en memoria.
 * @param {() => number} [options.clock] - inyectable para pruebas deterministas;
 *   por defecto Date.now.
 * @param {{ok: boolean, matrix: object|null, error: object|null}} [options.matrixResult]
 *   - resultado de loadResolutionMatrixFromFile; por defecto, el archivo
 *   productivo real. Inyectable unicamente para pruebas de degradacion segura.
 */
export function createCatastroxResolverShadow({
  enabled,
  candidateProvider,
  maxEntries = 200,
  clock = () => Date.now(),
  matrixResult = DEFAULT_MATRIX_RESULT,
} = {}) {
  let buffer = [];
  // Si la matriz no supero la validacion de arranque, el modo sombra queda
  // forzosamente desactivado sin importar el valor de "enabled": no hay
  // clasificacion valida contra la cual evaluar nada.
  const effectiveEnabled = Boolean(enabled) && matrixResult.ok;
  const matrix = matrixResult.matrix;

  function pushEvaluation(record) {
    buffer.push(record);
    if (buffer.length > maxEntries) {
      buffer = buffer.slice(buffer.length - maxEntries);
    }
  }

  async function evaluateLookupInShadow(input) {
    if (!effectiveEnabled) {
      return { outcome: SHADOW_OUTCOME.NO_OP };
    }

    const { lookupId, codigoPredial, currentSource, currentSourceRecordId } = input || {};
    const matrixEntry = codigoPredial ? matrix.entries[codigoPredial] : undefined;

    if (!matrixEntry) {
      return { outcome: SHADOW_OUTCOME.NOT_APPLICABLE };
    }

    const startedAt = clock();
    let record;

    try {
      const candidates = await candidateProvider(codigoPredial);
      const policyResult = resolveCatastroxDuplicate({
        codigoPredial,
        geometryStatus: matrixEntry.geometryStatus,
        attributeStatus: matrixEntry.attributeStatus,
        candidates,
        reasonCodes: matrixEntry.reasonCodes,
      });
      const evaluationMs = clock() - startedAt;
      const comparisonStatus = computeComparisonStatus({ currentSource, currentSourceRecordId, policyResult });
      const selected = policyResult.selectedCandidate;

      record = {
        timestamp: startedAt,
        matrixVersion: matrix.version,
        lookupId: lookupId ?? null,
        codigoPredial,
        currentSource: currentSource ?? null,
        currentSourceRecordId: currentSourceRecordId ?? null,
        resolutionStatus: policyResult.resolutionStatus,
        candidateSelectionStatus: policyResult.candidateSelectionStatus,
        policySelectedTechnicalKey: selected ? technicalKeyOf(selected.source, selected.sourceRecordId) : null,
        comparisonStatus,
        reasonCodes: [...policyResult.reasonCodes],
        evaluationMs,
        errorCode: null,
      };
    } catch (error) {
      const evaluationMs = clock() - startedAt;
      record = {
        timestamp: startedAt,
        matrixVersion: matrix.version,
        lookupId: lookupId ?? null,
        codigoPredial,
        currentSource: currentSource ?? null,
        currentSourceRecordId: currentSourceRecordId ?? null,
        resolutionStatus: null,
        candidateSelectionStatus: null,
        policySelectedTechnicalKey: null,
        comparisonStatus: COMPARISON_STATUS.EVALUATION_ERROR,
        reasonCodes: [],
        evaluationMs,
        errorCode: classifyShadowError(error),
      };
    }

    pushEvaluation(record);
    return { outcome: SHADOW_OUTCOME.EVALUATED, record };
  }

  function getShadowEvaluations() {
    return buffer.map((record) => ({ ...record, reasonCodes: [...record.reasonCodes] }));
  }

  function clearShadowEvaluations() {
    buffer = [];
  }

  function getShadowSummary() {
    const byComparisonStatus = {};
    const byResolutionStatus = {};
    let errors = 0;

    for (const record of buffer) {
      byComparisonStatus[record.comparisonStatus] = (byComparisonStatus[record.comparisonStatus] || 0) + 1;
      const resolutionKey = record.resolutionStatus || 'NONE';
      byResolutionStatus[resolutionKey] = (byResolutionStatus[resolutionKey] || 0) + 1;
      if (record.errorCode) errors += 1;
    }

    return {
      enabled: effectiveEnabled,
      matrixVersion: matrix ? matrix.version : null,
      matrixCounts: matrix ? { ...matrix.counts } : null,
      matrixError: matrixResult.error,
      totalEvaluations: buffer.length,
      byComparisonStatus,
      byResolutionStatus,
      errors,
    };
  }

  return {
    evaluateLookupInShadow,
    getShadowEvaluations,
    clearShadowEvaluations,
    getShadowSummary,
  };
}
