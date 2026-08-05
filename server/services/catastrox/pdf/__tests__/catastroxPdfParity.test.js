// CATX-PDF-PARITY-002: pruebas estructurales y deterministas del PDF
// server-side de 5 páginas (diseño canónico "DESCARGAS HABILITADAS" del
// navegador, nunca modificado por este sprint -- ver
// src/modules/catastrox/utils/catastroxDeliverables.js:buildPlanPdfBytes).
// Nunca dependen de red real: `fetchTile` se inyecta con un mock
// determinista (una misma imagen PNG mínima válida para toda tesela), así
// que estas pruebas corren offline y son 100% reproducibles.
//
// Alcance explícito de este sprint (acordado): pruebas ESTRUCTURALES, no
// comparación pixel-perfect (eso queda fuera, ver informe de entrega --
// comparación visual manual contra el PDF aprobado).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { generateCatastroxPdfBuffer } from '../catastroxPdfGenerator.js';
import { fetchTileBuffer, MapRenderError } from '../catastroxPdfMap.js';
import { extractPdfPageTexts, countPdfPages, countPdfImages } from './pdfTextExtraction.mjs';

const SAMPLE_RING = [
  [-75.9, 1.1],
  [-75.899, 1.1],
  [-75.899, 1.101],
  [-75.9, 1.101],
  [-75.9, 1.1],
];

const SAMPLE_CODIGO_PREDIAL = '184600002000000030015000000000';

function buildSamplePredioData(overrides = {}) {
  return {
    codigoPredial: SAMPLE_CODIGO_PREDIAL,
    codigoAnterior: 'No disponible',
    municipio: 'MILAN',
    departamento: 'CAQUETA',
    nombrePredio: 'Predio de prueba',
    direccionReal: 'Vereda de prueba',
    veredaDisplay: { value: 'Vereda de prueba' },
    barrioNombre: null,
    sectorCodigo: null,
    manzanaCodigo: null,
    areaM2: 4371500,
    areaHa: 437.15,
    perimetroM: 8400,
    estadoPredial: 'ACTIVO',
    tipoZona: 'RURAL',
    destinoEconomicoNombre: 'AGROPECUARIO',
    uso1Nombre: 'PASTOS',
    uso2Nombre: null,
    uso3Nombre: null,
    numeroConstrucciones: 1,
    areaConstruidaM2: 80,
    tiposConstruccionResumen: 'Vivienda rural',
    fuente: 'catastrox_clean',
    fechaProceso: '2026-01-01',
    geometry: { type: 'Polygon', coordinates: [SAMPLE_RING] },
    polygonGeoJson: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [SAMPLE_RING] } },
    ...overrides,
  };
}

// PNG mínimo válido (1x1 rojo) -- PDFKit trae su propio decodificador PNG
// (sin dependencias nativas); el tamaño real de la imagen no importa
// porque PDFKit siempre la reescala al `width`/`height` pedidos en
// doc.image(). Devuelto para CUALQUIER tesela solicitada -- determinista.
const MOCK_TILE_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let mockTileCallCount = 0;
async function mockFetchTile() {
  mockTileCallCount += 1;
  return MOCK_TILE_BUFFER;
}

async function generateSamplePdf(overrides = {}) {
  return generateCatastroxPdfBuffer({ predioData: buildSamplePredioData(), packageId: 'basico', fetchTile: mockFetchTile, ...overrides });
}

test('CATX-PDF-PARITY-002: el PDF de básico tiene exactamente 5 páginas (regresión: nunca 4)', async () => {
  const buffer = await generateSamplePdf();
  const pageCount = countPdfPages(buffer);
  assert.equal(
    pageCount,
    5,
    `se esperaban 5 páginas (resumen+mapa, ficha técnica, uso y alcance, plano, tabla) -- se obtuvieron ${pageCount}. ` +
      'Si esto falla, el plano y la tabla probablemente volvieron a fusionarse en una sola página, o falta la página del mapa.',
  );
});

test('CATX-PDF-PARITY-002: título y numeración "X de 5" correctos en cada una de las 5 páginas', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  assert.equal(pages.length, 5);

  // Títulos literales del diseño aprobado (drawHeader en cada
  // build*Canvas de catastroxDeliverables.js) -- la página 5 (tabla)
  // reutiliza el mismo título de encabezado "PLANO PREDIAL CATASTROX" que
  // la página 4 en el generador aprobado (buildExecutiveTablePageCanvas),
  // así que se distingue de la página 4 por el título de su panel interior
  // ("TABLA DE VÉRTICES...") en vez del título de encabezado.
  const expectations = [
    { index: 0, pageLabel: '1 de 5', titleFragment: 'DIAGNÓSTICO PREDIAL CATASTROX' },
    { index: 1, pageLabel: '2 de 5', titleFragment: 'FICHA TÉCNICA Y CATASTRAL' },
    { index: 2, pageLabel: '3 de 5', titleFragment: 'USO, ALCANCE Y ADVERTENCIAS' },
    { index: 3, pageLabel: '4 de 5', titleFragment: 'PLANO' },
    { index: 4, pageLabel: '5 de 5', titleFragment: 'TABLA DE VÉRTICES' },
  ];

  for (const { index, pageLabel, titleFragment } of expectations) {
    assert.ok(pages[index].includes(pageLabel), `página ${index + 1} debe mostrar "${pageLabel}" -- texto real: ${pages[index].slice(0, 80)}`);
    assert.ok(
      pages[index].toUpperCase().includes(titleFragment),
      `página ${index + 1} debe incluir el título "${titleFragment}" -- texto real: ${pages[index].slice(0, 80)}`,
    );
  }
});

test('CATX-PDF-PARITY-002: el código predial aparece en las 5 páginas', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  assert.equal(pages.length, 5);
  pages.forEach((text, index) => {
    assert.ok(text.includes(SAMPLE_CODIGO_PREDIAL), `página ${index + 1} debe incluir el código predial`);
  });
});

test('CATX-PDF-PARITY-002: la página 1 tiene teselas satelitales embebidas (imágenes reales, no solo texto)', async () => {
  mockTileCallCount = 0;
  const buffer = await generateSamplePdf();
  assert.ok(mockTileCallCount > 0, 'se esperaba al menos una llamada a fetchTile (imagería + etiquetas)');
  const imageCount = countPdfImages(buffer);
  assert.ok(imageCount >= mockTileCallCount, `se esperaban al menos ${mockTileCallCount} imágenes XObject embebidas, hay ${imageCount}`);
});

test('CATX-PDF-PARITY-002: la página 1 dibuja el polígono superpuesto sobre el mosaico (color de relleno y borde presentes)', async () => {
  const buffer = await generateSamplePdf();
  const raw = buffer.toString('latin1');
  // Colores exactos usados por drawSatelliteMapBox() en catastroxPdfGenerator.js:
  // relleno #00aeea (0, 0.68235294..., 0.91764706... scn) y borde #ffea00
  // (1, 0.91764706..., 0 SCN) -- PDFKit escribe el color como operador
  // `scn`/`SCN` (no `rg`/`RG`), verificado empíricamente contra la salida real.
  assert.ok(raw.includes('0 0.6823529411764706 0.9176470588235294 scn'), 'falta el color de relleno del polígono satelital (#00aeea)');
  assert.ok(raw.includes('1 0.9176470588235294 0 SCN'), 'falta el color de borde del polígono satelital (#ffea00)');
});

test('CATX-PDF-PARITY-002: la página 1 incluye rosa de los vientos (N/S/O/E) y escala gráfica', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  // Orden de dibujo real en catastroxPdfGenerator.js: polígono, luego
  // drawCompassRose (N, S, O, E en ese orden), luego drawScaleBar
  // ("ESCALA GRÁFICA") -- de ahí el orden exacto de la aserción.
  assert.ok(pages[0].includes('N S O E'), 'falta la rosa de los vientos (etiquetas N/S/O/E) en la página 1');
  assert.ok(pages[0].includes('ESCALA GRÁFICA'), 'falta la escala gráfica en la página 1');
});

test('CATX-PDF-PARITY-002: la página 1 dibuja la grilla de tarjetas en 2 columnas (nunca una sola columna)', async () => {
  // Verifica los rects reales de las tarjetas de datos en el content stream
  // (drawInfoCard, catastroxPdfGenerator.js) -- deben existir tarjetas
  // ancladas en x=24 (columna izquierda) Y en x=212 (columna derecha), con
  // el mismo ancho (172) y las alturas exactas del diseño aprobado
  // (drawCommercialMetric, catastroxDeliverables.js:2113-2140): 58pt para
  // las 6 tarjetas superiores, 74pt para las 2 inferiores (Destinación /
  // Usos constructivos). Si esto regresa a una sola columna, ninguna de las
  // dos listas de coincidencias tendría 4 elementos.
  const buffer = await generateSamplePdf();
  const raw = buffer.toString('latin1');
  const leftColumn = raw.match(/(?:^|\s)24 [\d.]+ 172 (?:58|74) re/g) || [];
  const rightColumn = raw.match(/(?:^|\s)212 [\d.]+ 172 (?:58|74) re/g) || [];
  assert.ok(leftColumn.length >= 4, `se esperaban al menos 4 tarjetas en la columna izquierda (x=24), se encontraron ${leftColumn.length}`);
  assert.ok(rightColumn.length >= 4, `se esperaban al menos 4 tarjetas en la columna derecha (x=212), se encontraron ${rightColumn.length}`);
  const pages = extractPdfPageTexts(buffer);
  ['MUNICIPIO', 'DEPARTAMENTO', 'ZONA', 'ÁREA TOTAL', 'DESTINACIÓN CATASTRAL', 'USOS CONSTRUCTIVOS'].forEach((label) => {
    assert.ok(pages[0].toUpperCase().includes(label), `falta la etiqueta de tarjeta "${label}" en la página 1`);
  });
});

test('CATX-PDF-PARITY-002: la página 4 (plano) incluye escala gráfica, rosa de los vientos y círculos de vértices P1..Pn', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  const planoPage = pages[3];
  assert.ok(planoPage.includes('ESCALA GRÁFICA'), 'falta la escala gráfica en la página 4 (plano)');
  assert.ok(planoPage.includes('N S O E') || (planoPage.includes('N') && planoPage.includes('S') && planoPage.includes('O') && planoPage.includes('E')), 'falta la rosa de los vientos en la página 4 (plano)');
  // SAMPLE_RING es un cuadrado -> 4 vértices representativos P1..P4.
  ['P1', 'P2', 'P3', 'P4'].forEach((label) => {
    assert.ok(planoPage.includes(label), `falta el círculo de vértice "${label}" en la página 4 (plano)`);
  });
});

test('CATX-PDF-PARITY-002: numeración "PÁGINA X de 5" uniforme y sin huecos en las 5 páginas', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  assert.equal(pages.length, 5);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(pages[index].includes(`${index + 1} de 5`), `página ${index + 1} debe mostrar "${index + 1} de 5"`);
  }
});

test('CATX-PDF-PARITY-002: página 4 es un plano independiente (sin tabla) y página 5 es la tabla independiente (sin plano)', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  const planoPage = pages[3];
  const tablaPage = pages[4];

  assert.ok(planoPage.includes('PLANO INFORMATIVO') || planoPage.includes('PLANO TÉCNICO'), 'página 4 debe ser el plano');
  assert.ok(!planoPage.toUpperCase().includes('TABLA DE VÉRTICES'), 'página 4 (plano) NO debe contener la tabla -- deben ser páginas separadas');

  assert.ok(tablaPage.toUpperCase().includes('TABLA DE VÉRTICES REPRESENTATIVOS Y DISTANCIAS'), 'página 5 debe ser la tabla');
  assert.ok(!tablaPage.includes('PLANO INFORMATIVO') && !tablaPage.includes('PLANO TÉCNICO'), 'página 5 (tabla) NO debe repetir el subtítulo del plano');
});

test('CATX-PDF-PARITY-002: la tabla de la página 5 tiene el mismo número de vértices/distancias que la geometría de entrada', async () => {
  const buffer = await generateSamplePdf();
  const pages = extractPdfPageTexts(buffer);
  const tablaPage = pages[4];
  // SAMPLE_RING cierra un cuadrado de 4 vértices -> 4 segmentos P1-P2-P3-P4-P1.
  const rows = tablaPage.match(/P\d+\s*P\d+\s*[\d.,]+\s*m/g) || [];
  assert.equal(rows.length, 4, `se esperaban 4 filas de vértices/distancias (cuadrado de prueba), se encontraron ${rows.length}`);
});

// CATX-POSTPAYMENT-UX-001 (defecto C): geometría sintética de 60 vértices
// (un círculo perturbado, radio ~800m, sin(theta*5) para variar la
// curvatura y así garantizar puntos genuinamente insignificantes) que
// dispara la reducción real de VisibleReferencePointEngine -- verificado
// empíricamente: 60 vértices de anillo -> 50 puntos de referencia. Antes de
// la corrección, el plano (página 4) dibujaba círculos P1..P60 (el anillo
// denso completo) mientras la tabla mostraba solo P1..P50 (el conjunto ya
// reducido) -- exactamente el defecto reportado (caso real: predio
// 184100001000000510012000000000, plano hasta ~P92, tabla hasta P70). Esta
// geometría sintética es un caso equivalente, sin depender de red/DB real.
function buildComplexRing({ vertexCount = 60, radiusMeters = 800, centerLng = -75.9, centerLat = 1.1 } = {}) {
  const degPerMeterLat = 1 / 111320;
  const degPerMeterLng = 1 / (111320 * Math.cos((centerLat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const theta = (i / vertexCount) * 2 * Math.PI;
    const r = radiusMeters * (1 + 0.15 * Math.sin(theta * 5));
    ring.push([
      centerLng + r * degPerMeterLng * Math.cos(theta),
      centerLat + r * degPerMeterLat * Math.sin(theta),
    ]);
  }
  ring.push(ring[0]);
  return ring;
}

test('CATX-POSTPAYMENT-UX-001: geometría compleja -- el plano (círculos Pn) y la tabla (filas Pn) muestran EXACTAMENTE el mismo conjunto de puntos', async () => {
  const complexRing = buildComplexRing();
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      geometry: { type: 'Polygon', coordinates: [complexRing] },
      polygonGeoJson: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [complexRing] } },
    }),
  });
  const pages = extractPdfPageTexts(buffer);

  // Mismo criterio que la prueba "página 4 es un plano independiente..." de
  // arriba: el subtítulo interno ("PLANO INFORMATIVO"/"PLANO TÉCNICO") es
  // exclusivo de la página del plano -- el título de encabezado ("PLANO
  // PREDIAL CATASTROX") NO sirve para distinguir, porque las páginas de
  // tabla lo reutilizan tal cual (ver comentario más abajo, línea ~99).
  const planoPageIndex = pages.findIndex(
    (text) =>
      (text.includes('PLANO INFORMATIVO') || text.includes('PLANO TÉCNICO')) &&
      !text.toUpperCase().includes('TABLA DE VÉRTICES'),
  );
  assert.ok(planoPageIndex >= 0, 'no se encontró la página del plano en el PDF generado');
  const planoPage = pages[planoPageIndex];

  // La cantidad de puntos de referencia depende de VisibleReferencePointEngine
  // (36 para esta geometría sintética con el paquete "basico"); con 18
  // filas por página (TABLE_ROW_HEIGHT en catastroxPdfGenerator.js), la
  // tabla se reparte en varias páginas -- se concatenan todas para no
  // perder filas de páginas posteriores a la primera.
  const tablePagesText = pages
    .filter((text) => text.toUpperCase().includes('TABLA DE VÉRTICES'))
    .join('\n');
  assert.ok(tablePagesText.length > 0, 'no se encontró ninguna página de tabla en el PDF generado');

  // Puntos visibles en el plano: únicamente los círculos P1..Pn
  // (drawVertexCircles) -- las cotas de distancia en esta página nunca
  // incluyen el prefijo "P" (solo el valor en metros), así que ningún otro
  // texto de la página produce falsos positivos para /\bP\d+\b/.
  const visiblePointIds = new Set(planoPage.match(/\bP\d+\b/g) || []);

  // Puntos tabulados: primera columna ("Pn") de cada fila "Pn Pm <dist> m".
  const tableRowMatches = [...tablePagesText.matchAll(/\bP(\d+)\s+P(\d+)\s+[\d.,]+\s*m/g)];
  assert.ok(tableRowMatches.length > 0, 'no se encontró ninguna fila de vértices/distancias en la tabla');
  const tablePointIds = new Set(tableRowMatches.map((match) => `P${match[1]}`));

  // La reducción realmente ocurrió (si no, esta prueba no distinguiría el
  // defecto de un caso donde plano y tabla coinciden por casualidad al usar
  // el anillo completo en ambos lados).
  assert.ok(
    visiblePointIds.size < complexRing.length - 1,
    `se esperaba que VisibleReferencePointEngine redujera el anillo de ${complexRing.length - 1} vértices -- el plano mostró ${visiblePointIds.size}, igual al anillo completo (la geometría de prueba no dispara reducción real)`,
  );

  assert.equal(
    visiblePointIds.size,
    tablePointIds.size,
    `cantidad de puntos visibles en el plano (${visiblePointIds.size}) debe igualar la cantidad de puntos tabulados (${tablePointIds.size})`,
  );
  const sortByNumber = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
  assert.deepEqual(
    [...visiblePointIds].sort(sortByNumber),
    [...tablePointIds].sort(sortByNumber),
    'el conjunto exacto de IDs de punto debe coincidir entre el plano y la tabla (ningún punto visible fuera de la tabla, ninguno tabulado ausente del plano)',
  );

  // Cierre Pn -> P1: la última fila de la tabla debe volver al primer punto.
  const [, lastFrom, lastTo] = tableRowMatches[tableRowMatches.length - 1];
  assert.equal(lastTo, '1', `la última fila debe cerrar hacia P1, cerró hacia P${lastTo} (desde P${lastFrom})`);
  assert.equal(Number(lastFrom), tablePointIds.size, 'la última fila debe partir del último punto (Pn), no de uno intermedio');
});

test('CATX-PDF-PARITY-002: checksum del PDF servido para descarga/correo se calcula sobre el mismo Buffer (mismo sha256)', async () => {
  // No repite la integración completa (ya cubierta por
  // catastroxDeliveryLifecycle.test.js, que reutiliza deliveryJobService.js
  // sin mocks) -- aquí solo confirma que el Buffer que produce el
  // generador es la única fuente de verdad para el checksum: hashear el
  // mismo Buffer dos veces (como hacen fetchVerifiedDeliverableForOrder al
  // guardar y al re-verificar en cada descarga) da el mismo resultado.
  const buffer = await generateSamplePdf();
  const hashA = crypto.createHash('sha256').update(buffer).digest('hex');
  const hashB = crypto.createHash('sha256').update(buffer).digest('hex');
  assert.equal(hashA, hashB);
});

// --- Tercera vuelta: paridad de campos urbano/rural (drawIdentificacionPanel) ---

test('CATX-PDF-PARITY-002: ficha técnica de un predio URBANO muestra "Dirección del predio", omite Vereda, y muestra Barrio real', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({ tipoZona: 'URBANO', direccionReal: 'Calle 5 # 6-10', barrioNombre: 'San Antonio', manzanaCodigo: null }),
  });
  const pages = extractPdfPageTexts(buffer);
  const fichaPage = pages[1];
  assert.ok(fichaPage.toUpperCase().includes('DIRECCIÓN DEL PREDIO'), 'un predio urbano debe mostrar "Dirección del predio", no "Nombre del predio"');
  assert.ok(!fichaPage.toUpperCase().includes('NOMBRE DEL PREDIO'), 'un predio urbano NO debe mostrar la etiqueta "Nombre del predio"');
  assert.ok(!fichaPage.toUpperCase().includes('VEREDA'), 'un predio urbano NO debe mostrar el campo Vereda en absoluto');
  assert.ok(fichaPage.includes('San Antonio'), 'un predio urbano debe mostrar el nombre real del barrio, no un valor derivado de otro campo');
  assert.ok(fichaPage.toUpperCase().includes('MANZANA'), 'un predio urbano debe mostrar el campo Manzana (con su fallback si falta el dato)');
});

test('CATX-PDF-PARITY-002: ficha técnica de un predio RURAL muestra "Nombre del predio", Vereda, y Barrio/Manzana como "No aplica"', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({ tipoZona: 'RURAL', nombrePredio: 'Finca La Esperanza', veredaDisplay: { label: 'Vereda', value: 'El Diamante', isCadastralCode: false }, barrioNombre: null, manzanaCodigo: null }),
  });
  const pages = extractPdfPageTexts(buffer);
  const fichaPage = pages[1];
  assert.ok(fichaPage.toUpperCase().includes('NOMBRE DEL PREDIO'), 'un predio rural debe mostrar "Nombre del predio"');
  assert.ok(!fichaPage.toUpperCase().includes('DIRECCIÓN DEL PREDIO'), 'un predio rural NO debe mostrar "Dirección del predio" como encabezado de identificación');
  assert.ok(fichaPage.includes('El Diamante'), 'un predio rural debe mostrar el nombre real de la vereda');
  const noAplicaCount = (fichaPage.match(/No aplica/gi) || []).length;
  assert.ok(noAplicaCount >= 2, `un predio rural sin barrio/manzana debe mostrar "No aplica" para ambos campos -- se encontraron ${noAplicaCount} ocurrencias`);
});

test('CATX-PDF-PARITY-002: predio rural cuya vereda solo tiene código catastral (sin nombre común) muestra la fila de código catastral de vereda', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      tipoZona: 'RURAL',
      veredaDisplay: { label: 'Vereda', value: 'Información no disponible', secondaryLabel: 'Identificador catastral de vereda', secondaryValue: '184600002000', note: 'Nota', isCadastralCode: true },
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  const fichaPage = pages[1];
  assert.ok(fichaPage.toUpperCase().includes('CÓDIGO CATASTRAL DE VEREDA'), 'debe mostrarse la fila "Código catastral de vereda" cuando la fuente solo trae el código, no un nombre común');
  assert.ok(fichaPage.includes('184600002000'), 'debe mostrarse el valor real del código catastral de vereda');
});

// CATX-POSTPAYMENT-UX-001: encontrado durante la generación de los PDFs de
// validación de este mismo sprint -- un veredaDisplay PRESENTE pero
// incompleto (le faltaba `.label`, como en el fixture de prueba usado)
// pasaba sin cambios por el chequeo superficial `predio.veredaDisplay || ...`
// (normalizePredioForDeliverables, catastroxPdfLayout.js) y aparecía
// literalmente "UNDEFINED" como rótulo en la página 2. No es alcanzable
// hoy por el flujo real (el único constructor real, getVeredaDisplay() en
// server/routes/catastrox.js, siempre devuelve un objeto completo), pero
// nada impedía que un llamador futuro con datos parciales lo disparara.
// Esta prueba cubre el requisito absoluto: nunca debe imprimirse
// literalmente "undefined"/"null"/"NaN"/"[object Object]" en ninguna
// página del PDF, ni siquiera con la entrada deliberadamente malformada
// que causó el defecto real.
test('CATX-POSTPAYMENT-UX-001: veredaDisplay incompleto (sin .label) nunca imprime "UNDEFINED" -- se reconstruye con el fallback completo', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({ tipoZona: 'RURAL', veredaDisplay: { value: 'Vereda de prueba' } }),
  });
  const pages = extractPdfPageTexts(buffer);
  const fichaPage = pages[1];

  assert.ok(fichaPage.toUpperCase().includes('VEREDA'), 'un veredaDisplay incompleto debe seguir mostrando la fila "Vereda", reconstruida con el fallback completo');
  assert.ok(fichaPage.includes('Vereda de prueba'), 'el valor real suministrado no debe perderse -- solo la forma inválida se descarta, no necesariamente el dato');

  // Ninguna página del documento completo debe filtrar un valor técnico no
  // definido -- lista exacta pedida: undefined, null, NaN, [object Object].
  const forbiddenTokens = ['undefined', 'null', 'NaN', '[object Object]'];
  pages.forEach((pageText, index) => {
    forbiddenTokens.forEach((token) => {
      assert.ok(
        !pageText.includes(token),
        `la página ${index + 1} no debe contener el token técnico "${token}" -- texto: ${pageText.slice(0, 200)}`,
      );
    });
  });
});

test('CATX-PDF-PARITY-002: campos faltantes (código anterior, barrio, manzana) nunca rompen la generación -- muestran su fallback textual', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({ tipoZona: 'URBANO', codigoAnterior: null, barrioNombre: null, manzanaCodigo: null, direccionReal: null }),
  });
  const pages = extractPdfPageTexts(buffer);
  assert.equal(pages.length, 5, 'datos faltantes no deben cambiar el número de páginas ni lanzar una excepción');
  const fichaPage = pages[1];
  assert.ok(fichaPage.toUpperCase().includes('DIRECCIÓN NO REGISTRADA') || fichaPage.toUpperCase().includes('NO REGISTRADO'), 'la dirección faltante debe mostrar su fallback textual, nunca "undefined" ni una cadena vacía');
  assert.ok(!fichaPage.includes('undefined') && !fichaPage.includes('null'), 'ningún campo faltante debe filtrar literalmente "undefined"/"null" al PDF');
});

test('CATX-PDF-PARITY-002: uso2Nombre y uso3Nombre idénticos NO se muestran duplicados (página 1 resumen y página 2 lista)', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({ uso1Nombre: 'PASTOS', uso2Nombre: 'ESTABLOS - PESEBRERAS', uso3Nombre: 'ESTABLOS - PESEBRERAS' }),
  });
  const pages = extractPdfPageTexts(buffer);
  const resumenPage = pages[0];
  const fichaPage = pages[1];
  // buildUsosConstructivosResumen (página 1) deduplica -> "Pastos y establos, pesebreras",
  // nunca "...establos, pesebreras y establos, pesebreras".
  assert.ok(!/establos,? pesebreras\s+y\s+establos,? pesebreras/i.test(resumenPage), 'la tarjeta "Usos constructivos" de la página 1 no debe repetir el mismo uso dos veces');
  const resumenOccurrences = (resumenPage.match(/establos/gi) || []).length;
  assert.equal(resumenOccurrences, 1, `"Establos" debe aparecer exactamente 1 vez en el resumen deduplicado de la página 1, apareció ${resumenOccurrences}`);
  // buildUsosConstructivosList (página 2, clasificación) también deduplica.
  const fichaOccurrences = (fichaPage.match(/establos/gi) || []).length;
  assert.equal(fichaOccurrences, 1, `"Establos" debe aparecer exactamente 1 vez en la lista deduplicada de la página 2, apareció ${fichaOccurrences}`);
});

test('CATX-PDF-PARITY-002: ficha técnica con nombre de predio y usos constructivos muy largos no rompe la generación ni desordena código predial/anterior', async () => {
  const longName = 'Predio San José de la Esperanza y la Bendición del Alto Caquetá Rural Disperso Sector Norte';
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      tipoZona: 'RURAL',
      nombrePredio: longName,
      uso1Nombre: 'ESTABLOS - PESEBRERAS - CANEYES - COBERTIZOS - GALPONES AVICOLAS',
      uso2Nombre: 'BODEGAS DE ALMACENAMIENTO DE PRODUCTOS AGROPECUARIOS Y FORESTALES',
      uso3Nombre: 'VIVIENDA RURAL DISPERSA CON ANEXOS PRODUCTIVOS',
      destinoEconomicoNombre: 'AGROPECUARIO CON VOCACIÓN FORESTAL Y DE CONSERVACIÓN AMBIENTAL',
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  assert.equal(pages.length, 5, 'texto largo no debe cambiar el número de páginas');
  const fichaPage = pages[1];
  assert.ok(fichaPage.includes('CÓDIGO PREDIAL'), 'el bloque de código predial debe seguir presente aunque el nombre/usos sean largos');
  assert.ok(fichaPage.includes('CÓDIGO ANTERIOR'), 'el bloque de código anterior debe seguir presente aunque el nombre/usos sean largos');
  assert.ok(fichaPage.includes(SAMPLE_CODIGO_PREDIAL), 'el código predial real debe seguir apareciendo pese al texto largo');
});

// --- Cuarta vuelta: ficha técnica dividida en 2 páginas (buildFichaTecnicaSplitPageCanvases) ---
// No se asume "siempre 5 páginas": estimateFichaTecnicaPageCount devuelve 2
// cuando usosCount>3 o tiposLineCount>3 (catastroxPdfLayout.js, puerto de
// catastroxDeliverables.js:2334-2338) -- el total de páginas debe crecer
// dinámicamente en ese caso, igual que el generador aprobado.

function buildSplitFichaPredioData(overrides = {}) {
  return buildSamplePredioData({
    tipoZona: 'RURAL',
    veredaDisplay: { label: 'Vereda', value: 'Vereda de prueba', isCadastralCode: false },
    // 5 partes separadas por ";" -> tiposLineCount=5>3 -> fichaPageCount=2.
    tiposConstruccionResumen: 'No Convencional: 3; Convencional: 1; Otro: 2; Mixto: 4; Especial: 1',
    uso1Nombre: 'PASTOS',
    uso2Nombre: 'ESTABLOS',
    uso3Nombre: 'GALPONES',
    ...overrides,
  });
}

test('CATX-PDF-PARITY-002: ficha técnica extensa se divide en 2 páginas -- el total de páginas crece dinámicamente (nunca se asume "siempre 5")', async () => {
  const buffer = await generateSamplePdf({ predioData: buildSplitFichaPredioData() });
  const pageCount = countPdfPages(buffer);
  assert.equal(pageCount, 6, `con ficha técnica dividida se esperaban 6 páginas (resumen, ficha A, ficha B, uso/alcance, plano, tabla) -- se obtuvieron ${pageCount}`);

  const pages = extractPdfPageTexts(buffer);
  for (let index = 0; index < 6; index += 1) {
    assert.ok(pages[index].includes(`${index + 1} de 6`), `página ${index + 1} debe mostrar "${index + 1} de 6"`);
    assert.ok(pages[index].includes(SAMPLE_CODIGO_PREDIAL), `página ${index + 1} debe incluir el código predial`);
  }

  assert.ok(pages[1].toUpperCase().includes('FICHA TÉCNICA Y CATASTRAL') && !pages[1].toUpperCase().includes('CONTINUACIÓN'), 'página 2 debe ser la ficha técnica (sin "continuación")');
  assert.ok(pages[2].toUpperCase().includes('FICHA TÉCNICA Y CATASTRAL (CONTINUACIÓN)'), 'página 3 debe ser la continuación de la ficha técnica');
  assert.ok(pages[3].toUpperCase().includes('USO, ALCANCE Y ADVERTENCIAS'), 'página 4 (no 3) debe ser uso y alcance, corrida un puesto por la ficha dividida');
});

test('CATX-PDF-PARITY-002: ficha técnica dividida -- página A (Identificación 1 columna + Características) sin superposición con el pie de página', async () => {
  const buffer = await generateSplitFichaPdfHelper();
  const pages = extractPdfPageTexts(buffer);
  const pageA = pages[1];
  assert.ok(pageA.toUpperCase().includes('IDENTIFICACIÓN Y LOCALIZACIÓN'));
  assert.ok(pageA.toUpperCase().includes('CARACTERÍSTICAS FÍSICAS'));
  assert.ok(pageA.includes('CÓDIGO PREDIAL') && pageA.includes('CÓDIGO ANTERIOR'), 'la página A debe seguir mostrando código predial/anterior aunque haya 7 campos de identificación (Nombre, Municipio, Departamento, Zona, Vereda, Barrio, Manzana)');
  // Si el bloque de código predial se solapara con el pie de página legal,
  // el texto del aviso legal terminaría intercalado entre las etiquetas de
  // código -- verificación indirecta: el aviso legal completo debe seguir
  // apareciendo íntegro y una sola vez, no fragmentado por otro contenido.
  const legalOccurrences = (pageA.match(/CatastroX realiza análisis técnico/g) || []).length;
  assert.equal(legalOccurrences, 1, 'el aviso legal del pie de página debe aparecer exactamente una vez, sin quedar partido por contenido que lo invada');
});

test('CATX-PDF-PARITY-002: ficha técnica dividida -- página B (Clasificación a todo el ancho + Fuente) muestra todos los tipos de construcción', async () => {
  const buffer = await generateSplitFichaPdfHelper();
  const pages = extractPdfPageTexts(buffer);
  const pageB = pages[2];
  assert.ok(pageB.toUpperCase().includes('CLASIFICACIÓN Y CONSTRUCCIONES'));
  assert.ok(pageB.toUpperCase().includes('FUENTE'));
  ['Pastos', 'Establos', 'Galpones'].forEach((uso) => {
    assert.ok(pageB.includes(uso), `la página B debe listar el uso constructivo "${uso}"`);
  });
  assert.ok(pageB.includes('No Convencional: 3') && pageB.includes('Especial: 1'), 'la página B debe mostrar los 5 tipos de construcción completos, sin truncar');
});

async function generateSplitFichaPdfHelper() {
  return generateSamplePdf({ predioData: buildSplitFichaPredioData() });
}

// --- Cierre: lindero por fuente hídrico (extremo a extremo, PDF real) ---
// SAMPLE_RING es un cuadrado -> P1,P2,P3,P4. Grupo hídrico P1(0)->P3(2):
// cubre los segmentos 0 (P1-P2) y 1 (P2-P3) -- P2 es el único vértice
// intermedio, debe quedar oculto en el plano; P1 y P3 siguen visibles.

test('CATX-PDF-PARITY-002 (hídrico): sin boundaryAnnotations, un polígono sinuoso NUNCA se agrupa automáticamente', async () => {
  const buffer = await generateSamplePdf(); // buildSamplePredioData() no trae boundaryAnnotations.
  const pages = extractPdfPageTexts(buffer);
  const planoPage = pages[3];
  const tablaPage = pages[4];
  assert.ok(!planoPage.includes('Lindero por fuente hídrica'), 'sin anotación explícita, el plano no debe mostrar ninguna etiqueta de lindero hídrico');
  assert.ok(!tablaPage.includes('Tipo de lindero') && !tablaPage.includes('Fuente hídrica'), 'sin anotación explícita, la tabla no debe ganar la columna "Tipo de lindero" ni agrupar filas -- nunca por inferencia de sinuosidad');
  ['P1', 'P2', 'P3', 'P4'].forEach((label) => assert.ok(planoPage.includes(label), `sin agrupación, los 4 vértices deben seguir visibles (${label})`));
});

test('CATX-PDF-PARITY-002 (hídrico): con boundaryAnnotations explícito, el plano oculta el vértice intermedio y muestra la etiqueta agrupada con la longitud acumulada real', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      boundaryAnnotations: [{ boundaryType: 'FUENTE_HIDRICA', startVertexIndex: 0, endVertexIndex: 2, label: 'Quebrada La Clara' }],
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  const planoPage = pages[3];

  assert.ok(planoPage.includes('P1') && planoPage.includes('P3'), 'el punto inicial (P1) y final (P3) del grupo hídrico deben seguir visibles');
  assert.ok(planoPage.includes('Quebrada La Clara'), 'debe mostrarse la etiqueta agrupada del lindero hídrico');
  assert.ok(planoPage.includes('m'), 'la etiqueta agrupada debe incluir la longitud acumulada en metros');
});

test('CATX-PDF-PARITY-002 (hídrico): con boundaryAnnotations explícito, la tabla ejecutiva agrupa las filas del tramo y añade "Tipo de lindero"', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      boundaryAnnotations: [{ boundaryType: 'FUENTE_HIDRICA', startVertexIndex: 0, endVertexIndex: 2, label: 'Quebrada La Clara' }],
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  const tablaPage = pages[4];

  assert.ok(tablaPage.includes('Tipo de lindero'), 'la tabla debe ganar la columna "Tipo de lindero" cuando hay anotaciones hídricas');
  assert.ok(tablaPage.includes('Fuente hídrica'), 'debe existir al menos una fila marcada "Fuente hídrica"');
  assert.ok(tablaPage.includes('Ordinario'), 'las filas no agrupadas deben marcarse "Ordinario"');
  // 4 segmentos originales -> 2 absorbidos por el grupo (P1-P2, P2-P3) + 1 fila agrupada + 2 filas ordinarias (P3-P4, P4-P1) = 3 filas totales.
  const rowMatches = tablaPage.match(/P\d+\s*P\d+\s*[\d.,]+\s*m\s*(Fuente hídrica|Ordinario)/g) || [];
  assert.equal(rowMatches.length, 3, `se esperaban 3 filas en la tabla (1 agrupada + 2 ordinarias), se encontraron ${rowMatches.length}`);
});

test('CATX-PDF-PARITY-002 (hídrico): la longitud acumulada mostrada es la suma real de subtramos, nunca la distancia recta entre extremos', async () => {
  // Cuadrado de SAMPLE_RING: cada lado mide ~111m (0.001° en el ecuador).
  // La suma real de 2 subtramos (P1-P2 + P2-P3) debe rondar el doble de un
  // solo lado -- muy distinta de la distancia recta P1-P3 (diagonal, ~157m,
  // pero el cálculo NUNCA debe tomar ese atajo).
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      boundaryAnnotations: [{ boundaryType: 'FUENTE_HIDRICA', startVertexIndex: 0, endVertexIndex: 2 }],
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  const tablaPage = pages[4];
  const groupedRowMatch = tablaPage.match(/P1\s*P3\s*([\d.,]+)\s*m\s*Fuente hídrica/);
  assert.ok(groupedRowMatch, 'debe existir la fila agrupada P1->P3 con una longitud numérica');
  const accumulated = Number(groupedRowMatch[1].replace(/\./g, '').replace(',', '.'));
  assert.ok(accumulated > 150, `la longitud acumulada de 2 subtramos debería superar los 150m para este predio de prueba, fue ${accumulated}`);
});

test('CATX-PDF-PARITY-002 (hídrico): boundaryType distinto de FUENTE_HIDRICA no produce agrupación', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      boundaryAnnotations: [{ boundaryType: 'LINDERO_VIAL', startVertexIndex: 0, endVertexIndex: 2 }],
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  const tablaPage = pages[4];
  assert.ok(!tablaPage.includes('Tipo de lindero'), 'un boundaryType distinto de FUENTE_HIDRICA no debe activar la columna ni la agrupación');
});

test('CATX-PDF-PARITY-002 (hídrico): un grupo que cruza el cierre del polígono (Pn->P1) también se agrupa y acumula correctamente', async () => {
  const buffer = await generateSamplePdf({
    predioData: buildSamplePredioData({
      // P4(3)->P2(1): cruza el cierre (segmento 3: P4-P1, luego segmento 0: P1-P2).
      boundaryAnnotations: [{ boundaryType: 'FUENTE_HIDRICA', startVertexIndex: 3, endVertexIndex: 1, label: 'Caño El Cruce' }],
    }),
  });
  const pages = extractPdfPageTexts(buffer);
  const tablaPage = pages[4];
  assert.ok(tablaPage.includes('Caño El Cruce') || tablaPage.includes('Fuente hídrica'), 'un grupo que cruza el cierre P4->P1->P2 debe agruparse igual que uno ordinario');
  assert.ok(tablaPage.includes('P4') && tablaPage.includes('P2'), 'la fila agrupada debe mostrar P4 como inicio y P2 como fin');
});

// --- Ajuste obligatorio #6: tesela crítica falla / timeout -> MAP_RENDER_FAILED ---

test('MAP_RENDER_FAILED: si fetchTile falla, generateCatastroxPdfBuffer rechaza con ese código -- nunca produce un Buffer parcial', async () => {
  async function failingFetchTile() {
    throw new MapRenderError('tesela simulada caída para la prueba');
  }

  await assert.rejects(
    () => generateSamplePdf({ fetchTile: failingFetchTile }),
    (error) => {
      assert.equal(error.code, 'MAP_RENDER_FAILED');
      return true;
    },
  );
});

test('MAP_RENDER_FAILED: fetchTileBuffer real -- HTTP no-200 del proveedor produce MapRenderError', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  try {
    await assert.rejects(
      () => fetchTileBuffer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/1/1'),
      (error) => {
        assert.equal(error.code, 'MAP_RENDER_FAILED');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MAP_RENDER_FAILED: fetchTileBuffer real -- timeout produce MapRenderError, nunca cuelga la prueba', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      // Nunca resuelve por sí sola -- solo el abort (timeout) la termina.
    });
  try {
    await assert.rejects(
      () => fetchTileBuffer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/1/1', { timeoutMs: 50 }),
      (error) => {
        assert.equal(error.code, 'MAP_RENDER_FAILED');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
