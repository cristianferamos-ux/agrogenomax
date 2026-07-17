import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKmlText, buildKmzBytes } from '../catastroxDeliverables.js';

// Regresion para CX-FILE-004: el pipeline GeoJSON -> KML/KMZ debe conservar
// todos los anillos interiores (huecos) de un Polygon/MultiPolygon, con la
// asociacion correcta parte<->hueco (sin aplanar ni mezclar entre partes de
// un MultiPolygon), y el KML dentro del KMZ debe ser identico byte a byte al
// KML standalone. No basta con que la estructura interna se llame
// `innerRings`: estas pruebas inspeccionan el XML serializado real. Todas
// las geometrias son sinteticas (cuadrados con huecos cuadrados en
// coordenadas WGS84 arbitrarias); ningun predio real.

function buildSource(geometry, overrides = {}) {
  return {
    predio: {
      codigoPredial: '000000000000000000000000TEST0',
      municipio: 'MUNICIPIO-SINTETICO',
      departamento: 'DEPARTAMENTO-SINTETICO',
      zona: 'rural',
      areaM2: 1000,
      areaHa: 0.1,
      perimetroM: 400,
      geometry,
      ...overrides,
    },
  };
}

function countTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s|>)`, 'g');
  return (xml.match(re) || []).length;
}

function polygonBlocks(xml) {
  return xml.match(/<Polygon>[\s\S]*?<\/Polygon>/g) || [];
}

function linearRingBlocks(xml) {
  return xml.match(/<LinearRing>[\s\S]*?<\/LinearRing>/g) || [];
}

// Extrae una entrada del ZIP manual (metodo STORE, sin compresion) que
// genera buildKmzBytes. Mismo patron ya usado en dbfFieldEncoding.test.js /
// projectedGeometryExports.test.js para no depender de una libreria de ZIP.
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

const outerSquare = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const holeSquare = [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]];
const holeSquareB = [[4, 1], [4, 2], [5, 2], [5, 1], [4, 1]];

test('A. Polygon con un hueco: exactamente 1 outerBoundaryIs, 1 innerBoundaryIs con las coordenadas reales del hueco', () => {
  const geometry = { type: 'Polygon', coordinates: [outerSquare, holeSquare] };
  const kml = buildKmlText(buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0A' }));

  assert.equal(countTag(kml, 'outerBoundaryIs'), 1);
  assert.equal(countTag(kml, 'innerBoundaryIs'), 1);
  assert.equal(countTag(kml, 'Polygon'), 1);

  const innerBlock = kml.match(/<innerBoundaryIs>[\s\S]*?<\/innerBoundaryIs>/);
  assert.ok(innerBlock, 'debe existir un bloque innerBoundaryIs');
  assert.ok(innerBlock[0].includes('3,3,0'), 'el bloque innerBoundaryIs debe contener las coordenadas reales del hueco');
});

test('B. Polygon con varios huecos: se serializan todos los innerBoundaryIs, cada uno con sus propias coordenadas', () => {
  const geometry = { type: 'Polygon', coordinates: [outerSquare, holeSquare, holeSquareB] };
  const kml = buildKmlText(buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0B' }));

  assert.equal(countTag(kml, 'outerBoundaryIs'), 1);
  assert.equal(countTag(kml, 'innerBoundaryIs'), 2, 'ambos huecos deben serializarse, ninguno se pierde');
  assert.equal(countTag(kml, 'Polygon'), 1);

  const innerBlocks = kml.match(/<innerBoundaryIs>[\s\S]*?<\/innerBoundaryIs>/g) || [];
  assert.equal(innerBlocks.length, 2);
  assert.ok(innerBlocks.some((block) => block.includes('3,3,0')), 'debe aparecer el primer hueco');
  assert.ok(innerBlocks.some((block) => block.includes('4,1,0')), 'debe aparecer el segundo hueco');
});

test('C. MultiPolygon con hueco solo en una parte: el hueco no se asocia a la parte incorrecta', () => {
  const outerPart1 = [[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]]; // sin hueco
  const outerPart2 = [[40, 40], [50, 40], [50, 50], [40, 50], [40, 40]]; // con hueco
  const holePart2 = [[43, 43], [43, 47], [47, 47], [47, 43], [43, 43]];
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [outerPart1],
      [outerPart2, holePart2],
    ],
  };
  const kml = buildKmlText(buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0C' }));

  assert.equal(countTag(kml, 'outerBoundaryIs'), 2, 'una por parte');
  assert.equal(countTag(kml, 'innerBoundaryIs'), 1, 'solo la parte 2 tiene hueco');
  assert.equal(countTag(kml, 'MultiGeometry'), 1);

  const blocks = polygonBlocks(kml);
  assert.equal(blocks.length, 2, 'deben generarse 2 bloques <Polygon> distintos, inspeccionados por separado');

  const part1Block = blocks.find((block) => block.includes('20,20,0'));
  const part2Block = blocks.find((block) => block.includes('40,40,0'));
  assert.ok(part1Block, 'debe existir el bloque de la parte 1');
  assert.ok(part2Block, 'debe existir el bloque de la parte 2');

  assert.ok(!part1Block.includes('innerBoundaryIs'), 'la parte 1 (sin hueco) NO debe contener innerBoundaryIs');
  assert.ok(part2Block.includes('innerBoundaryIs'), 'la parte 2 (con hueco) debe contener su propio innerBoundaryIs');
  assert.ok(part2Block.includes('43,43,0'), 'el innerBoundaryIs de la parte 2 debe traer las coordenadas reales de su hueco');
});

test('D. MultiPolygon con huecos en varias partes: cada parte conserva unicamente su propio hueco', () => {
  const outerPart1 = [[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]];
  const holePart1 = [[21, 21], [21, 24], [24, 24], [24, 21], [21, 21]];
  const outerPart2 = [[40, 40], [50, 40], [50, 50], [40, 50], [40, 40]];
  const holePart2 = [[43, 43], [43, 47], [47, 47], [47, 43], [43, 43]];
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [outerPart1, holePart1],
      [outerPart2, holePart2],
    ],
  };
  const kml = buildKmlText(buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0D' }));

  assert.equal(countTag(kml, 'innerBoundaryIs'), 2, 'un innerBoundaryIs por cada parte');

  const blocks = polygonBlocks(kml);
  assert.equal(blocks.length, 2);

  const part1Block = blocks.find((block) => block.includes('20,20,0'));
  const part2Block = blocks.find((block) => block.includes('40,40,0'));
  assert.ok(part1Block && part1Block.includes('innerBoundaryIs') && part1Block.includes('21,21,0'), 'la parte 1 debe contener SOLO su propio hueco');
  assert.ok(part2Block && part2Block.includes('innerBoundaryIs') && part2Block.includes('43,43,0'), 'la parte 2 debe contener SOLO su propio hueco');
  assert.ok(!part1Block.includes('43,43,0'), 'el hueco de la parte 2 no debe filtrarse al bloque de la parte 1');
  assert.ok(!part2Block.includes('21,21,0'), 'el hueco de la parte 1 no debe filtrarse al bloque de la parte 2');
});

test('E. Control negativo: Polygon sin huecos no produce innerBoundaryIs espurio', () => {
  const geometry = { type: 'Polygon', coordinates: [outerSquare] };
  const kml = buildKmlText(buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0E' }));

  assert.equal(countTag(kml, 'innerBoundaryIs'), 0);
  assert.equal(countTag(kml, 'outerBoundaryIs'), 1);
});

test('F. KMZ: el KML extraido del KMZ es identico byte a byte al KML standalone y conserva el hueco', () => {
  const geometry = { type: 'Polygon', coordinates: [outerSquare, holeSquare] };
  const source = buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0F' });

  const kmlStandalone = buildKmlText(source);
  const kmzBytes = buildKmzBytes(source);
  const entry = extractZipEntry(kmzBytes, '.kml');
  const kmlFromKmz = entry.data.toString('utf8');

  assert.equal(kmlFromKmz, kmlStandalone, 'el KML dentro del KMZ debe ser identico byte a byte al KML standalone');
  assert.equal(countTag(kmlFromKmz, 'innerBoundaryIs'), 1, 'el hueco tambien debe estar presente dentro del KMZ');

  const innerBlock = kmlFromKmz.match(/<innerBoundaryIs>[\s\S]*?<\/innerBoundaryIs>/);
  assert.ok(innerBlock && innerBlock[0].includes('3,3,0'), 'el innerBoundaryIs dentro del KMZ debe traer las coordenadas reales del hueco');
});

test('G. MultiPolygon con hueco en una parte, empaquetado en KMZ: la asociacion correcta sobrevive dentro del ZIP', () => {
  const outerPart1 = [[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]];
  const outerPart2 = [[40, 40], [50, 40], [50, 50], [40, 50], [40, 40]];
  const holePart2 = [[43, 43], [43, 47], [47, 47], [47, 43], [43, 43]];
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [outerPart1],
      [outerPart2, holePart2],
    ],
  };
  const source = buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0G' });

  const kmzBytes = buildKmzBytes(source);
  const entry = extractZipEntry(kmzBytes, '.kml');
  const kmlFromKmz = entry.data.toString('utf8');

  const blocks = polygonBlocks(kmlFromKmz);
  assert.equal(blocks.length, 2);
  const part1Block = blocks.find((block) => block.includes('20,20,0'));
  const part2Block = blocks.find((block) => block.includes('40,40,0'));
  assert.ok(!part1Block.includes('innerBoundaryIs'), 'dentro del KMZ, la parte sin hueco sigue sin innerBoundaryIs');
  assert.ok(part2Block.includes('innerBoundaryIs') && part2Block.includes('43,43,0'), 'dentro del KMZ, la parte con hueco conserva su innerBoundaryIs');
});

test('H. normalizeRing cierra cada LinearRing abierto antes de serializarlo en KML', () => {
  const outerPart1 = [[20, 20], [25, 20], [25, 25], [20, 25]];
  const holePart1 = [[21, 21], [21, 24], [24, 24], [24, 21]];
  const outerPart2 = [[40, 40], [50, 40], [50, 50], [40, 50]];
  const holePart2 = [[43, 43], [43, 47], [47, 47], [47, 43]];

  for (const inputRing of [outerPart1, holePart1, outerPart2, holePart2]) {
    assert.notDeepEqual(
      inputRing[0],
      inputRing[inputRing.length - 1],
      'el fixture debe entrar abierto para probar el cierre productivo',
    );
  }

  const geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [outerPart1, holePart1],
      [outerPart2, holePart2],
    ],
  };
  const kml = buildKmlText(buildSource(geometry, { codigoPredial: '000000000000000000000000CAS0H' }));

  const rings = linearRingBlocks(kml);
  assert.equal(rings.length, 4, 'debe haber 4 LinearRing: 2 exteriores + 2 interiores');

  for (const ring of rings) {
    const coordsMatch = ring.match(/<coordinates>(.*?)<\/coordinates>/);
    assert.ok(coordsMatch, 'cada LinearRing debe tener un bloque <coordinates>');
    const points = coordsMatch[1].trim().split(/\s+/);
    assert.equal(points.length, 5, 'cada cuadrilatero abierto debe serializarse con 4 vertices mas el cierre');
    assert.equal(
      points[0],
      points[points.length - 1],
      'normalizeRing debe agregar el cierre antes de serializar el KML',
    );
  }
});
