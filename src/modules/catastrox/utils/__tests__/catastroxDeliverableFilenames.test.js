// LOTE 018-D: convención de nombres de entregables con sufijo de plan. Antes de
// este lote, downloadPlanPdf/downloadKml/downloadKmz/downloadShpZip/downloadDxf
// usaban únicamente el código predial (sin distinguir plan) -- confirmado
// empíricamente que Básico/Plus/Profesional intentaban guardar el mismo nombre
// para el mismo predio. buildCatastroxDeliverableFilename es la única fuente de
// verdad para nombrar cualquier entregable descargable. Fixtures sintéticos.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCatastroxDeliverableFilename } from '../catastroxDeliverables.js';

const CODIGO = '180290001000000270015000000000';

test('1) Básico PDF -> <codigo>_basico.pdf', () => {
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'basico', deliverableType: 'pdf' }),
    `${CODIGO}_basico.pdf`,
  );
});

test('2) Plus PDF/KML/KMZ -> <codigo>_plus.<ext>', () => {
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'plus', deliverableType: 'pdf' }),
    `${CODIGO}_plus.pdf`,
  );
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'plus', deliverableType: 'kml' }),
    `${CODIGO}_plus.kml`,
  );
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'plus', deliverableType: 'kmz' }),
    `${CODIGO}_plus.kmz`,
  );
});

test('3) KML interno del KMZ Plus coincide con el nombre externo del KML de Plus', () => {
  const externalKml = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'plus', deliverableType: 'kml' });
  assert.equal(externalKml, `${CODIGO}_plus.kml`);
});

test('4) Profesional PDF/KML/KMZ -> <codigo>_profesional.<ext>', () => {
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'pdf' }),
    `${CODIGO}_profesional.pdf`,
  );
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'kml' }),
    `${CODIGO}_profesional.kml`,
  );
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'kmz' }),
    `${CODIGO}_profesional.kmz`,
  );
});

test('5) KML interno del KMZ Profesional coincide con el nombre externo del KML de Profesional', () => {
  const externalKml = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'kml' });
  assert.equal(externalKml, `${CODIGO}_profesional.kml`);
});

test('6) ZIP SHP externo -> <codigo>_profesional_shp.zip', () => {
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'shpZip' }),
    `${CODIGO}_profesional_shp.zip`,
  );
});

test('7) los cinco archivos internos SHP comparten exactamente el mismo basename (<codigo>_profesional)', () => {
  const expectedBase = `${CODIGO}_profesional`;
  const names = ['shp', 'shx', 'dbf', 'prj', 'cpg'].map((deliverableType) =>
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType }),
  );
  assert.deepEqual(names, [`${expectedBase}.shp`, `${expectedBase}.shx`, `${expectedBase}.dbf`, `${expectedBase}.prj`, `${expectedBase}.cpg`]);
  for (const name of names) {
    assert.equal(name.slice(0, expectedBase.length), expectedBase);
  }
});

test('8) DXF -> <codigo>_profesional.dxf', () => {
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'dxf' }),
    `${CODIGO}_profesional.dxf`,
  );
});

test('9) ZIP CSV -> <codigo>_profesional_coordenadas_epsg9377.zip', () => {
  assert.equal(
    buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'coordinatesZip' }),
    `${CODIGO}_profesional_coordenadas_epsg9377.zip`,
  );
});

test('10) CSV interno -> <codigo>_profesional_coordenadas_epsg9377.csv (mismo stem que el ZIP, sin .zip)', () => {
  const csvName = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'coordinatesCsv' });
  const zipName = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'coordinatesZip' });
  assert.equal(csvName, `${CODIGO}_profesional_coordenadas_epsg9377.csv`);
  assert.equal(zipName.replace(/\.zip$/, ''), csvName.replace(/\.csv$/, ''));
});

test('11) sanitización: espacios, tildes y símbolos en el código predial se reemplazan, y el resultado queda en minúsculas', () => {
  const name = buildCatastroxDeliverableFilename({
    codigoPredial: '  Código 123/ABCñ  ',
    packageId: 'basico',
    deliverableType: 'pdf',
  });
  assert.match(name, /^[a-z0-9_.-]+\.pdf$/);
  assert.doesNotMatch(name, /[áéíóúñÁÉÍÓÚÑ /]/);
});

test('12) packageId inválido o desconocido: no se agrega sufijo de plan (nunca inventa un plan)', () => {
  const name = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'no-existe', deliverableType: 'pdf' });
  assert.equal(name, `${CODIGO}.pdf`);

  const nameEmpty = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: '', deliverableType: 'pdf' });
  assert.equal(nameEmpty, `${CODIGO}.pdf`);
});

test('13) código predial vacío o ausente: usa el fallback "predio", nunca produce un nombre vacío', () => {
  const name = buildCatastroxDeliverableFilename({ codigoPredial: '', packageId: 'basico', deliverableType: 'pdf' });
  assert.equal(name, 'predio_basico.pdf');

  const nameUndefined = buildCatastroxDeliverableFilename({ packageId: 'basico', deliverableType: 'pdf' });
  assert.equal(nameUndefined, 'predio_basico.pdf');
});

test('14) ausencia de doble extensión en ningún nombre generado', () => {
  const cases = [
    ['pdf', 'basico'], ['pdf', 'plus'], ['kml', 'plus'], ['kmz', 'plus'],
    ['pdf', 'profesional'], ['kml', 'profesional'], ['kmz', 'profesional'],
    ['shpZip', 'profesional'], ['shp', 'profesional'], ['shx', 'profesional'],
    ['dbf', 'profesional'], ['prj', 'profesional'], ['cpg', 'profesional'],
    ['dxf', 'profesional'], ['coordinatesZip', 'profesional'], ['coordinatesCsv', 'profesional'],
  ];
  for (const [deliverableType, packageId] of cases) {
    const name = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId, deliverableType });
    const extensionMatches = name.match(/\.[a-z0-9]+/g) || [];
    assert.equal(extensionMatches.length, 1, `"${name}" no debe tener doble extensión`);
  }
});

test('15) descargar los tres PDF del mismo predio produce tres nombres diferentes (el riesgo original queda cerrado)', () => {
  const basico = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'basico', deliverableType: 'pdf' });
  const plus = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'plus', deliverableType: 'pdf' });
  const profesional = buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'profesional', deliverableType: 'pdf' });
  const unique = new Set([basico, plus, profesional]);
  assert.equal(unique.size, 3, 'los tres nombres deben ser distintos entre sí');
});

test('16) deliverableType desconocido lanza un error explícito en vez de producir un nombre silenciosamente incorrecto', () => {
  assert.throws(() => buildCatastroxDeliverableFilename({ codigoPredial: CODIGO, packageId: 'basico', deliverableType: 'algo-inventado' }));
});
