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
// PostGIS (candidateProvider, crossSourceProbe) se inyecta desde quien
// instancia el servicio, para que este modulo se pueda probar por completo sin
// base de datos real.
//
// V1.1 agrega observabilidad de divergencia legacy/clean: cuando /lookup sirve
// un codigo legacy que no esta en la matriz, este modulo puede (via
// crossSourceProbe, inyectado) verificar si un codigo clean distinto cubre el
// mismo punto, y registrar esa divergencia de forma puramente observacional —
// nunca sustituye el codigo legacy por el clean, y nunca ejecuta la politica
// sobre un codigo que /lookup no sirvio realmente.

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
  // V1.1: /lookup sirvio un codigo legacy no clasificado, y un codigo clean
  // distinto (o mas de uno) cubre el mismo punto. Nunca implica que la
  // politica se haya ejecutado sobre ningun codigo.
  SOURCE_CODE_DIVERGENCE: 'SOURCE_CODE_DIVERGENCE',
});

export const SHADOW_ERROR_CODE = Object.freeze({
  RESOLVER_CONTRACT_ERROR: 'RESOLVER_CONTRACT_ERROR',
  RESOLVER_VALIDATION_ERROR: 'RESOLVER_VALIDATION_ERROR',
  CANDIDATE_PROVIDER_ERROR: 'CANDIDATE_PROVIDER_ERROR',
  CROSS_SOURCE_PROBE_ERROR: 'CROSS_SOURCE_PROBE_ERROR',
});

export const MATRIX_ERROR_CODE = Object.freeze({
  MATRIX_LOAD_ERROR: 'MATRIX_LOAD_ERROR',
});

// Limite operativo de candidatos alternativos que se conservan en un registro
// de telemetria. Es un limite de exhibicion/almacenamiento, no de la consulta
// SQL real (que puede legitimamente devolver mas filas antes de normalizar
// aqui) — ver crossSourceCleanProbe en server/routes/catastrox.js, que ademas
// aplica su propio limite operativo (LIMIT) en la consulta.
export const MAX_ALTERNATE_CANDIDATES = 10;

// Reason codes propios del modo sombra (distintos de REASON_CODE en
// catastroxResolutionPolicy.js, que no se modifica). Describen el resultado
// del sondeo cruzado de fuentes, nunca una decision de la politica.
export const SHADOW_REASON_CODE = Object.freeze({
  SOURCE_CODE_DIVERGENCE: 'SOURCE_CODE_DIVERGENCE',
  MULTIPLE_CLEAN_CODES_AT_LOOKUP_POINT: 'MULTIPLE_CLEAN_CODES_AT_LOOKUP_POINT',
  CROSS_SOURCE_PROBE_ERROR: 'CROSS_SOURCE_PROBE_ERROR',
});

// Valores permitidos de relationStatus devueltos por crossSourceProbe (ver
// contrato en createCatastroxResolverShadow). Este modulo no impone la forma
// de la consulta real — solo interpreta esta salida limitada.
export const CROSS_SOURCE_RELATION_STATUS = Object.freeze({
  SAME_CODE: 'SAME_CODE',
  DIFFERENT_CODE: 'DIFFERENT_CODE',
  NO_CLEAN_MATCH: 'NO_CLEAN_MATCH',
  MULTIPLE_CLEAN_CODES: 'MULTIPLE_CLEAN_CODES',
  PROBE_ERROR: 'PROBE_ERROR',
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

// Ordena identificadores tecnicos de forma deterministica: numericamente
// cuando ambos valores son numeros validos (caso normal: fid de PostGIS),
// lexicograficamente en cualquier otro caso. Nunca decide "cual" identificador
// es representativo — solo fija un orden reproducible para toda la lista.
function compareTechnicalIds(a, b) {
  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Normaliza defensivamente la lista de candidatos alternativos devuelta por
// crossSourceProbe, sin importar que tan "limpia" sea la implementacion
// inyectada: nunca confia ciegamente en el orden, la ausencia de duplicados
// tecnicos, ni el tamano del arreglo recibido.
//
// Contrato por codigo (no por fila): cada entrada de entrada puede traer
// varios identificadores tecnicos (sourceRecordIds) para un mismo
// codigoPredial — nunca se elige uno solo (nunca MIN/MAX/primero). El
// resultado agrupa TODOS los identificadores encontrados para cada codigo:
//
// - Descarta entradas sin codigoPredial valido.
// - Fusiona por codigoPredial: si el mismo codigo aparece en mas de una
//   entrada de entrada, sus sourceRecordIds se combinan en un unico grupo.
// - Elimina identificadores tecnicos duplicados dentro de cada grupo.
// - Ordena los identificadores de cada grupo deterministicamente
//   (ver compareTechnicalIds) — nunca por area, ctid ni orden fisico.
// - Ordena los propios codigos alfabeticamente.
// - Nunca elige un "candidato principal": el resultado es siempre la lista
//   completa de codigos (posiblemente truncada a MAX_ALTERNATE_CANDIDATES
//   codigos, nunca reducida a un unico ganador).
// - Devuelve totalCodeCount/totalRecordCount calculados sobre lo recibido
//   aqui — esto es solo un respaldo defensivo; el conteo real y autoritativo
//   (anterior al limite operativo de la consulta SQL) debe venir del propio
//   crossSourceProbe (totalCodeCount/totalRecordCount), no de este calculo
//   local, que solo ve lo que el probe ya decidio devolver.
function normalizeAlternateCandidates(rawCandidates) {
  const list = Array.isArray(rawCandidates) ? rawCandidates : [];
  const idsByCode = new Map();

  for (const candidate of list) {
    const codigoPredial = candidate?.codigoPredial;
    if (typeof codigoPredial !== 'string' || codigoPredial.trim() === '') continue;
    const rawIds = Array.isArray(candidate?.sourceRecordIds) ? candidate.sourceRecordIds : [];
    const idSet = idsByCode.get(codigoPredial) ?? new Set();
    for (const rawId of rawIds) {
      if (rawId === null || rawId === undefined || rawId === '') continue;
      idSet.add(String(rawId));
    }
    idsByCode.set(codigoPredial, idSet);
  }

  const codes = [...idsByCode.keys()].sort();
  const grouped = codes.map((codigoPredial) => ({
    codigoPredial,
    sourceRecordIds: [...idsByCode.get(codigoPredial)].sort(compareTechnicalIds),
  }));

  const totalCodeCount = grouped.length;
  const totalRecordCount = grouped.reduce((sum, c) => sum + c.sourceRecordIds.length, 0);
  const truncated = totalCodeCount > MAX_ALTERNATE_CANDIDATES;
  const candidates = truncated ? grouped.slice(0, MAX_ALTERNATE_CANDIDATES) : grouped;

  return { candidates, totalCodeCount, totalRecordCount, truncated };
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
  // mezclan candidatos legacy y clean dentro de una misma clase de
  // equivalencia). Por eso una seleccion actual proveniente de la fuente
  // legacy nunca es comparable contra el representante tecnico elegido por la
  // politica.
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

// Forma base de un registro de telemetria, con todos los campos (incluidos los
// nuevos de V1.1) presentes y en null por defecto — nunca se construye un
// registro por composicion parcial ni por mezcla del objeto de entrada, para
// que las coordenadas efimeras (lat/lng) recibidas en el input jamas puedan
// filtrarse accidentalmente a un campo del registro persistido.
function baseRecord({ startedAt, matrixVersion, lookupId, codigoPredial, currentSource, currentSourceRecordId }) {
  return {
    timestamp: startedAt,
    matrixVersion,
    lookupId: lookupId ?? null,
    codigoPredial,
    currentSource: currentSource ?? null,
    currentSourceRecordId: currentSourceRecordId ?? null,
    resolutionStatus: null,
    candidateSelectionStatus: null,
    policySelectedTechnicalKey: null,
    comparisonStatus: null,
    reasonCodes: [],
    evaluationMs: null,
    errorCode: null,
    // V1.1 — divergencia de fuente (ver SOURCE_CODE_DIVERGENCE). Nunca incluye
    // coordenadas, geometria ni ningun otro dato prohibido: unicamente la
    // fuente alternativa y la lista de codigos tecnicos encontrados por
    // crossSourceProbe. alternateCandidates es siempre un arreglo de
    // {codigoPredial, sourceRecordIds} (nunca un campo singular "elegido"):
    // jamas se selecciona un candidato ni un identificador principal.
    alternateSource: null,
    alternateCodeCount: 0,
    alternateRecordCount: 0,
    alternateCandidates: Object.freeze([]),
    alternateCandidatesTruncated: false,
    // true si la propia consulta SQL del sondeo ya alcanzo su limite
    // operativo (ver crossSourceCleanProbe) antes de que este modulo aplicara
    // su limite de telemetria — son dos truncamientos independientes.
    crossSourceProbeTruncated: false,
    relationStatus: null,
  };
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
 * @param {(args: {lat:number, lng:number, currentSource:string, currentCodigoPredial:string}) => Promise<{found:boolean, alternateSource:string|null, alternateCandidates:Array<{codigoPredial:string, sourceRecordIds:string[]}>, totalCodeCount?:number, totalRecordCount?:number, queryResultTruncated?:boolean, relationStatus:string}>} [options.crossSourceProbe]
 *   - inyectado; en produccion consulta unicamente identificadores tecnicos de
 *   catastrox_clean.predios en el mismo punto de /lookup, para detectar
 *   divergencia de codigo entre fuentes. El contrato es POR CODIGO, no por
 *   fila: cada elemento de alternateCandidates agrupa TODOS los
 *   sourceRecordIds encontrados para ese codigoPredial — nunca se elige un
 *   unico fid representativo (nunca MIN/MAX). totalCodeCount/totalRecordCount
 *   son opcionales pero deben reflejar el conteo REAL anterior al limite
 *   operativo de la consulta SQL (ver crossSourceProbeTruncated); si se
 *   omiten, este modulo calcula un respaldo local a partir de lo recibido
 *   (que solo refleja lo que el probe ya decidio devolver). Este modulo nunca
 *   confia ciegamente en el orden ni en la ausencia de duplicados (ver
 *   normalizeAlternateCandidates). Nunca se implementa dentro de este modulo
 *   puro. Opcional: si no se suministra, la rama de divergencia se omite y el
 *   resultado sigue siendo NOT_APPLICABLE (comportamiento V1).
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
  crossSourceProbe,
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

  // Ejecuta la politica normal (candidateProvider + resolveCatastroxDuplicate)
  // para un codigoPredial ya confirmado presente en la matriz.
  async function evaluateWithPolicy({ startedAt, matrixEntry, lookupId, codigoPredial, currentSource, currentSourceRecordId }) {
    try {
      const candidates = await candidateProvider(codigoPredial);
      const policyResult = resolveCatastroxDuplicate({
        codigoPredial,
        geometryStatus: matrixEntry.geometryStatus,
        attributeStatus: matrixEntry.attributeStatus,
        candidates,
        reasonCodes: matrixEntry.reasonCodes,
      });
      const comparisonStatus = computeComparisonStatus({ currentSource, currentSourceRecordId, policyResult });
      const selected = policyResult.selectedCandidate;

      return {
        ...baseRecord({ startedAt, matrixVersion: matrix.version, lookupId, codigoPredial, currentSource, currentSourceRecordId }),
        resolutionStatus: policyResult.resolutionStatus,
        candidateSelectionStatus: policyResult.candidateSelectionStatus,
        policySelectedTechnicalKey: selected ? technicalKeyOf(selected.source, selected.sourceRecordId) : null,
        comparisonStatus,
        reasonCodes: [...policyResult.reasonCodes],
        evaluationMs: clock() - startedAt,
      };
    } catch (error) {
      return {
        ...baseRecord({ startedAt, matrixVersion: matrix.version, lookupId, codigoPredial, currentSource, currentSourceRecordId }),
        comparisonStatus: COMPARISON_STATUS.EVALUATION_ERROR,
        evaluationMs: clock() - startedAt,
        errorCode: classifyShadowError(error),
      };
    }
  }

  // Rama V1.1: codigoPredial (legacy) no esta en la matriz. Si se dispone de
  // coordenadas y de currentSource='legacy', sondea (via crossSourceProbe) si
  // un codigo clean distinto cubre el mismo punto, exclusivamente con fines de
  // trazabilidad — NUNCA ejecuta resolveCatastroxDuplicate sobre el codigo
  // alternativo, y NUNCA sustituye codigoPredial por alternateCodigoPredial.
  async function probeSourceDivergence({ startedAt, lookupId, codigoPredial, currentSource, currentSourceRecordId, lat, lng }) {
    const base = () => baseRecord({ startedAt, matrixVersion: matrix.version, lookupId, codigoPredial, currentSource, currentSourceRecordId });

    let probeResult;
    try {
      probeResult = await crossSourceProbe({ lat, lng, currentSource, currentCodigoPredial: codigoPredial });
    } catch (error) {
      return {
        record: {
          ...base(),
          comparisonStatus: COMPARISON_STATUS.EVALUATION_ERROR,
          evaluationMs: clock() - startedAt,
          errorCode: SHADOW_ERROR_CODE.CROSS_SOURCE_PROBE_ERROR,
        },
        outcome: SHADOW_OUTCOME.EVALUATED,
      };
    }

    // Si la consulta SQL del sondeo ya alcanzo su propio limite operativo
    // (mas codigos distintos de los que devolvio), es matematicamente
    // imposible que haya un unico codigo: el truncamiento en si mismo
    // demuestra que existen al menos dos. En ese caso se fuerza
    // MULTIPLE_CLEAN_CODES sin importar lo que el probe haya autoreportado —
    // salvo que el propio probe reporte un error (PROBE_ERROR), que nunca se
    // reinterpreta como divergencia.
    const crossSourceProbeTruncated = Boolean(probeResult?.queryResultTruncated);
    const rawRelationStatus = probeResult?.relationStatus;
    const relationStatus = (crossSourceProbeTruncated && rawRelationStatus !== CROSS_SOURCE_RELATION_STATUS.PROBE_ERROR)
      ? CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES
      : rawRelationStatus;

    if (
      relationStatus === CROSS_SOURCE_RELATION_STATUS.DIFFERENT_CODE
      || relationStatus === CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES
    ) {
      const normalized = normalizeAlternateCandidates(probeResult.alternateCandidates);
      // El conteo real y autoritativo (anterior al limite de la consulta SQL)
      // debe venir del propio probe cuando lo suministra; solo se usa el
      // calculo local como respaldo defensivo (p. ej. en pruebas con un
      // probe simplificado que no reporta totales explicitos).
      const alternateCodeCount = Number.isFinite(probeResult?.totalCodeCount)
        ? probeResult.totalCodeCount
        : normalized.totalCodeCount;
      const alternateRecordCount = Number.isFinite(probeResult?.totalRecordCount)
        ? probeResult.totalRecordCount
        : normalized.totalRecordCount;
      const reasonCode = relationStatus === CROSS_SOURCE_RELATION_STATUS.MULTIPLE_CLEAN_CODES
        ? SHADOW_REASON_CODE.MULTIPLE_CLEAN_CODES_AT_LOOKUP_POINT
        : SHADOW_REASON_CODE.SOURCE_CODE_DIVERGENCE;

      return {
        record: {
          ...base(),
          comparisonStatus: COMPARISON_STATUS.SOURCE_CODE_DIVERGENCE,
          reasonCodes: [reasonCode],
          evaluationMs: clock() - startedAt,
          alternateSource: probeResult.alternateSource ?? null,
          alternateCodeCount,
          alternateRecordCount,
          alternateCandidates: Object.freeze(normalized.candidates.map((c) => Object.freeze({
            codigoPredial: c.codigoPredial,
            sourceRecordIds: Object.freeze([...c.sourceRecordIds]),
          }))),
          alternateCandidatesTruncated: normalized.truncated,
          crossSourceProbeTruncated,
          relationStatus,
        },
        outcome: SHADOW_OUTCOME.EVALUATED,
      };
    }

    if (relationStatus === CROSS_SOURCE_RELATION_STATUS.SAME_CODE) {
      // El codigo clean encontrado coincide con el legacy ya evaluado, que por
      // definicion de esta rama no esta en la matriz. Se re-verifica de forma
      // explicita (en vez de asumir) por si el disparador de esta rama cambia
      // en el futuro. SAME_CODE solo tiene sentido con exactamente un
      // candidato normalizado; si el probe reporta SAME_CODE de forma
      // inconsistente con su propio arreglo, se trata con la misma cautela
      // que NO_CLEAN_MATCH (sin informacion fiable que registrar).
      const { candidates } = normalizeAlternateCandidates(probeResult.alternateCandidates);
      const sameCodigoPredial = candidates.length === 1 ? candidates[0].codigoPredial : null;
      const sameCodeEntry = sameCodigoPredial ? matrix.entries[sameCodigoPredial] : undefined;
      if (sameCodeEntry) {
        const policyRecord = await evaluateWithPolicy({
          startedAt,
          matrixEntry: sameCodeEntry,
          lookupId,
          codigoPredial,
          currentSource,
          currentSourceRecordId,
        });
        return { record: policyRecord, outcome: SHADOW_OUTCOME.EVALUATED };
      }
      return { record: null, outcome: SHADOW_OUTCOME.NOT_APPLICABLE };
    }

    if (relationStatus === CROSS_SOURCE_RELATION_STATUS.PROBE_ERROR) {
      return {
        record: {
          ...base(),
          comparisonStatus: COMPARISON_STATUS.EVALUATION_ERROR,
          evaluationMs: clock() - startedAt,
          errorCode: SHADOW_ERROR_CODE.CROSS_SOURCE_PROBE_ERROR,
        },
        outcome: SHADOW_OUTCOME.EVALUATED,
      };
    }

    // NO_CLEAN_MATCH, o cualquier relationStatus no reconocido: sin
    // informacion adicional que registrar.
    return { record: null, outcome: SHADOW_OUTCOME.NOT_APPLICABLE };
  }

  async function evaluateLookupInShadow(input) {
    if (!effectiveEnabled) {
      return { outcome: SHADOW_OUTCOME.NO_OP };
    }

    // lat/lng se leen unicamente para, si corresponde, invocar
    // crossSourceProbe en esta misma funcion — nunca se almacenan en una
    // variable de modulo, nunca se incluyen en un registro (baseRecord no las
    // acepta como parametro) y se descartan al retornar.
    const { lookupId, codigoPredial, currentSource, currentSourceRecordId, lat, lng } = input || {};
    const matrixEntry = codigoPredial ? matrix.entries[codigoPredial] : undefined;
    const startedAt = clock();

    if (matrixEntry) {
      const record = await evaluateWithPolicy({ startedAt, matrixEntry, lookupId, codigoPredial, currentSource, currentSourceRecordId });
      pushEvaluation(record);
      return { outcome: SHADOW_OUTCOME.EVALUATED, record };
    }

    const canProbeDivergence = currentSource === 'legacy'
      && typeof crossSourceProbe === 'function'
      && codigoPredial
      && Number.isFinite(lat)
      && Number.isFinite(lng);

    if (canProbeDivergence) {
      const { record, outcome } = await probeSourceDivergence({
        startedAt, lookupId, codigoPredial, currentSource, currentSourceRecordId, lat, lng,
      });
      if (record) {
        pushEvaluation(record);
        return { outcome, record };
      }
      return { outcome };
    }

    return { outcome: SHADOW_OUTCOME.NOT_APPLICABLE };
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
