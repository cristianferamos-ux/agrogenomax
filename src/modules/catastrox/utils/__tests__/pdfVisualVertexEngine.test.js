// Pruebas de regresion del motor EXISTENTE de limpieza y seleccion visual de
// vertices usado por los PDF (Auditoria 018-A, Implementacion 018-B1).
//
// Estas pruebas protegen el comportamiento actual -- no modifican ni
// recalibran el motor. Todos los fixtures son sinteticos (ninguna geometria
// real ni catastrox-lookup-test.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDisplayRingFromOriginalRing } from '../CartographicPresentationEngine.js';
import { selectVisibleReferencePoints, reducePointsForVisualClarity } from '../VisibleReferencePointEngine.js';
import { buildReferenceRows, buildReferenceSegments } from '../DistanceEngine.js';
import { haversineMeters } from '../GeometryCore.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const deliverablesSourcePath = path.join(currentDir, '..', 'catastroxDeliverables.js');
const kmlSourcePath = deliverablesSourcePath;

// Coordenadas WGS84 realistas (cerca de Florencia, Caqueta) para que las
// tolerancias del motor (definidas en metros reales) se comporten como en
// produccion -- usar "grados" a escala arbitraria distorsiona por completo el
// resultado (ya documentado en la Auditoria 018-A).
const BASE_LNG = -75.61;
const BASE_LAT = 1.61;
const M_PER_DEG_LAT = 111000;
const M_PER_DEG_LNG = 111266;

function metersToDeg(dxMeters, dyMeters) {
  return [BASE_LNG + dxMeters / M_PER_DEG_LNG, BASE_LAT + dyMeters / M_PER_DEG_LAT];
}

function closeRing(openRing) {
  return [...openRing, openRing[0]];
}

function rectangleWithPointsPerSide(widthM, heightM, pointsPerSide) {
  const corners = [[0, 0], [widthM, 0], [widthM, heightM], [0, heightM]];
  const ring = [];
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    ring.push(a);
    for (let k = 1; k <= pointsPerSide; k += 1) {
      const t = k / (pointsPerSide + 1);
      ring.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return closeRing(ring.map(([x, y]) => metersToDeg(x, y)));
}

test('M1) rectangulo con muchos puntos colineales por lado: buildDisplayRingFromOriginalRing conserva solo las 4 esquinas', () => {
  const ring = rectangleWithPointsPerSide(800, 500, 60); // 244 vertices reales
  const originalSnapshot = JSON.parse(JSON.stringify(ring));

  const result = buildDisplayRingFromOriginalRing(ring);

  assert.equal(result.report.totalOriginalVertices, 244);
  assert.equal(result.displayVertices.length, 4, 'un rectangulo perfecto debe reducirse a exactamente 4 esquinas');
  assert.ok(result.report.removedByCollinearity >= 239, 'debe eliminar los puntos colineales intermedios');

  // Cada vertice conservado debe traer un originalIndex numerico valido y
  // apuntar exactamente al mismo punto del anillo original (sin proximidad).
  result.displayVertices.forEach((vertex) => {
    assert.equal(typeof vertex.originalIndex, 'number');
    const openRing = ring.slice(0, -1);
    assert.deepEqual(vertex.point, openRing[vertex.originalIndex]);
  });

  // El anillo original no debe mutarse.
  assert.deepStrictEqual(ring, originalSnapshot);
});

test('M2) triangulo: conserva las 3 esquinas, ninguna se elimina', () => {
  const ring = closeRing([metersToDeg(0, 0), metersToDeg(100, 0), metersToDeg(50, 80)]);
  const result = buildDisplayRingFromOriginalRing(ring);

  assert.ok(result.displayVertices.length >= 3, 'un triangulo nunca debe quedar con menos de 3 vertices utiles');
  const selection = selectVisibleReferencePoints(result.displayRing.length ? result.displayRing : ring, {});
  assert.equal(selection.selectedCandidates.length, 3);
  selection.selectedCandidates.forEach((candidate) => {
    assert.equal(typeof candidate.index, 'number');
  });
});

test('M3) poligono irregular simple: conserva cambios claros de direccion y nunca produce menos de 3 vertices', () => {
  const ring = closeRing([
    metersToDeg(0, 0),
    metersToDeg(30, -5),
    metersToDeg(80, 0),
    metersToDeg(100, 40),
    metersToDeg(60, 90),
    metersToDeg(20, 70),
    metersToDeg(-10, 30),
  ]);
  const selection = selectVisibleReferencePoints(ring, {});

  assert.ok(selection.selectedCandidates.length >= 3);
  const indices = selection.selectedCandidates.map((c) => c.index);
  const sortedUnique = [...new Set(indices)].sort((a, b) => a - b);
  assert.equal(indices.length, sortedUnique.length, 'no debe haber indices duplicados');
  sortedUnique.forEach((index) => assert.ok(index >= 0 && index < 7));
});

test('M4) cobertura cardinal: ningun lado (oeste/este/norte/sur) queda sin representacion', () => {
  const ring = rectangleWithPointsPerSide(800, 500, 60); // 244 vertices reales
  const selection = selectVisibleReferencePoints(ring, {});

  const sides = { west: 0, east: 0, north: 0, south: 0 };
  selection.selectedCandidates.forEach((candidate) => {
    if (candidate.primarySide && sides[candidate.primarySide] !== undefined) {
      sides[candidate.primarySide] += 1;
    }
  });

  assert.ok(sides.west > 0, 'lado oeste sin puntos visibles');
  assert.ok(sides.east > 0, 'lado este sin puntos visibles');
  assert.ok(sides.north > 0, 'lado norte sin puntos visibles');
  assert.ok(sides.south > 0, 'lado sur sin puntos visibles');
  assert.equal(selection.report.validation, 'OK');
});

test('M5) plano y tabla sincronizados: referencePoints, referenceRows y referenceSegments coinciden en cantidad y orden', () => {
  const ring = closeRing([metersToDeg(0, 0), metersToDeg(100, 0), metersToDeg(100, 60), metersToDeg(0, 60)]);
  const selection = selectVisibleReferencePoints(ring, {});
  const reduced = reducePointsForVisualClarity(selection.selectedCandidates, ring, { scale: 1, centerWorldX: 0, centerWorldY: 0 }, { x: 0, y: 0, width: 400, height: 400 }, {});

  const referencePoints = reduced.map((entry) => ({ point: entry.point, originalIndex: entry.index }));
  const referenceRows = buildReferenceRows(referencePoints);
  const referenceSegments = buildReferenceSegments(ring, referencePoints);

  assert.equal(referencePoints.length, referenceRows.length);
  assert.equal(referencePoints.length, referenceSegments.length);

  referenceRows.forEach((row, index) => {
    assert.equal(row.point, `P${index + 1}`);
    assert.equal(referenceSegments[index].from, `P${index + 1}`);
  });

  // El ultimo segmento debe enlazar de vuelta al primer punto visible (anillo cerrado).
  const last = referenceSegments[referenceSegments.length - 1];
  assert.equal(last.to, 'P1');
});

test('M6) trazabilidad por originalIndex: el punto util coincide exactamente con el vertice del anillo original en ese indice (nunca por proximidad)', () => {
  const ring = rectangleWithPointsPerSide(200, 120, 5); // 24 vertices reales
  const openRing = ring.slice(0, -1);
  const display = buildDisplayRingFromOriginalRing(ring);

  display.displayVertices.forEach((vertex) => {
    const originalPoint = openRing[vertex.originalIndex];
    assert.deepEqual(vertex.point, originalPoint, 'el punto util debe ser exactamente el punto original en ese indice, no el mas cercano');
  });
});

test('M7) distancia acumulada: buildReferenceSegments suma los segmentos originales del recorrido, no la cuerda directa', () => {
  // A -> P (desvio) -> B -> C: un recorrido con un desvio real entre A y C.
  const a = metersToDeg(0, 0);
  const detour = metersToDeg(2, 5);
  const b = metersToDeg(4, 0);
  const c = metersToDeg(8, 0);
  const d = metersToDeg(8, 6);
  const e = metersToDeg(0, 6);
  const ring = closeRing([a, detour, b, c, d, e]);

  // Puntos utiles: A (indice 0) y C (indice 3), saltando el desvio (detour, B).
  const referencePoints = [
    { point: a, originalIndex: 0 },
    { point: c, originalIndex: 3 },
  ];
  const segments = buildReferenceSegments(ring, referencePoints);

  const expectedSum = haversineMeters(a, detour) + haversineMeters(detour, b) + haversineMeters(b, c);
  const directChord = haversineMeters(a, c);

  assert.ok(Math.abs(segments[0].distance - expectedSum) < 0.01, `la distancia debe ser la suma de tramos originales (${expectedSum}), no ${segments[0].distance}`);
  assert.ok(segments[0].distance > directChord + 0.5, 'la suma por el desvio real debe ser mayor que la cuerda directa A-C');
});

test('M8) geometria original intacta: el pipeline completo no muta el anillo de entrada', () => {
  const ring = rectangleWithPointsPerSide(300, 200, 8);
  const snapshot = JSON.parse(JSON.stringify(ring));

  const display = buildDisplayRingFromOriginalRing(ring);
  const selection = selectVisibleReferencePoints(display.displayRing, {});
  reducePointsForVisualClarity(selection.selectedCandidates, display.displayRing, { scale: 1, centerWorldX: 0, centerWorldY: 0 }, { x: 0, y: 0, width: 400, height: 400 }, {});

  assert.deepStrictEqual(ring, snapshot, 'el anillo original no debe mutarse en ningun punto del pipeline');
});

test('M9) archivos tecnicos aislados: buildKmlText/buildShpZipBytes/buildDxfText/buildCoordinatesZipBytes no referencian el motor visual', () => {
  const source = readFileSync(kmlSourcePath, 'utf8');
  const forbiddenTokens = ['referencePoints', 'displayRing', 'displayVertices', 'selectVisibleReferencePoints', 'reducePointsForVisualClarity'];
  const functionNames = ['buildKmlText', 'buildShpZipBytes', 'buildDxfText', 'buildCoordinatesZipBytes', 'writeShapefileParts', 'buildCoordinateCsvRows'];

  functionNames.forEach((functionName) => {
    const startPattern = new RegExp(`(export )?(async )?function ${functionName}\\(`);
    const startMatch = source.match(startPattern);
    assert.ok(startMatch, `no se encontro la funcion ${functionName} en el archivo fuente`);
    const startIndex = source.indexOf(startMatch[0]);

    // Localiza el cierre de la funcion contando llaves de forma simple desde
    // la primera '{' encontrada tras la firma.
    const braceStart = source.indexOf('{', startIndex);
    let depth = 0;
    let endIndex = braceStart;
    for (let i = braceStart; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
    const body = source.slice(startIndex, endIndex + 1);

    forbiddenTokens.forEach((token) => {
      assert.ok(!body.includes(token), `${functionName} no debe referenciar "${token}" (motor visual exclusivo de PDF)`);
    });
  });
});
