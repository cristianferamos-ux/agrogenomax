// R3.5: regresión de MultiPolygon + anillos interiores (huecos) en
// el motor de PDF server-side (catastroxPdfGenerator.js/catastroxPdfLayout.js/
// catastroxPdfGeometry.js). Root cause confirmado en la Fase 0 de auditoría
// de linaje: el generador normalizaba geometryParts correctamente, pero solo
// DIBUJABA geometryParts[0] -- nunca iteraba las demás partes de un
// MultiPolygon, y nunca dibujaba innerRings (huecos) en absoluto. El motor
// de navegador (src/modules/catastrox/utils/catastroxDeliverables.js) sí lo
// hacía desde 2026-07-09 (partPredio/geometryParts), pero esa lógica nunca
// se portó al generador server-side (extracción AST deliberadamente excluye
// funciones de dibujo canvas-only, y partPredio vive dentro de una de ellas).
//
// Sin red, sin Postgres -- fetchTile mockeado igual que
// catastroxPdfGenerator.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCatastroxPdfBuffer } from '../catastroxPdfGenerator.js';
import { normalizePredioForDeliverables, partPredio } from '../catastroxPdfLayout.js';
import { buildTechnicalPolygonSubpaths } from '../catastroxPdfGeometry.js';
import {
  LARGE_COMPONENT_OUTER,
  LARGE_COMPONENT_HOLE,
  SMALL_COMPONENT_OUTER,
  SIMPLE_POLYGON_GEOMETRY,
  POLYGON_WITH_HOLE_GEOMETRY,
  MULTIPOLYGON_NO_HOLES_SMALL_FIRST_GEOMETRY,
  MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY,
  MULTIPOLYGON_WITH_HOLE_SMALL_FIRST_GEOMETRY,
  MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY,
  buildMultiPolygonPredioData,
} from './multiPolygonFixtures.js';

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const MOCK_TILE_BUFFER = Buffer.from(MINIMAL_PNG_BASE64, 'base64');
async function mockFetchTile() {
  return MOCK_TILE_BUFFER;
}

// PDFKit con compress:false (ya usado por generateCatastroxPdfBuffer) deja
// el árbol de páginas en texto plano dentro del stream -- /Count N en el
// diccionario /Type /Pages es el conteo REAL de páginas del documento.
// Verificado directamente contra un PDFKit real antes de usarlo aquí (no es
// una suposición): es un dato ESTRUCTURAL del PDF, no una extracción de
// texto dibujado (que PDFKit codifica vía glyphs, no ASCII literal -- ver
// sección 19 del encargo, "si la extracción de texto no es fiable, usar
// helpers estructurales puros").
function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const match = text.match(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/);
  if (!match) throw new Error('No fue posible localizar /Type /Pages ... /Count en el PDF generado.');
  return Number(match[1]);
}

// ---------------------------------------------------------------------
// Sección 6: normalizePredioForDeliverables -- MultiPolygon sintético
// ---------------------------------------------------------------------

test('normalizePredioForDeliverables: MultiPolygon de 2 componentes produce geometryParts.length === 2', () => {
  const predio = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
  });
  assert.equal(predio.geometryParts.length, 2);
  assert.ok(predio.geometryParts[0].outerRing.length >= 4);
  assert.ok(predio.geometryParts[1].outerRing.length >= 4);
});

test('normalizePredioForDeliverables: geometryBounds del MultiPolygon abarca AMBOS componentes, nunca solo el primero', () => {
  const predio = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
  });
  // SMALL_COMPONENT_OUTER vive alrededor de lng=-75.4; LARGE_COMPONENT_OUTER
  // alrededor de lng=-75.9 -- si geometryBounds se limitara al primer
  // componente (large-first en esta fixture), minLng nunca bajaría de
  // -75.9 y maxLng nunca superaría -75.882 (el propio large). El bounds
  // real debe extenderse hasta el componente pequeño en -75.39/-75.4.
  assert.ok(predio.geometryBounds.minLng <= -75.9, `minLng no incluye el componente grande: ${predio.geometryBounds.minLng}`);
  assert.ok(predio.geometryBounds.maxLng >= -75.39, `maxLng no incluye el componente pequeño: ${predio.geometryBounds.maxLng}`);
});

test('normalizePredioForDeliverables: mapRing incluye puntos de ambos componentes (no solo el primero)', () => {
  const predio = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
  });
  const hasPointNear = (lng) => predio.mapRing.some(([x]) => Math.abs(x - lng) < 0.01);
  assert.ok(hasPointNear(-75.9), 'mapRing debe incluir puntos del componente grande');
  assert.ok(hasPointNear(-75.4), 'mapRing debe incluir puntos del componente pequeño');
});

test('normalizePredioForDeliverables: orden de componentes NO afecta el conjunto topológico resultante (solo el orden de las partes)', () => {
  const smallFirst = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_SMALL_FIRST_GEOMETRY }),
  });
  const largeFirst = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
  });
  assert.equal(smallFirst.geometryParts.length, 2);
  assert.equal(largeFirst.geometryParts.length, 2);
  // El orden de entrada se preserva (nunca se reordena por área) -- en
  // smallFirst la parte 0 es la chica; en largeFirst la parte 0 es la
  // grande (SMALL_COMPONENT_OUTER/LARGE_COMPONENT_OUTER tienen distinto
  // número de vértices, así que esto es observable directamente).
  assert.notEqual(
    smallFirst.geometryParts[0].outerRing.length,
    largeFirst.geometryParts[0].outerRing.length,
    'la parte 0 debe ser distinta entre las dos fixtures (small-first vs large-first) -- el orden de entrada se preserva',
  );
  const smallFirstSizes = smallFirst.geometryParts.map((p) => p.outerRing.length).sort();
  const largeFirstSizes = largeFirst.geometryParts.map((p) => p.outerRing.length).sort();
  assert.deepEqual(smallFirstSizes, largeFirstSizes, 'mismo conjunto de partes, solo cambia el orden de entrada');
  // Los bounds globales (agregados) deben ser IDÉNTICOS sin importar el
  // orden de entrada.
  assert.deepEqual(smallFirst.geometryBounds, largeFirst.geometryBounds);
});

// ---------------------------------------------------------------------
// Sección 14: Polygon + hueco -- debe seguir siendo 1 sola parte
// ---------------------------------------------------------------------

test('Polygon con un hueco interior: sigue siendo geometryParts.length === 1, el hueco nunca se cuenta como una parte', () => {
  const predio = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: POLYGON_WITH_HOLE_GEOMETRY }),
  });
  assert.equal(predio.geometryParts.length, 1);
  assert.equal(predio.geometryParts[0].innerRings.length, 1);
});

// ---------------------------------------------------------------------
// Sección 16: MultiPolygon + hueco -- el hueco nunca se independiza
// ---------------------------------------------------------------------

test('MultiPolygon de 2 componentes con hueco en uno: 2 partes, el hueco vive DENTRO de su parte, nunca es una 3ra parte', () => {
  for (const geometry of [MULTIPOLYGON_WITH_HOLE_SMALL_FIRST_GEOMETRY, MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY]) {
    const predio = normalizePredioForDeliverables({ predio: buildMultiPolygonPredioData({ geometry }) });
    assert.equal(predio.geometryParts.length, 2, 'el hueco no debe generar una tercera parte');
    const partsWithHole = predio.geometryParts.filter((part) => part.innerRings.length > 0);
    const partsWithoutHole = predio.geometryParts.filter((part) => part.innerRings.length === 0);
    assert.equal(partsWithHole.length, 1, 'exactamente una parte debe tener el hueco');
    assert.equal(partsWithoutHole.length, 1, 'la otra parte no debe tener huecos');
    assert.equal(partsWithHole[0].innerRings[0].length, LARGE_COMPONENT_HOLE.length);
  }
});

// ---------------------------------------------------------------------
// Sección 10: partPredio() -- helper de descomposición por parte
// ---------------------------------------------------------------------

test('partPredio: construye un predio equivalente con ring=outerRing de la parte, y partLabel solo si totalParts > 1', () => {
  const predio = normalizePredioForDeliverables({
    predio: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
  });
  const [partA, partB] = predio.geometryParts;

  const single = partPredio(predio, partA, 1);
  assert.equal(single.partLabel, '', 'sin partLabel cuando totalParts es 1');

  const first = partPredio(predio, { ...partA, partIndex: 0 }, 2);
  const second = partPredio(predio, { ...partB, partIndex: 1 }, 2);
  assert.equal(first.partLabel, 'Polígono 1 de 2');
  assert.equal(second.partLabel, 'Polígono 2 de 2');
  assert.deepEqual(first.ring, partA.outerRing);
  assert.deepEqual(second.ring, partB.outerRing);
  assert.deepEqual(first.geometryParts, [partA]);
});

// ---------------------------------------------------------------------
// Sección 8: buildTechnicalPolygonSubpaths -- huecos como subpaths
// independientes, nunca concatenados
// ---------------------------------------------------------------------

test('buildTechnicalPolygonSubpaths: exterior + cada hueco como subpath independiente, sin concatenar', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole1 = [[2, 2], [4, 2], [4, 4]];
  const hole2 = [[6, 6], [8, 6], [8, 8]];
  const subpaths = buildTechnicalPolygonSubpaths(outer, [hole1, hole2]);
  assert.equal(subpaths.length, 3);
  assert.deepEqual(subpaths[0], outer, 'el exterior debe ser el primer subpath, sin modificar');
  assert.deepEqual(subpaths[1], hole1);
  assert.deepEqual(subpaths[2], hole2);
});

test('buildTechnicalPolygonSubpaths: descarta anillos vacíos, sin lanzar', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const subpaths = buildTechnicalPolygonSubpaths(outer, [[], [[1, 1], [2, 1], [2, 2]]]);
  assert.equal(subpaths.length, 2);
});

test('buildTechnicalPolygonSubpaths: sin exterior, devuelve arreglo vacío', () => {
  assert.deepEqual(buildTechnicalPolygonSubpaths([], [[[1, 1], [2, 1]]]), []);
});

// ---------------------------------------------------------------------
// Sección 18/19: el PDF generado -- prueba del bug exacto (conteo de
// páginas estructural, sin depender de extracción de texto dibujado)
// ---------------------------------------------------------------------

test('generateCatastroxPdfBuffer: Polygon simple (sin huecos, sin MultiPolygon) -- 1 sola página técnica, sin regresión', async () => {
  const predioData = buildMultiPolygonPredioData({ geometry: SIMPLE_POLYGON_GEOMETRY });
  const buffer = await generateCatastroxPdfBuffer({ predioData, packageId: 'basico', fetchTile: mockFetchTile });
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  // 1 resumen + 1 ficha técnica + 1 uso/alcance + 1 plano + 1 tabla = 5,
  // el conteo básico histórico para un predio simple cuya tabla cabe en
  // una sola página.
  assert.equal(countPdfPages(buffer), 5);
});

test('generateCatastroxPdfBuffer: Polygon + hueco -- MISMO conteo de páginas que sin hueco (el hueco no agrega páginas)', async () => {
  const simple = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: SIMPLE_POLYGON_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const withHole = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: POLYGON_WITH_HOLE_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  assert.equal(countPdfPages(withHole), countPdfPages(simple));
});

// ESTA es la prueba que falla contra HEAD sin corregir: hoy
// generateCatastroxPdfBuffer solo dibuja geometryParts[0] y jamás itera el
// resto -- por diseño, el conteo de páginas NUNCA depende de cuántas partes
// tenga el MultiPolygon (siempre calcula 1 sola página técnica + 1 tabla,
// sin importar 1 o 2 componentes). Con la corrección, un MultiPolygon de 2
// componentes debe producir MÁS páginas que un Polygon simple (una página
// técnica + su(s) página(s) de tabla adicionales por el segundo
// componente).
test('generateCatastroxPdfBuffer: MultiPolygon de 2 componentes produce MÁS páginas que un Polygon simple (bug exacto de la Fase 0)', async () => {
  const simple = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: SIMPLE_POLYGON_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const multi = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const simplePages = countPdfPages(simple);
  const multiPages = countPdfPages(multi);
  assert.ok(
    multiPages > simplePages,
    `un MultiPolygon de 2 componentes debe generar más páginas que un Polygon simple (simple=${simplePages}, multi=${multiPages})`,
  );
});

test('generateCatastroxPdfBuffer: MultiPolygon + hueco en un componente -- MISMO conteo que MultiPolygon sin huecos (el hueco no agrega páginas)', async () => {
  const noHoles = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const withHole = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  assert.equal(countPdfPages(withHole), countPdfPages(noHoles));
});

test('generateCatastroxPdfBuffer: el orden de los componentes (small-first vs large-first) no cambia el conteo total de páginas', async () => {
  const smallFirst = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_WITH_HOLE_SMALL_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const largeFirst = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  assert.equal(countPdfPages(smallFirst), countPdfPages(largeFirst));
});

test('generateCatastroxPdfBuffer: MultiPolygon nunca lanza, siempre produce un PDF válido con magic bytes', async () => {
  for (const geometry of [
    MULTIPOLYGON_NO_HOLES_SMALL_FIRST_GEOMETRY,
    MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY,
    MULTIPOLYGON_WITH_HOLE_SMALL_FIRST_GEOMETRY,
    MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY,
  ]) {
    const buffer = await generateCatastroxPdfBuffer({
      predioData: buildMultiPolygonPredioData({ geometry }),
      packageId: 'basico',
      fetchTile: mockFetchTile,
    });
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.length > 0);
  }
});

// ---------------------------------------------------------------------
// Cobertura estructural del content-stream real (PDFKit compress:false):
// subpaths disjuntos y compound path even-odd de la página 1 de resumen.
// Helpers TEST-ONLY (no se exportan desde el generador productivo).
//
// doc.fillAndStroke('even-odd') se invoca EXACTAMENTE una vez en todo
// catastroxPdfGenerator.js (dibujo de la página 1 de resumen) y, verificado
// contra el pdfkit@0.19.1 instalado (node_modules/pdfkit/js/pdfkit.js,
// fillAndStroke -> addContent(`B${_windingRule(rule)}`), _windingRule
// coincide con /even-?odd/ -> '*'), emite el operador PDF `B*`. Ningún otro
// trazo del documento usa B* -- localizar el content-stream que lo contiene
// identifica sin ambigüedad el compound path de la página 1, sin depender
// de números de página, coordenadas absolutas ni compresión (el generador
// ya usa compress:false, dejando los streams en texto plano).
function findContentStreamsContainingOperator(buffer, operatorToken) {
  const text = buffer.toString('latin1');
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  const escaped = operatorToken.replace(/\*/g, '\\*');
  const opBoundary = new RegExp(`(^|\\s)${escaped}(\\s|$)`);
  const matches = [];
  let match;
  while ((match = streamRegex.exec(text))) {
    if (opBoundary.test(match[1])) matches.push(match[1]);
  }
  return matches;
}

// Un content-stream de página 1 contiene VARIAS construcciones de path
// consecutivas (el rect().clip() del recorte del mapa, el compound path del
// predio, y luego más formas no relacionadas dibujadas después --
// escala/norte/atribución -- cada una con su propio operador de pintado).
// Un path se limpia en cuanto lo consume su operador de pintado (PDF spec:
// f/f*/S/s/B/B*/b/b*/n) -- así que la secuencia de moveTo/lineTo/closePath
// que pertenece EXACTAMENTE a un `operatorToken` dado es la que queda
// acumulada desde el último operador de pintado anterior hasta ese mismo
// operador. Esto aísla el compound path de la página 1 sin asumir que sea
// lo último dibujado en el stream (no lo es: tras fillAndStroke el código
// sigue dibujando escala/etiquetas en el mismo stream).
function extractPathSegmentBeforeOperator(streamText, operatorToken) {
  const PAINT_OPS = new Set(['f', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'n']);
  const tokens = streamText.split(/\s+/).filter(Boolean);
  let currentSegment = [];
  for (const token of tokens) {
    if (token === 'm' || token === 'l' || token === 'h') {
      currentSegment.push(token);
      continue;
    }
    if (PAINT_OPS.has(token)) {
      if (token === operatorToken) return currentSegment;
      currentSegment = [];
    }
  }
  return null;
}

test('generateCatastroxPdfBuffer: componentes disjuntos de un MultiPolygon nunca se conectan con una línea artificial (subpaths independientes en el content-stream real)', async () => {
  const buffer = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const streams = findContentStreamsContainingOperator(buffer, 'B*');
  assert.equal(streams.length, 1, 'debe existir exactamente un content-stream con B* (el compound path de la página 1 de resumen)');
  const segment = extractPathSegmentBeforeOperator(streams[0], 'B*');
  assert.ok(segment, 'no se encontró el segmento de path que precede al operador B*');

  // Al menos un moveTo por componente del MultiPolygon (2 componentes).
  const moveToCount = segment.filter((op) => op === 'm').length;
  assert.ok(moveToCount >= 2, `se esperaban >= 2 moveTo (uno por componente), se encontraron ${moveToCount}`);

  // El segmento (ya delimitado para terminar justo antes de ESTE B*, ver
  // extractPathSegmentBeforeOperator) debe cerrar con closePath -- B* pinta
  // un subpath recién cerrado, nunca uno a medio construir.
  assert.equal(segment[segment.length - 1], 'h', 'B* debe pintarse inmediatamente después de un closePath (h)');

  // Prueba central: nunca debe aparecer un lineTo ('l') inmediatamente
  // después de un closePath ('h') dentro de este segmento -- eso sería
  // exactamente la línea artificial que conectaría el final de un
  // componente con el inicio del siguiente. Cada 'h' interno debe ir
  // seguido únicamente de 'm' (nuevo subpath); el último 'h' del segmento
  // ya se sabe seguido de B* por construcción del segmento.
  for (let i = 0; i < segment.length - 1; i += 1) {
    if (segment[i] === 'h') {
      const next = segment[i + 1];
      assert.equal(
        next,
        'm',
        `después de un closePath (h) en la posición ${i} se esperaba 'm', se encontró '${next}' -- indicaría un puente artificial entre componentes`,
      );
    }
  }
});

test('generateCatastroxPdfBuffer: página 1 (resumen) pinta el exterior de AMBOS componentes + el hueco como UN compound path even-odd (>=3 subpaths independientes)', async () => {
  const buffer = await generateCatastroxPdfBuffer({
    predioData: buildMultiPolygonPredioData({ geometry: MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY }),
    packageId: 'basico',
    fetchTile: mockFetchTile,
  });
  const streams = findContentStreamsContainingOperator(buffer, 'B*');
  assert.equal(streams.length, 1, 'debe existir exactamente un content-stream con B*');
  const segment = extractPathSegmentBeforeOperator(streams[0], 'B*');
  assert.ok(segment, 'no se encontró el segmento de path que precede al operador B*');

  // 2 exteriores (componente grande + componente chico) + 1 hueco (dentro
  // del componente grande) = al menos 3 subpaths independientes, cada uno
  // con su propio moveTo.
  const moveToCount = segment.filter((op) => op === 'm').length;
  assert.ok(moveToCount >= 3, `se esperaban >= 3 moveTo (2 exteriores + 1 hueco), se encontraron ${moveToCount}`);

  // Cada subpath se cierra con 'h' antes del siguiente 'm' -- el hueco
  // nunca queda concatenado (vía lineTo) al exterior que lo contiene, ni un
  // exterior al otro. El último 'h' del segmento ya se sabe seguido de B*
  // por construcción de extractPathSegmentBeforeOperator.
  assert.equal(segment[segment.length - 1], 'h', 'B* debe pintarse inmediatamente después de un closePath (h)');
  for (let i = 0; i < segment.length - 1; i += 1) {
    if (segment[i] === 'h') {
      const next = segment[i + 1];
      assert.equal(next, 'm', `subpath concatenado indebidamente en la posición ${i}`);
    }
  }

  // Un único content-stream con B* en todo el documento ya fue confirmado
  // arriba (streams.length === 1) -- esto es, en sí, la prueba de que un
  // único operador de pintado even-odd cubre el compound path completo.
});
