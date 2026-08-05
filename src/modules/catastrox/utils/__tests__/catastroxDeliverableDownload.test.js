// CATX-DELIVERABLE-CANONICAL-001: pruebas de la lógica pura que decide
// cómo se descarga el PDF desde "Descargas habilitadas" -- ver
// catastroxDeliverableDownload.js para por qué esta lógica vive en un
// archivo separado de CatastroXPackagePage.jsx (evita la cadena de
// imports hacia leaflet, que exige un DOM completo para cargar en
// node:test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDeliverableDownloadErrorMessage,
  resolveDeliverableOrderTokenForPredio,
  shouldUseOfficialPdfDownload,
} from '../catastroxDeliverableDownload.js';

// --- shouldUseOfficialPdfDownload -------------------------------------------

test('shouldUseOfficialPdfDownload) PDF de una compra real (sin auditoría) -> usa el endpoint oficial', () => {
  assert.equal(shouldUseOfficialPdfDownload({ fileType: 'pdf', useAuditEndpoint: false }), true);
});

test('shouldUseOfficialPdfDownload) PDF en modo auditoría local -> NO usa el endpoint oficial (no existe orden real)', () => {
  assert.equal(shouldUseOfficialPdfDownload({ fileType: 'pdf', useAuditEndpoint: true }), false);
});

test('shouldUseOfficialPdfDownload) KML/KMZ/SHP/DXF/coordenadas nunca usan el endpoint oficial (no hay deliverable de esos tipos en el backend)', () => {
  ['kml', 'kmz', 'shp', 'dxf', 'coords9377'].forEach((fileType) => {
    assert.equal(shouldUseOfficialPdfDownload({ fileType, useAuditEndpoint: false }), false, fileType);
    assert.equal(shouldUseOfficialPdfDownload({ fileType, useAuditEndpoint: true }), false, fileType);
  });
});

// --- resolveDeliverableOrderTokenForPredio ----------------------------------

const SAMPLE_ORDERS = [
  { orderToken: 'tok-basico', packageId: 'basico', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
  { orderToken: 'tok-otro-predio', packageId: 'profesional', codigoPredial: '999900002000000030015000000000', paymentStatus: 'APPROVED' },
  { orderToken: 'tok-pendiente', packageId: 'profesional', codigoPredial: '184600002000000030015000000000', paymentStatus: 'PENDING' },
];

test('resolveDeliverableOrderTokenForPredio) encuentra la orden APROBADA que coincide con el código predial', () => {
  const token = resolveDeliverableOrderTokenForPredio({ orders: SAMPLE_ORDERS, codigoPredial: '184600002000000030015000000000' });
  assert.equal(token, 'tok-basico');
});

test('resolveDeliverableOrderTokenForPredio) ignora órdenes de otro predio y órdenes no aprobadas', () => {
  const token = resolveDeliverableOrderTokenForPredio({ orders: SAMPLE_ORDERS, codigoPredial: '999900002000000030015000000000' });
  assert.equal(token, 'tok-otro-predio');
});

test('resolveDeliverableOrderTokenForPredio) sin ninguna orden aprobada para el predio -> null', () => {
  const token = resolveDeliverableOrderTokenForPredio({ orders: SAMPLE_ORDERS, codigoPredial: '000000000000000000000000000000' });
  assert.equal(token, null);
});

test('resolveDeliverableOrderTokenForPredio) dos órdenes aprobadas del mismo predio -> prefiere la de mayor rango de paquete', () => {
  const orders = [
    { orderToken: 'tok-basico', packageId: 'basico', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
    { orderToken: 'tok-profesional', packageId: 'profesional', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
  ];
  const token = resolveDeliverableOrderTokenForPredio({ orders, codigoPredial: '184600002000000030015000000000' });
  assert.equal(token, 'tok-profesional');
});

test('resolveDeliverableOrderTokenForPredio) sin código predial, sin órdenes, o entradas inválidas -> null, nunca lanza', () => {
  assert.equal(resolveDeliverableOrderTokenForPredio({ orders: SAMPLE_ORDERS, codigoPredial: '' }), null);
  assert.equal(resolveDeliverableOrderTokenForPredio({ orders: [], codigoPredial: '184600002000000030015000000000' }), null);
  assert.equal(resolveDeliverableOrderTokenForPredio({ orders: null, codigoPredial: '184600002000000030015000000000' }), null);
  assert.equal(resolveDeliverableOrderTokenForPredio({}), null);
});

// --- requiredPackageId: filtro explícito de compatibilidad de paquete ------
// (revisión pre-commit: nunca debe devolverse una orden de rango INFERIOR
// al paquete que se está viendo, aunque exista alguna orden aprobada para
// el mismo predio -- segunda verificación explícita, independiente del
// estado optimista "isPaid" del componente).

test('resolveDeliverableOrderTokenForPredio) con requiredPackageId: rechaza una orden aprobada de rango inferior al paquete visto', () => {
  const orders = [
    { orderToken: 'tok-basico', packageId: 'basico', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
  ];
  const token = resolveDeliverableOrderTokenForPredio({
    orders,
    codigoPredial: '184600002000000030015000000000',
    requiredPackageId: 'profesional',
  });
  assert.equal(token, null, 'una orden básica nunca debe satisfacer una vista de paquete profesional');
});

test('resolveDeliverableOrderTokenForPredio) con requiredPackageId: acepta una orden de rango igual o superior', () => {
  const orders = [
    { orderToken: 'tok-plus', packageId: 'plus', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
  ];
  assert.equal(
    resolveDeliverableOrderTokenForPredio({ orders, codigoPredial: '184600002000000030015000000000', requiredPackageId: 'plus' }),
    'tok-plus',
    'mismo rango exacto debe aceptarse',
  );
  const orders2 = [
    { orderToken: 'tok-profesional', packageId: 'profesional', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
  ];
  assert.equal(
    resolveDeliverableOrderTokenForPredio({ orders: orders2, codigoPredial: '184600002000000030015000000000', requiredPackageId: 'basico' }),
    'tok-profesional',
    'un paquete superior siempre satisface la vista de un paquete inferior (subsume su contenido)',
  );
});

test('resolveDeliverableOrderTokenForPredio) con requiredPackageId: entre varias órdenes compatibles, prefiere el mayor rango y, en empate, la más reciente', () => {
  // GET /orders/mine ya devuelve las órdenes ordenadas por created_at desc
  // (server/services/catastrox/recoverySessionRepository.js) -- el array
  // de prueba respeta ese mismo orden (más reciente primero).
  const orders = [
    { orderToken: 'tok-profesional-reciente', packageId: 'profesional', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED', createdAt: '2026-02-01T00:00:00Z' },
    { orderToken: 'tok-profesional-antigua', packageId: 'profesional', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED', createdAt: '2026-01-01T00:00:00Z' },
    { orderToken: 'tok-basico', packageId: 'basico', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED', createdAt: '2026-01-15T00:00:00Z' },
  ];
  const token = resolveDeliverableOrderTokenForPredio({
    orders,
    codigoPredial: '184600002000000030015000000000',
    requiredPackageId: 'basico',
  });
  assert.equal(token, 'tok-profesional-reciente', 'ante empate de rango (profesional == profesional), gana la más reciente');
});

test('resolveDeliverableOrderTokenForPredio) sin requiredPackageId (comportamiento previo): sigue prefiriendo el mayor rango sin exigir compatibilidad mínima', () => {
  const orders = [
    { orderToken: 'tok-basico', packageId: 'basico', codigoPredial: '184600002000000030015000000000', paymentStatus: 'APPROVED' },
  ];
  const token = resolveDeliverableOrderTokenForPredio({ orders, codigoPredial: '184600002000000030015000000000' });
  assert.equal(token, 'tok-basico');
});

// --- resolveDeliverableDownloadErrorMessage ---------------------------------

test('resolveDeliverableDownloadErrorMessage) mapea cada código real del endpoint oficial a un mensaje claro y no vacío', () => {
  ['SESSION_REQUIRED', 'ORDER_ACCESS_DENIED', 'DELIVERABLE_NOT_READY', 'ORDER_NOT_FOUND'].forEach((code) => {
    const message = resolveDeliverableDownloadErrorMessage(code);
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0, code);
  });
});

test('resolveDeliverableDownloadErrorMessage) código desconocido/null/undefined -> mensaje genérico seguro, nunca lanza', () => {
  [null, undefined, 'ALGO_INESPERADO', ''].forEach((code) => {
    const message = resolveDeliverableDownloadErrorMessage(code);
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0, String(code));
  });
});
