// LOTE 018-C/018-D: corrige la contaminacion comercial Basico -> Plus (018-C)
// y luego cierra la identidad narrativa definitiva de los tres planes (018-D):
// Basico ("CÓMO UTILIZARLO", sin coma en la fila del PDF), Profesional ya no
// muestra "PAQUETE PLUS" ni omite SHP/DXF, y su nota final ya no menciona
// unicamente KML/KMZ. El PDF es enteramente raster (Canvas -> JPEG, sin capa
// de texto real -- ver Auditoria 017), por lo que estas pruebas ejercitan
// directamente las funciones puras que deciden QUE texto se dibuja, en vez de
// intentar extraer texto de un JPEG. Fixtures exclusivamente sinteticos.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PDF_CONTENT_MODE,
  resolveExecutiveTableHeaders,
  resolvePdfContentMode,
  resolvePdfExecutiveBottomNote,
  resolvePdfSummaryCardContent,
  resolvePdfTechnicalPageTitle,
  resolvePdfUsoAlcanceContent,
} from '../catastroxDeliverables.js';

function assertNoneMatch(haystack, terms) {
  for (const term of terms) {
    assert.doesNotMatch(haystack, new RegExp(term, 'i'), `no debe mencionar "${term}"`);
  }
}

function assertAllMatch(haystack, terms) {
  for (const term of terms) {
    assert.match(haystack, new RegExp(term, 'i'), `debe mencionar "${term}"`);
  }
}

// =================== BÁSICO ===================

test('1) Básico: tarjeta "PAQUETE BÁSICO"', () => {
  const card = resolvePdfSummaryCardContent('basico');
  assert.equal(card.title, 'PAQUETE BÁSICO');
});

test('2/3) Básico: sección "CÓMO UTILIZARLO" (singular), no "CÓMO UTILIZARLOS"', () => {
  const { instructionsTitle } = resolvePdfUsoAlcanceContent('basico');
  assert.equal(instructionsTitle, 'CÓMO UTILIZARLO');
  assert.notEqual(instructionsTitle, 'CÓMO UTILIZARLOS');
});

test('4) Básico: la fila del PDF ya no lleva la coma "catastral, y plano"', () => {
  const { deliveredFiles } = resolvePdfUsoAlcanceContent('basico');
  assert.equal(deliveredFiles.length, 1);
  assert.doesNotMatch(deliveredFiles[0], /catastral,\s*y plano/);
  assert.match(deliveredFiles[0], /catastral y plano/);
});

test('5/6) Básico: solo PDF, sin KML/KMZ/SHP/DXF', () => {
  const { deliveredFiles } = resolvePdfUsoAlcanceContent('basico');
  assert.match(deliveredFiles[0], /^PDF:/);
  assertNoneMatch(deliveredFiles.join(' '), ['KML', 'KMZ', 'SHP', 'DXF', 'Google Earth', 'coordenadas']);
});

test('7) Básico: tabla Punto/Siguiente/Distancia (sin Latitud/Longitud)', () => {
  const headers = resolveExecutiveTableHeaders(resolvePdfContentMode('basico'));
  assert.deepEqual(headers, ['Punto', 'Siguiente', 'Distancia']);
});

// =================== PLUS (sin cambios en este lote) ===================

test('8) Plus: tarjeta "PAQUETE PLUS" (sin cambios)', () => {
  assert.equal(resolvePdfSummaryCardContent('plus').title, 'PAQUETE PLUS');
});

test('9/10) Plus: PDF/KML/KMZ y Google Earth', () => {
  const { deliveredFiles, instructions } = resolvePdfUsoAlcanceContent('plus');
  assertAllMatch(deliveredFiles.join(' '), ['KML', 'KMZ']);
  assertAllMatch(instructions.join(' '), ['Google Earth']);
});

test('11) Plus: sin SHP/DXF/CSV', () => {
  const { deliveredFiles } = resolvePdfUsoAlcanceContent('plus');
  assertNoneMatch(deliveredFiles.join(' '), ['SHP', 'DXF', 'CSV']);
});

test('12) Plus: tabla Punto/Siguiente/Distancia (sin cambios)', () => {
  const headers = resolveExecutiveTableHeaders(resolvePdfContentMode('plus'));
  assert.deepEqual(headers, ['Punto', 'Siguiente', 'Distancia']);
});

// =================== PROFESIONAL ===================

test('13/14) Profesional: tarjeta "PAQUETE PROFESIONAL", nunca "PAQUETE PLUS"', () => {
  const card = resolvePdfSummaryCardContent('profesional');
  assert.equal(card.title, 'PAQUETE PROFESIONAL');
  assert.notEqual(card.title, 'PAQUETE PLUS');
});

test('15) Profesional: ARCHIVOS ENTREGADOS enumera exactamente PDF/KML/KMZ/SHP/DXF/CSV (6 filas, sin omitir SHP/DXF)', () => {
  const { deliveredFiles } = resolvePdfUsoAlcanceContent('profesional');
  assert.equal(deliveredFiles.length, 6);
  const joined = deliveredFiles.join(' | ');
  assertAllMatch(joined, ['^PDF:|PDF:', 'KML:', 'KMZ:', 'SHP:', 'DXF:', 'CSV:']);
  assert.match(joined, /Este/i);
  assert.match(joined, /Norte/i);
  assert.match(joined, /EPSG:9377/);
});

test('Profesional: SHP/DXF no se presentan como equivalentes a un levantamiento topográfico certificado', () => {
  const { deliveredFiles, instructions } = resolvePdfUsoAlcanceContent('profesional');
  const joined = [...deliveredFiles, ...instructions].join(' ');
  assertNoneMatch(joined, ['levantamiento topogr[aá]fico certificado', 'certificaci[oó]n oficial']);
});

test('16) Profesional: instrucciones cubren SIG (SHP), CAD (DXF) y coordenadas (CSV), además de PDF y KML/KMZ', () => {
  const { instructions, instructionsTitle } = resolvePdfUsoAlcanceContent('profesional');
  assert.equal(instructionsTitle, 'CÓMO UTILIZARLOS');
  const joined = instructions.join(' ');
  assertAllMatch(joined, ['PDF', 'KML', 'KMZ', 'SIG', 'CAD', 'EPSG:9377']);
});

test('17) Profesional: título "PLANO TÉCNICO • GEOMETRÍA DEL PREDIO" (conservado)', () => {
  assert.equal(resolvePdfContentMode('profesional'), PDF_CONTENT_MODE.PROFESSIONAL_CURRENT);
  assert.equal(resolvePdfTechnicalPageTitle(PDF_CONTENT_MODE.PROFESSIONAL_CURRENT), 'PLANO TÉCNICO • GEOMETRÍA DEL PREDIO');
});

test('18) Profesional: tabla Punto/Latitud/Longitud/Tramo/Distancia (conservada, sin Este/Norte en este lote)', () => {
  const headers = resolveExecutiveTableHeaders(PDF_CONTENT_MODE.PROFESSIONAL_CURRENT);
  assert.deepEqual(headers, ['Punto', 'Latitud', 'Longitud', 'Tramo', 'Distancia']);
  assertNoneMatch(headers.join(' '), ['Este', 'Norte']);
});

test('19/20) Profesional: nota final actualizada, menciona los entregables técnicos y advierte que no reemplaza un levantamiento topográfico', () => {
  const note = resolvePdfExecutiveBottomNote(PDF_CONTENT_MODE.PROFESSIONAL_CURRENT, 'profesional');
  assert.match(note, /archivos técnicos/i);
  assert.match(note, /no reemplaza un levantamiento topográfico/i);
  assert.match(note, /certificación oficial/i);
});

test('Profesional: la nota final ya no dice que la geometría "permanece disponible en los archivos KML y KMZ descargables" (ya no es solo KML/KMZ)', () => {
  const note = resolvePdfExecutiveBottomNote(PDF_CONTENT_MODE.PROFESSIONAL_CURRENT, 'profesional');
  assert.doesNotMatch(note, /permanece disponible en los archivos KML y KMZ descargables/);
});

// =================== Regresión: Básico/Plus sin cambios por los ajustes de Profesional ===================

test('Básico/Plus (contentMode informativo): subtítulo "PLANO INFORMATIVO • GEOMETRÍA CATASTRAL DEL PREDIO" (sin cambios)', () => {
  const title = resolvePdfTechnicalPageTitle(PDF_CONTENT_MODE.INFORMATIVE);
  assert.equal(title, 'PLANO INFORMATIVO • GEOMETRÍA CATASTRAL DEL PREDIO');
});

test('Básico: nota final sigue sin mencionar KML/KMZ (sin cambios)', () => {
  const note = resolvePdfExecutiveBottomNote(PDF_CONTENT_MODE.INFORMATIVE, 'basico');
  assertNoneMatch(note, ['KML', 'KMZ']);
});

test('Plus: nota final conserva la mención a KML/KMZ descargables (sin cambios)', () => {
  const note = resolvePdfExecutiveBottomNote(PDF_CONTENT_MODE.INFORMATIVE, 'plus');
  assert.match(note, /KML y KMZ descargables/);
});

test('Plus: "CÓMO UTILIZARLOS" (plural) sin cambios', () => {
  assert.equal(resolvePdfUsoAlcanceContent('plus').instructionsTitle, 'CÓMO UTILIZARLOS');
});
