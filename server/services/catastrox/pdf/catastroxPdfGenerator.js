// CATX-DELIVERY-001: generador de PDF server-side, 100% JS puro (PDFKit,
// sin dependencias nativas) -- reemplaza el bloqueador de
// deliveryJobService.js (antes lanzaba SERVER_SIDE_GENERATION_NOT_IMPLEMENTED
// siempre). El generador de navegador (src/modules/catastrox/utils/catastroxDeliverables.js,
// canvas hecho a mano) se mantiene intacto como respaldo -- este módulo NO
// lo reemplaza, coexiste con él.
//
// Reutiliza directamente la capa de DATOS/GEOMETRÍA de catastroxDeliverables.js
// (verificada libre de document/window/canvas -- ver auditoría del sprint):
// normalizePredioForDeliverables, resolvePlanLayoutOptions, buildLayoutData,
// estimateFichaTecnicaPageCount, resolvePdfContentMode,
// resolvePdfSummaryCardContent, resolvePdfUsoAlcanceContent,
// resolveExecutiveTableHeaders, buildUnifiedTableRows,
// resolvePdfTechnicalPageTitle, resolvePdfExecutiveBottomNote,
// buildCatastroxDeliverableFilename. Solo se reescribe la capa de DIBUJO
// (antes canvas, ahora PDFKit) -- prioriza paridad de contenido y
// estructura de página sobre replicar píxel a píxel el diseño satelital
// del navegador (riesgo documentado en el informe del sprint).
import PDFDocument from 'pdfkit';
import {
  normalizePredioForDeliverables,
  resolvePlanLayoutOptions,
  buildLayoutData,
  estimateFichaTecnicaPageCount,
  resolvePdfContentMode,
  resolvePdfSummaryCardContent,
  resolvePdfUsoAlcanceContent,
  resolveExecutiveTableHeaders,
  buildUnifiedTableRows,
  resolvePdfTechnicalPageTitle,
  resolvePdfExecutiveBottomNote,
  buildCatastroxDeliverableFilename,
} from '../../../../src/modules/catastrox/utils/catastroxDeliverables.js';

const PAGE_SIZE = 'LETTER';
const MARGIN = 50;
const BRAND_COLOR = '#1f5138';
const MUTED_COLOR = '#555555';

function withSilencedConsole(fn) {
  const originals = { log: console.log, table: console.table, warn: console.warn };
  console.log = () => {};
  console.table = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, originals);
  }
}

function formatNumberEs(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'No disponible';
  return num.toLocaleString('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function drawHeader(doc, { title, pageLabel }) {
  doc
    .fillColor(BRAND_COLOR)
    .fontSize(16)
    .font('Helvetica-Bold')
    .text('CatastroX', MARGIN, MARGIN, { continued: false });
  doc
    .fillColor(MUTED_COLOR)
    .fontSize(9)
    .font('Helvetica')
    .text(pageLabel, doc.page.width - MARGIN - 120, MARGIN, { width: 120, align: 'right' });
  doc
    .fillColor('#000000')
    .fontSize(13)
    .font('Helvetica-Bold')
    .text(title, MARGIN, MARGIN + 26, { width: doc.page.width - MARGIN * 2 });
  doc.moveTo(MARGIN, MARGIN + 50).lineTo(doc.page.width - MARGIN, MARGIN + 50).strokeColor('#cccccc').stroke();
  doc.y = MARGIN + 62;
}

function drawFooter(doc, { legalNotice }) {
  const bottom = doc.page.height - MARGIN;
  doc
    .fontSize(7)
    .fillColor(MUTED_COLOR)
    .font('Helvetica')
    .text(legalNotice, MARGIN, bottom - 22, { width: doc.page.width - MARGIN * 2, align: 'left' });
}

function drawLabelValueRows(doc, rows, { colWidth } = {}) {
  const startX = MARGIN;
  const width = colWidth || doc.page.width - MARGIN * 2;
  const labelWidth = 170;

  for (const [label, value] of rows) {
    const rowY = doc.y;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#333333')
      .text(label, startX, rowY, { width: labelWidth });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#000000')
      .text(String(value ?? 'No disponible'), startX + labelWidth, rowY, { width: width - labelWidth });
    doc.moveDown(0.35);
  }
}

function drawTable(doc, { headers, rows, columnWidths }) {
  const startX = MARGIN;
  let y = doc.y;
  const rowHeight = 16;
  const tableWidth = columnWidths.reduce((a, b) => a + b, 0);

  doc.rect(startX, y, tableWidth, rowHeight).fill(BRAND_COLOR);
  let cursorX = startX;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
  headers.forEach((header, index) => {
    doc.text(header, cursorX + 4, y + 4, { width: columnWidths[index] - 8 });
    cursorX += columnWidths[index];
  });
  y += rowHeight;

  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  rows.forEach((row, rowIndex) => {
    if (y > doc.page.height - MARGIN - 40) {
      doc.addPage({ size: PAGE_SIZE, margin: MARGIN });
      y = MARGIN;
    }
    if (rowIndex % 2 === 1) {
      doc.rect(startX, y, tableWidth, rowHeight).fill('#f2f2f2');
      doc.fillColor('#000000');
    }
    cursorX = startX;
    row.forEach((cell, colIndex) => {
      doc.text(String(cell ?? ''), cursorX + 4, y + 4, { width: columnWidths[colIndex] - 8 });
      cursorX += columnWidths[colIndex];
    });
    y += rowHeight;
  });

  doc.y = y + 10;
}

// Proyección simple de caja delimitadora -- el ring viene en WGS84
// (grados, ver server/routes/catastrox.js:resolvePredioDataForDelivery) y
// el predio es de escala parcelaria (variación de pocos km) -- una
// proyección equirrectangular local (sin corrección trigonométrica) es
// visualmente correcta a esta escala y evita reimplementar el motor de
// proyección cartográfica completo (CartographicPresentationEngine.js)
// solo para dibujar un contorno. Nunca se usa para calcular área/distancia
// -- esos valores SIEMPRE vienen de PostGIS (ST_Area/ST_Perimeter) o de
// buildLayoutData/DistanceEngine, nunca de esta proyección visual.
function projectRingToBox(ring, box) {
  const xs = ring.map((point) => point[0]);
  const ys = ring.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min(box.width / spanX, box.height / spanY) * 0.85;
  const offsetX = box.x + (box.width - spanX * scale) / 2;
  const offsetY = box.y + (box.height - spanY * scale) / 2;

  return ring.map(([lng, lat]) => [
    offsetX + (lng - minX) * scale,
    // Y de PDF crece hacia abajo; latitud crece hacia el norte -- se invierte.
    offsetY + (maxY - lat) * scale,
  ]);
}

// Los vértices de referencia (P1..Pn) se listan en la tabla adjunta, no
// como rótulos rotados sobre el propio plano -- se omite deliberadamente
// la colocación de etiquetas (LabelPlacementEngine.js, la pieza más
// compleja del motor visual del navegador) a favor de legibilidad simple:
// numeración consistente entre plano y tabla, sin intentar replicar el
// posicionamiento píxel a píxel del canvas original.
function drawPolygon(doc, ring, box) {
  if (!Array.isArray(ring) || ring.length < 3) return;
  const projected = projectRingToBox(ring, box);

  doc.save();
  doc.rect(box.x, box.y, box.width, box.height).strokeColor('#dddddd').stroke();
  doc.polygon(...projected).fillColor(BRAND_COLOR).fillOpacity(0.12).fill();
  doc.polygon(...projected).strokeColor(BRAND_COLOR).lineWidth(1.5).fillOpacity(1).stroke();
  doc.restore();
}

/**
 * Genera el PDF completo (Buffer) para un predio+paquete ya resueltos
 * server-side. NUNCA recibe datos de identidad del cliente -- `predioData`
 * viene exclusivamente de resolvePredioDataForDelivery(canonicalPredioId)
 * (server/routes/catastrox.js), y packageId de la orden en Postgres.
 *
 * @param {{ predioData: object, packageId: string, orderReference: string }} input
 * @returns {Promise<Buffer>}
 */
export async function generateCatastroxPdfBuffer({ predioData, packageId }) {
  const predio = normalizePredioForDeliverables({ predio: { ...predioData, deliverablePackageId: packageId } });
  const contentMode = resolvePdfContentMode(packageId);
  const summaryCard = resolvePdfSummaryCardContent(packageId);
  const usoAlcance = resolvePdfUsoAlcanceContent(packageId);

  // buildLayoutData() registra reportes de depuración extensos vía
  // console.log/console.table (pensados para la consola del navegador,
  // ver catastroxDeliverables.js) -- se silencian solo durante esta
  // llamada puntual para no inundar los logs de Railway en cada PDF
  // generado; nunca se toca el comportamiento de la función en sí.
  const layoutData = withSilencedConsole(() => buildLayoutData(predio, resolvePlanLayoutOptions(predio, {})));
  const fichaPageCount = estimateFichaTecnicaPageCount(predio);
  const tableHeaders = resolveExecutiveTableHeaders(contentMode);
  const tableRows = buildUnifiedTableRows(layoutData.referenceRows, layoutData.referenceSegments, contentMode);
  const technicalTitle = resolvePdfTechnicalPageTitle(contentMode);
  const bottomNote = resolvePdfExecutiveBottomNote(contentMode, packageId);

  const legalNotice =
    'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. ' +
    'No reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.';

  const doc = new PDFDocument({ size: PAGE_SIZE, margin: MARGIN, bufferPages: true, compress: false });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  // Página 1 -- resumen
  drawHeader(doc, { title: `Diagnóstico predial · ${summaryCard.title}`, pageLabel: '1' });
  doc.font('Helvetica').fontSize(10).fillColor('#000000').text(summaryCard.body, MARGIN, doc.y, {
    width: doc.page.width - MARGIN * 2,
  });
  doc.moveDown(0.8);
  drawLabelValueRows(doc, [
    ['Código predial', predio.codigoPredial],
    ['Código anterior', predio.codigoAnterior],
    ['Municipio', predio.municipio],
    ['Departamento', predio.departamento],
    ['Vereda', predio.veredaDisplay?.value || 'No disponible'],
    ['Nombre del predio', predio.nombrePredio],
    ['Zona', predio.tipoZona],
    ['Área (hectáreas)', `${formatNumberEs(predio.areaHa, 4)} ha`],
    ['Área (m²)', `${formatNumberEs(predio.areaM2, 2)} m²`],
    ['Perímetro', `${formatNumberEs(predio.perimetroM, 2)} m`],
  ]);
  drawFooter(doc, { legalNotice });

  // Página(s) 2..N -- ficha técnica y catastral
  const fichaRows = [
    ['Dirección', predio.direccionReal],
    ['Barrio', predio.barrioNombre || 'No disponible'],
    ['Sector', predio.sectorCodigo || 'No disponible'],
    ['Manzana', predio.manzanaCodigo || 'No disponible'],
    ['Destino económico', predio.destinoEconomicoNombre || 'No disponible'],
    ['Uso 1', predio.uso1Nombre || 'No disponible'],
    ['Uso 2', predio.uso2Nombre || 'No disponible'],
    ['Uso 3', predio.uso3Nombre || 'No disponible'],
    ['Número de construcciones', predio.numeroConstrucciones ?? 'No disponible'],
    ['Área construida (m²)', predio.areaConstruidaM2 ? `${formatNumberEs(predio.areaConstruidaM2, 2)} m²` : 'No disponible'],
    ['Tipos de construcción', predio.tiposConstruccionResumen || 'No disponible'],
    ['Fuente', predio.fuente || 'No disponible'],
    ['Fecha de proceso', predio.fechaProceso || 'No disponible'],
  ];
  const rowsPerFichaPage = Math.ceil(fichaRows.length / fichaPageCount);
  for (let page = 0; page < fichaPageCount; page += 1) {
    doc.addPage({ size: PAGE_SIZE, margin: MARGIN });
    drawHeader(doc, {
      title: 'Ficha técnica y catastral',
      pageLabel: `${2 + page} de ${2 + fichaPageCount}`,
    });
    const slice = fichaRows.slice(page * rowsPerFichaPage, (page + 1) * rowsPerFichaPage);
    drawLabelValueRows(doc, slice);
    drawFooter(doc, { legalNotice });
  }

  // Página siguiente -- uso y alcance
  doc.addPage({ size: PAGE_SIZE, margin: MARGIN });
  drawHeader(doc, { title: 'Uso y alcance del documento', pageLabel: `${2 + fichaPageCount}` });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND_COLOR).text('ARCHIVOS ENTREGADOS');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  usoAlcance.deliveredFiles.forEach((line) => doc.text(`• ${line}`, { width: doc.page.width - MARGIN * 2 }));
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND_COLOR).text(usoAlcance.instructionsTitle);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  usoAlcance.instructions.forEach((line) => doc.text(`• ${line}`, { width: doc.page.width - MARGIN * 2 }));
  drawFooter(doc, { legalNotice });

  // Página(s) finales -- plano técnico + tabla de puntos de referencia
  doc.addPage({ size: PAGE_SIZE, margin: MARGIN });
  drawHeader(doc, { title: technicalTitle, pageLabel: 'Plano' });
  const mapBox = { x: MARGIN, y: doc.y, width: doc.page.width - MARGIN * 2, height: 220 };
  drawPolygon(doc, predio.displayRing?.length ? predio.displayRing : predio.ring, mapBox);
  doc.y = mapBox.y + mapBox.height + 16;
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED_COLOR)
    .text(bottomNote, MARGIN, doc.y, { width: doc.page.width - MARGIN * 2 });
  doc.moveDown(0.8);

  const columnWidths =
    tableHeaders.length === 3
      ? [120, 120, doc.page.width - MARGIN * 2 - 240]
      : tableHeaders.map(() => (doc.page.width - MARGIN * 2) / tableHeaders.length);
  drawTable(doc, { headers: tableHeaders, rows: tableRows, columnWidths });
  drawFooter(doc, { legalNotice });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export { buildCatastroxDeliverableFilename };
