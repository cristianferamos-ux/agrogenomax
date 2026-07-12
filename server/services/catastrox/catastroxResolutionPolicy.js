// Motor de decision del resolver de duplicados catastrales — modulo puro.
//
// Convierte una clasificacion geometrica y de atributos (ya calculada por otro
// proceso, tipicamente consultas PostGIS de solo lectura) en una decision de
// resolucion. No ejecuta SQL, no abre conexiones, no lee archivos, no importa nada
// de Express ni de rutas HTTP, no depende de audit_outputs/ y no mantiene estado
// mutable entre llamadas: cada invocacion de resolveCatastroxDuplicate() es una
// funcion pura de su argumento de entrada.
//
// Este modulo NO esta conectado todavia a /lookup, audit/full-result, PostGIS, PDF,
// KML/KMZ, SHP, DXF ni a la interfaz. Es deliberadamente un componente aislado,
// probado de forma independiente, para que su logica de decision pueda revisarse y
// validarse antes de integrarlo a cualquier flujo real.

// ---------------------------------------------------------------------------
// Valores validos de entrada
// ---------------------------------------------------------------------------

export const GEOMETRY_STATUS = Object.freeze({
  EXACT: 'EXACT',
  MINIMAL_VARIATION: 'MINIMAL_VARIATION',
  MATERIAL_CONFLICT: 'MATERIAL_CONFLICT',
  SEPARATE: 'SEPARATE',
});

export const ATTRIBUTE_STATUS = Object.freeze({
  NONE: 'NONE',
  COMPLEMENTARY: 'COMPLEMENTARY',
  COMMERCIAL_SENSITIVE: 'COMMERCIAL_SENSITIVE',
  TERRITORIAL_CRITICAL: 'TERRITORIAL_CRITICAL',
  NORMALIZATION_SUSPECT: 'NORMALIZATION_SUSPECT',
});

const VALID_GEOMETRY_STATUSES = new Set(Object.values(GEOMETRY_STATUS));
const VALID_ATTRIBUTE_STATUSES = new Set(Object.values(ATTRIBUTE_STATUS));

// ---------------------------------------------------------------------------
// Valores validos de salida
// ---------------------------------------------------------------------------

export const RESOLUTION_STATUS = Object.freeze({
  AUTO_RESOLVED: 'AUTO_RESOLVED',
  PENDING_POLICY: 'PENDING_POLICY',
  // Reservado para una fase futura en la que exista una politica de seleccion
  // aprobada, se elija un candidato representante y se permitan entregables con
  // advertencia. En esta version (V1) ninguna regla del resolver produce este
  // estado — ver docs/catastrox/CATASTROX_RESOLUTION_POLICY_V1.md.
  RESOLVED_WITH_WARNING: 'RESOLVED_WITH_WARNING',
  BLOCKED_REVIEW: 'BLOCKED_REVIEW',
  BLOCKED_CRITICAL: 'BLOCKED_CRITICAL',
});

export const CANDIDATE_SELECTION_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  SELECTED_EQUIVALENT: 'SELECTED_EQUIVALENT',
  PENDING_POLICY: 'PENDING_POLICY',
  BLOCKED: 'BLOCKED',
});

// ---------------------------------------------------------------------------
// Reason codes (constantes unicas; nunca se construyen mensajes por
// concatenacion dispersa de cadenas — cada reason code es una clave fija y cada
// mensaje humano se deriva de esa clave via REASON_CODE_MESSAGES, mas abajo).
// ---------------------------------------------------------------------------

export const REASON_CODE = Object.freeze({
  EXACT_EQUIVALENT_DUPLICATES: 'EXACT_EQUIVALENT_DUPLICATES',
  MINIMAL_GEOMETRY_VARIATION: 'MINIMAL_GEOMETRY_VARIATION',
  MATERIAL_GEOMETRY_CONFLICT: 'MATERIAL_GEOMETRY_CONFLICT',
  SEPARATE_GEOMETRIES: 'SEPARATE_GEOMETRIES',
  COMPLEMENTARY_ATTRIBUTE: 'COMPLEMENTARY_ATTRIBUTE',
  COMMERCIAL_ATTRIBUTE_CONFLICT: 'COMMERCIAL_ATTRIBUTE_CONFLICT',
  TERRITORIAL_ATTRIBUTE_CONFLICT: 'TERRITORIAL_ATTRIBUTE_CONFLICT',
  NORMALIZATION_SUSPECT: 'NORMALIZATION_SUSPECT',
  ZONE_NORMALIZATION_SUSPECT: 'ZONE_NORMALIZATION_SUSPECT',
  MANZANA_ZERO_SENTINEL: 'MANZANA_ZERO_SENTINEL',
  CANDIDATE_SELECTION_POLICY_PENDING: 'CANDIDATE_SELECTION_POLICY_PENDING',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
});

const REASON_CODE_MESSAGES = Object.freeze({
  [REASON_CODE.EXACT_EQUIVALENT_DUPLICATES]:
    'Todos los candidatos son geometrica y atributivamente equivalentes; se conservan como duplicados exactos.',
  [REASON_CODE.MINIMAL_GEOMETRY_VARIATION]:
    'La geometria de los candidatos varia dentro de un margen minimo (solapamiento, area y perimetro dentro de umbral); no existe aun un criterio aprobado para elegir un representante.',
  [REASON_CODE.MATERIAL_GEOMETRY_CONFLICT]:
    'La geometria de los candidatos difiere de forma material (solapamiento, area, perimetro, partes o huecos fuera de umbral); bloqueado para revision.',
  [REASON_CODE.SEPARATE_GEOMETRIES]:
    'Los candidatos no comparten ubicacion espacial (geometrias separadas); bloqueado para revision.',
  [REASON_CODE.COMPLEMENTARY_ATTRIBUTE]:
    'Existe al menos un atributo distinto entre candidatos sin implicacion comercial ni territorial; no existe aun un criterio aprobado para elegir un representante.',
  [REASON_CODE.COMMERCIAL_ATTRIBUTE_CONFLICT]:
    'Existe una diferencia de atributo con posible impacto comercial (ej. destino economico, uso, area declarada); bloqueado para revision.',
  [REASON_CODE.TERRITORIAL_ATTRIBUTE_CONFLICT]:
    'Existe una contradiccion territorial entre candidatos (ej. zona rural/urbano); bloqueado para revision critica antes de cualquier entregable.',
  [REASON_CODE.NORMALIZATION_SUSPECT]:
    'La causa probable de la diferencia de atributos es un error de normalizacion, pero aun requiere revision antes de confirmarse.',
  [REASON_CODE.ZONE_NORMALIZATION_SUSPECT]:
    'La contradiccion de zona (rural/urbano) tiene evidencia de ser un error de normalizacion, no una contradiccion territorial real; aun asi requiere revision manual antes de confirmarse.',
  [REASON_CODE.MANZANA_ZERO_SENTINEL]:
    'El codigo de manzana compuesto unicamente por ceros es una inferencia estructural de alta confianza de valor sentinela (ausencia de informacion), no una definicion oficial confirmada.',
  [REASON_CODE.CANDIDATE_SELECTION_POLICY_PENDING]:
    'La seleccion de un candidato representante esta pendiente de un criterio de negocio aprobado; no se elige ninguno automaticamente.',
  [REASON_CODE.MANUAL_REVIEW_REQUIRED]:
    'Este codigo predial requiere revision manual antes de generar cualquier entregable.',
});

// ---------------------------------------------------------------------------
// Errores contractuales
// ---------------------------------------------------------------------------

// Error dedicado (distinto de TypeError/RangeError de validacion de forma) para
// violaciones del contrato de negocio del resolver — ej. EXACT + NONE sin
// candidatos, candidatos sin identidad de trazabilidad, o claves tecnicas
// duplicadas. Se distingue de los errores de validacion de entrada porque no es
// un problema de "forma" del objeto sino de coherencia de la decision solicitada.
export class CatastroxResolverContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatastroxResolverContractError';
  }
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function allDeliverablesAllowed(allowed) {
  return { pdf: allowed, kml: allowed, kmz: allowed, shp: allowed, dxf: allowed };
}

function dedupeReasonCodes(codes) {
  return [...new Set(codes)];
}

// Familia de reason codes que explican una sospecha de normalizacion. Si quien
// llama a este modulo ya aporta uno especifico (ej. ZONE_NORMALIZATION_SUSPECT
// para el caso de zona, o MANZANA_ZERO_SENTINEL para el caso de manzana) via
// input.reasonCodes, el modulo NO agrega ademas el generico NORMALIZATION_SUSPECT
// — evita reason codes redundantes cuando ya existe una explicacion mas precisa.
const NORMALIZATION_SUSPECT_FAMILY = new Set([
  REASON_CODE.NORMALIZATION_SUSPECT,
  REASON_CODE.ZONE_NORMALIZATION_SUSPECT,
  REASON_CODE.MANZANA_ZERO_SENTINEL,
]);

function normalizationSuspectFallbackReasonCodes(attributeStatus, upstreamReasonCodes) {
  if (attributeStatus !== ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT) return [];
  const hasSpecificReason = upstreamReasonCodes.some((code) => NORMALIZATION_SUSPECT_FAMILY.has(code));
  return hasSpecificReason ? [] : [REASON_CODE.NORMALIZATION_SUSPECT];
}

function buildWarnings(reasonCodes) {
  return reasonCodes
    .map((code) => REASON_CODE_MESSAGES[code])
    .filter(Boolean);
}

// Clonacion defensiva profunda: nunca se devuelve ni se conserva una referencia
// compartida con objetos suministrados por quien llama (input.candidates,
// input.evidence, etc.), de modo que mutar el objeto de entrada despues de la
// llamada, o intentar mutar el resultado devuelto, jamas afecta al otro lado.
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// Congelamiento profundo real (Object.freeze por si solo es superficial: solo
// impide reasignar las propiedades de primer nivel, pero permite mutar objetos o
// arreglos anidados). Recorre recursivamente el valor y congela cada nivel.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

// Clave tecnica estable y reproducible, EXCLUSIVAMENTE a partir de campos de
// trazabilidad no catastrales (fuente + identificador de registro de esa fuente,
// suministrados por quien llama a este modulo). Nunca usa fid, ctid, area ni orden
// fisico de base de datos: esos campos ni siquiera se leen aqui.
function technicalSortKey(candidate) {
  const source = String(candidate?.source ?? '');
  const sourceRecordId = String(candidate?.sourceRecordId ?? '');
  return `${source}::${sourceRecordId}`;
}

// Ordena por la clave tecnica estable, unicamente para reproducibilidad entre
// ejecuciones — este orden no representa vigencia ni prioridad oficial alguna.
// Opera sobre una copia del arreglo para no mutar el arreglo recibido.
function sortCandidatesForReproducibility(candidates) {
  return [...candidates].sort((a, b) => technicalSortKey(a).localeCompare(technicalSortKey(b)));
}

// Blindaje exclusivo de la rama EXACT + NONE (regla 5): exige identidad de
// trazabilidad valida y unica en cada candidato antes de permitir una seleccion
// automatica. EXACT + NONE sin candidatos, o con candidatos sin identidad
// verificable, es una entrada incoherente para una resolucion automatica y se
// rechaza con un error contractual explicito en vez de degradar silenciosamente
// a BLOCKED_REVIEW.
function assertExactEquivalentCandidatesAreWellFormed(candidates) {
  if (candidates.length === 0) {
    throw new CatastroxResolverContractError(
      'catastroxResolutionPolicy: geometryStatus=EXACT y attributeStatus=NONE requieren al menos un candidato; '
      + 'candidates vacio es una entrada incoherente para una resolucion automatica.',
    );
  }

  const seenTechnicalKeys = new Set();
  for (const candidate of candidates) {
    const { source, sourceRecordId } = candidate ?? {};
    if (typeof source !== 'string' || source.trim() === '') {
      throw new CatastroxResolverContractError(
        'catastroxResolutionPolicy: cada candidato en EXACT + NONE requiere "source" como texto no vacio.',
      );
    }
    if (typeof sourceRecordId !== 'string' || sourceRecordId.trim() === '') {
      throw new CatastroxResolverContractError(
        'catastroxResolutionPolicy: cada candidato en EXACT + NONE requiere "sourceRecordId" como texto no vacio.',
      );
    }
    const technicalKey = technicalSortKey(candidate);
    if (seenTechnicalKeys.has(technicalKey)) {
      throw new CatastroxResolverContractError(
        `catastroxResolutionPolicy: clave tecnica duplicada "${technicalKey}" entre candidatos de EXACT + NONE; `
        + 'cada candidato debe ser identificable de forma unica mediante source + sourceRecordId.',
      );
    }
    seenTechnicalKeys.add(technicalKey);
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('catastroxResolutionPolicy: se requiere un objeto de entrada.');
  }
  const { codigoPredial, geometryStatus, attributeStatus, candidates } = input;

  if (!codigoPredial || typeof codigoPredial !== 'string') {
    throw new TypeError('catastroxResolutionPolicy: codigoPredial es obligatorio y debe ser texto.');
  }
  if (!VALID_GEOMETRY_STATUSES.has(geometryStatus)) {
    throw new RangeError(
      `catastroxResolutionPolicy: geometryStatus desconocido "${geometryStatus}". Valores validos: ${[...VALID_GEOMETRY_STATUSES].join(', ')}.`,
    );
  }
  if (!VALID_ATTRIBUTE_STATUSES.has(attributeStatus)) {
    throw new RangeError(
      `catastroxResolutionPolicy: attributeStatus desconocido "${attributeStatus}". Valores validos: ${[...VALID_ATTRIBUTE_STATUSES].join(', ')}.`,
    );
  }
  if (candidates !== undefined && !Array.isArray(candidates)) {
    throw new TypeError('catastroxResolutionPolicy: candidates debe ser un arreglo cuando se suministra.');
  }
}

// Unico punto de salida del modulo: clona defensivamente cada estructura anidada
// (nunca reutiliza referencias del objeto de entrada ni de estructuras internas
// compartidas) y congela profundamente el resultado completo antes de
// devolverlo, para que ninguna mutacion externa posterior — directa o anidada —
// pueda alterar una decision ya emitida.
function buildResult({
  codigoPredial,
  geometryStatus,
  attributeStatus,
  resolutionStatus,
  candidateSelectionStatus,
  selectedCandidate,
  equivalentCandidates,
  reasonCodes,
  manualReviewRequired,
  criticalReview,
  traceabilityRequired,
  deliverablesAllowed,
  extraReasonCodes,
}) {
  const mergedReasonCodes = dedupeReasonCodes([...reasonCodes, ...(extraReasonCodes || [])]);
  const result = {
    codigoPredial,
    resolutionStatus,
    candidateSelectionStatus,
    selectedCandidate: selectedCandidate ? deepClone(selectedCandidate) : null,
    equivalentCandidates: equivalentCandidates.map((candidate) => deepClone(candidate)),
    geometryStatus,
    attributeStatus,
    reasonCodes: mergedReasonCodes,
    warnings: buildWarnings(mergedReasonCodes),
    manualReviewRequired,
    criticalReview,
    traceabilityRequired,
    deliverablesAllowed: { ...deliverablesAllowed },
  };
  return deepFreeze(result);
}

// ---------------------------------------------------------------------------
// Funcion principal
// ---------------------------------------------------------------------------

/**
 * Funcion pura: misma entrada siempre produce la misma salida, sin efectos
 * secundarios, sin I/O, sin estado compartido entre llamadas. El resultado
 * devuelto esta congelado de forma profunda y no comparte referencias con el
 * objeto de entrada.
 *
 * @param {object} input
 * @param {string} input.codigoPredial
 * @param {string} input.geometryStatus - uno de GEOMETRY_STATUS
 * @param {string} input.attributeStatus - uno de ATTRIBUTE_STATUS
 * @param {Array<{source: string, sourceRecordId: string}>} [input.candidates]
 *   - para geometryStatus=EXACT y attributeStatus=NONE, cada candidato debe
 *   tener source y sourceRecordId como texto no vacio, y la combinacion
 *   source+sourceRecordId debe ser unica entre los candidatos suministrados.
 * @param {string[]} [input.reasonCodes] - reason codes calculados aguas arriba
 *   (ej. por el proceso de clasificacion geometrica/atributiva); se fusionan con
 *   los que este modulo agrega, sin duplicados.
 * @param {object} [input.evidence] - contexto libre de solo lectura (metricas,
 *   umbrales, etc.); este modulo no lo interpreta ni lo requiere para decidir, y
 *   no se incluye en el objeto de salida (ver Fase 2 del contrato).
 * @returns {object} objeto de resolucion inmutable (congelado de forma profunda)
 * @throws {TypeError|RangeError} si la forma o los valores de entrada son invalidos
 * @throws {CatastroxResolverContractError} si la entrada es contractualmente
 *   incoherente para la decision solicitada (ej. EXACT + NONE sin candidatos
 *   validos)
 */
export function resolveCatastroxDuplicate(input) {
  validateInput(input);

  const { codigoPredial, geometryStatus, attributeStatus } = input;
  const candidates = Array.isArray(input.candidates) ? input.candidates.map((c) => ({ ...c })) : [];
  const upstreamReasonCodes = Array.isArray(input.reasonCodes) ? [...input.reasonCodes] : [];

  // Regla 1 (maxima precedencia): contradiccion territorial critica.
  if (attributeStatus === ATTRIBUTE_STATUS.TERRITORIAL_CRITICAL) {
    return buildResult({
      codigoPredial,
      geometryStatus,
      attributeStatus,
      resolutionStatus: RESOLUTION_STATUS.BLOCKED_CRITICAL,
      candidateSelectionStatus: CANDIDATE_SELECTION_STATUS.BLOCKED,
      selectedCandidate: null,
      equivalentCandidates: candidates,
      reasonCodes: [REASON_CODE.TERRITORIAL_ATTRIBUTE_CONFLICT, REASON_CODE.MANUAL_REVIEW_REQUIRED],
      extraReasonCodes: upstreamReasonCodes,
      manualReviewRequired: true,
      criticalReview: true,
      traceabilityRequired: true,
      deliverablesAllowed: allDeliverablesAllowed(false),
    });
  }

  // Regla 2: conflicto geometrico material o geometrias separadas.
  // NORMALIZATION_SUSPECT nunca reduce este bloqueo (se agrega como reason code
  // adicional, pero el resultado sigue BLOCKED_REVIEW por la geometria).
  if (geometryStatus === GEOMETRY_STATUS.MATERIAL_CONFLICT || geometryStatus === GEOMETRY_STATUS.SEPARATE) {
    const geometryReasonCode = geometryStatus === GEOMETRY_STATUS.MATERIAL_CONFLICT
      ? REASON_CODE.MATERIAL_GEOMETRY_CONFLICT
      : REASON_CODE.SEPARATE_GEOMETRIES;
    const reasonCodes = [
      geometryReasonCode,
      ...normalizationSuspectFallbackReasonCodes(attributeStatus, upstreamReasonCodes),
      REASON_CODE.MANUAL_REVIEW_REQUIRED,
    ];
    return buildResult({
      codigoPredial,
      geometryStatus,
      attributeStatus,
      resolutionStatus: RESOLUTION_STATUS.BLOCKED_REVIEW,
      candidateSelectionStatus: CANDIDATE_SELECTION_STATUS.BLOCKED,
      selectedCandidate: null,
      equivalentCandidates: candidates,
      reasonCodes,
      extraReasonCodes: upstreamReasonCodes,
      manualReviewRequired: true,
      criticalReview: false,
      traceabilityRequired: true,
      deliverablesAllowed: allDeliverablesAllowed(false),
    });
  }

  // Regla 3: conflicto de atributo comercialmente sensible.
  if (attributeStatus === ATTRIBUTE_STATUS.COMMERCIAL_SENSITIVE) {
    return buildResult({
      codigoPredial,
      geometryStatus,
      attributeStatus,
      resolutionStatus: RESOLUTION_STATUS.BLOCKED_REVIEW,
      candidateSelectionStatus: CANDIDATE_SELECTION_STATUS.BLOCKED,
      selectedCandidate: null,
      equivalentCandidates: candidates,
      reasonCodes: [REASON_CODE.COMMERCIAL_ATTRIBUTE_CONFLICT, REASON_CODE.MANUAL_REVIEW_REQUIRED],
      extraReasonCodes: upstreamReasonCodes,
      manualReviewRequired: true,
      criticalReview: false,
      traceabilityRequired: true,
      deliverablesAllowed: allDeliverablesAllowed(false),
    });
  }

  // Regla 4: variacion geometrica minima, atributo complementario, o sospecha de
  // normalizacion sin conflicto geometrico/comercial/territorial. Obligatoria:
  // no existe todavia un criterio aprobado para escoger un representante, por lo
  // que ni la resolucion ni la seleccion de candidato pueden considerarse
  // definitivas todavia (resolutionStatus=PENDING_POLICY). RESOLVED_WITH_WARNING
  // queda reservado para una fase futura con politica de seleccion aprobada.
  if (
    geometryStatus === GEOMETRY_STATUS.MINIMAL_VARIATION
    || attributeStatus === ATTRIBUTE_STATUS.COMPLEMENTARY
    || attributeStatus === ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT
  ) {
    const reasonCodes = [];
    if (geometryStatus === GEOMETRY_STATUS.MINIMAL_VARIATION) reasonCodes.push(REASON_CODE.MINIMAL_GEOMETRY_VARIATION);
    if (attributeStatus === ATTRIBUTE_STATUS.COMPLEMENTARY) reasonCodes.push(REASON_CODE.COMPLEMENTARY_ATTRIBUTE);
    reasonCodes.push(...normalizationSuspectFallbackReasonCodes(attributeStatus, upstreamReasonCodes));
    reasonCodes.push(REASON_CODE.CANDIDATE_SELECTION_POLICY_PENDING);
    return buildResult({
      codigoPredial,
      geometryStatus,
      attributeStatus,
      resolutionStatus: RESOLUTION_STATUS.PENDING_POLICY,
      candidateSelectionStatus: CANDIDATE_SELECTION_STATUS.PENDING_POLICY,
      selectedCandidate: null,
      equivalentCandidates: candidates,
      reasonCodes,
      extraReasonCodes: upstreamReasonCodes,
      manualReviewRequired: false,
      criticalReview: false,
      traceabilityRequired: true,
      deliverablesAllowed: allDeliverablesAllowed(false),
    });
  }

  // Regla 5: geometria exacta y sin conflicto de atributos -> resolucion
  // automatica. Antes de seleccionar, se blinda la entrada: EXACT + NONE sin
  // candidatos, o con candidatos sin identidad de trazabilidad valida y unica,
  // es una entrada incoherente y se rechaza explicitamente (ver
  // assertExactEquivalentCandidatesAreWellFormed) en vez de degradarse a un
  // resultado silencioso.
  if (geometryStatus === GEOMETRY_STATUS.EXACT && attributeStatus === ATTRIBUTE_STATUS.NONE) {
    assertExactEquivalentCandidatesAreWellFormed(candidates);

    const hasMultipleCandidates = candidates.length > 1;
    const orderedCandidates = sortCandidatesForReproducibility(candidates);
    const selectedCandidate = orderedCandidates[0];

    return buildResult({
      codigoPredial,
      geometryStatus,
      attributeStatus,
      resolutionStatus: RESOLUTION_STATUS.AUTO_RESOLVED,
      candidateSelectionStatus: hasMultipleCandidates
        ? CANDIDATE_SELECTION_STATUS.SELECTED_EQUIVALENT
        : CANDIDATE_SELECTION_STATUS.NOT_REQUIRED,
      selectedCandidate,
      equivalentCandidates: orderedCandidates,
      reasonCodes: [REASON_CODE.EXACT_EQUIVALENT_DUPLICATES],
      extraReasonCodes: upstreamReasonCodes,
      manualReviewRequired: false,
      criticalReview: false,
      traceabilityRequired: hasMultipleCandidates,
      deliverablesAllowed: allDeliverablesAllowed(true),
    });
  }

  // No deberia alcanzarse con los enums validados arriba (toda combinacion de
  // geometryStatus x attributeStatus queda cubierta por las reglas 1-5), pero se
  // deja como salvaguarda explicita en vez de una salida silenciosa/ambigua.
  throw new Error(
    `catastroxResolutionPolicy: combinacion no contemplada geometryStatus="${geometryStatus}" attributeStatus="${attributeStatus}".`,
  );
}
