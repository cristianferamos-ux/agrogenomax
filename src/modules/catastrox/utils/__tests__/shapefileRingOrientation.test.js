import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSignedRingArea,
  ensureClosedRing,
  orientRingForShapefile,
  buildShapefileOrientedParts,
} from '../catastroxDeliverables.js';

// Cuadrado en sentido antihorario (CCW): area firmada positiva, verificado con la
// formula shoelace estandar para (lng=X, lat=Y, Y creciente hacia el norte).
const CCW_SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
// Mismo cuadrado, orden invertido: sentido horario (CW), area firmada negativa.
const CW_SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
const CCW_SQUARE_OPEN = [[0, 0], [10, 0], [10, 10], [0, 10]];
const CCW_HOLE = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
const CW_HOLE = [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]];

test('1. Exterior CCW se convierte a CW', () => {
  const result = orientRingForShapefile(CCW_SQUARE, 'outer');
  assert.equal(calculateSignedRingArea(result) < 0, true, 'debe quedar en sentido horario (area negativa)');
});

test('2. Exterior CW se conserva tal cual (misma secuencia)', () => {
  const result = orientRingForShapefile(CW_SQUARE, 'outer');
  assert.deepEqual(result, CW_SQUARE);
});

test('3. Interior CW se convierte a CCW', () => {
  const result = orientRingForShapefile(CW_HOLE, 'inner');
  assert.equal(calculateSignedRingArea(result) > 0, true, 'debe quedar en sentido antihorario (area positiva)');
});

test('4. Interior CCW se conserva tal cual (misma secuencia)', () => {
  const result = orientRingForShapefile(CCW_HOLE, 'inner');
  assert.deepEqual(result, CCW_HOLE);
});

test('5. Anillo abierto se cierra correctamente antes de orientar', () => {
  const result = orientRingForShapefile(CCW_SQUARE_OPEN, 'outer');
  assert.deepEqual(result[0], result[result.length - 1], 'primer y ultimo punto deben coincidir');
  assert.equal(result.length, 5, 'debe agregarse exactamente un punto de cierre');
});

test('6. Anillo ya cerrado no duplica el punto de cierre', () => {
  const closed = ensureClosedRing(CCW_SQUARE);
  assert.equal(closed.length, CCW_SQUARE.length, 'no debe crecer si ya estaba cerrado');
});

test('7. orientRingForShapefile no muta el arreglo original', () => {
  const original = CCW_SQUARE.map((p) => [...p]);
  const snapshot = JSON.parse(JSON.stringify(original));
  orientRingForShapefile(original, 'outer');
  assert.deepEqual(original, snapshot, 'el arreglo de entrada debe permanecer intacto');
});

test('7b. ensureClosedRing no muta el arreglo original al cerrar uno abierto', () => {
  const original = CCW_SQUARE_OPEN.map((p) => [...p]);
  const snapshot = JSON.parse(JSON.stringify(original));
  ensureClosedRing(original);
  assert.deepEqual(original, snapshot);
});

test('8. Poligono con 21 huecos: 1 exterior CW + 21 interiores CCW', () => {
  const huecos = Array.from({ length: 21 }, (_, i) => {
    const base = i * 0.1;
    return [[base, base], [base, base + 0.05], [base + 0.05, base + 0.05], [base + 0.05, base], [base, base]];
  });
  const parts = buildShapefileOrientedParts([{ outerRing: CCW_SQUARE, innerRings: huecos }]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].innerRings.length, 21);
  assert.equal(calculateSignedRingArea(parts[0].outerRing) < 0, true);
  parts[0].innerRings.forEach((ring) => {
    assert.equal(calculateSignedRingArea(ring) > 0, true);
  });
});

test('9. MultiPolygon con 5 exteriores y 4 huecos distribuidos', () => {
  const geometryParts = [
    { outerRing: CCW_SQUARE, innerRings: [CW_HOLE] },
    { outerRing: CW_SQUARE, innerRings: [] },
    { outerRing: CCW_SQUARE, innerRings: [CW_HOLE, CCW_HOLE] },
    { outerRing: CW_SQUARE, innerRings: [] },
    { outerRing: CCW_SQUARE, innerRings: [CCW_HOLE] },
  ];
  const parts = buildShapefileOrientedParts(geometryParts);
  assert.equal(parts.length, 5);
  const totalInner = parts.reduce((sum, p) => sum + p.innerRings.length, 0);
  assert.equal(totalInner, 4);
  parts.forEach((part) => {
    assert.equal(calculateSignedRingArea(part.outerRing) < 0, true, 'todo exterior debe quedar CW');
    part.innerRings.forEach((ring) => {
      assert.equal(calculateSignedRingArea(ring) > 0, true, 'todo interior debe quedar CCW');
    });
  });
});

test('10. Dos poligonos independientes sin huecos conservan sus 2 partes', () => {
  const parts = buildShapefileOrientedParts([
    { outerRing: CCW_SQUARE, innerRings: [] },
    { outerRing: CW_SQUARE, innerRings: [] },
  ]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].innerRings.length, 0);
  assert.equal(parts[1].innerRings.length, 0);
  parts.forEach((part) => assert.equal(calculateSignedRingArea(part.outerRing) < 0, true));
});

test('11. Isla representada como exterior independiente tambien queda CW', () => {
  // Una isla dentro de un hueco es, en la estructura de geometryParts, otra "parte"
  // con su propio outerRing (no un innerRing anidado), igual que cualquier exterior.
  const geometryParts = [
    { outerRing: CCW_SQUARE, innerRings: [CW_HOLE] },
    { outerRing: CCW_SQUARE.map(([x, y]) => [x + 3, y + 3]), innerRings: [] }, // isla
  ];
  const parts = buildShapefileOrientedParts(geometryParts);
  assert.equal(parts.length, 2);
  parts.forEach((part) => assert.equal(calculateSignedRingArea(part.outerRing) < 0, true));
});

test('12. Anillo invalido con menos de 4 posiciones tras cerrar se excluye', () => {
  const invalido = [[0, 0], [1, 1]]; // 2 puntos -> tras cerrar, 3 posiciones, sigue < 4
  assert.equal(orientRingForShapefile(invalido, 'outer'), null);
  const parts = buildShapefileOrientedParts([{ outerRing: invalido, innerRings: [] }]);
  assert.equal(parts.length, 0, 'la parte completa se excluye si su exterior es invalido');
});

test('13. Anillo degenerado con area cero se excluye', () => {
  const degenerado = [[0, 0], [5, 0], [10, 0], [0, 0]]; // colineal, area = 0
  assert.equal(orientRingForShapefile(degenerado, 'outer'), null);
});

test('14. Conservacion exacta del numero de vertices validos', () => {
  const result = orientRingForShapefile(CCW_SQUARE, 'outer');
  assert.equal(result.length, CCW_SQUARE.length);
  const resultInner = orientRingForShapefile(CW_HOLE, 'inner');
  assert.equal(resultInner.length, CW_HOLE.length);
});

test('15. Conserva el primer vertice cuando no se requiere invertir', () => {
  const result = orientRingForShapefile(CW_SQUARE, 'outer'); // ya CW, no debe invertirse
  assert.deepEqual(result[0], CW_SQUARE[0]);
});

test('16. Resultado final: todos los exteriores CW y todos los interiores CCW (caso mixto)', () => {
  const geometryParts = [
    { outerRing: CCW_SQUARE, innerRings: [CCW_HOLE] }, // exterior mal orientado, hueco mal orientado
    { outerRing: CW_SQUARE, innerRings: [CW_HOLE] }, // exterior bien orientado, hueco mal orientado
  ];
  const parts = buildShapefileOrientedParts(geometryParts);
  parts.forEach((part) => {
    assert.equal(calculateSignedRingArea(part.outerRing) < 0, true);
    part.innerRings.forEach((ring) => assert.equal(calculateSignedRingArea(ring) > 0, true));
  });
});

test('17. Secuencia por parte: exterior e interiores nunca se concatenan ni se reordenan globalmente', () => {
  const geometryParts = [
    { outerRing: CCW_SQUARE, innerRings: [CW_HOLE] },
    { outerRing: CW_SQUARE, innerRings: [] },
  ];
  const parts = buildShapefileOrientedParts(geometryParts);
  // La estructura por parte se conserva (no es un arreglo plano de anillos mezclados).
  assert.equal(Array.isArray(parts[0].innerRings), true);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].innerRings.length, 1);
  assert.equal(parts[1].innerRings.length, 0);
});
