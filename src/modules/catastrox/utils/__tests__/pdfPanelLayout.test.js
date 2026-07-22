import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutiveBottomNoteLayout,
  buildUsoAlcancePageLayout,
  measureFuentePanel,
  measureWrappedText,
} from '../catastroxDeliverables.js';

function createFakeContext() {
  return {
    font: '',
    fillStyle: '#000000',
    measureText(text) {
      return { width: String(text).length * 5.2 };
    },
    fillText() {},
    fillRect() {},
    strokeRect() {},
  };
}

function createPredio(overrides = {}) {
  return {
    fuente: 'Geoportal del IGAC. Base catastral pública consultada el 2026-07-15',
    fechaProceso: '2026-07-15',
    deliverablePackageId: 'profesional',
    ...overrides,
  };
}

test('el panel de entregables calcula altura suficiente para la lista larga del paquete profesional', () => {
  const context = createFakeContext();
  const layout = buildUsoAlcancePageLayout(context, createPredio());
  const renderedBottom = layout.topPanel.y + layout.topMetrics.requiredHeight - layout.topMetrics.body.bottomPadding;
  const boxBottom = layout.topPanel.y + layout.topPanel.height - layout.topMetrics.body.bottomPadding;
  assert.ok(renderedBottom <= boxBottom, 'la última línea de ARCHIVOS ENTREGADOS debe quedar dentro del recuadro');
  assert.ok(layout.lowerLeftPanel.y >= layout.topPanel.y + layout.topPanel.height, 'los paneles inferiores deben desplazarse cuando crece el panel superior');
  assert.ok(layout.lowerLeftPanel.y + layout.lowerLeftPanel.height <= 576 - 18, 'los paneles inferiores deben respetar el footer');
});

test('el panel FUENTE reserva padding inferior real para textos descriptivos largos', () => {
  const context = createFakeContext();
  const rect = { x: 24, y: 430, width: 744, height: 92 };
  const metrics = measureFuentePanel(context, rect, createPredio());
  const boxBottom = rect.y + rect.height - metrics.body.bottomPadding;
  assert.ok(metrics.renderedBottom <= boxBottom, 'el texto de FUENTE no debe tocar el borde inferior del panel');
});

test('la nota ejecutiva inferior respeta la franja reservada antes del footer', () => {
  const context = createFakeContext();
  const rect = { x: 24, y: 536, width: 744, height: 32 };
  const text =
    'La tabla ejecutiva compila en una sola vista los puntos visibles del plano, sus coordenadas y la distancia entre tramos consecutivos. La geometría completa del predio permanece disponible en los archivos KML y KMZ descargables.';
  const metrics = buildExecutiveBottomNoteLayout(context, text, rect);
  const boxBottom = rect.y + rect.height - metrics.body.bottomPadding;
  assert.ok(metrics.renderedBottom <= boxBottom, 'la nota ejecutiva no debe invadir el área del footer legal');
});

test('el wrapping matemático conserva la última línea dentro del bloque disponible', () => {
  const context = createFakeContext();
  const startY = 18;
  const result = measureWrappedText(
    context,
    'Uso constructivo predominante: ramadas, cobertizos y caneyes para apoyo de operación pecuaria.',
    220,
    13,
    400,
    11,
  );
  const boxBottom = 82 - 12;
  assert.ok(startY + result.height <= boxBottom, 'los textos largos medidos deben caber dentro de su caja con padding inferior');
});
