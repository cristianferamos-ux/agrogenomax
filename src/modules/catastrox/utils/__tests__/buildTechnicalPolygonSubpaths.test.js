import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTechnicalPolygonSubpaths } from '../catastroxDeliverables.js';

const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const HOLE_A = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
const HOLE_B = [[6, 6], [8, 6], [8, 8], [6, 8], [6, 6]];

test('1. Exterior sin huecos produce un unico subpath (el exterior)', () => {
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, []);
  assert.equal(subpaths.length, 1);
  assert.deepEqual(subpaths[0], SQUARE);
});

test('2. Exterior con un hueco produce exactamente 2 subpaths', () => {
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, [HOLE_A]);
  assert.equal(subpaths.length, 2);
  assert.deepEqual(subpaths[0], SQUARE);
  assert.deepEqual(subpaths[1], HOLE_A);
});

test('3. Exterior con 21 huecos produce 22 subpaths (caso real El Doncello)', () => {
  const veintiunHuecos = Array.from({ length: 21 }, (_, i) => [
    [i, i], [i + 1, i], [i + 1, i + 1], [i, i + 1], [i, i],
  ]);
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, veintiunHuecos);
  assert.equal(subpaths.length, 22);
  assert.equal(subpaths[0], SQUARE);
  for (let i = 0; i < 21; i++) {
    assert.equal(subpaths[i + 1], veintiunHuecos[i]);
  }
});

test('4. Cinco partes con huecos distribuidos: cada parte se procesa de forma independiente', () => {
  // Simula el caso real El Paujil: 5 partes, 4 anillos interiores en total,
  // distribuidos de forma desigual (no todas las partes tienen hueco).
  const partes = [
    { outerRing: SQUARE, innerRings: [HOLE_A] },
    { outerRing: SQUARE, innerRings: [] },
    { outerRing: SQUARE, innerRings: [HOLE_A, HOLE_B] },
    { outerRing: SQUARE, innerRings: [] },
    { outerRing: SQUARE, innerRings: [HOLE_B] },
  ];
  const subpathsPorParte = partes.map((p) => buildTechnicalPolygonSubpaths(p.outerRing, p.innerRings));
  assert.deepEqual(subpathsPorParte.map((s) => s.length), [2, 1, 3, 1, 2]);
  const totalAnillosInteriores = subpathsPorParte.reduce((sum, s) => sum + (s.length - 1), 0);
  assert.equal(totalAnillosInteriores, 4);
});

test('5. Cada subpath conserva su anillo cerrado (primer y ultimo punto iguales)', () => {
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, [HOLE_A, HOLE_B]);
  subpaths.forEach((ring) => {
    assert.deepEqual(ring[0], ring[ring.length - 1], 'el anillo debe estar cerrado');
  });
});

test('6. Los subpaths nunca se concatenan entre si (permanecen como arreglos independientes)', () => {
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, [HOLE_A, HOLE_B]);
  // Si se hubieran concatenado, habria un unico arreglo plano de puntos en vez de 3
  // arreglos de anillos separados.
  assert.equal(Array.isArray(subpaths), true);
  assert.equal(subpaths.length, 3);
  subpaths.forEach((ring) => assert.equal(Array.isArray(ring), true));
  // Ademas, ningun punto de un anillo debe "fusionarse" con el siguiente: el ultimo
  // punto de un anillo y el primero del siguiente no deben tratarse como continuos.
  assert.notDeepEqual(subpaths[0][subpaths[0].length - 1], subpaths[1][0]);
});

test('7a. Exterior vacio no produce ningun subpath, incluso con huecos presentes', () => {
  const subpaths = buildTechnicalPolygonSubpaths([], [HOLE_A]);
  assert.deepEqual(subpaths, []);
});

test('7b. Anillos interiores vacios o invalidos se descartan sin romper la funcion', () => {
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, [[], null, undefined, HOLE_A]);
  assert.equal(subpaths.length, 2);
  assert.deepEqual(subpaths[1], HOLE_A);
});

test('7c. Sin argumentos no rompe la funcion (valores por defecto)', () => {
  assert.deepEqual(buildTechnicalPolygonSubpaths(), []);
});

test('8. El anillo exterior original se conserva sin modificar (misma referencia y valores)', () => {
  const subpaths = buildTechnicalPolygonSubpaths(SQUARE, [HOLE_A]);
  assert.equal(subpaths[0], SQUARE, 'debe ser la misma referencia, no una copia transformada');
  assert.deepEqual(subpaths[0], SQUARE);
});
