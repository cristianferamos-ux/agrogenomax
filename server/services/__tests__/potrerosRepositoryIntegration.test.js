// SPRINT-3D3-POTREROS-API-FOUNDATION: pruebas del repositorio de Potreros
// (server/services/ganaderia/potrerosRepository.js) contra un
// Postgres/PostGIS REAL -- mismo patrón que prediosRepositoryIntegration.test.js.
// Cubre: scoping por predio dentro de la organización, aislamiento
// cross-tenant, cálculo de área server-side, ST_CoveredBy (incluido borde
// compartido), rechazo de geometría inválida/fuera del predio/sin
// geometría en el predio padre, y que MultiPolygon es rechazado por el
// propio esquema (agx.potreros.geometry es geometry(Polygon,4326)).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (nunca la variable de
// producción/runtime real). Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { geoJsonPolygonToWkt } from '../ganaderia/potreroKmlImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

let dbAvailable = false;
let adminPool;
let repo;
let businessDb;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }

  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;

  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.potreros') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potrerosRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

// Predio cuadrado ~0.1 x 0.1 grados.
const PREDIO_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';
// Completamente dentro del predio.
const POTRERO_INSIDE_WKT = 'POLYGON((-75.48 1.32, -75.42 1.32, -75.42 1.38, -75.48 1.38, -75.48 1.32))';
// Comparte el borde izquierdo del predio (x = -75.5) -- debe aceptarse.
const POTRERO_SHARED_EDGE_WKT = 'POLYGON((-75.5 1.3, -75.45 1.3, -75.45 1.35, -75.5 1.35, -75.5 1.3))';
// Se extiende fuera del predio (x hasta -75.35, y hasta 1.42).
const POTRERO_OUTSIDE_WKT = 'POLYGON((-75.42 1.35, -75.35 1.35, -75.35 1.42, -75.42 1.42, -75.42 1.35))';
// Bowtie -- autointersección clásica.
const POTRERO_SELF_INTERSECTING_WKT = 'POLYGON((-75.48 1.32, -75.42 1.38, -75.48 1.38, -75.42 1.32, -75.48 1.32))';

// SPRINT-3D5.1-KML-CLOSED-LINESTRING: predio y coordenadas del caso real
// confirmado POTRERO_1.kml -- un LineString cerrado exportado desde
// AutoCAD que representa el perímetro del potrero.
const PREDIO_POTRERO1_WKT = 'POLYGON((-75.89 1.249, -75.88 1.249, -75.88 1.251, -75.89 1.251, -75.89 1.249))';
const POTRERO_1_CLOSED_LINE_COORDS = [
  [-75.8847911620009, 1.24967933395856],
  [-75.8852492360009, 1.24993185695855],
  [-75.8847978338518, 1.25050614366061],
  [-75.8844887570009, 1.25007831195854],
  [-75.8847911620009, 1.24967933395856],
];
// Bowtie cerrado -- misma forma que el fixture 3D5.1-E de
// potreroKmlImport.test.js, usada aquí para probar ST_IsValid REAL.
const CLOSED_BOWTIE_COORDS = [
  [-74.6, 4.6],
  [-74.58, 4.62],
  [-74.6, 4.62],
  [-74.58, 4.6],
  [-74.6, 4.6],
];

function randomOrgId() {
  return crypto.randomUUID();
}

async function seedPredio(orgId, { nombre = 'Predio Sprint3D3 Test', wkt = PREDIO_WKT } = {}) {
  const geometryFragment = wkt ? 'ST_GeomFromText($3, 4326)' : 'null';
  const params = wkt ? [orgId, nombre, wkt] : [orgId, nombre];
  const result = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, geometry) values ($1, $2, ${geometryFragment}) returning predio_id`,
    params,
  );
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, { nombre = 'Potrero Sprint3D3 Test', wkt = POTRERO_INSIDE_WKT, areaHa = 5, metodo = 'coordenadas' } = {}) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), $5, $6)
     returning potrero_id`,
    [orgId, predioId, nombre, wkt, areaHa, metodo],
  );
  return result.rows[0].potrero_id;
}

// ---------------------------------------------------------------------
// W/X: legacy y CatastroX intactos -- aserciones estáticas, sin DB.
// ---------------------------------------------------------------------
describe('SPRINT-3D3: legacy y CatastroX quedan intactos (sin DB)', () => {
  test('W: server/routes/potreros.js (legacy) sigue usando server/db.js', () => {
    const legacyRoutePath = path.join(repoRoot, 'server', 'routes', 'potreros.js');
    const content = fs.readFileSync(legacyRoutePath, 'utf8');
    assert.match(content, /from ['"]\.\.\/db\.js['"]/, 'legacy debe seguir usando server/db.js');
  });

  test('W: server/routes/ganaderiaPotreros.js (nuevo) NUNCA importa server/db.js ni DATABASE_URL', () => {
    const newRoutePath = path.join(repoRoot, 'server', 'routes', 'ganaderiaPotreros.js');
    const content = fs.readFileSync(newRoutePath, 'utf8');
    assert.doesNotMatch(content, /from ['"]\.\.\/db\.js['"]/);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });

  test('W: server/services/ganaderia/potrerosRepository.js solo usa agxBusinessPool', () => {
    const repoPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'potrerosRepository.js');
    const content = fs.readFileSync(repoPath, 'utf8');
    assert.match(content, /agxBusinessPool\.js/);
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
  });

  test('X: CatastroX no se toca -- rutas y módulo siguen existiendo', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, 'server', 'routes', 'catastrox.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'src', 'modules', 'catastrox')));
  });

  test('SPRINT-3D5: potreroKmlImport.js (parser KML/KMZ) no importa server/db.js ni nada de CatastroX', () => {
    const importPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'potreroKmlImport.js');
    const content = fs.readFileSync(importPath, 'utf8');
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
    assert.doesNotMatch(content, /catastrox/i);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });
});

describe('SPRINT-3D3: potrerosRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D3%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D3%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  // -----------------------------------------------------------------
  // A/B: listado scoped por predio dentro de la misma organización.
  // -----------------------------------------------------------------
  test('A/B: listPotrerosByPredio devuelve solo los potreros del predio solicitado, sin mezclar otro predio de la misma org', async () => {
    const org = randomOrgId();
    const predioA = await seedPredio(org, { nombre: 'Predio Sprint3D3 A' });
    const predioB = await seedPredio(org, { nombre: 'Predio Sprint3D3 B' });
    await seedPotrero(org, predioA, { nombre: 'Potrero Sprint3D3 A1' });
    await seedPotrero(org, predioA, { nombre: 'Potrero Sprint3D3 A2' });
    await seedPotrero(org, predioB, { nombre: 'Potrero Sprint3D3 B1' });

    const rowsA = await repo.listPotrerosByPredio(org, predioA);
    assert.equal(rowsA.length, 2);
    assert.ok(rowsA.every((r) => ['Potrero Sprint3D3 A1', 'Potrero Sprint3D3 A2'].includes(r.nombre)));

    const rowsB = await repo.listPotrerosByPredio(org, predioB);
    assert.equal(rowsB.length, 1);
    assert.equal(rowsB[0].nombre, 'Potrero Sprint3D3 B1');
  });

  // I/J: el listado no expone organizacion_id ni geometry completa.
  test('I/J: las filas del listado no incluyen organizacion_id ni geometry', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 IJ' });
    await seedPotrero(org, predioId, { nombre: 'Potrero Sprint3D3 IJ' });

    const rows = await repo.listPotrerosByPredio(org, predioId);
    assert.equal(rows.length, 1);
    assert.equal('organizacion_id' in rows[0], false);
    assert.equal('geometry' in rows[0], false);
  });

  // C: cross-tenant predio -> PREDIO_NOT_FOUND.
  test('C: listPotrerosByPredio con predio de OTRA organización -> PREDIO_NOT_FOUND', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, { nombre: 'Predio Sprint3D3 C' });

    await assert.rejects(
      () => repo.listPotrerosByPredio(orgB, predioA),
      (error) => error.status === 404 && error.code === 'PREDIO_NOT_FOUND',
    );
  });

  // H: detalle incluye geometry.
  test('H: getPotreroDetail incluye geometry (GeoJSON)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 H' });
    const potreroId = await seedPotrero(org, predioId, { nombre: 'Potrero Sprint3D3 H' });

    const detail = await repo.getPotreroDetail(org, predioId, potreroId);
    assert.ok(detail);
    assert.equal(detail.geometry.type, 'Polygon');
  });

  // D: cross-tenant potrero -> 404 (null).
  test('D: getPotreroDetail con potrero de OTRA organización -> null', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, { nombre: 'Predio Sprint3D3 D' });
    const potreroIdA = await seedPotrero(orgA, predioA, { nombre: 'Potrero Sprint3D3 D' });

    const detail = await repo.getPotreroDetail(orgB, predioA, potreroIdA);
    assert.equal(detail, null);
  });

  // E: potrero bajo predio incorrecto (misma org) -> 404 (null).
  test('E: getPotreroDetail con el potrero correcto pero predioId incorrecto -> null', async () => {
    const org = randomOrgId();
    const predioA = await seedPredio(org, { nombre: 'Predio Sprint3D3 E-A' });
    const predioB = await seedPredio(org, { nombre: 'Predio Sprint3D3 E-B' });
    const potreroIdA = await seedPotrero(org, predioA, { nombre: 'Potrero Sprint3D3 E' });

    const detail = await repo.getPotreroDetail(org, predioB, potreroIdA);
    assert.equal(detail, null);
  });

  // G: RLS efectivo (ORG B no ve potreros de ORG A vía consulta directa).
  test('G: RLS bloquea SELECT cross-tenant directo sobre agx.potreros', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, { nombre: 'Predio Sprint3D3 G' });
    const potreroIdA = await seedPotrero(orgA, predioA, { nombre: 'Potrero Sprint3D3 G' });

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select * from agx.potreros where potrero_id = $1', [potreroIdA]);
      assert.equal(result.rows.length, 0);
    });
  });

  // T: predio sin geometry -> PREDIO_WITHOUT_GEOMETRY.
  test('T: computePotreroPreview con predio sin geometry -> PREDIO_WITHOUT_GEOMETRY', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 T', wkt: null });

    await assert.rejects(
      () => repo.computePotreroPreview(org, predioId, POTRERO_INSIDE_WKT),
      (error) => error.status === 422 && error.code === 'PREDIO_WITHOUT_GEOMETRY',
    );
  });

  // V: autointersección rechazada -- ST_IsValid, sin ST_MakeValid.
  test('V: computePotreroPreview con polígono autointersectante -> INVALID_POTRERO_GEOMETRY', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 V' });

    await assert.rejects(
      () => repo.computePotreroPreview(org, predioId, POTRERO_SELF_INTERSECTING_WKT),
      (error) => error.status === 422 && error.code === 'INVALID_POTRERO_GEOMETRY',
    );
  });

  // Q/S: fuera del predio rechazado.
  test('Q/S: computePotreroPreview con potrero parcialmente fuera del predio -> POTRERO_OUTSIDE_PREDIO', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 QS' });

    await assert.rejects(
      () => repo.computePotreroPreview(org, predioId, POTRERO_OUTSIDE_WKT),
      (error) => error.status === 422 && error.code === 'POTRERO_OUTSIDE_PREDIO',
    );
  });

  // R: borde compartido permitido.
  test('R: computePotreroPreview acepta un potrero que comparte borde con el predio', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 R' });

    const result = await repo.computePotreroPreview(org, predioId, POTRERO_SHARED_EDGE_WKT);
    assert.ok(result.areaHa > 0);
    assert.equal(result.geometry.type, 'Polygon');
  });

  // P: área calculada server-side (ST_Area(geometry::geography)/10000).
  test('P: computePotreroPreview calcula areaHa server-side (~0.06 grados^2 cerca del ecuador)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 P' });

    const result = await repo.computePotreroPreview(org, predioId, POTRERO_INSIDE_WKT);
    // Cuadrado 0.06 x 0.06 grados cerca del ecuador -> ~44 km^2 -> ~4400 ha.
    // Solo se verifica orden de magnitud (no depende de un valor exacto de
    // elipsoide) y que sea un número positivo calculado, no un valor fijo.
    assert.ok(result.areaHa > 4000 && result.areaHa < 4800, `areaHa fuera del rango esperado: ${result.areaHa}`);
  });

  // Creación a partir de candidate: geometry/areaHa/metodoDelimitacion
  // vienen del candidate, nunca del cliente -- ver ganaderiaPotreros.js.
  test('createPotreroFromCandidate inserta el potrero con la geometry/areaHa del candidate', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 CREATE' });
    const preview = await repo.computePotreroPreview(org, predioId, POTRERO_INSIDE_WKT);

    const potreroId = await repo.createPotreroFromCandidate(org, predioId, {
      geometry: preview.geometry,
      areaHa: preview.areaHa,
      metodoDelimitacion: 'coordenadas',
      nombre: 'Potrero Sprint3D3 CREATE',
      capacidadAnimales: 10,
      observaciones: null,
    });

    const detail = await repo.getPotreroDetail(org, predioId, potreroId);
    assert.ok(detail);
    assert.equal(detail.nombre, 'Potrero Sprint3D3 CREATE');
    assert.equal(Number(detail.area_ha), preview.areaHa);
    assert.equal(detail.metodo_delimitacion, 'coordenadas');
  });

  // O: si la transacción de negocio falla (predioId no pertenece a la
  // organización -- FK compuesta 23503), el insert no se aplica.
  test('O: createPotreroFromCandidate con predioId de OTRA organización falla por integridad referencial (23503)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioIdA = await seedPredio(orgA, { nombre: 'Predio Sprint3D3 O' });

    await assert.rejects(
      () =>
        repo.createPotreroFromCandidate(orgB, predioIdA, {
          geometry: { type: 'Polygon', coordinates: [[[-75.48, 1.32], [-75.42, 1.32], [-75.42, 1.38], [-75.48, 1.32]]] },
          areaHa: 1,
          metodoDelimitacion: 'coordenadas',
          nombre: 'Potrero Sprint3D3 O (no debe crearse)',
          capacidadAnimales: null,
          observaciones: null,
        }),
      (error) => error.code === '23503' || /row-level security/i.test(error.message),
    );
  });

  // U: Polygon requerido -- MultiPolygon es rechazado por el propio
  // esquema (agx.potreros.geometry es geometry(Polygon,4326)).
  test('U: createPotreroFromCandidate con geometry MultiPolygon es rechazado por el esquema', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 U' });

    const multiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[-75.48, 1.32], [-75.46, 1.32], [-75.46, 1.34], [-75.48, 1.32]]],
        [[[-75.44, 1.36], [-75.42, 1.36], [-75.42, 1.38], [-75.44, 1.36]]],
      ],
    };

    await assert.rejects(
      () =>
        repo.createPotreroFromCandidate(org, predioId, {
          geometry: multiPolygon,
          areaHa: 1,
          metodoDelimitacion: 'coordenadas',
          nombre: 'Potrero Sprint3D3 U (no debe crearse)',
          capacidadAnimales: null,
          observaciones: null,
        }),
      /Polygon|geometry type/i,
    );
  });

  // ---------------------------------------------------------------------
  // SPRINT-3D5-POTRERO-KML-KMZ: computePotreroPreviewsBatch -- misma
  // validación espacial exacta de computePotreroPreview, aplicada a varios
  // polígonos de un mismo archivo KML/KMZ en una única transacción. Nunca
  // ST_Union: cada resultado se evalúa y devuelve por separado, en el
  // mismo orden que la lista de entrada.
  // ---------------------------------------------------------------------

  test('SPRINT-3D5: computePotreroPreviewsBatch evalúa cada polígono por separado (válido, autointersectante, fuera del predio, borde compartido) preservando el orden', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLBATCH' });

    const results = await repo.computePotreroPreviewsBatch(org, predioId, [
      POTRERO_INSIDE_WKT,
      POTRERO_SELF_INTERSECTING_WKT,
      POTRERO_OUTSIDE_WKT,
      POTRERO_SHARED_EDGE_WKT,
    ]);

    assert.equal(results.length, 4);
    assert.equal(results[0].ok, true);
    assert.ok(results[0].areaHa > 0);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].code, 'INVALID_POTRERO_GEOMETRY');
    assert.equal(results[2].ok, false);
    assert.equal(results[2].code, 'POTRERO_OUTSIDE_PREDIO');
    assert.equal(results[3].ok, true);
    assert.ok(results[3].areaHa > 0);
  });

  test('SPRINT-3D5: computePotreroPreviewsBatch con predio sin geometry -> PREDIO_WITHOUT_GEOMETRY (falla el archivo completo, no por polígono)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLBATCH-SINGEO', wkt: null });

    await assert.rejects(
      () => repo.computePotreroPreviewsBatch(org, predioId, [POTRERO_INSIDE_WKT]),
      (error) => error.status === 422 && error.code === 'PREDIO_WITHOUT_GEOMETRY',
    );
  });

  test('SPRINT-3D5: computePotreroPreviewsBatch con predio de OTRA organización -> PREDIO_NOT_FOUND', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, { nombre: 'Predio Sprint3D3 KMLBATCH-XORG' });

    await assert.rejects(
      () => repo.computePotreroPreviewsBatch(orgB, predioA, [POTRERO_INSIDE_WKT]),
      (error) => error.status === 404 && error.code === 'PREDIO_NOT_FOUND',
    );
  });

  test('SPRINT-3D5: candidatos de un preview-file quedan ligados a organizacionId/cuentaId/predioId igual que coordenadas/gps (mismo candidate store, sin mecanismo paralelo)', async () => {
    const { createPotreroCandidate, reservePotreroCandidate, __resetPotrerosCandidateStoreForTests } = await import(
      '../ganaderia/potrerosCandidateStore.js'
    );
    __resetPotrerosCandidateStoreForTests();

    const org = randomOrgId();
    const cuentaId = randomOrgId();
    const predioA = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLBATCH-CAND-A' });
    const predioB = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLBATCH-CAND-B' });

    const [previewA] = await repo.computePotreroPreviewsBatch(org, predioA, [POTRERO_INSIDE_WKT]);
    const candidateId = createPotreroCandidate({
      organizacionId: org,
      cuentaId,
      predioId: predioA,
      geometry: previewA.geometry,
      areaHa: previewA.areaHa,
      metodoDelimitacion: 'kml',
    });

    // Mismo candidate, mismo dueño, pero confirmando bajo OTRO predio de la
    // misma organización -> scope_mismatch (nunca se cuela en predioB).
    const crossPredio = reservePotreroCandidate({ candidateId, organizacionId: org, cuentaId, predioId: predioB });
    assert.equal(crossPredio.status, 'scope_mismatch');

    const ok = reservePotreroCandidate({ candidateId, organizacionId: org, cuentaId, predioId: predioA });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.metodoDelimitacion, 'kml');
  });

  // -----------------------------------------------------------------
  // SPRINT-3D5.1-KML-CLOSED-LINESTRING §13: el WKT que produce
  // geoJsonPolygonToWkt() a partir de un LineString cerrado NO se valida
  // distinto de cualquier otro Polygon -- pasa por el MISMO pipeline
  // PostGIS real (ST_IsValid, ST_CoveredBy, ST_Area). Esto prueba contra
  // Postgres/PostGIS real, no solo JS, que la conversión es correcta.
  // -----------------------------------------------------------------
  test('3D5.1-B/13: WKT convertido desde el LineString cerrado real de POTRERO_1.kml -> ST_IsValid=true, ST_CoveredBy=true, área>0', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLCLOSEDLINE-P1', wkt: PREDIO_POTRERO1_WKT });

    const wkt = geoJsonPolygonToWkt([POTRERO_1_CLOSED_LINE_COORDS]);
    const preview = await repo.computePotreroPreview(org, predioId, wkt);

    assert.ok(preview.areaHa > 0);
    assert.ok(preview.geometry);
  });

  test('3D5.1-E/13: WKT convertido desde un LineString cerrado autointersectante (bowtie) -> ST_IsValid=false, INVALID_POTRERO_GEOMETRY, nunca ST_MakeValid', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLCLOSEDLINE-BOWTIE' });

    const wkt = geoJsonPolygonToWkt([CLOSED_BOWTIE_COORDS]);

    await assert.rejects(
      () => repo.computePotreroPreview(org, predioId, wkt),
      (error) => error.status === 422 && error.code === 'INVALID_POTRERO_GEOMETRY',
    );
  });

  test('3D5.1-13: computePotreroPreviewsBatch con varios LineString cerrados (algunos válidos, uno autointersectante) preserva el orden, sin ST_Union', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, { nombre: 'Predio Sprint3D3 KMLCLOSEDLINE-BATCH', wkt: PREDIO_POTRERO1_WKT });

    const validWkt = geoJsonPolygonToWkt([POTRERO_1_CLOSED_LINE_COORDS]);
    const bowtieWkt = geoJsonPolygonToWkt([CLOSED_BOWTIE_COORDS]);

    const results = await repo.computePotreroPreviewsBatch(org, predioId, [validWkt, bowtieWkt]);

    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.ok(results[0].areaHa > 0);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].code, 'INVALID_POTRERO_GEOMETRY');
  });
});
