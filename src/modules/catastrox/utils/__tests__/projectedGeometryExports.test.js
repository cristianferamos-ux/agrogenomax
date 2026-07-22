import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProjectedGeometryFor9377,
  buildCoordinatesZipBytes,
  buildDxfText,
  buildShpZipBytes,
} from '../catastroxDeliverables.js';
import zlib from 'node:zlib';

const WGS84_RING = [
  [-74.115774992, 0.332047598],
  [-74.113163564, 0.332047598],
  [-74.113163564, 0.334930294],
  [-74.115774992, 0.334930294],
  [-74.115774992, 0.332047598],
];

function closeRing(points) {
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return points;
  return [...points, first];
}

function buildMetricRing(x0, y0, width, height, vertexCount) {
  const edgePoints = Math.max(vertexCount - 4, 0);
  const bottomExtra = Math.ceil(edgePoints / 4);
  const rightExtra = Math.floor(edgePoints / 4);
  const topExtra = Math.ceil((edgePoints - bottomExtra - rightExtra) / 2);
  const leftExtra = edgePoints - bottomExtra - rightExtra - topExtra;
  const ring = [];
  ring.push([x0, y0]);
  for (let i = 1; i <= bottomExtra + 1; i += 1) {
    ring.push([x0 + (width * i) / (bottomExtra + 1), y0]);
  }
  for (let i = 1; i <= rightExtra + 1; i += 1) {
    ring.push([x0 + width, y0 + (height * i) / (rightExtra + 1)]);
  }
  for (let i = 1; i <= topExtra + 1; i += 1) {
    ring.push([x0 + width - (width * i) / (topExtra + 1), y0 + height]);
  }
  for (let i = 1; i <= leftExtra; i += 1) {
    ring.push([x0, y0 + height - (height * i) / (leftExtra + 1)]);
  }
  return closeRing(ring);
}

function buildCartagenaProjectedGeometry() {
  const vertexCounts = [12, 12, 12, 12, 12, 12, 12, 13];
  const polygons = vertexCounts.map((vertexCount, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x0 = 4875886.05538616 + col * 80;
    const y0 = 1594743.0643133 + row * 120;
    const width = 24 + col * 3;
    const height = 18 + row * 4;
    return [buildMetricRing(x0, y0, width, height, vertexCount)];
  });
  return { type: 'MultiPolygon', coordinates: polygons };
}

function buildAlbaniaProjectedGeometry() {
  return {
    type: 'Polygon',
    coordinates: [[
      [4869000, 1589000],
      [4869010, 1589000],
      [4869015, 1589002],
      [4869020, 1589002],
      [4869020, 1589005],
      [4869015, 1589005],
      [4869010, 1589007],
      [4869000, 1589007],
      [4869000, 1589000],
    ]],
  };
}

function projectToPseudoWgs84(geometry) {
  if (!geometry?.type || !geometry?.coordinates) {
    return {
      type: 'MultiPolygon',
      coordinates: [[WGS84_RING]],
    };
  }

  const transformPoint = ([x, y]) => {
    const lng = -75.95 + ((x - 4869000) / 100000);
    const lat = 1.18 + ((y - 1589000) / 100000);
    return [Number(lng.toFixed(7)), Number(lat.toFixed(7))];
  };

  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring) => ring.map(transformPoint)),
    };
  }

  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(transformPoint))),
    };
  }

  return {
    type: 'MultiPolygon',
    coordinates: [[WGS84_RING]],
  };
}

function buildSource(projectedGeometry, overrides = {}) {
  return {
    predio: {
      id: overrides.codigoPredial || '181500003000000130054000000000',
      codigoPredial: overrides.codigoPredial || '181500003000000130054000000000',
      codigoAnterior: overrides.codigoAnterior || '181500003000000130054000000000',
      municipio: overrides.municipio || 'CARTAGENA DEL CHAIRA',
      departamento: overrides.departamento || 'CAQUETA',
      tipoZona: overrides.tipoZona || 'rural',
      areaM2: overrides.areaM2 ?? 34926.72,
      areaHa: overrides.areaHa ?? 3.49,
      perimetroM: overrides.perimetroM ?? 2327.96,
      geometry: overrides.geometry || projectToPseudoWgs84(projectedGeometry),
      projectedGeometry,
    },
  };
}

function parseDxfPairs(text) {
  const raw = text.trim().split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i < raw.length; i += 2) {
    pairs.push({ code: raw[i]?.trim() ?? '', value: raw[i + 1] ?? '' });
  }
  return pairs;
}

function parseDxfStructure(text) {
  const pairs = parseDxfPairs(text);
  const sections = [];
  let current = null;
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    if (pair.code === '0' && pair.value === 'SECTION') {
      const name = pairs[i + 1]?.value;
      current = { name, pairs: [] };
      sections.push(current);
      i += 1;
      continue;
    }
    if (pair.code === '0' && pair.value === 'ENDSEC') {
      current = null;
      continue;
    }
    if (current) current.pairs.push(pair);
  }
  return { pairs, sections };
}

function extractZipEntry(zipBytes, suffix) {
  const buffer = Buffer.from(zipBytes);
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.slice(offset + 30, offset + 30 + fileNameLength).toString('utf8');
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (fileName.endsWith(suffix)) {
      const compressed = buffer.slice(dataStart, dataEnd);
      return compression === 0 ? compressed : zlib.inflateRawSync(compressed);
    }
    offset = dataEnd;
  }
  throw new Error(`No se encontro ${suffix} dentro del ZIP`);
}

function getSection(structure, name) {
  return structure.sections.find((section) => section.name === name);
}

function parseLayerColors(tablesSection) {
  const colors = {};
  let currentLayer = null;
  for (let i = 0; i < tablesSection.pairs.length; i += 1) {
    const pair = tablesSection.pairs[i];
    if (pair.code === '0' && pair.value === 'LAYER') {
      currentLayer = null;
      continue;
    }
    if (pair.code === '2') {
      currentLayer = pair.value;
      continue;
    }
    if (pair.code === '62' && currentLayer) {
      colors[currentLayer] = Number(pair.value);
      currentLayer = null;
    }
  }
  return colors;
}

function countSectionEntities(section) {
  return section.pairs.filter((pair) => pair.code === '0').map((pair) => pair.value);
}

function parseR12Polylines(section) {
  const polylines = [];
  let current = null;
  for (let i = 0; i < section.pairs.length; i += 1) {
    const pair = section.pairs[i];
    if (pair.code === '0' && pair.value === 'POLYLINE') {
      current = { flags: 0, vertices: [] };
      polylines.push(current);
      continue;
    }
    if (!current) continue;
    if (pair.code === '70' && current.vertices.length === 0 && current.flags === 0) {
      current.flags = Number(pair.value);
      continue;
    }
    if (pair.code === '0' && pair.value === 'VERTEX') {
      let x = null;
      let y = null;
      for (let j = i + 1; j < section.pairs.length; j += 1) {
        const next = section.pairs[j];
        if (next.code === '0') break;
        if (next.code === '10') x = Number(next.value);
        if (next.code === '20') y = Number(next.value);
      }
      current.vertices.push([x, y]);
      continue;
    }
    if (pair.code === '0' && pair.value === 'SEQEND') {
      current = null;
    }
  }
  return polylines;
}

function collectGeometryPoints(section) {
  const points = [];
  let active = null;
  for (let i = 0; i < section.pairs.length; i += 1) {
    const pair = section.pairs[i];
    if (pair.code === '0') {
      active = pair.value;
      continue;
    }
    if (!['POINT', 'CIRCLE', 'TEXT', 'VERTEX'].includes(active)) continue;
    if (pair.code === '10') {
      const yPair = section.pairs[i + 1];
      if (yPair?.code === '20') {
        points.push([Number(pair.value), Number(yPair.value)]);
      }
    }
  }
  return points;
}

function bboxOf(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

test('1. projectedGeometry metrica valida pasa la guardia EPSG:9377', () => {
  const bbox = assertProjectedGeometryFor9377([{ outerRing: buildMetricRing(4875886, 1594743, 20, 10, 8), innerRings: [] }]);
  assert.equal(bbox.minX > 1000000, true);
  assert.equal(bbox.maxY > 1000000, true);
});

test('2. projectedGeometry en lon/lat se bloquea antes de exportar SHP/DXF', () => {
  const source = buildSource({
    type: 'MultiPolygon',
    coordinates: [[WGS84_RING]],
  });
  assert.throws(() => buildShpZipBytes(source), /ProjectedGeometry invalida/i);
  assert.throws(() => buildDxfText(source), /ProjectedGeometry invalida/i);
});

test('3. falta projectedGeometry se bloquea para SHP/DXF profesional', () => {
  const source = buildSource(null);
  assert.throws(() => buildShpZipBytes(source), /ProjectedGeometry no disponible/i);
  assert.throws(() => buildDxfText(source), /ProjectedGeometry no disponible/i);
});

test('4. area_m2 conserva los dos decimales canonicos dentro del DBF del ZIP', () => {
  const source = buildSource(buildCartagenaProjectedGeometry());
  const zipBytes = buildShpZipBytes(source);
  const dbfText = extractZipEntry(zipBytes, '.dbf').toString('utf8');
  assert.match(dbfText, /34926\.72/);
  assert.doesNotMatch(dbfText, /34927\.00/);
});

test('5. DXF R12 de Cartagena es estructuralmente coherente y conserva 8 componentes / 97 vertices', () => {
  const source = buildSource(buildCartagenaProjectedGeometry());
  const dxf = buildDxfText(source);
  const structure = parseDxfStructure(dxf);
  const entities = getSection(structure, 'ENTITIES');
  const header = getSection(structure, 'HEADER');
  const tables = getSection(structure, 'TABLES');
  const blocks = getSection(structure, 'BLOCKS');

  assert.ok(header);
  assert.ok(tables);
  assert.ok(blocks);
  assert.ok(entities);
  assert.match(dxf, /\$ACADVER\n1\nAC1009/);
  assert.match(dxf, /0\nEOF\n?$/);
  assert.doesNotMatch(dxf, /LWPOLYLINE/);
  assert.doesNotMatch(dxf, /AcDbPolyline|AcDbEntity/);
  assert.doesNotMatch(dxf, /CATASTROX_ADVERTENCIA|reproyecc/i);

  const layerColors = parseLayerColors(tables);
  assert.equal(layerColors.CATASTROX_POLIGONO > 0, true);
  assert.equal(layerColors.CATASTROX_VERTICES < 0, true);
  assert.equal(layerColors.CATASTROX_ETIQUETAS < 0, true);
  assert.equal(layerColors.CATASTROX_INFO < 0, true);

  const entityNames = countSectionEntities(entities);
  assert.equal(entityNames.filter((name) => name === 'POLYLINE').length, 8);
  assert.equal(entityNames.filter((name) => name === 'SEQEND').length, 8);
  assert.equal(entityNames.filter((name) => name === 'VERTEX').length, 97);
  assert.equal(entityNames.filter((name) => name === 'POINT').length, 97);
  assert.equal(entityNames.filter((name) => name === 'CIRCLE').length, 97);
  assert.equal(entityNames.filter((name) => name === 'TEXT').length >= 105, true);

  const polylines = parseR12Polylines(entities);
  assert.equal(polylines.length, 8);
  assert.equal(polylines.every((polyline) => (polyline.flags & 1) === 1), true);
  assert.equal(polylines.reduce((sum, polyline) => sum + polyline.vertices.length, 0), 97);

  const points = collectGeometryPoints(entities);
  const bbox = bboxOf(points);
  assert.equal(bbox.minX > 1000000, true);
  assert.equal(bbox.maxY > 1000000, true);
  assert.doesNotMatch(dxf, /-74\.11|0\.33/);

  const infoPoints = [];
  let activeEntity = null;
  let activeLayer = null;
  for (let i = 0; i < entities.pairs.length; i += 1) {
    const pair = entities.pairs[i];
    if (pair.code === '0') {
      activeEntity = pair.value;
      activeLayer = null;
      continue;
    }
    if (activeEntity !== 'TEXT') continue;
    if (pair.code === '8') {
      activeLayer = pair.value;
      continue;
    }
    if (activeLayer === 'CATASTROX_INFO' && pair.code === '10') {
      const yPair = entities.pairs[i + 1];
      if (yPair?.code === '20') {
        infoPoints.push([Number(pair.value), Number(yPair.value)]);
      }
    }
  }
  const infoBbox = bboxOf(infoPoints);
  assert.equal(infoBbox.minX > 4876176.56847667, true);
  assert.equal(infoBbox.maxX < 4876176.56847667 + 290.6 * 0.9, true);
});

test('6. DXF de Albania mantiene una sola parte y 8 vertices reales en EPSG:9377', () => {
  const source = buildSource(buildAlbaniaProjectedGeometry(), {
    codigoPredial: '180290001000000230067000000000',
    codigoAnterior: '180290001000000230067000000000',
    municipio: 'ALBANIA',
    departamento: 'CAQUETA',
    areaM2: 100,
    areaHa: 0.01,
    perimetroM: 50,
  });
  const dxf = buildDxfText(source);
  const structure = parseDxfStructure(dxf);
  const entities = getSection(structure, 'ENTITIES');
  const tables = getSection(structure, 'TABLES');
  const polylines = parseR12Polylines(entities);
  assert.equal(polylines.length, 1);
  assert.equal(polylines[0].vertices.length, 8);
  assert.match(dxf, /EPSG: 9377/);
  assert.match(dxf, /UNIDADES: METROS/);
  assert.doesNotMatch(dxf, /LWPOLYLINE|AcDbPolyline/);
  const layerColors = parseLayerColors(tables);
  assert.equal(layerColors.CATASTROX_POLIGONO > 0, true);
  assert.equal(layerColors.CATASTROX_VERTICES < 0, true);
  assert.equal(layerColors.CATASTROX_ETIQUETAS < 0, true);
  assert.equal(layerColors.CATASTROX_INFO < 0, true);
});

test('7. CSV EPSG:9377 se bloquea si falta projectedGeometry', () => {
  const source = buildSource(null);
  assert.throws(() => buildCoordinatesZipBytes(source), /ProjectedGeometry no disponible/i);
});

test('8. CSV EPSG:9377 se bloquea si projectedGeometry sigue en lon\/lat', () => {
  const source = buildSource({
    type: 'Polygon',
    coordinates: [WGS84_RING],
  });
  assert.throws(() => buildCoordinatesZipBytes(source), /ProjectedGeometry invalida/i);
});

test('9. CSV de Cartagena incluye 97 filas, BOM UTF-8 y encabezados esperados', () => {
  const source = buildSource(buildCartagenaProjectedGeometry(), {
    deliverablePackageId: 'profesional',
  });
  const zipBytes = buildCoordinatesZipBytes(source);
  const csvBytes = extractZipEntry(zipBytes, '.csv');
  assert.equal(csvBytes[0], 0xef);
  assert.equal(csvBytes[1], 0xbb);
  assert.equal(csvBytes[2], 0xbf);
  const csvText = csvBytes.toString('utf8');
  const rows = csvText.trim().split(/\r?\n/);
  assert.equal(
    rows[0].replace(/^\uFEFF/, ''),
    'punto;poligono;anillo;tipo_anillo;secuencia;norte_m;este_m;latitud;longitud;siguiente_punto;distancia_m;epsg',
  );
  assert.equal(rows.length - 1, 97);
  assert.match(csvText, /POL1-P1;POL1;EXT1;EXTERIOR;1;/);
  assert.match(csvText, /;9377\r?\n?$/m);
  assert.doesNotMatch(csvText, /-74\.11;0\.33/);
});

test('10. CSV de Albania conserva 8 vertices reales y no duplica el cierre', () => {
  const source = buildSource(buildAlbaniaProjectedGeometry(), {
    codigoPredial: '180290001000000230067000000000',
    codigoAnterior: '180290001000000230067000000000',
    municipio: 'ALBANIA',
    departamento: 'CAQUETA',
    areaM2: 100,
    areaHa: 0.01,
    perimetroM: 50,
  });
  const csvText = extractZipEntry(buildCoordinatesZipBytes(source), '.csv').toString('utf8');
  const rows = csvText.trim().split(/\r?\n/).slice(1).map((row) => row.split(';'));
  assert.equal(rows.length, 8);
  assert.equal(rows[0][0], 'POL1-P1');
  assert.equal(rows[7][0], 'POL1-P8');
  assert.equal(rows[7][9], 'POL1-P1');
});

test('11. CSV con anillo interior etiqueta EXT1 e INT1 y conserva huecos', () => {
  const source = buildSource(
    {
      type: 'Polygon',
      coordinates: [
        [
          [4876000, 1594800],
          [4876100, 1594800],
          [4876100, 1594900],
          [4876000, 1594900],
          [4876000, 1594800],
        ],
        [
          [4876030, 1594830],
          [4876070, 1594830],
          [4876070, 1594870],
          [4876030, 1594870],
          [4876030, 1594830],
        ],
      ],
    },
    {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-74.2, 0.4],
            [-74.1, 0.4],
            [-74.1, 0.5],
            [-74.2, 0.5],
            [-74.2, 0.4],
          ],
          [
            [-74.18, 0.42],
            [-74.14, 0.42],
            [-74.14, 0.46],
            [-74.18, 0.46],
            [-74.18, 0.42],
          ],
        ],
      },
    },
  );
  const csvText = extractZipEntry(buildCoordinatesZipBytes(source), '.csv').toString('utf8');
  assert.match(csvText, /;EXT1;EXTERIOR;/);
  assert.match(csvText, /;INT1;INTERIOR;/);
  const rows = csvText.trim().split(/\r?\n/).slice(1);
  assert.equal(rows.length, 8);
});
