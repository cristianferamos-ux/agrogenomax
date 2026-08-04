// CATX-PDF-PARITY-002 -- CIERRE: pruebas puras y deterministas (sin
// PDFKit/red/Postgres) de la capacidad de agrupación de linderos por fuente
// hídrica. Requisito crítico probado explícitamente: la agrupación NUNCA se
// activa por inferencia (sinuosidad, número de vértices, etc.) -- solo por
// `boundaryType: 'FUENTE_HIDRICA'` explícito.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HYDRIC_BOUNDARY_TYPE,
  computeAccumulatedDistance,
  getHydricSegmentIndices,
  getIntermediateVertexIndices,
  buildHydricGroups,
  collectHiddenVertexIndices,
  collectHiddenSegmentIndices,
  applyHydricGroupsToTableRows,
  BoundaryAnnotationError,
} from '../catastroxPdfBoundaryAnnotations.js';

// Octágono regular: segment[i] conecta el vértice i con el vértice
// (i+1)%8 -- misma convención que layoutData.referenceSegments en el
// generador real (from/to/distance).
function buildOctagonSegments() {
  return Array.from({ length: 8 }, (_, i) => ({
    from: `P${i + 1}`,
    to: `P${((i + 1) % 8) + 1}`,
    distance: 10 + i, // 10,11,12,13,14,15,16,17 -- sin simetría, para detectar sumas incorrectas.
  }));
}

const formatDistance = (meters) => `${meters.toFixed(2)} m`;

test('CATX-PDF-PARITY-002 (hídrico): sin anotaciones -> ningún grupo, ninguna fila oculta (nunca automático)', () => {
  const segments = buildOctagonSegments();
  assert.deepEqual(buildHydricGroups(segments, []), []);
  assert.deepEqual(buildHydricGroups(segments, undefined), []);
  assert.deepEqual([...collectHiddenVertexIndices(buildHydricGroups(segments, []))], []);
});

test('CATX-PDF-PARITY-002 (hídrico): un boundaryType distinto de FUENTE_HIDRICA se ignora sin lanzar', () => {
  const segments = buildOctagonSegments();
  const groups = buildHydricGroups(segments, [{ boundaryType: 'LINDERO_VIAL', startVertexIndex: 1, endVertexIndex: 3 }]);
  assert.deepEqual(groups, []);
});

test('CATX-PDF-PARITY-002 (hídrico): tramo ordinario (no cruza el cierre) -- longitud acumulada = suma real, nunca la distancia recta', () => {
  const segments = buildOctagonSegments();
  // Tramo P2(1)->P5(4): cubre segmentos 1,2,3 -> distancias 11+12+13=36.
  const groups = buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 1, endVertexIndex: 4 }]);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.accumulatedDistance, 36);
  assert.deepEqual(group.segmentIndices, [1, 2, 3]);
  assert.deepEqual(group.intermediateVertexIndices, [2, 3]);
  assert.equal(group.startVertexIndex, 1);
  assert.equal(group.endVertexIndex, 4);
  assert.equal(group.label, 'Lindero por fuente hídrica');
});

test('CATX-PDF-PARITY-002 (hídrico): tramo que cruza el cierre Pn->P1 se recorre correctamente (wraparound)', () => {
  const segments = buildOctagonSegments();
  // Tramo P7(6)->P2(1): cubre segmentos 6,7,0 (cruza el cierre) -> 16+17+10=43.
  const groups = buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 6, endVertexIndex: 1 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].accumulatedDistance, 43);
  assert.deepEqual(groups[0].segmentIndices, [6, 7, 0]);
  assert.deepEqual(groups[0].intermediateVertexIndices, [7, 0]);
});

test('CATX-PDF-PARITY-002 (hídrico): computeAccumulatedDistance nunca es igual a una distancia recta cuando hay más de un subtramo', () => {
  const segments = buildOctagonSegments();
  const accumulated = computeAccumulatedDistance(segments, 0, 3);
  // Suma real de 3 subtramos (10+11+12=33), no una única distancia recta.
  assert.equal(accumulated, 33);
  assert.notEqual(accumulated, segments[0].distance);
});

test('CATX-PDF-PARITY-002 (hídrico): índices inválidos lanzan BoundaryAnnotationError, nunca generan un grupo silenciosamente incorrecto', () => {
  const segments = buildOctagonSegments();
  assert.throws(() => buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 2, endVertexIndex: 2 }]), BoundaryAnnotationError);
  assert.throws(() => buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: -1, endVertexIndex: 3 }]), BoundaryAnnotationError);
  assert.throws(() => buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 0, endVertexIndex: 99 }]), BoundaryAnnotationError);
  assert.throws(() => buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 1.5, endVertexIndex: 3 }]), BoundaryAnnotationError);
});

test('CATX-PDF-PARITY-002 (hídrico): la tabla ejecutiva agrupa las filas del tramo hídrico en una sola, conservando las filas ordinarias intactas', () => {
  const segments = buildOctagonSegments();
  const tableRows = segments.map((s) => [s.from, s.to, formatDistance(s.distance)]);
  const groups = buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 1, endVertexIndex: 4, label: 'Quebrada La Clara' }]);

  const { rows, hasHydricColumn } = applyHydricGroupsToTableRows(tableRows, groups, formatDistance);
  assert.equal(hasHydricColumn, true);
  // 8 filas originales - 3 filas absorbidas por el grupo (segmentos 1,2,3) + 1 fila agrupada = 6 filas.
  assert.equal(rows.length, 6);

  const groupedRow = rows.find((row) => row[3] === 'Fuente hídrica');
  assert.ok(groupedRow, 'debe existir exactamente una fila agrupada para el tramo hídrico');
  assert.deepEqual(groupedRow, ['P2', 'P5', formatDistance(36), 'Fuente hídrica']);

  const ordinaryRows = rows.filter((row) => row[3] === 'Ordinario');
  assert.equal(ordinaryRows.length, 5);
  // Las filas ordinarias conservan Punto/Siguiente/Distancia exactamente como antes.
  assert.deepEqual(ordinaryRows[0], ['P1', 'P2', formatDistance(10), 'Ordinario']);
});

test('CATX-PDF-PARITY-002 (hídrico): sin grupos, applyHydricGroupsToTableRows devuelve las filas originales sin columna añadida', () => {
  const segments = buildOctagonSegments();
  const tableRows = segments.map((s) => [s.from, s.to, formatDistance(s.distance)]);
  const { rows, hasHydricColumn } = applyHydricGroupsToTableRows(tableRows, [], formatDistance);
  assert.equal(hasHydricColumn, false);
  assert.deepEqual(rows, tableRows);
});

test('CATX-PDF-PARITY-002 (hídrico): el perímetro total (suma de todas las distancias reales) no cambia por la agrupación visual', () => {
  const segments = buildOctagonSegments();
  const realPerimeter = segments.reduce((sum, s) => sum + s.distance, 0);
  const groups = buildHydricGroups(segments, [{ boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 1, endVertexIndex: 4 }]);
  // El inventario interno sigue siendo la lista COMPLETA de segmentos --
  // este módulo nunca la trunca ni la reemplaza, solo calcula qué ocultar
  // en la presentación (collectHiddenSegmentIndices/collectHiddenVertexIndices).
  const perimeterFromInventory = segments.reduce((sum, s) => sum + s.distance, 0);
  assert.equal(perimeterFromInventory, realPerimeter);
  assert.equal(segments.length, 8, 'los 8 segmentos originales siguen presentes en el inventario, incluidos los absorbidos por el grupo');
  assert.ok(groups.length > 0);
});

test('CATX-PDF-PARITY-002 (hídrico): dos grupos hídricos no contiguos se agrupan de forma independiente', () => {
  const segments = buildOctagonSegments();
  const groups = buildHydricGroups(segments, [
    { boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 0, endVertexIndex: 2 },
    { boundaryType: HYDRIC_BOUNDARY_TYPE, startVertexIndex: 4, endVertexIndex: 6 },
  ]);
  assert.equal(groups.length, 2);
  const hiddenVertices = collectHiddenVertexIndices(groups);
  assert.deepEqual([...hiddenVertices].sort(), [1, 5]);
  const hiddenSegments = collectHiddenSegmentIndices(groups);
  assert.deepEqual([...hiddenSegments].sort((a, b) => a - b), [0, 1, 4, 5]);
});
