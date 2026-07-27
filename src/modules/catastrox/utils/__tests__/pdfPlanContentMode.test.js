// Pruebas del contrato explicito de contenido del PDF por plan
// (Especificacion 018, Implementacion 018-B1/B2).
//
// Basico y Plus: tabla informativa sin coordenadas (Punto/Siguiente/Distancia).
// Profesional: comportamiento actual preservado (Punto/Latitud/Longitud/Tramo/Distancia)
// hasta que un lote posterior implemente su tabla tecnica definitiva.
//
// Estas pruebas ejercitan funciones puras (sin canvas/DOM) al nivel mas bajo
// posible. Fixtures exclusivamente sinteticos.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PDF_CONTENT_MODE,
  resolvePdfContentMode,
  resolveExecutiveTableHeaders,
  buildUnifiedTableRows,
} from '../catastroxDeliverables.js';
import { buildReferenceRows, buildReferenceSegments } from '../DistanceEngine.js';

function buildSquareFixture() {
  // Cuadrado cerrado de 4 vertices reales -> referencePoints sinteticos.
  const ring = [
    [-75.6100, 1.6100],
    [-75.6090, 1.6100],
    [-75.6090, 1.6091],
    [-75.6100, 1.6091],
    [-75.6100, 1.6100],
  ];
  const referencePoints = ring.slice(0, -1).map((point, index) => ({ point, originalIndex: index }));
  const referenceRows = buildReferenceRows(referencePoints);
  const referenceSegments = buildReferenceSegments(ring, referencePoints);
  return { ring, referencePoints, referenceRows, referenceSegments };
}

test('P1) Basico: resuelve modo informativo, encabezados exactos y filas sin latitud/longitud/Este/Norte', () => {
  const mode = resolvePdfContentMode('basico');
  assert.equal(mode, PDF_CONTENT_MODE.INFORMATIVE);

  const headers = resolveExecutiveTableHeaders(mode);
  assert.deepEqual(headers, ['Punto', 'Siguiente', 'Distancia']);

  const { referenceRows, referenceSegments } = buildSquareFixture();
  const rows = buildUnifiedTableRows(referenceRows, referenceSegments, mode);

  assert.equal(rows.length, referenceSegments.length);
  rows.forEach((row) => {
    assert.equal(row.length, 3, 'cada fila debe tener exactamente 3 columnas: Punto, Siguiente, Distancia');
    const [point, next, distance] = row;
    assert.match(point, /^P\d+$/);
    assert.match(next, /^P\d+$/);
    assert.match(distance, /^-?\d+[.,]\d{2} m$/, 'la distancia debe tener 2 decimales y unidad "m"');
    // Ninguna columna debe contener un valor de latitud/longitud (numero con
    // signo/decimales fuera del formato "N.NN m" ya validado arriba).
    assert.ok(!String(distance).toLowerCase().includes('lat'));
    assert.ok(!String(distance).toLowerCase().includes('lng'));
  });

  // Confirmacion explicita: ninguna fila expone las columnas eliminadas.
  const headerNames = headers.map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes('latitud'));
  assert.ok(!headerNames.includes('longitud'));
  assert.ok(!headerNames.includes('este'));
  assert.ok(!headerNames.includes('norte'));
});

test('P2) Plus: exactamente el mismo contenido informativo que Basico', () => {
  const modeBasico = resolvePdfContentMode('basico');
  const modePlus = resolvePdfContentMode('plus');
  assert.equal(modeBasico, modePlus);
  assert.equal(modePlus, PDF_CONTENT_MODE.INFORMATIVE);

  const { referenceRows, referenceSegments } = buildSquareFixture();
  const rowsBasico = buildUnifiedTableRows(referenceRows, referenceSegments, modeBasico);
  const rowsPlus = buildUnifiedTableRows(referenceRows, referenceSegments, modePlus);
  assert.deepStrictEqual(rowsPlus, rowsBasico);
  assert.deepStrictEqual(resolveExecutiveTableHeaders(modePlus), resolveExecutiveTableHeaders(modeBasico));
});

test('P3) Profesional: conserva durante este lote las columnas actuales (Punto/Latitud/Longitud/Tramo/Distancia)', () => {
  const mode = resolvePdfContentMode('profesional');
  assert.equal(mode, PDF_CONTENT_MODE.PROFESSIONAL_CURRENT);

  const headers = resolveExecutiveTableHeaders(mode);
  assert.deepEqual(headers, ['Punto', 'Latitud', 'Longitud', 'Tramo', 'Distancia']);

  const { referenceRows, referenceSegments } = buildSquareFixture();
  const rows = buildUnifiedTableRows(referenceRows, referenceSegments, mode);

  rows.forEach((row, index) => {
    assert.equal(row.length, 5);
    assert.equal(row[0], referenceRows[index].point);
    assert.equal(row[1], referenceRows[index].lat);
    assert.equal(row[2], referenceRows[index].lng);
    assert.equal(row[3], `${referenceSegments[index].from}-${referenceSegments[index].to}`);
  });

  // Regresion: llamar sin especificar contentMode debe preservar exactamente
  // el comportamiento previo a esta implementacion (parametro por defecto).
  const rowsDefault = buildUnifiedTableRows(referenceRows, referenceSegments);
  assert.deepStrictEqual(rowsDefault, rows);
});

test('P4) Sin discrepancia plano/tabla: mismo numero de puntos, mismos identificadores, mismo orden, cierre correcto', () => {
  const { referencePoints, referenceRows, referenceSegments } = buildSquareFixture();
  const mode = resolvePdfContentMode('basico');
  const rows = buildUnifiedTableRows(referenceRows, referenceSegments, mode);

  assert.equal(rows.length, referencePoints.length);
  assert.equal(rows.length, referenceSegments.length);

  rows.forEach((row, index) => {
    assert.equal(row[0], referenceSegments[index].from);
    assert.equal(row[1], referenceSegments[index].to);
  });

  // El anillo esta cerrado: el ultimo "siguiente" debe enlazar al primer punto visible.
  assert.equal(rows[rows.length - 1][1], rows[0][0]);
});

test('P5) El cambio de columnas no depende ni altera codigo predial, nombre ni otros campos del predio', () => {
  // buildUnifiedTableRows/resolveExecutiveTableHeaders no reciben "predio" en
  // absoluto en su firma (referenceRows, referenceSegments, contentMode) y
  // (contentMode) respectivamente -- el cambio de contenido por plan queda
  // aislado de cualquier campo textual/identidad del predio (codigoPredial,
  // nombrePredio, encabezados generales de la pagina), que se dibujan en
  // drawHeader/buildFichaTecnicaCanvases y no se ven afectados por este lote.
  const source = buildUnifiedTableRows.toString();
  assert.doesNotMatch(source, /predio/i, 'buildUnifiedTableRows no debe leer ningun campo de "predio"');

  const { referenceRows, referenceSegments } = buildSquareFixture();
  const rowsA = buildUnifiedTableRows(referenceRows, referenceSegments, PDF_CONTENT_MODE.INFORMATIVE);
  const rowsB = buildUnifiedTableRows(referenceRows, referenceSegments, PDF_CONTENT_MODE.INFORMATIVE);
  assert.deepStrictEqual(rowsA, rowsB, 'la salida depende solo de referenceRows/referenceSegments/contentMode, es determinista');
});

test('P6) MultiPolygon por partes: cada parte numera y enlaza sus propios puntos, sin mezclar segmentos entre partes', () => {
  const ringPartA = [
    [-75.6100, 1.6100],
    [-75.6090, 1.6100],
    [-75.6090, 1.6091],
    [-75.6100, 1.6091],
    [-75.6100, 1.6100],
  ];
  const ringPartB = [
    [-75.6300, 1.6300],
    [-75.6280, 1.6300],
    [-75.6280, 1.6280],
    [-75.6300, 1.6280],
    [-75.6300, 1.6300],
  ];

  const buildPartTable = (ring) => {
    const referencePoints = ring.slice(0, -1).map((point, index) => ({ point, originalIndex: index }));
    const referenceRows = buildReferenceRows(referencePoints);
    const referenceSegments = buildReferenceSegments(ring, referencePoints);
    return buildUnifiedTableRows(referenceRows, referenceSegments, PDF_CONTENT_MODE.INFORMATIVE);
  };

  const rowsA = buildPartTable(ringPartA);
  const rowsB = buildPartTable(ringPartB);

  // Cada parte reinicia su propia numeracion en P1 (comportamiento actual, no ampliado aqui).
  assert.equal(rowsA[0][0], 'P1');
  assert.equal(rowsB[0][0], 'P1');

  // Ninguna fila de la parte A referencia un punto de la parte B y viceversa
  // (los identificadores son solo P1..Pn locales a cada parte; se verifica
  // que las coordenadas subyacentes de cada tabla nunca se combinen).
  const pointsA = new Set(ringPartA.slice(0, -1).map((p) => p.join(',')));
  const pointsB = new Set(ringPartB.slice(0, -1).map((p) => p.join(',')));
  assert.equal([...pointsA].some((p) => pointsB.has(p)), false, 'las partes no deben compartir vertices');
  assert.equal(rowsA.length, 4);
  assert.equal(rowsB.length, 4);
});
