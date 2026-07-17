import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShpZipBytes } from '../catastroxDeliverables.js';

// Regresion para CX-FILE-005: el .shp real (dentro del ZIP producido por
// buildShpZipBytes) debe conservar todos los anillos exteriores e
// interiores (huecos) de Polygon/MultiPolygon, con numParts/PartStart
// correctos, cierre de anillo, orientacion ESRI (exterior CW, interior
// CCW) y asociacion correcta hueco<->parte. Se parsea el binario real, no
// se confia en que buildShapefileOrientedParts se llame como se espera.
// Todas las geometrias son sinteticas (coordenadas metricas arbitrarias);
// ningun predio real.

function extractZipEntry(zipBytes, suffix) {
  const buffer = Buffer.from(zipBytes);
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.slice(offset + 30, offset + 30 + fileNameLength).toString('utf8');
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (fileName.endsWith(suffix)) {
      return { fileName, data: buffer.slice(dataStart, dataEnd) };
    }
    offset = dataEnd;
  }
  throw new Error(`No se encontro entrada con sufijo ${suffix} en el ZIP`);
}

function parseShp(bytes) {
  const buf = Buffer.from(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const fileCode = view.getInt32(0, false);
  const version = view.getInt32(28, true);
  const shapeType = view.getInt32(32, true);
  const recShapeType = view.getInt32(108, true);
  const numParts = view.getInt32(144, true);
  const numPoints = view.getInt32(148, true);

  const partStarts = [];
  for (let i = 0; i < numParts; i += 1) {
    partStarts.push(view.getInt32(152 + i * 4, true));
  }

  const pointsBase = 152 + numParts * 4;
  const points = [];
  for (let i = 0; i < numPoints; i += 1) {
    const x = view.getFloat64(pointsBase + i * 16, true);
    const y = view.getFloat64(pointsBase + i * 16 + 8, true);
    points.push([x, y]);
  }

  const rings = partStarts.map((start, i) => {
    const end = i + 1 < partStarts.length ? partStarts[i + 1] : numPoints;
    return points.slice(start, end);
  });

  return { fileCode, version, shapeType, recShapeType, numParts, numPoints, partStarts, rings };
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function ringsApproxEqualAsSet(ringA, ringB) {
  if (ringA.length !== ringB.length) return false;
  const keyOf = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const setA = new Set(ringA.map(keyOf));
  const setB = new Set(ringB.map(keyOf));
  if (setA.size !== setB.size) return false;
  for (const key of setA) if (!setB.has(key)) return false;
  return true;
}

function isClosed(ring) {
  return ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
}

function buildSource(projectedGeometry, overrides = {}) {
  return {
    predio: {
      codigoPredial: '000000000000000000000000TEST0',
      municipio: 'MUNICIPIO-SINTETICO',
      departamento: 'DEPARTAMENTO-SINTETICO',
      zona: 'rural',
      areaM2: 1000,
      areaHa: 0.1,
      perimetroM: 400,
      projectedGeometry,
      ...overrides,
    },
  };
}

const CCW_UNIT = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const CW_UNIT = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
const CCW_HOLE_UNIT = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
const CW_HOLE_UNIT = [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]];

function shift(ring, dx, dy) {
  return ring.map(([x, y]) => [x + dx, y + dy]);
}

const OX = 4860000;
const OY = 1590000;

test('A. Polygon sin huecos: numParts=1 sin partes espurias, cerrado, exterior CW', () => {
  const outer = shift(CCW_UNIT, OX, OY);
  const geometry = { type: 'Polygon', coordinates: [outer] };
  const zipBytes = buildShpZipBytes(buildSource(geometry, { codigoPredial: '000000000000000000000000CAA1' }));
  const shp = parseShp(extractZipEntry(zipBytes, '.shp').data);

  assert.equal(shp.fileCode, 9994);
  assert.equal(shp.version, 1000);
  assert.equal(shp.shapeType, 5);
  assert.equal(shp.recShapeType, 5);
  assert.equal(shp.numParts, 1);
  assert.equal(shp.numPoints, 5);
  assert.deepEqual(shp.partStarts, [0]);
  assert.ok(isClosed(shp.rings[0]));
  assert.ok(signedArea(shp.rings[0]) < 0, 'exterior debe quedar CW');
  assert.ok(ringsApproxEqualAsSet(shp.rings[0], outer));
});

test('B. Polygon con un hueco: hueco serializado, asociado y orientado correctamente', () => {
  const outer = shift(CCW_UNIT, OX + 1000, OY);
  const hole = shift(CW_HOLE_UNIT, OX + 1000, OY);
  const geometry = { type: 'Polygon', coordinates: [outer, hole] };
  const zipBytes = buildShpZipBytes(buildSource(geometry, { codigoPredial: '000000000000000000000000CAA2' }));
  const shp = parseShp(extractZipEntry(zipBytes, '.shp').data);

  assert.equal(shp.numParts, 2, 'el hueco debe generar una parte adicional');
  assert.equal(shp.numPoints, 10);
  assert.deepEqual(shp.partStarts, [0, 5]);
  assert.ok(shp.rings.every(isClosed));
  assert.ok(signedArea(shp.rings[0]) < 0, 'exterior CW');
  assert.ok(signedArea(shp.rings[1]) > 0, 'hueco CCW');
  assert.ok(ringsApproxEqualAsSet(shp.rings[0], outer));
  assert.ok(ringsApproxEqualAsSet(shp.rings[1], hole));
});

test('C. Polygon con varios huecos: ninguno se pierde ni se duplica', () => {
  const outer = shift([[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], OX + 2000, OY);
  const hole1 = shift(CCW_HOLE_UNIT, OX + 2000, OY);
  const hole2 = shift(CW_HOLE_UNIT, OX + 2010, OY);
  const geometry = { type: 'Polygon', coordinates: [outer, hole1, hole2] };
  const zipBytes = buildShpZipBytes(buildSource(geometry, { codigoPredial: '000000000000000000000000CAA3' }));
  const shp = parseShp(extractZipEntry(zipBytes, '.shp').data);

  assert.equal(shp.numParts, 3);
  assert.equal(shp.numPoints, 15);
  assert.deepEqual(shp.partStarts, [0, 5, 10]);
  assert.ok(signedArea(shp.rings[0]) < 0);
  assert.ok(signedArea(shp.rings[1]) > 0);
  assert.ok(signedArea(shp.rings[2]) > 0);
  assert.ok(ringsApproxEqualAsSet(shp.rings[0], outer));
  assert.ok(ringsApproxEqualAsSet(shp.rings[1], hole1));
  assert.ok(ringsApproxEqualAsSet(shp.rings[2], hole2));
  assert.ok(!ringsApproxEqualAsSet(shp.rings[1], shp.rings[2]), 'hole1 y hole2 no deben ser el mismo anillo duplicado');
});

test('D. MultiPolygon con hueco solo en una parte: sin hueco espurio y sin mezcla entre partes', () => {
  const outer1 = shift(CCW_UNIT, OX + 3000, OY);
  const outer2 = shift(CW_UNIT, OX + 3100, OY);
  const hole2 = shift(CCW_HOLE_UNIT, OX + 3100, OY);
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [[outer1], [outer2, hole2]],
  };
  const zipBytes = buildShpZipBytes(buildSource(geometry, { codigoPredial: '000000000000000000000000CAA4' }));
  const shp = parseShp(extractZipEntry(zipBytes, '.shp').data);

  assert.equal(shp.numParts, 3, 'outer1 + outer2 + hole2, la parte 1 no debe generar hueco espurio');
  assert.equal(shp.numPoints, 15);
  assert.deepEqual(shp.partStarts, [0, 5, 10]);
  assert.ok(ringsApproxEqualAsSet(shp.rings[0], outer1));
  assert.ok(ringsApproxEqualAsSet(shp.rings[1], outer2));
  assert.ok(ringsApproxEqualAsSet(shp.rings[2], hole2));
  assert.ok(signedArea(shp.rings[0]) < 0);
  assert.ok(signedArea(shp.rings[1]) < 0);
  assert.ok(signedArea(shp.rings[2]) > 0);
});

test('E. MultiPolygon con huecos en varias partes: orden y orientacion preservados por parte', () => {
  const outer1 = shift(CCW_UNIT, OX + 4000, OY);
  const hole1 = shift(CW_HOLE_UNIT, OX + 4000, OY);
  const outer2 = shift(CW_UNIT, OX + 4100, OY);
  const hole2 = shift(CCW_HOLE_UNIT, OX + 4100, OY);
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [[outer1, hole1], [outer2, hole2]],
  };
  const zipBytes = buildShpZipBytes(buildSource(geometry, { codigoPredial: '000000000000000000000000CAA5' }));
  const shp = parseShp(extractZipEntry(zipBytes, '.shp').data);

  assert.equal(shp.numParts, 4);
  assert.equal(shp.numPoints, 20);
  assert.deepEqual(shp.partStarts, [0, 5, 10, 15]);
  assert.ok(ringsApproxEqualAsSet(shp.rings[0], outer1));
  assert.ok(ringsApproxEqualAsSet(shp.rings[1], hole1));
  assert.ok(ringsApproxEqualAsSet(shp.rings[2], outer2));
  assert.ok(ringsApproxEqualAsSet(shp.rings[3], hole2));
  assert.ok(signedArea(shp.rings[0]) < 0 && signedArea(shp.rings[1]) > 0);
  assert.ok(signedArea(shp.rings[2]) < 0 && signedArea(shp.rings[3]) > 0);
});

test('F. Anillos abiertos: se cierran en produccion (4 -> 5 puntos) antes de orientarse', () => {
  const outerOpen = shift(CCW_UNIT.slice(0, 4), OX + 5000, OY);
  const holeOpen = shift(CW_HOLE_UNIT.slice(0, 4), OX + 5000, OY);
  assert.ok(!isClosed(outerOpen), 'precondicion: el exterior debe entrar abierto');
  assert.ok(!isClosed(holeOpen), 'precondicion: el hueco debe entrar abierto');

  const expectedOuter = [...outerOpen, outerOpen[0]];
  const expectedHole = [...holeOpen, holeOpen[0]];
  const geometry = { type: 'Polygon', coordinates: [outerOpen, holeOpen] };
  const zipBytes = buildShpZipBytes(buildSource(geometry, { codigoPredial: '000000000000000000000000CAA6' }));
  const shp = parseShp(extractZipEntry(zipBytes, '.shp').data);

  assert.equal(shp.numParts, 2);
  assert.equal(shp.numPoints, 10, 'cada anillo de 4 puntos debe cerrarse a 5');
  assert.ok(isClosed(shp.rings[0]));
  assert.ok(isClosed(shp.rings[1]));
  assert.equal(shp.rings[0][4][0], outerOpen[0][0]);
  assert.equal(shp.rings[0][4][1], outerOpen[0][1]);
  assert.equal(shp.rings[1][4][0], holeOpen[0][0]);
  assert.equal(shp.rings[1][4][1], holeOpen[0][1]);
  assert.ok(ringsApproxEqualAsSet(shp.rings[0], expectedOuter));
  assert.ok(ringsApproxEqualAsSet(shp.rings[1], expectedHole));
  assert.ok(signedArea(shp.rings[0]) < 0);
  assert.ok(signedArea(shp.rings[1]) > 0);
});
