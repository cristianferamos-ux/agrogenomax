// Defecto corregido: en la página 1 del PDF oficial, el panel azul del
// paquete ("PAQUETE BÁSICO"/"PAQUETE PLUS"/"PAQUETE PROFESIONAL") se
// dibujaba en una Y fija (456, equivalente a mapRect.bottom + 24) que no
// tenía relación con el alto REAL de las 2 líneas de atribución obligatoria
// del mapa satelital ("Fuente: ..."/"Referencias: ..."), dibujadas a su vez
// en offsets también fijos (+12/+20). A 5.5pt cada línea mide realmente
// ~6.36pt de alto (medido con doc.heightOfString, PDFKit) -- el bloque
// completo termina en offset ~25.72pt respecto al fondo del mapa, MÁS ALLÁ
// del offset fijo de 24pt donde arrancaba el panel: el panel invadía la
// segunda línea de atribución (ver PDF real adjunto al reporte del
// defecto). Esta prueba mide con la misma API de PDFKit que usa el
// generador (doc.heightOfString) y comprueba geométricamente que la Y del
// panel calculada por drawStackedTextBlock + MAP_ATTRIBUTION_SAFE_GAP
// siempre queda estrictamente después del final real de las atribuciones,
// nunca de una coordenada fija que ignore ese alto.
import test from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import {
  drawStackedTextBlock,
  MAP_ATTRIBUTION_FONT_SIZE,
  MAP_ATTRIBUTION_TOP_GAP,
  MAP_ATTRIBUTION_LINE_GAP,
  MAP_ATTRIBUTION_SAFE_GAP,
} from '../catastroxPdfGenerator.js';
import { ESRI_IMAGERY_ATTRIBUTION, ESRI_LABELS_ATTRIBUTION } from '../catastroxPdfMap.js';

// mapRect real de la página 1 (catastroxPdfGenerator.js:518, sin cambios
// por este defecto).
const MAP_RECT = { x: 420, y: 136, width: 332, height: 296 };
// Offset fijo donde arrancaba el panel ANTES de esta corrección
// (drawPanel(doc, { x: 420, y: 456, ... })) -- 456 = mapRect.y + mapRect.height + 24.
const OLD_FIXED_PANEL_OFFSET_FROM_MAP_BOTTOM = 24;

function createMeasuringDoc() {
  // No hace falta escribir a disco ni consumir el stream -- solo se usa
  // doc.text()/doc.heightOfString() como superficie de medición, igual que
  // hace el generador real.
  const doc = new PDFDocument({ size: [792, 612], compress: false });
  doc.on('data', () => {});
  return doc;
}

test('drawStackedTextBlock mide el alto REAL de cada línea con doc.heightOfString -- nunca asume una altura fija', () => {
  const doc = createMeasuringDoc();
  doc.font('Helvetica').fontSize(MAP_ATTRIBUTION_FONT_SIZE);
  const options = { width: MAP_RECT.width, lineBreak: false };

  // Medición independiente, tomada por fuera de drawStackedTextBlock, con
  // la misma API -- si drawStackedTextBlock usara un número fijo en vez de
  // heightOfString, este valor no coincidiría.
  const expectedLine1Height = doc.heightOfString(ESRI_IMAGERY_ATTRIBUTION, options);
  const expectedLine2Height = doc.heightOfString(ESRI_LABELS_ATTRIBUTION, options);
  assert.ok(expectedLine1Height > 0 && expectedLine2Height > 0);

  const startY = MAP_RECT.y + MAP_RECT.height + MAP_ATTRIBUTION_TOP_GAP;
  const { bottom } = drawStackedTextBlock(
    doc,
    [ESRI_IMAGERY_ATTRIBUTION, ESRI_LABELS_ATTRIBUTION],
    MAP_RECT.x,
    startY,
    options,
    { lineGap: MAP_ATTRIBUTION_LINE_GAP },
  );

  const expectedBottom = startY + expectedLine1Height + MAP_ATTRIBUTION_LINE_GAP + expectedLine2Height;
  assert.equal(bottom, expectedBottom, 'el bottom devuelto debe coincidir exactamente con la suma de alturas medidas, no con un número fijo');

  doc.end();
});

test('el bloque de atribución real (2 líneas, 5.5pt) ya supera el offset fijo de 24pt donde arrancaba el panel antes de esta corrección -- reproduce el defecto reportado', () => {
  // Prueba dirigida al caso real del reporte: confirma que el bug era
  // real (no una sospecha) -- con las 2 líneas oficiales de atribución, el
  // alto real siempre excede el margen que el panel fijo dejaba disponible.
  const doc = createMeasuringDoc();
  doc.font('Helvetica').fontSize(MAP_ATTRIBUTION_FONT_SIZE);
  const options = { width: MAP_RECT.width, lineBreak: false };

  const startY = MAP_RECT.y + MAP_RECT.height + MAP_ATTRIBUTION_TOP_GAP;
  const { bottom: attributionBottom } = drawStackedTextBlock(
    doc,
    [ESRI_IMAGERY_ATTRIBUTION, ESRI_LABELS_ATTRIBUTION],
    MAP_RECT.x,
    startY,
    options,
    { lineGap: MAP_ATTRIBUTION_LINE_GAP },
  );

  const oldFixedPanelY = MAP_RECT.y + MAP_RECT.height + OLD_FIXED_PANEL_OFFSET_FROM_MAP_BOTTOM;
  assert.ok(
    attributionBottom > oldFixedPanelY,
    `el final real de las atribuciones (${attributionBottom}) debía superar la Y fija del panel anterior (${oldFixedPanelY}) -- así se reprodujo el solapamiento`,
  );

  doc.end();
});

test('packageHeaderY > attributionBottom + safeGap -- fórmula geométrica exigida, con el separador mínimo de 8-12pt', () => {
  const doc = createMeasuringDoc();
  doc.font('Helvetica').fontSize(MAP_ATTRIBUTION_FONT_SIZE);
  const options = { width: MAP_RECT.width, lineBreak: false };

  const attributionY = MAP_RECT.y + MAP_RECT.height + MAP_ATTRIBUTION_TOP_GAP;
  const { bottom: attributionBottom } = drawStackedTextBlock(
    doc,
    [ESRI_IMAGERY_ATTRIBUTION, ESRI_LABELS_ATTRIBUTION],
    MAP_RECT.x,
    attributionY,
    options,
    { lineGap: MAP_ATTRIBUTION_LINE_GAP },
  );

  // Misma fórmula que usa generateCatastroxPdfBuffer para posicionar
  // drawPanel(...) -- ver catastroxPdfGenerator.js.
  const packageHeaderY = attributionBottom + MAP_ATTRIBUTION_SAFE_GAP;

  assert.ok(MAP_ATTRIBUTION_SAFE_GAP >= 8, 'el separador mínimo pedido es 8pt');
  assert.ok(MAP_ATTRIBUTION_SAFE_GAP <= 12, 'el separador máximo sugerido es 12pt (evitar espacio excesivo)');
  assert.ok(
    packageHeaderY > attributionBottom + 8,
    `packageHeaderY (${packageHeaderY}) debe superar attributionBottom + 8pt (${attributionBottom + 8})`,
  );
  assert.ok(packageHeaderY < MAP_RECT.y + MAP_RECT.height + 40, 'el panel no debe desplazarse excesivamente hacia abajo (evita invadir el resto de la página)');

  doc.end();
});

test('el separador funciona igual si la atribución ocupara 1 sola línea (independiente del número de líneas)', () => {
  const doc = createMeasuringDoc();
  doc.font('Helvetica').fontSize(MAP_ATTRIBUTION_FONT_SIZE);
  const options = { width: MAP_RECT.width, lineBreak: false };
  const startY = MAP_RECT.y + MAP_RECT.height + MAP_ATTRIBUTION_TOP_GAP;

  const { bottom: oneLineBottom } = drawStackedTextBlock(doc, [ESRI_IMAGERY_ATTRIBUTION], MAP_RECT.x, startY, options, {
    lineGap: MAP_ATTRIBUTION_LINE_GAP,
  });
  const packageHeaderYForOneLine = oneLineBottom + MAP_ATTRIBUTION_SAFE_GAP;

  assert.ok(packageHeaderYForOneLine > oneLineBottom + 8);
  // Con una sola línea el panel debe quedar MÁS ARRIBA que con dos --
  // confirma que el cálculo reacciona al contenido real, no a un número de
  // líneas hardcodeado.
  const { bottom: twoLineBottom } = drawStackedTextBlock(
    doc,
    [ESRI_IMAGERY_ATTRIBUTION, ESRI_LABELS_ATTRIBUTION],
    MAP_RECT.x,
    startY,
    options,
    { lineGap: MAP_ATTRIBUTION_LINE_GAP },
  );
  assert.ok(twoLineBottom > oneLineBottom);

  doc.end();
});
