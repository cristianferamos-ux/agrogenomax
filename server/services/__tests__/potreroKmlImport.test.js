// SPRINT-3D5-POTRERO-KML-KMZ: pruebas unitarias del parser KML/KMZ
// (server/services/ganaderia/potreroKmlImport.js). Módulo puro -- sin
// Express, sin DB -- así que estas pruebas corren en `test:node` sin
// necesitar Postgres/PostGIS desechable. La validación espacial real
// (ST_IsValid/ST_CoveredBy/ST_Area, self-intersection, outside predio,
// shared border, predio sin geometry) vive en
// server/services/ganaderia/potrerosRepository.js y se prueba contra
// PostGIS real en potrerosRepositoryIntegration.test.js
// (test:ganaderia-potreros-integration) -- este archivo NO la duplica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import {
  parseKmlOrKmzUpload,
  resolveDeclaredExtension,
  geoJsonPolygonToWkt,
  FILE_MAX_BYTES,
  KMZ_MAX_DECOMPRESSED_BYTES,
} from '../ganaderia/potreroKmlImport.js';

function kmlDocument(placemarksXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarksXml}</Document></kml>`;
}

function polygonPlacemark(name, ring) {
  const coords = ring.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
  return `<Placemark><name>${name}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
}

const SQUARE_A = [
  [-74.1, 4.1],
  [-74.1, 4.12],
  [-74.08, 4.12],
  [-74.08, 4.1],
  [-74.1, 4.1],
];
const SQUARE_B = [
  [-74.2, 4.2],
  [-74.2, 4.22],
  [-74.18, 4.22],
  [-74.18, 4.2],
  [-74.2, 4.2],
];

const KML_SINGLE_POLYGON = kmlDocument(polygonPlacemark('Potrero Norte', SQUARE_A));

async function buildKmz(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  // DEFLATE explícito: sin esto, JSZip usa STORE (sin comprimir) por
  // defecto y el fixture de "zip bomb" (contenido MUY repetitivo) pesaría
  // en el ZIP lo mismo que descomprimido -- justo lo opuesto de lo que ese
  // caso necesita ejercitar (archivo subido pequeño, contenido real
  // descomprimido grande).
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

// ---------------------------------------------------------------------
// resolveDeclaredExtension / geoJsonPolygonToWkt: helpers puros.
// ---------------------------------------------------------------------

test('resolveDeclaredExtension: extrae la extensión en minúsculas ignorando componentes de ruta', () => {
  assert.equal(resolveDeclaredExtension('Potrero Norte.KMZ'), 'kmz');
  assert.equal(resolveDeclaredExtension('carpeta/subcarpeta/predio.kml'), 'kml');
  assert.equal(resolveDeclaredExtension('sin-extension'), null);
  assert.equal(resolveDeclaredExtension(undefined), null);
});

test('geoJsonPolygonToWkt: cierra el anillo explícitamente y descarta la altitud', () => {
  const wkt = geoJsonPolygonToWkt([[[-74.1, 4.1, 100], [-74.1, 4.12, 50], [-74.08, 4.12, 0]]]);
  assert.equal(wkt, 'POLYGON((-74.1 4.1, -74.1 4.12, -74.08 4.12, -74.1 4.1))');
});

test('geoJsonPolygonToWkt: soporta huecos (anillo interior) como POLYGON con múltiples anillos', () => {
  const outer = [[-74.2, 4.2], [-74.2, 4.3], [-74.1, 4.3], [-74.1, 4.2], [-74.2, 4.2]];
  const hole = [[-74.18, 4.22], [-74.18, 4.24], [-74.16, 4.24], [-74.16, 4.22], [-74.18, 4.22]];
  const wkt = geoJsonPolygonToWkt([outer, hole]);
  assert.match(wkt, /^POLYGON\(\(.+\), \(.+\)\)$/);
});

// ---------------------------------------------------------------------
// KML/KMZ válidos.
// ---------------------------------------------------------------------

test('KML válido con 1 Polygon -> un candidato, metodoDelimitacion=kml, nombreSugerido tomado del Placemark', async () => {
  const result = await parseKmlOrKmzUpload(Buffer.from(KML_SINGLE_POLYGON, 'utf8'), { fileNameHeader: 'potrero.kml' });
  assert.equal(result.metodoDelimitacion, 'kml');
  assert.equal(result.polygons.length, 1);
  assert.equal(result.polygons[0].nombreSugerido, 'Potrero Norte');
  assert.match(result.polygons[0].wkt, /^POLYGON\(/);
});

test('KMZ válido con 1 Polygon (doc.kml dentro del zip) -> metodoDelimitacion=kmz', async () => {
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON });
  const result = await parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'potrero.kmz' });
  assert.equal(result.metodoDelimitacion, 'kmz');
  assert.equal(result.polygons.length, 1);
});

test('KML con varios Placemark Polygon -> varios candidatos separados (nunca ST_Union, cada uno con su propio wkt)', async () => {
  const kml = kmlDocument(polygonPlacemark('Potrero A', SQUARE_A) + polygonPlacemark('Potrero B', SQUARE_B));
  const result = await parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'multi.kml' });
  assert.equal(result.polygons.length, 2);
  assert.deepEqual(result.polygons.map((p) => p.nombreSugerido), ['Potrero A', 'Potrero B']);
  assert.notEqual(result.polygons[0].wkt, result.polygons[1].wkt);
});

test('MultiPolygon (un Placemark con MultiGeometry de 2 Polygon) se separa determinísticamente en 2 candidatos individuales', async () => {
  const coordsA = SQUARE_A.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
  const coordsB = SQUARE_B.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
  const kml = kmlDocument(
    `<Placemark><name>Grupo</name><MultiGeometry>` +
      `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsA}</coordinates></LinearRing></outerBoundaryIs></Polygon>` +
      `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsB}</coordinates></LinearRing></outerBoundaryIs></Polygon>` +
      `</MultiGeometry></Placemark>`,
  );
  const result = await parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'multipolygon.kml' });
  assert.equal(result.polygons.length, 2);
  assert.notEqual(result.polygons[0].wkt, result.polygons[1].wkt);
});

// ---------------------------------------------------------------------
// §7: Point/LineString nunca se convierten en polígonos.
// ---------------------------------------------------------------------

test('KML con solo un Point -> NO_POLYGONS_FOUND (nunca se convierte el punto en polígono)', async () => {
  const kml = kmlDocument('<Placemark><name>Punto</name><Point><coordinates>-74.1,4.1,0</coordinates></Point></Placemark>');
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'punto.kml' }),
    (error) => error.code === 'NO_POLYGONS_FOUND',
  );
});

test('KML con solo un LineString -> NO_POLYGONS_FOUND (nunca se convierte la línea en polígono)', async () => {
  const kml = kmlDocument(
    '<Placemark><name>Linea</name><LineString><coordinates>-74.1,4.1,0 -74.1,4.2,0 -74.0,4.2,0</coordinates></LineString></Placemark>',
  );
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'linea.kml' }),
    (error) => error.code === 'NO_POLYGONS_FOUND',
  );
});

// ---------------------------------------------------------------------
// SPRINT-3D5-CIERRE-SEMANTICO §1: archivo mixto -- Polygon válido +
// geometría no poligonal. Nunca se aborta el archivo; se reporta el
// conteo de elementos ignorados al llamador.
// ---------------------------------------------------------------------

test('A: KML con Polygon + Point -> candidate válido, Point reportado en ignored.points', async () => {
  const kml = kmlDocument(
    polygonPlacemark('Potrero Norte', SQUARE_A) +
      '<Placemark><name>Aguada</name><Point><coordinates>-74.1,4.1,0</coordinates></Point></Placemark>',
  );
  const result = await parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'mixto-punto.kml' });
  assert.equal(result.polygons.length, 1);
  assert.deepEqual(result.ignored, { points: 1, lineStrings: 0, multiLineStrings: 0 });
});

test('B: KML con Polygon + LineString -> candidate válido, línea reportada en ignored.lineStrings', async () => {
  const kml = kmlDocument(
    polygonPlacemark('Potrero Norte', SQUARE_A) +
      '<Placemark><name>Cerca</name><LineString><coordinates>-74.1,4.1,0 -74.1,4.2,0 -74.0,4.2,0</coordinates></LineString></Placemark>',
  );
  const result = await parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'mixto-linea.kml' });
  assert.equal(result.polygons.length, 1);
  assert.deepEqual(result.ignored, { points: 0, lineStrings: 1, multiLineStrings: 0 });
});

test('KML con Polygon + MultiLineString -> candidate válido, reportado en ignored.multiLineStrings', async () => {
  const kml = kmlDocument(
    polygonPlacemark('Potrero Norte', SQUARE_A) +
      '<Placemark><name>Cercas</name><MultiGeometry>' +
      '<LineString><coordinates>-74.1,4.1,0 -74.1,4.2,0</coordinates></LineString>' +
      '<LineString><coordinates>-74.2,4.1,0 -74.2,4.2,0</coordinates></LineString>' +
      '</MultiGeometry></Placemark>',
  );
  const result = await parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'mixto-multilinea.kml' });
  assert.equal(result.polygons.length, 1);
  // togeojson representa un MultiGeometry de solo LineString como
  // MultiLineString -- se cuenta como 1 elemento ignorado (el Placemark),
  // no como 2 líneas sueltas.
  assert.equal(result.ignored.multiLineStrings + result.ignored.lineStrings >= 1, true);
});

test('KML válido sin elementos mixtos -> ignored en cero (contrato estable incluso sin nada que ignorar)', async () => {
  const result = await parseKmlOrKmzUpload(Buffer.from(KML_SINGLE_POLYGON, 'utf8'), { fileNameHeader: 'limpio.kml' });
  assert.deepEqual(result.ignored, { points: 0, lineStrings: 0, multiLineStrings: 0 });
});

// ---------------------------------------------------------------------
// §3: solo .kml/.kmz -- extensión Y firma binaria.
// ---------------------------------------------------------------------

test('extensión no soportada (.csv) -> UNSUPPORTED_FILE_TYPE, nunca intenta parsear', async () => {
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from('a,b,c\n1,2,3'), { fileNameHeader: 'predio.csv' }),
    (error) => error.code === 'UNSUPPORTED_FILE_TYPE',
  );
});

test('extensión .geojson -> UNSUPPORTED_FILE_TYPE', async () => {
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from('{"type":"FeatureCollection","features":[]}'), { fileNameHeader: 'predio.geojson' }),
    (error) => error.code === 'UNSUPPORTED_FILE_TYPE',
  );
});

test('.kml declarado pero contenido es en realidad un ZIP -> INVALID_KML (la extensión nunca es la única defensa)', async () => {
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'disfrazado.kml' }),
    (error) => error.code === 'INVALID_KML',
  );
});

test('.kmz declarado pero contenido no es ZIP -> INVALID_KMZ', async () => {
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from(KML_SINGLE_POLYGON, 'utf8'), { fileNameHeader: 'no-es-zip.kmz' }),
    (error) => error.code === 'INVALID_KMZ',
  );
});

// ---------------------------------------------------------------------
// §4: tamaño.
// ---------------------------------------------------------------------

test('archivo mayor a FILE_MAX_BYTES -> FILE_TOO_LARGE, validado ANTES de intentar parsear', async () => {
  const oversized = Buffer.alloc(FILE_MAX_BYTES + 1, 0x41);
  await assert.rejects(
    parseKmlOrKmzUpload(oversized, { fileNameHeader: 'grande.kml' }),
    (error) => error.code === 'FILE_TOO_LARGE' && error.status === 413,
  );
});

// ---------------------------------------------------------------------
// §5: seguridad KMZ.
// ---------------------------------------------------------------------

test('KMZ con path traversal (../evil.txt) -> INVALID_KMZ, se rechaza el archivo completo', async () => {
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON, '../evil.txt': 'x' });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'traversal.kmz' }),
    (error) => error.code === 'INVALID_KMZ',
  );
});

test('KMZ con ruta absoluta (/abs/evil.txt) -> INVALID_KMZ', async () => {
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON, '/abs/evil.txt': 'x' });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'abs.kmz' }),
    (error) => error.code === 'INVALID_KMZ',
  );
});

test('KMZ con un ZIP anidado (entrada .zip dentro del KMZ) -> INVALID_KMZ, nunca se descomprime la entrada anidada', async () => {
  const nestedZip = await buildKmz({ 'inner.kml': KML_SINGLE_POLYGON });
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON, 'nested.zip': nestedZip });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'anidado.kmz' }),
    (error) => error.code === 'INVALID_KMZ',
  );
});

test('KMZ con un .kmz anidado -> INVALID_KMZ', async () => {
  const nestedKmz = await buildKmz({ 'inner.kml': KML_SINGLE_POLYGON });
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON, 'nested.kmz': nestedKmz });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'anidado2.kmz' }),
    (error) => error.code === 'INVALID_KMZ',
  );
});

test('KMZ con más de KMZ_MAX_ENTRIES entradas -> KMZ_TOO_MANY_ENTRIES', async () => {
  const files = { 'doc.kml': KML_SINGLE_POLYGON };
  for (let i = 0; i < 105; i += 1) {
    files[`resource_${i}.txt`] = 'x';
  }
  const kmzBuffer = await buildKmz(files);
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'muchas-entradas.kmz' }),
    (error) => error.code === 'KMZ_TOO_MANY_ENTRIES',
  );
});

test('KMZ tipo "zip bomb" (contenido .kml altamente comprimible que excede KMZ_MAX_DECOMPRESSED_BYTES ya descomprimido) -> KMZ_DECOMPRESSED_TOO_LARGE, nunca se acepta el contenido', async () => {
  // Contenido de un único carácter repetido (comprime bajo DEFLATE a un
  // archivo subido diminuto) pero cuyo tamaño REAL ya descomprimido supera
  // el límite -- ejercita tanto el chequeo de tamaño declarado como el
  // chequeo real post-descompresión.
  const hugeKmlLike = 'A'.repeat(KMZ_MAX_DECOMPRESSED_BYTES + 1024);
  const kmzBuffer = await buildKmz({ 'doc.kml': hugeKmlLike });
  assert.ok(kmzBuffer.length < FILE_MAX_BYTES, 'el fixture debe comprimir por debajo del límite de subida para probar el caso real');
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'bomba.kmz' }),
    (error) => error.code === 'KMZ_DECOMPRESSED_TOO_LARGE',
  );
});

test('D: KMZ sin ningún archivo .kml dentro -> INVALID_KMZ', async () => {
  const kmzBuffer = await buildKmz({ 'imagen.png': 'no-es-kml' });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'sin-kml.kmz' }),
    (error) => error.code === 'INVALID_KMZ',
  );
});

test('E: KMZ con exactamente 1 archivo .kml -> se procesa normalmente', async () => {
  const kmzBuffer = await buildKmz({ 'doc.kml': KML_SINGLE_POLYGON });
  const result = await parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'uno.kmz' });
  assert.equal(result.polygons.length, 1);
});

test('F: KMZ con MÁS DE 1 archivo .kml -> KMZ_MULTIPLE_KML_FILES, nunca se elige "el primero" en silencio', async () => {
  const kmzBuffer = await buildKmz({
    'doc.kml': KML_SINGLE_POLYGON,
    'otro.kml': kmlDocument(polygonPlacemark('Otro Potrero', SQUARE_B)),
  });
  await assert.rejects(
    parseKmlOrKmzUpload(kmzBuffer, { fileNameHeader: 'ambiguo.kmz' }),
    (error) => error.code === 'KMZ_MULTIPLE_KML_FILES',
  );
});

// ---------------------------------------------------------------------
// §6: seguridad XML / XXE.
// ---------------------------------------------------------------------

test('KML con DOCTYPE/ENTITY (intento de XXE) -> INVALID_KML, rechazado por el pre-check ANTES de tocar el parser', async () => {
  const xxeKml = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe "pwned">]><kml>&xxe;</kml>';
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from(xxeKml, 'utf8'), { fileNameHeader: 'xxe.kml' }),
    (error) => error.code === 'INVALID_KML',
  );
});

test('KML mal formado (tags sin cerrar) -> INVALID_KML', async () => {
  const brokenKml = '<?xml version="1.0"?><kml><Document><Placemark></Document></kml>';
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from(brokenKml, 'utf8'), { fileNameHeader: 'roto.kml' }),
    (error) => error.code === 'INVALID_KML',
  );
});

// ---------------------------------------------------------------------
// §4: máximo de polígonos procesables.
// ---------------------------------------------------------------------

test('KML con más de 100 Polygon -> TOO_MANY_POLYGONS', async () => {
  let placemarks = '';
  for (let i = 0; i < 101; i += 1) {
    const offset = i * 0.001;
    placemarks += polygonPlacemark(`Potrero ${i}`, SQUARE_A.map(([lng, lat]) => [lng + offset, lat]));
  }
  const kml = kmlDocument(placemarks);
  await assert.rejects(
    parseKmlOrKmzUpload(Buffer.from(kml, 'utf8'), { fileNameHeader: 'demasiados.kml' }),
    (error) => error.code === 'TOO_MANY_POLYGONS',
  );
});

// ---------------------------------------------------------------------
// No legacy / no CatastroX -- este módulo es autocontenido.
// ---------------------------------------------------------------------

test('potreroKmlImport.js no importa el pool legacy (server/db.js) ni nada de CatastroX', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ganaderia/potreroKmlImport.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  assert.doesNotMatch(source, /from ['"].*\/db\.js['"]/);
  assert.doesNotMatch(source, /catastrox/i);
});
