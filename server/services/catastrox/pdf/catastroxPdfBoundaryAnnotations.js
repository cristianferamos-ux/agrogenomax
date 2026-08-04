// CATX-PDF-PARITY-002 -- CIERRE: agrupación cartográfica opcional para
// linderos asociados a fuentes hídricas. Capacidad NUEVA -- no existe
// equivalente en el generador de navegador (catastroxDeliverables.js), que
// nunca clasifica tramos por tipo de lindero. No hay, por lo tanto,
// "función canónica" que portar aquí: es diseño nuevo, construido para
// cumplir exactamente las reglas pedidas, documentado en cada función.
//
// Regla crítica (nunca relajar): la agrupación SOLO se activa cuando existe
// una anotación EXPLÍCITA `{ boundaryType: 'FUENTE_HIDRICA', startVertexIndex,
// endVertexIndex, label? }` en `predio.boundaryAnnotations`. Nunca se infiere
// a partir de la sinuosidad del polígono, del número de vértices, ni de
// ninguna otra propiedad geométrica -- ver `buildHydricGroups`. Un predio sin
// `boundaryAnnotations` (el caso de CUALQUIER predio real hoy, incluido el de
// geometría irregular usado en las pruebas de esta sprint) se renderiza
// exactamente igual que antes de este módulo, byte a byte en su lógica de
// dibujo (la única entrada de este módulo es un array opcional que, vacío o
// ausente, produce listas de grupos vacías en cada función de abajo).
//
// La geometría interna (vértices, segmentos, distancias individuales,
// perímetro) NUNCA se modifica ni se pierde -- este módulo solo calcula qué
// mostrar/ocultar en la PRESENTACIÓN (plano y tabla ejecutiva); toda la
// información fuente sigue disponible vía `layoutData.referenceSegments`
// sin filtrar.
//
// ESTADO: CAPACIDAD PREPARATORIA, NO CONECTADA A COMPRAS REALES.
// La capacidad boundaryAnnotations es preparatoria y actualmente no está
// conectada al flujo real de compras ni entregas. Solo se activa cuando
// predioData.boundaryAnnotations es suministrado explícitamente. Su
// operación real requiere el sprint CATX-BOUNDARIES-001, incluyendo
// almacenamiento persistente, servicio administrativo, propagación al
// delivery job y auditoría de actor. Auditado: resolvePredioDataForDelivery
// (server/routes/catastrox.js) nunca puebla este campo -- ningún lookup,
// orden, webhook ni delivery job real puede activarlo hoy.

export const HYDRIC_BOUNDARY_TYPE = 'FUENTE_HIDRICA';

class BoundaryAnnotationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BoundaryAnnotationError';
  }
}

/**
 * Suma las distancias reales de cada subtramo entre `startVertexIndex` y
 * `endVertexIndex`, recorriendo el polígono en el sentido de avance de
 * `referenceSegments` (segment[i] conecta el vértice i con el vértice
 * i+1 mod n) -- NUNCA la distancia recta entre los extremos. Maneja el
 * cierre del polígono (Pn -> P1) de forma natural: si endVertexIndex es
 * menor que startVertexIndex, el recorrido simplemente da la vuelta módulo
 * n, sumando el tramo que cruza el cierre igual que cualquier otro.
 */
export function computeAccumulatedDistance(referenceSegments, startVertexIndex, endVertexIndex) {
  const n = referenceSegments.length;
  let total = 0;
  let i = startVertexIndex;
  let guard = 0;
  while (i !== endVertexIndex) {
    total += referenceSegments[i].distance;
    i = (i + 1) % n;
    guard += 1;
    if (guard > n) {
      throw new BoundaryAnnotationError('No fue posible recorrer el lindero hídrico: índices de vértice inconsistentes.');
    }
  }
  return total;
}

/** Índices de segmento (0-based) cubiertos por el tramo [start, end) -- sus etiquetas individuales se omiten en el plano y sus filas se agrupan en la tabla. */
export function getHydricSegmentIndices(startVertexIndex, endVertexIndex, vertexCount) {
  const indices = [];
  let i = startVertexIndex;
  let guard = 0;
  while (i !== endVertexIndex) {
    indices.push(i);
    i = (i + 1) % vertexCount;
    guard += 1;
    if (guard > vertexCount) break;
  }
  return indices;
}

/** Vértices estrictamente intermedios (excluye start y end) -- sus círculos y rótulos P se omiten en el plano; el punto inicial y final SIEMPRE se conservan visibles. */
export function getIntermediateVertexIndices(startVertexIndex, endVertexIndex, vertexCount) {
  const indices = [];
  let i = (startVertexIndex + 1) % vertexCount;
  let guard = 0;
  while (i !== endVertexIndex) {
    indices.push(i);
    i = (i + 1) % vertexCount;
    guard += 1;
    if (guard > vertexCount) break;
  }
  return indices;
}

function validateAnnotation(annotation, vertexCount) {
  if (!annotation || typeof annotation !== 'object') {
    throw new BoundaryAnnotationError('Anotación de lindero inválida: se esperaba un objeto.');
  }
  const { startVertexIndex, endVertexIndex } = annotation;
  if (!Number.isInteger(startVertexIndex) || !Number.isInteger(endVertexIndex)) {
    throw new BoundaryAnnotationError('Anotación de lindero hídrico inválida: startVertexIndex/endVertexIndex deben ser enteros.');
  }
  if (startVertexIndex < 0 || startVertexIndex >= vertexCount || endVertexIndex < 0 || endVertexIndex >= vertexCount) {
    throw new BoundaryAnnotationError(`Anotación de lindero hídrico inválida: índice de vértice fuera de rango (0..${vertexCount - 1}).`);
  }
  if (startVertexIndex === endVertexIndex) {
    throw new BoundaryAnnotationError('Anotación de lindero hídrico inválida: startVertexIndex y endVertexIndex no pueden ser iguales (el tramo debe cubrir al menos un segmento).');
  }
}

/**
 * Construye los grupos hídricos a partir de las anotaciones explícitas del
 * predio. Filtra estrictamente por `boundaryType === 'FUENTE_HIDRICA'` --
 * cualquier otro valor (incluido ausente/undefined) se ignora sin lanzar,
 * de modo que este campo puede evolucionar a futuro (otros tipos de
 * lindero) sin romper la generación actual.
 *
 * @param {Array<{distance:number, from:string, to:string}>} referenceSegments
 * @param {Array<{boundaryType:string, startVertexIndex:number, endVertexIndex:number, label?:string}>} [annotations]
 */
export function buildHydricGroups(referenceSegments, annotations = []) {
  const vertexCount = referenceSegments.length;
  if (!vertexCount || !Array.isArray(annotations) || !annotations.length) return [];

  return annotations
    .filter((annotation) => annotation && annotation.boundaryType === HYDRIC_BOUNDARY_TYPE)
    .map((annotation) => {
      validateAnnotation(annotation, vertexCount);
      const { startVertexIndex, endVertexIndex } = annotation;
      const segmentIndices = getHydricSegmentIndices(startVertexIndex, endVertexIndex, vertexCount);
      const intermediateVertexIndices = getIntermediateVertexIndices(startVertexIndex, endVertexIndex, vertexCount);
      const accumulatedDistance = computeAccumulatedDistance(referenceSegments, startVertexIndex, endVertexIndex);
      return {
        boundaryType: HYDRIC_BOUNDARY_TYPE,
        startVertexIndex,
        endVertexIndex,
        label: annotation.label || 'Lindero por fuente hídrica',
        segmentIndices,
        intermediateVertexIndices,
        accumulatedDistance,
      };
    });
}

/**
 * Índices de vértice (0-based) que deben omitirse en el plano (círculo +
 * rótulo Pn) -- unión de los intermedios de todos los grupos. El punto
 * inicial y final de cada grupo NUNCA se incluye aquí (deben seguir
 * visibles, requisito explícito).
 */
export function collectHiddenVertexIndices(hydricGroups) {
  const hidden = new Set();
  hydricGroups.forEach((group) => group.intermediateVertexIndices.forEach((index) => hidden.add(index)));
  return hidden;
}

/** Índices de segmento (0-based) cuya etiqueta individual de distancia debe omitirse en el plano -- se reemplaza por una única etiqueta agrupada por grupo hídrico. */
export function collectHiddenSegmentIndices(hydricGroups) {
  const hidden = new Set();
  hydricGroups.forEach((group) => group.segmentIndices.forEach((index) => hidden.add(index)));
  return hidden;
}

/**
 * Reconstruye las filas de la tabla ejecutiva reemplazando las filas
 * individuales de cada grupo hídrico por UNA fila agrupada (Punto=inicio,
 * Siguiente=fin, Distancia=longitud acumulada real). Añade una 4ta columna
 * "Tipo de lindero" SOLO si existe al menos un grupo hídrico -- una tabla
 * sin anotaciones hídricas conserva exactamente las mismas 3 columnas de
 * siempre (Punto/Siguiente/Distancia), sin ningún cambio visual.
 *
 * @param {Array<Array<string>>} tableRows filas ya formateadas por buildUnifiedTableRows (informative: [from, to, "X,XX m"]) -- row[i] corresponde 1:1 a referenceSegments[i].
 * @param {Array<{distance:number}>} referenceSegments
 * @param {ReturnType<typeof buildHydricGroups>} hydricGroups
 * @param {(meters:number) => string} formatDistance
 */
export function applyHydricGroupsToTableRows(tableRows, hydricGroups, formatDistance) {
  if (!hydricGroups.length) return { rows: tableRows, hasHydricColumn: false };

  const groupBySegmentStart = new Map();
  const suppressedSegmentIndices = collectHiddenSegmentIndices(hydricGroups);
  hydricGroups.forEach((group) => {
    // El grupo se inserta en la posición de su PRIMER segmento -- conserva
    // el orden natural P1->P2->...->Pn de la tabla.
    groupBySegmentStart.set(group.segmentIndices[0], group);
  });

  const rows = [];
  tableRows.forEach((row, index) => {
    if (groupBySegmentStart.has(index)) {
      const group = groupBySegmentStart.get(index);
      rows.push([
        `P${group.startVertexIndex + 1}`,
        `P${group.endVertexIndex + 1}`,
        formatDistance(group.accumulatedDistance),
        'Fuente hídrica',
      ]);
    }
    if (!suppressedSegmentIndices.has(index)) {
      rows.push([...row, 'Ordinario']);
    }
  });

  return { rows, hasHydricColumn: true };
}

export { BoundaryAnnotationError };
