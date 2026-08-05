// CATX-DELIVERY-001 / CATX-PDF-PARITY-002: generador de PDF server-side,
// 100% JS puro (PDFKit, sin dependencias nativas) -- reemplaza el
// bloqueador de deliveryJobService.js (antes lanzaba
// SERVER_SIDE_GENERATION_NOT_IMPLEMENTED siempre). El generador de
// navegador (src/modules/catastrox/utils/catastroxDeliverables.js, canvas
// hecho a mano, botón "Descargar PDF" de "DESCARGAS HABILITADAS") se
// mantiene intacto como diseño canónico/respaldo -- este módulo NO lo
// reemplaza ni lo modifica, coexiste con él.
//
// CATX-PDF-PARITY-002 (segunda vuelta -- paridad visual real, no solo de
// datos/estructura): el generador aprobado dibuja sobre un lienzo de
// 792x612pt (LANDSCAPE) -- este archivo usaba antes LETTER portrait
// (612x792), lo que por sí solo invalidaba cualquier intento de igualar
// posiciones. Cada coordenada de este archivo está copiada literalmente de
// las constantes SATELLITE_LAYOUT/TECHNICAL_LAYOUT/TABLE_LAYOUT y de las
// funciones de dibujo de catastroxDeliverables.js (drawHeader,
// drawCommercialMetric, drawPanel, drawScaleBar, drawCompassRose,
// drawVisiblePoints, drawTechnicalSegmentDimensions, drawSimpleTable) --
// traducidas 1:1 de la API canvas 2D a primitivas PDFKit. La única
// diferencia estructural deliberada es el texto: canvas fillText(x,y) usa
// y=línea de base; PDFKit doc.text(x,y) usa y=techo de la caja. `baseText`
// /`wrappedText` de abajo hacen esa conversión de forma centralizada.
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
  buildUsosConstructivosList,
  buildUsosConstructivosResumen,
  toProperNameTitleCase,
  formatFuenteDisplay,
  formatFechaProcesoDisplay,
  resolveFieldOrNotRegistered,
  resolveUrbanFieldOrNotApplicable,
  isUrbanZona,
  toDisplayToponymTitleCase,
  toSentenceCase,
} from './catastroxPdfLayout.js';
import { computeMapState, projectRingToViewport, projectPointToViewport, computeDynamicScaleMeters } from './catastroxPdfGeometry.js';
import { fetchSatelliteMosaic, TILE_SIZE, ESRI_IMAGERY_ATTRIBUTION, ESRI_LABELS_ATTRIBUTION, MapRenderError } from './catastroxPdfMap.js';
import {
  buildVisiblePointPlacements,
  buildTechnicalSegmentDimensionPlacements,
  getCompassRoseRect,
  getScaleBarRect,
  chooseScaleBarAnchor,
} from './catastroxPdfDimensions.js';
import {
  buildHydricGroups,
  collectHiddenVertexIndices,
  collectHiddenSegmentIndices,
  applyHydricGroupsToTableRows,
} from './catastroxPdfBoundaryAnnotations.js';

// Página landscape 792x612pt -- misma que PAGE = { width: 792, height: 612 }
// en catastroxDeliverables.js. PDFKit no tiene un tamaño con nombre para
// esto, se pasa el arreglo [width, height] directamente.
const PAGE_SIZE = [792, 612];
const MUTED_COLOR = '#334155';

// Colores literales del diseño aprobado (catastroxDeliverables.js).
const NAVY_TITLE = '#0a2e73';
const NAVY_PANEL = '#0a2e73';
const NAVY_HEADLINE = '#07152d';
const CYAN = '#00aeea';
const GREEN = '#8bcf2b';
const INK = '#0f172a';
const LABEL_GRAY = '#52637d';
const BODY_GRAY = '#243446';
const TABLE_BODY = '#334155';
const BORDER_LIGHT = '#d6dfef';
const BORDER_LIGHTER = '#c9d6ea';
const STRIPE_BG = '#f8fbff';
const DIMENSION_GRAY = '#64748b';
const LEGAL_FOOTER_TEXT =
  'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. ' +
  'Este documento no reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.';

// Zonas de página -- copiadas literalmente de SATELLITE_LAYOUT/TECHNICAL_LAYOUT/TABLE_LAYOUT
// (catastroxDeliverables.js:47-71). UNIFIED_FOOTER_RECT es el mismo rect en las 3.
const UNIFIED_FOOTER_RECT = { x: 24, y: 576, width: 744, height: 20 };
const HEADER_ZONE = { x: 22, y: 20, width: 748, height: 84 };
const TECHNICAL_MAP_AREA = { x: 24, y: 108, width: 744, height: 450 };
const TABLE_AREA = { x: 24, y: 116, width: 744, height: 416 };
const TABLE_BOTTOM_PANEL = { x: 24, y: 536, width: 744, height: 32 };

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

function cleanValue(value, fallback = 'No disponible') {
  if (value === null || value === undefined) return fallback;
  const str = String(value).trim();
  return str ? str : fallback;
}

// --- Primitivas de dibujo (traducción canvas 2D -> PDFKit) ---

function fillRect(doc, x, y, w, h, color) {
  doc.rect(x, y, w, h).fillColor(color).fill();
}

function strokeRect(doc, x, y, w, h, color, lineWidth = 1) {
  doc.rect(x, y, w, h).strokeColor(color).lineWidth(lineWidth).stroke();
}

// canvas fillText(text, x, yBaseline) -> PDFKit doc.text(text, x, yTop).
// Aproximación estándar ascender/tamaño para Helvetica (~0.8) -- no
// pixel-perfect, pero preserva la posición relativa de cada bloque de texto
// tal como está diagramado en el generador aprobado.
function baseText(doc, text, x, yBaseline, { size = 10, bold = false, color = INK, width, align, lineBreak = false } = {}) {
  doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  const opts = { lineBreak };
  if (width != null) opts.width = width;
  if (align) opts.align = align;
  doc.text(String(text ?? ''), x, yBaseline - size * 0.8, opts);
}

function widthOf(doc, text, size, bold) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  return doc.widthOfString(String(text ?? ''));
}

// Réplica de measureWrappedText/drawWrappedText (catastroxDeliverables.js:1114-1150):
// wrap por palabras contra maxWidth, una línea por índice, baseline en
// y + index*lineHeight.
function wrapLines(doc, text, maxWidth, size, bold) {
  const words = cleanValue(text, '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (widthOf(doc, next, size, bold) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrappedText(doc, text, x, y, maxWidth, lineHeight, { size = 10, bold = false, color = INK } = {}) {
  const lines = wrapLines(doc, text, maxWidth, size, bold);
  lines.forEach((line, index) => {
    baseText(doc, line, x, y + index * lineHeight, { size, bold, color });
  });
  return { lines, height: lines.length * lineHeight };
}

function fitSingleLineFontSize(doc, text, maxWidth, { maxSize = 11, minSize = 7, bold = true, step = 0.5 } = {}) {
  let size = maxSize;
  while (size > minSize) {
    if (widthOf(doc, text, size, bold) <= maxWidth) return size;
    size -= step;
  }
  return minSize;
}

// drawHeader (catastroxDeliverables.js:1294-1340) -- misma fila para las 5
// páginas: marca, título dinámico (se reduce hasta caber), código predial,
// y la insignia "PÁGINA X de N" arriba a la derecha.
function drawHeader(doc, { title, pageLabel, codigoPredial }) {
  const zone = HEADER_ZONE;
  strokeRect(doc, zone.x, zone.y, zone.width, zone.height, BORDER_LIGHTER);

  baseText(doc, 'Catastro', zone.x + 14, zone.y + 30, { size: 28, bold: true, color: '#10233a' });
  baseText(doc, 'X', zone.x + 124, zone.y + 30, { size: 28, bold: true, color: CYAN });
  baseText(doc, 'by CRH', zone.x + 16, zone.y + 46, { size: 9, color: '#10233a' });
  baseText(doc, 'Vertical predial de AgroGenomaX', zone.x + 16, zone.y + 60, { size: 9, color: '#10233a' });

  const pageBox = { x: zone.x + zone.width - 76, y: zone.y + 8, width: 62, height: 34 };
  const titleX = zone.x + 360;
  const titleMaxWidth = pageBox.x - titleX - 12;
  let titleSize = 18;
  while (widthOf(doc, title, titleSize, true) > titleMaxWidth && titleSize > 12) titleSize -= 0.5;
  baseText(doc, title, titleX, zone.y + 24, { size: titleSize, bold: true, color: NAVY_TITLE });

  baseText(doc, 'CÓDIGO PREDIAL', zone.x + 500, zone.y + 42, { size: 8, bold: true, color: '#334155' });
  const codigoMaxWidth = pageBox.x - (zone.x + 500) - 12;
  const codigoSize = fitSingleLineFontSize(doc, codigoPredial, codigoMaxWidth, { maxSize: 11, minSize: 7 });
  baseText(doc, codigoPredial, zone.x + 500, zone.y + 58, { size: codigoSize, bold: true, color: INK });

  fillRect(doc, pageBox.x, pageBox.y, pageBox.width, pageBox.height, NAVY_TITLE);
  baseText(doc, 'PÁGINA', pageBox.x + 7, zone.y + 21, { size: 7, bold: true, color: '#ffffff' });
  baseText(doc, pageLabel, pageBox.x + 7, zone.y + 34, { size: 8.6, bold: true, color: '#ffffff' });
}

// drawPanel (catastroxDeliverables.js:1342-1352): caja blanca + barra
// superior navy con título en blanco.
function drawPanel(doc, rect, title) {
  fillRect(doc, rect.x, rect.y, rect.width, rect.height, '#ffffff');
  strokeRect(doc, rect.x, rect.y, rect.width, rect.height, BORDER_LIGHTER);
  fillRect(doc, rect.x, rect.y, rect.width, 24, NAVY_PANEL);
  baseText(doc, title, rect.x + 12, rect.y + 16, { size: 10, bold: true, color: '#ffffff' });
}

function drawLegalFooter(doc, rect) {
  wrappedText(doc, LEGAL_FOOTER_TEXT, rect.x + 16, rect.y, rect.width - 32, 10, { size: 8, color: TABLE_BODY });
}

// drawBullets (catastroxDeliverables.js:1396-1419): cuadro 6x6 + texto
// envuelto, devuelve el Y siguiente disponible.
function drawBullets(doc, items, x, y, width, color, { lineHeight = 14, itemGap = 8, minItemHeight = 22, size = 10.5 } = {}) {
  let cursorY = y;
  items.forEach((item) => {
    const lines = wrapLines(doc, item, width - 14, size, false);
    const textHeight = Math.max(1, lines.length) * lineHeight;
    fillRect(doc, x, cursorY - 7, 6, 6, color);
    wrappedText(doc, item, x + 14, cursorY, width - 14, lineHeight, { size, color: BODY_GRAY });
    cursorY += Math.max(minItemHeight, textHeight + itemGap);
  });
  return cursorY;
}

// drawCommercialMetric (catastroxDeliverables.js:2113-2140): tarjeta de la
// grilla de página 1 -- fondo blanco, borde gris claro, barra de acento
// izquierda de 5pt, etiqueta gris mayúscula, valor negro en negrita.
function drawInfoCard(doc, x, y, width, height, label, value, accent, { labelSize = 8.7, valueSize = 12 } = {}) {
  fillRect(doc, x, y, width, height, '#ffffff');
  strokeRect(doc, x, y, width, height, BORDER_LIGHT);
  fillRect(doc, x, y, 5, height, accent);
  const labelLines = wrapLines(doc, String(label).toUpperCase(), width - 24, labelSize, true);
  wrappedText(doc, String(label).toUpperCase(), x + 14, y + 18, width - 24, 9.5, { size: labelSize, bold: true, color: LABEL_GRAY });
  const valueY = y + (labelLines.length > 1 ? 43 : 40);
  wrappedText(doc, value, x + 14, valueY, width - 24, 13, { size: valueSize, bold: true, color: INK });
}

// drawCompassRose (catastroxDeliverables.js:1868-1918): rosa de 8 puntas
// alternando relleno primario/secundario, círculo central, etiquetas N/S/O/E.
function drawCompassRose(doc, cx, cy, { outer = 18, inner = 7, dark = false } = {}) {
  const color = dark ? '#10233a' : '#ffffff';
  const secondary = dark ? '#ffffff' : '#10233a';

  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI / 4) * index - Math.PI / 2;
    const tip = [cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer];
    const left = [cx + Math.cos(angle + Math.PI / 12) * inner, cy + Math.sin(angle + Math.PI / 12) * inner];
    const right = [cx + Math.cos(angle - Math.PI / 12) * inner, cy + Math.sin(angle - Math.PI / 12) * inner];
    if (index % 2 === 0) {
      doc.polygon(tip, left, right).fillColor(color).fill();
    } else {
      doc.polygon(tip, left, right).fillColor(secondary).fill();
      doc.polygon(tip, left, right).strokeColor(color).lineWidth(1.2).stroke();
    }
  }
  doc.circle(cx, cy, 5).fillColor(secondary).fill();
  doc.circle(cx, cy, 5).strokeColor(color).lineWidth(1.2).stroke();

  baseText(doc, 'N', cx - 4, cy - outer - 4, { size: 7, bold: true, color, width: 8, align: 'center' });
  baseText(doc, 'S', cx - 4, cy + outer + 12, { size: 7, bold: true, color, width: 8, align: 'center' });
  baseText(doc, 'O', cx - outer - 14, cy + 3, { size: 7, bold: true, color, width: 10, align: 'center' });
  baseText(doc, 'E', cx + outer + 4, cy + 3, { size: 7, bold: true, color, width: 10, align: 'center' });
}

// drawScaleBar (catastroxDeliverables.js:1767-1798): caja blanca, 4 bloques
// alternados, marcas de metros en 0/25/50/75/100%.
function drawScaleBar(doc, x, y, totalMeters, { compact = false } = {}) {
  const boxWidth = compact ? 146 : 170;
  const boxHeight = compact ? 46 : 50;
  const blockWidth = compact ? 26 : 32;
  const boxTop = y - 22;
  const barY = boxTop + 18;
  const labelY = boxTop + 13;
  const tickY = boxTop + 38;

  fillRect(doc, x - 8, boxTop, boxWidth, boxHeight, '#ffffff');
  strokeRect(doc, x - 8, boxTop, boxWidth, boxHeight, '#10233a');
  baseText(doc, 'ESCALA GRÁFICA', x, labelY, { size: compact ? 8 : 9, bold: true, color: '#10233a' });

  for (let index = 0; index < 4; index += 1) {
    fillRect(doc, x + index * blockWidth, barY, blockWidth, 10, index % 2 === 0 ? '#10233a' : '#ffffff');
    strokeRect(doc, x + index * blockWidth, barY, blockWidth, 10, '#10233a', 0.75);
  }
  baseText(doc, '0', x, tickY, { size: 8, color: '#10233a' });
  baseText(doc, `${Math.round(totalMeters / 4)}`, x + Math.round(blockWidth * 0.9), tickY, { size: 8, color: '#10233a' });
  baseText(doc, `${Math.round(totalMeters / 2)}`, x + Math.round(blockWidth * 1.9), tickY, { size: 8, color: '#10233a' });
  baseText(doc, `${Math.round((totalMeters * 3) / 4)}`, x + Math.round(blockWidth * 2.9), tickY, { size: 8, color: '#10233a' });
  baseText(doc, `${totalMeters} m`, x + Math.round(blockWidth * 3.7), tickY, { size: 8, color: '#10233a' });
}

// drawVisiblePoints (catastroxDeliverables.js:1689-1735) aplicada sobre las
// posiciones YA resueltas por buildVisiblePointPlacements (motor de
// colisiones, catastroxPdfDimensions.js) -- círculo blanco con borde navy,
// etiqueta P1..Pn centrada, línea guía si el círculo se desplazó de su
// vértice real, y el vértice se omite (nunca se dibuja superpuesto) si el
// motor no encontró ninguna posición libre.
function drawVertexCircles(doc, placements, { radius = 7.25, fontSize = 7.1, hiddenIndices = null } = {}) {
  placements.forEach((placement, index) => {
    if (placement.hidden) return;
    // CATX-PDF-PARITY-002 (cierre): vértices intermedios de un lindero
    // hídrico agrupado (catastroxPdfBoundaryAnnotations.js) -- el punto
    // inicial y final del grupo SIEMPRE se dibujan; solo los intermedios se
    // omiten aquí. La geometría (la línea del polígono) sigue dibujándose
    // completa e inalterada; solo se omite el círculo+rótulo Pn.
    if (hiddenIndices?.has(index)) return;
    const { anchorX, anchorY, circleX: x, circleY: y, showGuide } = placement;
    if (showGuide) {
      doc.save();
      doc.strokeColor('#9aa7bc').lineWidth(0.8);
      doc.moveTo(anchorX, anchorY).lineTo(x, y).stroke();
      doc.restore();
    }
    doc.circle(x, y, radius).fillColor('#ffffff').fill();
    doc.circle(x, y, radius).strokeColor(NAVY_TITLE).lineWidth(1.5).stroke();
    const label = `P${index + 1}`;
    const w = widthOf(doc, label, fontSize, true);
    baseText(doc, label, x - w / 2, y + 3, { size: fontSize, bold: true, color: NAVY_TITLE });
  });
}

// drawTechnicalSegmentDimensions (catastroxDeliverables.js:2902-2924) sobre
// los `placements` ya resueltos por buildTechnicalSegmentDimensionPlacements
// (búsqueda de candidatos + evasión de colisiones, catastroxPdfDimensions.js)
// -- línea guía opcional, caja de fondo translúcida, texto rotado al ángulo
// exacto del tramo.
function drawSegmentDimensions(doc, placements) {
  const fontSize = 6.8;
  placements.forEach((placement) => {
    if (placement.guideLine) {
      doc.save();
      doc.strokeColor('#b7c0cd').lineWidth(0.5);
      doc.moveTo(placement.guideLine.x1, placement.guideLine.y1).lineTo(placement.guideLine.x2, placement.guideLine.y2).stroke();
      doc.restore();
    }
    const textWidth = widthOf(doc, placement.text, fontSize, false);
    doc.save();
    doc.translate(placement.centerX, placement.centerY);
    doc.rotate((placement.angle * 180) / Math.PI);
    doc.rect(-placement.maskWidth / 2, -placement.maskHeight / 2, placement.maskWidth, placement.maskHeight).fillColor('#ffffff').fillOpacity(0.74).fill();
    doc.fillOpacity(1);
    doc.fillColor(DIMENSION_GRAY).font('Helvetica').fontSize(fontSize);
    doc.text(placement.text, -textWidth / 2, -3, { lineBreak: false });
    doc.restore();
  });
}

// CATX-PDF-PARITY-002 (cierre): etiqueta agrupada de un lindero por fuente
// hídrica -- capacidad NUEVA sin equivalente canónico en el navegador (ver
// catastroxPdfBoundaryAnnotations.js). Se dibuja UNA vez por grupo, en el
// centroide de TODOS los vértices del tramo (inicio + intermedios + fin, en
// coordenadas de página ya proyectadas) -- a diferencia de una etiqueta de
// tramo recto, un lindero sinuoso no tiene un único ángulo bien definido,
// así que el texto se dibuja horizontal (sin rotar) con una caja de fondo
// blanca, mismo estilo visual que las demás etiquetas de distancia. No pasa
// por el motor de colisiones de buildTechnicalSegmentDimensionPlacements
// (diseño nuevo, documentado como tal) -- para los fixtures probados no
// coincide con ningún otro elemento; queda como brecha conocida disponible
// para un futuro ajuste si un caso real lo requiere.
function drawHydricGroupLabel(doc, { centerX, centerY, label, distanceMeters }) {
  const text = `${label} — ${formatNumberEs(distanceMeters, 2)} m`;
  const fontSize = 7.2;
  const textWidth = widthOf(doc, text, fontSize, false);
  const maskWidth = textWidth + 10;
  const maskHeight = 14;
  doc.rect(centerX - maskWidth / 2, centerY - maskHeight / 2, maskWidth, maskHeight).fillColor('#ffffff').fillOpacity(0.88).fill();
  doc.rect(centerX - maskWidth / 2, centerY - maskHeight / 2, maskWidth, maskHeight).strokeColor('#7dd3fc').lineWidth(0.75).fillOpacity(1).stroke();
  baseText(doc, text, centerX - textWidth / 2, centerY + 3, { size: fontSize, bold: true, color: '#0369a1' });
}

/**
 * Dibuja el mosaico satelital + polígono superpuesto dentro de `box`.
 * Estricto (ajuste obligatorio del pedido, requisito 6): si
 * fetchSatelliteMosaic() lanza (cualquier tesela falla o excede el
 * timeout), esta función NO atrapa el error -- se propaga tal cual hacia
 * generateCatastroxPdfBuffer() y de ahí hacia processDeliveryJob(), que
 * nunca llega a insertar metadatos ni a llamar storage.put() (ver
 * deliveryJobService.js) -- nunca se almacena ni se envía un PDF sin mapa.
 *
 * @param {{ fetchTile?: Function }} [testOverrides] únicamente para
 *   pruebas -- inyecta un mock determinista de descarga de tesela.
 * @returns {Promise<{ mapState: object, projected: number[][] }>}
 */
async function drawSatelliteTiles(doc, ring, box, testOverrides = {}) {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new MapRenderError('El predio no tiene un polígono válido para dibujar el mapa satelital.');
  }

  const mapState = computeMapState(ring, box.width, box.height, 18);
  const tiles = await fetchSatelliteMosaic(mapState, box.width, box.height, testOverrides);

  doc.save();
  doc.rect(box.x, box.y, box.width, box.height).clip();
  fillRect(doc, box.x, box.y, box.width, box.height, '#1a3325');
  for (const tile of tiles) {
    doc.image(tile.buffer, box.x + tile.drawX, box.y + tile.drawY, { width: TILE_SIZE, height: TILE_SIZE });
  }
  doc.restore();

  const projected = projectRingToViewport(ring, mapState, box.width, box.height).map(([px, py]) => [box.x + px, box.y + py]);
  return { mapState, projected };
}

/**
 * Genera el PDF completo (Buffer) para un predio+paquete ya resueltos
 * server-side. NUNCA recibe datos de identidad del cliente -- `predioData`
 * viene exclusivamente de resolvePredioDataForDelivery(canonicalPredioId)
 * (server/routes/catastrox.js), y packageId de la orden en Postgres.
 *
 * Produce exactamente 5 páginas para el contenido típico de "básico"
 * (resumen+mapa, ficha técnica, uso y alcance, plano, tabla) -- el total
 * real se calcula dinámicamente (fichaPageCount y tablePages varían según
 * el predio), igual que el generador de navegador, nunca se asume "5" a
 * ciegas.
 *
 * @param {{ predioData: object, packageId: string, orderReference: string, fetchTile?: Function }} input
 * @returns {Promise<Buffer>}
 */
export async function generateCatastroxPdfBuffer({ predioData, packageId, fetchTile } = {}) {
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
  const ring = predio.displayRing?.length ? predio.displayRing : predio.ring;

  // CATX-PDF-PARITY-002 (cierre): linderos por fuente hídrica -- SOLO se
  // agrupa cuando predio.boundaryAnnotations trae anotaciones explícitas
  // con boundaryType='FUENTE_HIDRICA' (normalizePredioForDeliverables ya
  // garantiza un array, vacío por defecto). Ningún predio real de
  // catastrox_clean tiene hoy este campo, así que hydricGroups=[] para
  // cualquier predio existente -- cero cambio de comportamiento salvo que
  // alguien lo asigne explícitamente (ver catastroxPdfBoundaryAnnotations.js).
  const hydricGroups = buildHydricGroups(layoutData.referenceSegments, predio.boundaryAnnotations);
  const hydricHiddenVertexIndices = collectHiddenVertexIndices(hydricGroups);
  const hydricHiddenSegmentIndices = collectHiddenSegmentIndices(hydricGroups);
  const { rows: tableRowsWithHydric, hasHydricColumn } = applyHydricGroupsToTableRows(
    tableRows,
    hydricGroups,
    (meters) => `${formatNumberEs(meters, 2)} m`,
  );

  const doc = new PDFDocument({ size: PAGE_SIZE, margins: { top: 0, bottom: 0, left: 0, right: 0 }, bufferPages: true, compress: false });

  // Filas de la tabla de vértices (24pt por fila, misma constante que
  // drawSimpleTable) -- prepaginado ANTES de dibujar para poder numerar
  // "X de N" correctamente en todas las páginas, incluida la primera.
  const TABLE_ROW_HEIGHT = 20;
  const tableBodyTop = TABLE_AREA.y + 34;
  const availableTableRows = Math.max(1, Math.floor((TABLE_AREA.height - 54) / TABLE_ROW_HEIGHT));
  const tablePages = Math.max(1, Math.ceil(tableRowsWithHydric.length / availableTableRows));
  // 1 (resumen) + fichaPageCount + 1 (uso/alcance) + 1 (plano) + tablePages.
  const totalPages = 1 + fichaPageCount + 1 + 1 + tablePages;

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  // ---------- Página 1: resumen + mapa satelital ----------
  // Layout literal de buildPlusSummaryPageCanvas (catastroxDeliverables.js:2142-2234).
  drawHeader(doc, { title: 'DIAGNÓSTICO PREDIAL CATASTROX', pageLabel: `1 de ${totalPages}`, codigoPredial: predio.codigoPredial });

  const headlineText = predio.direccionReal && predio.direccionReal !== 'No disponible'
    ? `Dirección del predio: ${predio.direccionReal}. Información identificada por CatastroX a partir de fuentes geográficas y catastrales públicas disponibles.`
    : `Predio ${cleanValue(predio.nombrePredio)}. Información identificada por CatastroX a partir de fuentes geográficas y catastrales públicas disponibles.`;
  fillRect(doc, 24, 128, 360, 86, NAVY_HEADLINE);
  fillRect(doc, 24, 128, 6, 86, CYAN);
  wrappedText(doc, headlineText, 44, 150, 316, 13, { size: 11.5, bold: true, color: '#ffffff' });

  // buildUsosConstructivosResumen (catastroxPdfLayout.js, puerto literal de
  // catastroxDeliverables.js:305-324): deduplica uso1/uso2/uso3 por valor
  // normalizado ANTES de unirlos -- nunca un join() directo, que mostraba
  // el mismo uso dos veces cuando la fuente traía uso2Nombre/uso3Nombre
  // duplicados (regresión detectada en la revisión visual de este mismo
  // predio de referencia). No se toca el dato fuente, solo la presentación.
  const usosConstructivos = buildUsosConstructivosResumen(predio);
  const registrosConstructivos = `${predio.numeroConstrucciones ?? 0} / ${formatNumberEs(predio.areaConstruidaM2, 2)} m²`;
  const areaTotalDisplay = `${formatNumberEs(predio.areaM2, 2)} m²`;

  drawInfoCard(doc, 24, 238, 172, 58, 'Municipio', predio.municipio, CYAN);
  drawInfoCard(doc, 212, 238, 172, 58, 'Departamento', predio.departamento, CYAN);
  drawInfoCard(doc, 24, 312, 172, 58, 'Zona', predio.tipoZona, CYAN);
  drawInfoCard(doc, 212, 312, 172, 58, 'Área total', areaTotalDisplay, GREEN);
  drawInfoCard(doc, 24, 386, 172, 58, 'Perímetro cartográfico total', `${formatNumberEs(predio.perimetroM, 2)} m`, GREEN, { labelSize: 7.6 });
  drawInfoCard(doc, 212, 386, 172, 58, 'Construcciones', registrosConstructivos, GREEN);
  drawInfoCard(doc, 24, 460, 172, 74, 'Destinación catastral', predio.destinoEconomicoNombre, CYAN);
  drawInfoCard(doc, 212, 460, 172, 74, 'Usos constructivos', usosConstructivos, CYAN, { valueSize: 10.2 });

  const mapRect = { x: 420, y: 136, width: 332, height: 296 };
  fillRect(doc, mapRect.x - 10, mapRect.y - 10, mapRect.width + 20, mapRect.height + 20, STRIPE_BG);
  strokeRect(doc, mapRect.x - 10, mapRect.y - 10, mapRect.width + 20, mapRect.height + 20, BORDER_LIGHTER);

  // Si el mapa falla, se lanza ANTES de terminar el documento (doc.end()
  // nunca se llama) -- el llamador debe tratar esto como generación
  // fallida, no como un PDF parcial válido.
  const { mapState: summaryMapState, projected: mapPolygon } = await drawSatelliteTiles(doc, ring, mapRect, { fetchTile });
  doc.save();
  doc.rect(mapRect.x, mapRect.y, mapRect.width, mapRect.height).clip();
  doc.polygon(...mapPolygon).fillColor(CYAN).fillOpacity(0.18).fill();
  doc.fillOpacity(1);
  doc.polygon(...mapPolygon).strokeColor('#ffea00').lineWidth(2.4).stroke();
  doc.restore();
  strokeRect(doc, mapRect.x, mapRect.y, mapRect.width, mapRect.height, BORDER_LIGHTER);
  drawCompassRose(doc, mapRect.x + 46, mapRect.y + 48, { dark: false });
  const summaryScaleMeters = computeDynamicScaleMeters(summaryMapState, mapRect.width);
  // chooseScaleBarAnchor (catastroxPdfDimensions.js, puerto literal de
  // catastroxDeliverables.js:1830-1866): evalúa las 4 esquinas interiores
  // del recuadro y elige la que menos choque con el polígono -- página 1
  // no tiene puntos de referencia ni etiquetas propias todavía (mismos
  // argumentos vacíos que usa buildPlusSummaryPageCanvas para esta llamada).
  const summaryScaleAnchor = chooseScaleBarAnchor(mapRect, mapPolygon, [], [], true);
  drawScaleBar(doc, summaryScaleAnchor.x, summaryScaleAnchor.y, summaryScaleMeters, { compact: true });

  doc.fillColor(MUTED_COLOR).font('Helvetica').fontSize(5.5);
  doc.text(ESRI_IMAGERY_ATTRIBUTION, mapRect.x, mapRect.y + mapRect.height + 12, { width: mapRect.width, lineBreak: false });
  doc.text(ESRI_LABELS_ATTRIBUTION, mapRect.x, mapRect.y + mapRect.height + 20, { width: mapRect.width, lineBreak: false });

  drawPanel(doc, { x: 420, y: 456, width: 332, height: 68 }, summaryCard.title);
  wrappedText(doc, summaryCard.body, 436, 494, 300, 13, { size: 10.5, color: BODY_GRAY });

  drawLegalFooter(doc, UNIFIED_FOOTER_RECT);

  // ---------- Página(s) 2..N: ficha técnica y catastral ----------
  // Layout literal de buildFichaTecnicaSinglePageCanvas +
  // drawIdentificacionPanel (catastroxDeliverables.js:2340-2394,
  // 2566-2589): 3 paneles superiores (Identificación / Características
  // físicas / Clasificación) + panel Fuente inferior. La lógica condicional
  // urbano/rural de drawIdentificacionPanel se porta completa -- ningún
  // campo se selecciona de forma simplificada:
  //  - urbano: encabezado "Dirección del predio", vereda omitida por
  //    completo, Barrio/Manzana muestran valor real o "No registrado";
  //  - rural: encabezado "Nombre del predio", vereda mostrada (nombre común
  //    o, si la fuente solo trae un código catastral de vereda, la fila
  //    "Vereda: No registrada" + "Código catastral de vereda: <código>",
  //    igual que veredaDisplay.isCadastralCode en el navegador), Barrio no
  //    aplica, Manzana no aplica.
  const isUrban = isUrbanZona(predio);
  const veredaDisplay = predio.veredaDisplay || { label: 'Vereda', value: 'Información no disponible', isCadastralCode: false };
  const identificationHeaderField = isUrban
    ? { label: 'Dirección del predio', value: predio.direccionReal && predio.direccionReal !== 'No disponible' ? predio.direccionReal : 'Dirección no registrada', fullWidth: true }
    : { label: 'Nombre del predio', value: toProperNameTitleCase(predio.nombrePredio), fullWidth: true };
  const veredaFields = isUrban
    ? []
    : veredaDisplay.isCadastralCode
      ? [
          { label: veredaDisplay.label, value: 'No registrada' },
          { label: 'Código catastral de vereda', value: veredaDisplay.secondaryValue },
        ]
      : [{ label: veredaDisplay.label, value: veredaDisplay.value }];
  const identFields = [
    identificationHeaderField,
    { label: 'Municipio', value: toDisplayToponymTitleCase(predio.municipio) },
    { label: 'Departamento', value: toDisplayToponymTitleCase(predio.departamento) },
    { label: 'Zona', value: toSentenceCase(predio.tipoZona) },
    ...veredaFields,
    { label: 'Barrio', value: resolveUrbanFieldOrNotApplicable(predio.barrioNombre, predio.tipoZona) },
    { label: 'Manzana', value: isUrban ? 'No registrada' : resolveUrbanFieldOrNotApplicable(predio.manzanaCodigo, predio.tipoZona) },
  ];
  const fisicasFields = [
    { label: 'Área total (ha)', value: formatNumberEs(predio.areaHa, 2) },
    { label: 'Área total (m²)', value: formatNumberEs(predio.areaM2, 2) },
    { label: 'Perímetro cartográfico total', value: `${formatNumberEs(predio.perimetroM, 2)} m` },
    { label: 'Número de construcciones', value: predio.numeroConstrucciones ?? 'No disponible' },
    { label: 'Área construida', value: predio.areaConstruidaM2 ? `${formatNumberEs(predio.areaConstruidaM2, 2)} m²` : 'No disponible' },
  ];

  // Puerto de drawFieldGrid (catastroxDeliverables.js:2018-2059): grilla de
  // 1 o 2 columnas (`columns`) con soporte para filas de ancho completo
  // (`fullWidth`, fuerza salto de fila) y ALTURA DINÁMICA por fila según el
  // número real de líneas que ocupa el valor más largo -- nunca un
  // incremento fijo, que colisionaba cuando un valor envolvía a más de una
  // línea. Devuelve el cursorY siguiente disponible para encadenar bloques
  // (código predial/anterior, panel Fuente) sin huecos ni superposición.
  const drawFieldGridSimple = (rect, fields, options = {}) => {
    const { columns = 2, labelValueGap = 15, fieldGap = 24, columnGap = 24, paddingX = 26, labelSize = 9, valueSize = 10.8, valueLineHeight = 13 } = options;
    const colWidth = columns === 2 ? (rect.width - paddingX * 2 - columnGap) / 2 : rect.width - paddingX * 2;
    let cursorY = rect.y + 46;
    let col = 0;
    let pendingRowHeight = 0;
    const flushRow = () => {
      cursorY += pendingRowHeight + fieldGap;
      col = 0;
      pendingRowHeight = 0;
    };
    fields.forEach((field) => {
      if (field.fullWidth && col !== 0) flushRow();
      const x = rect.x + paddingX + (columns === 2 && col === 1 ? colWidth + columnGap : 0);
      baseText(doc, String(field.label).toUpperCase(), x, cursorY, { size: labelSize, bold: true, color: LABEL_GRAY });
      const lines = wrapLines(doc, cleanValue(field.value), colWidth, valueSize, true);
      wrappedText(doc, cleanValue(field.value), x, cursorY + labelValueGap, colWidth, valueLineHeight, { size: valueSize, bold: true, color: INK });
      const rowHeight = labelValueGap + Math.max(1, lines.length) * valueLineHeight;
      pendingRowHeight = Math.max(pendingRowHeight, rowHeight);
      if (field.fullWidth || columns === 1 || col === 1) flushRow();
      else col = 1;
    });
    if (col !== 0) flushRow();
    return cursorY;
  };

  // Puerto de drawCodeFieldRows (catastroxDeliverables.js:1965-1997): filas
  // de altura fija (código predial/anterior) encadenadas DESPUÉS de la
  // grilla dinámica -- mismo cálculo de arranque que drawIdentificacionPanel
  // (afterRegularY + PDF_LAYOUT_GRID.sectionGap[22] - fieldGap). Código
  // anterior usa resolveFieldOrNotRegistered (mismo fallback "No
  // registrado" que el navegador, no un "|| 'No registrado'" ad-hoc).
  const drawCodeFieldsBlock = (rect, afterRegularY, fieldGap, fieldHeight) => {
    const startX = rect.x + 26;
    const width = rect.width - 52;
    let cursorY = afterRegularY + 22 - fieldGap;
    [
      { label: 'CÓDIGO PREDIAL', value: predio.codigoPredial },
      { label: 'CÓDIGO ANTERIOR', value: resolveFieldOrNotRegistered(predio.codigoAnterior) },
    ].forEach(({ label, value }) => {
      baseText(doc, label, startX, cursorY, { size: 9, bold: true, color: LABEL_GRAY });
      wrappedText(doc, value, startX, cursorY + 12, width, 13, { size: 10.5, bold: true, color: INK });
      cursorY += fieldHeight;
    });
    return cursorY;
  };

  // Puerto de drawClasificacionPanel (catastroxDeliverables.js:2413-2451),
  // generalizado por `rect.width` -- la versión de 1 página lo usa a 360pt
  // (2 columnas de ~142pt), la versión dividida a todo el ancho (744pt, 2
  // columnas de ~334pt). "USOS CONSTRUCTIVOS" se dibuja como LISTA (una
  // línea por uso, vía buildUsosConstructivosList -- deduplicado, nunca el
  // resumen unido de la página 1) y "TIPOS DE CONSTRUCCIÓN" se ubica
  // DEBAJO del bloque más alto entre destinación/usos, nunca a un offset
  // fijo. Devuelve el cursorY final (tiposCursorY) para poder encadenar el
  // panel FUENTE justo debajo, como hace buildFichaTecnicaSplitPageCanvases.
  const drawClasificacionPanelBlock = (rect, options = {}) => {
    const { usoLineHeight = 13, usoItemGap = 4, tiposLineHeight = 15 } = options;
    drawPanel(doc, rect, 'CLASIFICACIÓN Y CONSTRUCCIONES');
    const leftX = rect.x + 26;
    const colW = (rect.width - 52 - 24) / 2;
    const rightX = leftX + colW + 24;
    const labelY = rect.y + 42;
    baseText(doc, 'DESTINACIÓN CATASTRAL', leftX, labelY, { size: 9, bold: true, color: LABEL_GRAY });
    const destLines = wrapLines(doc, predio.destinoEconomicoNombre, colW, 13, true);
    wrappedText(doc, predio.destinoEconomicoNombre, leftX, labelY + 15, colW, 16, { size: 13, bold: true, color: INK });

    baseText(doc, 'USOS CONSTRUCTIVOS', rightX, labelY, { size: 9, bold: true, color: LABEL_GRAY });
    const usosList = buildUsosConstructivosList(predio);
    let usosCursorY = labelY + 15;
    usosList.forEach((uso) => {
      const usoLines = wrapLines(doc, uso, colW, 11.5, true);
      wrappedText(doc, uso, rightX, usosCursorY, colW, usoLineHeight, { size: 11.5, bold: true, color: INK });
      usosCursorY += Math.max(1, usoLines.length) * usoLineHeight + usoItemGap;
    });

    const destBottom = labelY + 15 + Math.max(1, destLines.length) * 16;
    const tiposY = Math.max(destBottom, usosCursorY) + 10;
    baseText(doc, 'TIPOS DE CONSTRUCCIÓN', leftX, tiposY, { size: 9, bold: true, color: LABEL_GRAY });
    const tiposLines = wrapLines(doc, predio.tiposConstruccionResumen || 'No disponible', rect.width - 52, 11.5, true);
    wrappedText(doc, predio.tiposConstruccionResumen || 'No disponible', leftX, tiposY + 15, rect.width - 52, tiposLineHeight, { size: 11.5, bold: true, color: INK });
    return tiposY + 15 + Math.max(1, tiposLines.length) * tiposLineHeight;
  };

  // Puerto de measureFuentePanel/drawFuentePanel (catastroxDeliverables.js:2453-2496):
  // formatFuenteDisplay/formatFechaProcesoDisplay muestran el nombre legible
  // de la fuente y la fecha en español, nunca el código crudo.
  const buildFuenteText = () =>
    `${formatFuenteDisplay(predio.fuente)}. Este documento fue elaborado por CatastroX mediante el procesamiento, organización y presentación de información catastral pública disponible en el Geoportal del IGAC. Fecha de procesamiento: ${formatFechaProcesoDisplay(predio.fechaProceso)}.`;
  const drawFuentePanelBlock = (rect) => {
    drawPanel(doc, rect, 'FUENTE');
    wrappedText(doc, buildFuenteText(), rect.x + 26, rect.y + 36, rect.width - 52, 13, { size: 11, color: BODY_GRAY });
  };

  for (let page = 0; page < fichaPageCount; page += 1) {
    doc.addPage({ size: PAGE_SIZE, margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (fichaPageCount === 1) {
      drawHeader(doc, { title: 'FICHA TÉCNICA Y CATASTRAL', pageLabel: `2 de ${totalPages}`, codigoPredial: predio.codigoPredial });
      const identRect = { x: 24, y: 126, width: 360, height: 356 };
      const fisicasRect = { x: 408, y: 126, width: 360, height: 168 };
      const clasifRect = { x: 408, y: 302, width: 360, height: 198 };
      drawPanel(doc, identRect, 'IDENTIFICACIÓN Y LOCALIZACIÓN');
      const identCursorY = drawFieldGridSimple(identRect, identFields, { columns: 2, labelValueGap: 13, fieldGap: 24 });
      drawCodeFieldsBlock(identRect, identCursorY, 24, 34);

      drawPanel(doc, fisicasRect, 'CARACTERÍSTICAS FÍSICAS');
      drawFieldGridSimple(fisicasRect, fisicasFields, { columns: 2, labelValueGap: 13, fieldGap: 24 });

      drawClasificacionPanelBlock(clasifRect, { usoLineHeight: 13, usoItemGap: 4, tiposLineHeight: 14 });

      const fuenteRect = { x: 24, y: 478, width: 744, height: 78 };
      drawFuentePanelBlock(fuenteRect);
    } else if (page === 0) {
      // Página A de buildFichaTecnicaSplitPageCanvases (catastroxDeliverables.js:2591-2596):
      // Identificación (1 sola columna, todo el alto del panel) +
      // Características físicas (2 columnas), lado a lado.
      drawHeader(doc, { title: 'FICHA TÉCNICA Y CATASTRAL', pageLabel: `2 de ${totalPages}`, codigoPredial: predio.codigoPredial });
      const identRect = { x: 24, y: 126, width: 360, height: 430 };
      const fisicasRect = { x: 408, y: 126, width: 360, height: 430 };
      drawPanel(doc, identRect, 'IDENTIFICACIÓN Y LOCALIZACIÓN');
      // DESVIACIÓN DOCUMENTADA frente al puerto literal: con los gaps
      // nominales del generador aprobado (labelValueGap:15, fieldGap:28,
      // fieldHeight:40) y el conteo real de campos de identFields (hasta 7:
      // encabezado + Municipio + Departamento + Zona + Vereda + Barrio +
      // Manzana, ver arriba), 7 filas de una sola columna + 2 filas de
      // código exceden los 430pt del panel y terminan invadiendo el pie de
      // página -- overflow que también existiría en el código canónico
      // para este mismo conteo de campos (verificado a mano: 172 + 7×56 =
      // 564pt, panel termina en 556pt). Para no reproducir una regresión
      // visual real, el espaciado vertical (labelValueGap/fieldGap) se
      // comprime dinámicamente SOLO cuando hace falta para que 7 campos +
      // 2 filas de código quepan siempre dentro del panel -- mismo orden,
      // etiquetas, valores y jerarquía tipográfica, nunca menos contenido.
      const identCodeRowsHeight = 40 * 2;
      const identBottomPadding = 18;
      const identAvailableForFields = identRect.height - 46 - identCodeRowsHeight - identBottomPadding;
      const identNominalRowHeight = 15 + 13 + 28;
      const identFieldGap = identFields.length * identNominalRowHeight > identAvailableForFields
        ? Math.max(6, identAvailableForFields / identFields.length - 15 - 13)
        : 28;
      const identCursorY = drawFieldGridSimple(identRect, identFields, { columns: 1, labelValueGap: 15, fieldGap: identFieldGap });
      drawCodeFieldsBlock(identRect, identCursorY, identFieldGap, 40);

      drawPanel(doc, fisicasRect, 'CARACTERÍSTICAS FÍSICAS');
      drawFieldGridSimple(fisicasRect, fisicasFields, { columns: 2, labelValueGap: 15, fieldGap: 40 });
    } else {
      // Página B de buildFichaTecnicaSplitPageCanvases (catastroxDeliverables.js:2598-2613):
      // Clasificación a todo el ancho + panel Fuente inmediatamente debajo,
      // con altura dinámica (mínimo 72pt, nunca invade el pie de página).
      drawHeader(doc, { title: 'FICHA TÉCNICA Y CATASTRAL (CONTINUACIÓN)', pageLabel: `${2 + page} de ${totalPages}`, codigoPredial: predio.codigoPredial });
      const clasifRect = { x: 24, y: 118, width: 744, height: 300 };
      const clasificacionBottomY = drawClasificacionPanelBlock(clasifRect, { usoLineHeight: 15, usoItemGap: 4, tiposLineHeight: 14 });

      const fuenteGap = 16;
      const fuenteBottomGap = 16;
      const fuenteY = Math.max(430, Math.ceil(clasificacionBottomY + fuenteGap));
      const fuenteText = buildFuenteText();
      const fuenteLines = wrapLines(doc, fuenteText, 744 - 52, 11, true);
      const fuenteRequiredHeight = 36 + Math.max(1, fuenteLines.length) * 13 + 12;
      const fuenteAvailableHeight = UNIFIED_FOOTER_RECT.y - fuenteBottomGap - fuenteY;
      const fuenteHeight = Math.max(72, Math.min(fuenteRequiredHeight, fuenteAvailableHeight));
      drawFuentePanelBlock({ x: 24, y: fuenteY, width: 744, height: fuenteHeight });
    }

    drawLegalFooter(doc, UNIFIED_FOOTER_RECT);
  }

  // ---------- Página siguiente: uso y alcance ----------
  // Layout literal de buildUsoAlcancePageLayout/buildUsoAlcancePageCanvas
  // (catastroxDeliverables.js:2498-2645): panel superior a todo el ancho
  // ("ARCHIVOS ENTREGADOS") + dos paneles inferiores lado a lado
  // (instrucciones / alcance y validación oficial).
  const usoAlcancePageNumber = 2 + fichaPageCount;
  doc.addPage({ size: PAGE_SIZE, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  drawHeader(doc, { title: 'USO, ALCANCE Y ADVERTENCIAS', pageLabel: `${usoAlcancePageNumber} de ${totalPages}`, codigoPredial: predio.codigoPredial });

  const scopeItems = [
    'No reemplaza certificados oficiales del IGAC, gestor catastral ni oficina de registro.',
    'No reemplaza levantamientos topográficos ni actos de deslinde o amojonamiento.',
    'Los usos normativos del suelo están sujetos al POT, PBOT o EOT municipal vigente.',
    'Decisiones jurídicas, registrales o de linderos requieren validación de autoridad competente.',
  ];
  const topPanel = { x: 24, y: 126, width: 744, height: 110 };
  drawPanel(doc, topPanel, 'ARCHIVOS ENTREGADOS');
  drawBullets(doc, usoAlcance.deliveredFiles, topPanel.x + 24, topPanel.y + 46, topPanel.width - 48, CYAN);

  const lowerY = topPanel.y + topPanel.height + 14;
  const lowerHeight = 236;
  const lowerLeft = { x: 24, y: lowerY, width: 360, height: lowerHeight };
  const lowerRight = { x: 408, y: lowerY, width: 360, height: lowerHeight };
  drawPanel(doc, lowerLeft, usoAlcance.instructionsTitle);
  drawBullets(doc, usoAlcance.instructions, lowerLeft.x + 24, lowerLeft.y + 46, lowerLeft.width - 48, GREEN);
  drawPanel(doc, lowerRight, 'ALCANCE Y VALIDACIÓN OFICIAL');
  drawBullets(doc, scopeItems, lowerRight.x + 16, lowerRight.y + 46, lowerRight.width - 32, CYAN);

  drawLegalFooter(doc, UNIFIED_FOOTER_RECT);

  // ---------- Página siguiente: plano predial independiente ----------
  // Layout literal de buildTechnicalPagesCanvases (catastroxDeliverables.js:3762-3854):
  // recuadro expandido a todo el ancho, polígono técnico (solo contorno,
  // sin relleno), rosa de los vientos, escala gráfica, círculos P1..Pn con
  // motor de colisiones (buildVisiblePointPlacements) y distancias rotadas
  // sobre cada tramo con el motor completo de búsqueda de candidatos +
  // evasión de colisiones (buildTechnicalSegmentDimensionPlacements,
  // catastroxPdfDimensions.js -- puerto literal, ver auditoría de paridad
  // en el informe de entrega).
  const planoPageNumber = usoAlcancePageNumber + 1;
  doc.addPage({ size: PAGE_SIZE, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  // Bug encontrado en esta revisión: el encabezado de la página 4 usaba
  // `technicalTitle` (el subtítulo largo "PLANO INFORMATIVO • GEOMETRÍA
  // CATASTRAL DEL PREDIO"), duplicando el mismo texto que ya se dibuja como
  // subtítulo interno más abajo. El generador aprobado
  // (buildTechnicalPagesCanvases, catastroxDeliverables.js:3774) usa el
  // título corto fijo "PLANO PREDIAL CATASTROX" en el encabezado -- igual
  // que ya hace correctamente la página de tabla (mismo título de
  // encabezado en ambas, por diseño del navegador).
  drawHeader(doc, { title: 'PLANO PREDIAL CATASTROX', pageLabel: `${planoPageNumber} de ${totalPages}`, codigoPredial: predio.codigoPredial });

  fillRect(doc, TECHNICAL_MAP_AREA.x, TECHNICAL_MAP_AREA.y, TECHNICAL_MAP_AREA.width, TECHNICAL_MAP_AREA.height, '#ffffff');
  strokeRect(doc, TECHNICAL_MAP_AREA.x, TECHNICAL_MAP_AREA.y, TECHNICAL_MAP_AREA.width, TECHNICAL_MAP_AREA.height, BORDER_LIGHT);
  const planoMapRect = { x: TECHNICAL_MAP_AREA.x + 16, y: TECHNICAL_MAP_AREA.y + 16, width: TECHNICAL_MAP_AREA.width - 32, height: TECHNICAL_MAP_AREA.height - 32 };
  strokeRect(doc, planoMapRect.x, planoMapRect.y, planoMapRect.width, planoMapRect.height, BORDER_LIGHTER);
  baseText(doc, `${resolvePdfTechnicalPageTitle(contentMode)}${predio.partLabel ? ` • ${predio.partLabel.toUpperCase()}` : ''}`, HEADER_ZONE.x + 16, HEADER_ZONE.y + 76, { size: 10.5, bold: true, color: NAVY_TITLE });

  const planoMapState = computeMapState(ring, planoMapRect.width, planoMapRect.height, 20);
  const planoProjectedClosed = projectRingToViewport(ring, planoMapState, planoMapRect.width, planoMapRect.height).map(([px, py]) => [planoMapRect.x + px, planoMapRect.y + py]);
  const planoPoints = planoProjectedClosed.slice(0, -1);
  // CATX-POSTPAYMENT-UX-001 (defecto C -- causa raíz): hasta esta corrección,
  // los círculos/etiquetas Pn del plano y las cotas de distancia se
  // construían sobre `planoPoints` (TODOS los vértices del anillo de
  // presentación, ~92 para geometrías complejas), mientras que la tabla de
  // vértices (páginas siguientes) se construye sobre
  // `layoutData.referencePoints` (el subconjunto YA reducido por
  // VisibleReferencePointEngine, ~70) -- dos colecciones distintas,
  // numeradas cada una por su propio índice, así que el plano mostraba
  // etiquetas hasta P92 mientras la tabla terminaba en P70. El generador de
  // navegador (buildTechnicalPagesCanvases, catastroxDeliverables.js:3779-3780)
  // SIEMPRE usó `referencePoints` (proyectados con esta misma
  // projectPointToViewport) para los puntos/etiquetas/cotas -- `planoPoints`
  // (el anillo denso) solo debe usarse para el CONTORNO del polígono y como
  // referencia de colisión (`polygonPoints`), nunca para decidir cuántos
  // puntos se numeran. `planoReferencePoints` es la única colección
  // canónica de puntos representativos para esta página -- point circles,
  // etiquetas de distancia y ancla de la escala gráfica usan exclusivamente
  // este array (mismo orden/índices que layoutData.referenceRows/
  // referenceSegments, que ya alimentan la tabla), garantizando
  // visiblePointIds === tablePointIds.
  const planoReferencePoints = layoutData.referencePoints.map((entry) => {
    const [vx, vy] = projectPointToViewport(entry.point || entry, planoMapState, planoMapRect.width, planoMapRect.height);
    return [planoMapRect.x + vx, planoMapRect.y + vy];
  });
  doc.save();
  doc.rect(planoMapRect.x, planoMapRect.y, planoMapRect.width, planoMapRect.height).clip();
  doc.polygon(...planoProjectedClosed).strokeColor('#1170cf').lineWidth(2).stroke();
  doc.restore();

  const compassCenter = { x: planoMapRect.x + 52, y: planoMapRect.y + 54 };
  const compassRoseRect = getCompassRoseRect(compassCenter.x, compassCenter.y);
  const footerRect = { x: UNIFIED_FOOTER_RECT.x + 8, y: UNIFIED_FOOTER_RECT.y - 2, width: UNIFIED_FOOTER_RECT.width - 16, height: 20 };

  // buildVisiblePointPlacements (catastroxDeliverables.js:1623-1687): busca,
  // para cada vértice, la posición de su círculo (ángulo+distancia
  // crecientes) que no choque con otro círculo ni salga del recuadro.
  const pointPlacements = buildVisiblePointPlacements(planoReferencePoints, planoMapRect, planoPoints, []);

  // chooseScaleBarAnchor en 2 pasadas -- misma secuencia exacta que
  // buildTechnicalPagesCanvases (catastroxDeliverables.js:3813-3840):
  // 1) una posición PRELIMINAR (solo contra polígono/vértices) se reserva
  //    como rect bloqueado para la búsqueda de etiquetas de distancia;
  // 2) tras dibujar las etiquetas, se recalcula la posición FINAL
  //    considerando las etiquetas ya colocadas -- nunca una esquina fija.
  const preliminaryScaleAnchor = chooseScaleBarAnchor(planoMapRect, planoPoints, planoReferencePoints, pointPlacements, true);

  // buildTechnicalSegmentDimensionPlacements (catastroxDeliverables.js:2792-2900):
  // para cada tramo, evalúa la grilla completa de candidatos (2 normales
  // interior/exterior × 3 desplazamientos normales × 5 a lo largo del
  // tramo), descarta los que choquen con vértices, otras etiquetas, el
  // borde del recuadro, la rosa de los vientos o la escala gráfica
  // (posición preliminar), y se queda con el de menor puntaje -- nunca
  // dibuja una etiqueta superpuesta; si ningún candidato es válido, omite
  // esa etiqueta (nunca la fuerza).
  const dimensionResult = buildTechnicalSegmentDimensionPlacements({
    measureTextWidth: (text, size) => widthOf(doc, text, size, false),
    formatDistanceLabel: (meters) => `${formatNumberEs(meters, 2)} m`,
    projectedRefs: planoReferencePoints,
    referenceSegments: layoutData.referenceSegments,
    polygonPoints: planoPoints,
    pointPlacements,
    mapRect: planoMapRect,
    reservedRects: [compassRoseRect, getScaleBarRect(preliminaryScaleAnchor.x, preliminaryScaleAnchor.y, true), footerRect],
    // Los segmentos absorbidos por un grupo hídrico no reciben etiqueta
    // individual -- se reemplazan por una única etiqueta agrupada (ver
    // drawHydricGroupLabel más abajo). Vacío para cualquier predio sin
    // anotaciones -- comportamiento idéntico al de antes de esta capacidad.
    skipSegmentIndices: hydricHiddenSegmentIndices,
  });
  drawSegmentDimensions(doc, dimensionResult.placements);
  // Círculos P1..Pn: los vértices intermedios de un lindero hídrico
  // agrupado se omiten (geometría de la línea intacta, solo se omite el
  // círculo+rótulo) -- el punto inicial y final del grupo siempre quedan
  // visibles porque nunca están en `hydricHiddenVertexIndices`.
  drawVertexCircles(doc, pointPlacements, { hiddenIndices: hydricHiddenVertexIndices });
  // Una etiqueta agrupada por lindero hídrico, en el centroide de todos sus
  // vértices (inicio + intermedios + fin) -- "Lindero por fuente hídrica —
  // X m", X = longitud acumulada real de los subtramos (nunca la distancia
  // recta entre extremos).
  hydricGroups.forEach((group) => {
    const groupVertexIndices = [group.startVertexIndex, ...group.intermediateVertexIndices, group.endVertexIndex];
    const groupPoints = groupVertexIndices.map((index) => planoReferencePoints[index]).filter(Boolean);
    if (!groupPoints.length) return;
    const centerX = groupPoints.reduce((sum, p) => sum + p[0], 0) / groupPoints.length;
    const centerY = groupPoints.reduce((sum, p) => sum + p[1], 0) / groupPoints.length;
    drawHydricGroupLabel(doc, { centerX, centerY, label: group.label, distanceMeters: group.accumulatedDistance });
  });
  drawCompassRose(doc, compassCenter.x, compassCenter.y, { dark: true });

  const planoScaleAnchor = chooseScaleBarAnchor(planoMapRect, planoPoints, planoReferencePoints, [...dimensionResult.placements, ...pointPlacements], true);
  const planoScaleMeters = computeDynamicScaleMeters(planoMapState, planoMapRect.width);
  drawScaleBar(doc, planoScaleAnchor.x, planoScaleAnchor.y, planoScaleMeters, { compact: true });

  drawLegalFooter(doc, UNIFIED_FOOTER_RECT);

  // ---------- Página(s) finales: tabla de vértices, independiente del plano ----------
  // Layout literal de drawSimpleTable (catastroxDeliverables.js:2926-2961):
  // panel con título navy, encabezado de columnas, franjas alternadas cada
  // 2 filas, línea separadora bajo el encabezado.
  const isInformative = tableHeaders.length === 3;
  // hasHydricColumn (catastroxPdfBoundaryAnnotations.js): SOLO añade "Tipo
  // de lindero" cuando el predio trae al menos una anotación explícita de
  // lindero hídrico -- una tabla sin anotaciones conserva exactamente las
  // mismas 3 columnas de siempre (Punto/Siguiente/Distancia), sin ningún
  // cambio visual respecto al diseño ya aprobado en esta sprint.
  const finalTableHeaders = hasHydricColumn ? [...tableHeaders, 'Tipo de lindero'] : tableHeaders;
  const columnXs = isInformative
    ? hasHydricColumn
      ? [TABLE_AREA.x + 16, TABLE_AREA.x + 170, TABLE_AREA.x + 330, TABLE_AREA.x + 470]
      : [TABLE_AREA.x + 16, TABLE_AREA.x + 220, TABLE_AREA.x + 420]
    : finalTableHeaders.map((_, index) => TABLE_AREA.x + 16 + index * (TABLE_AREA.width - 32) / finalTableHeaders.length);
  const tableTitleBase = isInformative
    ? 'TABLA DE VÉRTICES REPRESENTATIVOS Y DISTANCIAS'
    : 'TABLA DE VÉRTICES REPRESENTATIVOS Y LONGITUDES';

  for (let tablePage = 0; tablePage < tablePages; tablePage += 1) {
    doc.addPage({ size: PAGE_SIZE, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    drawHeader(doc, { title: 'PLANO PREDIAL CATASTROX', pageLabel: `${planoPageNumber + 1 + tablePage} de ${totalPages}`, codigoPredial: predio.codigoPredial });

    const isContinuation = tablePage > 0;
    drawPanel(doc, TABLE_AREA, isContinuation ? `${tableTitleBase} (CONTINUACIÓN)` : tableTitleBase);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
    finalTableHeaders.forEach((header, index) => {
      baseText(doc, header, columnXs[index], tableBodyTop, { size: 8.5, bold: true, color: INK });
    });
    doc.strokeColor(BORDER_LIGHT).lineWidth(1);
    doc.moveTo(TABLE_AREA.x + 10, tableBodyTop + 6).lineTo(TABLE_AREA.x + TABLE_AREA.width - 10, tableBodyTop + 6).stroke();

    const slice = tableRowsWithHydric.slice(tablePage * availableTableRows, (tablePage + 1) * availableTableRows);
    let cursorY = tableBodyTop + 20;
    slice.forEach((row, rowIndex) => {
      if (rowIndex % 2 === 0) {
        fillRect(doc, TABLE_AREA.x + 8, cursorY - 12, TABLE_AREA.width - 16, TABLE_ROW_HEIGHT, STRIPE_BG);
      }
      row.forEach((cell, colIndex) => {
        baseText(doc, String(cell ?? ''), columnXs[colIndex], cursorY, { size: 8.4, color: TABLE_BODY });
      });
      cursorY += TABLE_ROW_HEIGHT;
    });

    wrappedText(doc, bottomNote, TABLE_BOTTOM_PANEL.x, TABLE_BOTTOM_PANEL.y + 6, TABLE_BOTTOM_PANEL.width, 10, { size: 9, color: TABLE_BODY });
    drawLegalFooter(doc, UNIFIED_FOOTER_RECT);
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export { buildCatastroxDeliverableFilename };
