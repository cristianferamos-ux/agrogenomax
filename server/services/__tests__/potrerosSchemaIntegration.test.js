// SPRINT-3D2-POTREROS-BUSINESS-FOUNDATION: pruebas de la fundación tenant-safe
// de agx.potreros (db/agx-business/migrations/0003_potreros_foundation.sql)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// prediosRepositoryIntegration.test.js (0001). Este sprint NO crea API ni
// repositorio de Potreros -- estas pruebas validan el esquema (constraints,
// FK compuesta, RLS, grants, índices) directamente vía SQL, más un puñado
// de aserciones estáticas (sin DB) de que legacy y CatastroX quedan intactos.
//
// Lee EXCLUSIVAMENTE `AGX_BUSINESS_DATABASE_URL_TEST` -- nunca
// `AGX_BUSINESS_DATABASE_URL` (esa es la variable de producción/runtime
// real). Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

let dbAvailable = false;
let adminPool;
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
  businessDb = await import('../../db/agxBusinessPool.js');
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

function randomOrgId() {
  return crypto.randomUUID();
}

async function seedPredio(orgId, nombre = 'Predio Sprint3D2 Test') {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, nombre],
  );
  return result.rows[0].predio_id;
}

async function insertPotrero(client, { organizacionId, predioId, nombre = 'Potrero Sprint3D2 Test', wkt = SQUARE_WKT, areaHa = 5, metodo = 'coordenadas', capacidad = null }) {
  const result = await client.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion, capacidad_animales)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), $5, $6, $7)
     returning potrero_id`,
    [organizacionId, predioId, nombre, wkt, areaHa, metodo, capacidad],
  );
  return result.rows[0].potrero_id;
}

// ---------------------------------------------------------------------
// S/T: legacy y CatastroX intactos -- aserciones estáticas, sin DB.
// ---------------------------------------------------------------------
describe('SPRINT-3D2: legacy y CatastroX quedan intactos (sin DB)', () => {
  test('S: server/routes/potreros.js (legacy) sigue usando server/db.js -- no fue migrado a agx.potreros/agxBusinessPool', () => {
    const legacyRoutePath = path.join(repoRoot, 'server', 'routes', 'potreros.js');
    assert.ok(fs.existsSync(legacyRoutePath), 'la ruta legacy de potreros debe seguir existiendo intacta');

    const content = fs.readFileSync(legacyRoutePath, 'utf8');
    assert.match(content, /from ['"]\.\.\/db\.js['"]/, 'legacy debe seguir usando server/db.js');
    assert.doesNotMatch(content, /agxBusinessPool/, 'legacy NO debe referenciar el pool de Postgres-AGX-Business');
    assert.doesNotMatch(content, /agx\.potreros/, 'legacy NO debe referenciar la nueva tabla agx.potreros');
  });

  test('T: la migración 0003 no toca CatastroX (schema, rutas ni módulo)', () => {
    const migrationPath = path.join(
      repoRoot,
      'db',
      'agx-business',
      'migrations',
      '0003_potreros_foundation.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();
    assert.doesNotMatch(migrationSql, /catastrox/, 'la migración de potreros no debe mencionar catastrox');

    assert.ok(
      fs.existsSync(path.join(repoRoot, 'server', 'routes', 'catastrox.js')),
      'server/routes/catastrox.js debe seguir existiendo intacto',
    );
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'src', 'modules', 'catastrox')),
      'src/modules/catastrox debe seguir existiendo intacto',
    );
  });

  test('la migración 0003 es aditiva pura -- sin DROP/TRUNCATE, y no toca 0001/0002', () => {
    const migrationPath = path.join(
      repoRoot,
      'db',
      'agx-business',
      'migrations',
      '0003_potreros_foundation.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\b(?!\s+if\s+exists\s+agx\.potreros)/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.predios\b/i, 'no debe alterar agx.predios');

    assert.ok(
      fs.existsSync(path.join(repoRoot, 'db', 'agx-business', 'migrations', '0001_business_foundation.sql')),
    );
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'db', 'agx-business', 'migrations', '0002_predio_operational_fields.sql')),
    );
  });
});

describe('SPRINT-3D2: agx.potreros contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potreros where nombre = 'Potrero Sprint3D2 Test'`);
    await adminPool.query(`delete from agx.predios where nombre_predio = 'Predio Sprint3D2 Test'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  // -----------------------------------------------------------------
  // A-D: tabla y columnas base.
  // -----------------------------------------------------------------
  test('A: agx.potreros existe', async () => {
    const result = await adminPool.query("select to_regclass('agx.potreros') as t");
    assert.ok(result.rows[0].t);
  });

  test('B: geometry es Polygon, SRID 4326', async () => {
    const result = await adminPool.query(
      `select type, srid from geometry_columns
       where f_table_schema = 'agx' and f_table_name = 'potreros' and f_geometry_column = 'geometry'`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].type, 'POLYGON');
    assert.equal(result.rows[0].srid, 4326);
  });

  test('C/D: organizacion_id y predio_id son NOT NULL', async () => {
    const result = await adminPool.query(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'agx' and table_name = 'potreros'
         and column_name in ('organizacion_id', 'predio_id')`,
    );
    const byName = Object.fromEntries(result.rows.map((r) => [r.column_name, r.is_nullable]));
    assert.equal(byName.organizacion_id, 'NO');
    assert.equal(byName.predio_id, 'NO');
  });

  // -----------------------------------------------------------------
  // E: FK compuesta -- regla de dominio ORGANIZACIÓN -> PREDIO -> POTREROS.
  // -----------------------------------------------------------------
  test('E: FK compuesta (predio_id, organizacion_id) -> agx.predios(predio_id, organizacion_id)', async () => {
    const result = await adminPool.query(
      `select pg_get_constraintdef(oid) as def
       from pg_constraint
       where conrelid = 'agx.potreros'::regclass and conname = 'potreros_predio_organizacion_fkey'`,
    );
    assert.equal(result.rows.length, 1);
    const def = result.rows[0].def;
    assert.match(def, /FOREIGN KEY \(predio_id, organizacion_id\)/);
    assert.match(def, /REFERENCES agx\.predios\(predio_id, organizacion_id\)/);
  });

  test('E: un potrero no puede enumerar predio_id de OTRA organización (rechazado por integridad referencial, 23503)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      await assert.rejects(
        () => insertPotrero(client, { organizacionId: orgB, predioId: predioIdA }),
        (error) => error.code === '23503',
      );
    });
  });

  // -----------------------------------------------------------------
  // F/G/H: RLS.
  // -----------------------------------------------------------------
  test('F/G: RLS ENABLE y FORCE están activos', async () => {
    const result = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potreros'::regclass`,
    );
    assert.equal(result.rows[0].relrowsecurity, true);
    assert.equal(result.rows[0].relforcerowsecurity, true);
  });

  test('H: la policy tenant usa app.current_org_id', async () => {
    const result = await adminPool.query(
      `select qual, with_check from pg_policies
       where schemaname = 'agx' and tablename = 'potreros' and policyname = 'potreros_tenant_isolation'`,
    );
    assert.equal(result.rows.length, 1);
    assert.match(result.rows[0].qual, /current_org_id/);
    assert.match(result.rows[0].with_check, /current_org_id/);
  });

  // -----------------------------------------------------------------
  // I/J/K: aislamiento cross-tenant real (RLS).
  // -----------------------------------------------------------------
  test('I: cross-tenant SELECT bloqueado -- ORG B no ve potreros de ORG A', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    let potreroIdA;
    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      potreroIdA = await insertPotrero(client, { organizacionId: orgA, predioId: predioIdA });
    });

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select * from agx.potreros where predio_id = $1', [predioIdA]);
      assert.equal(result.rows.length, 0);
    });

    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      const result = await client.query('select * from agx.potreros where potrero_id = $1', [potreroIdA]);
      assert.equal(result.rows.length, 1);
    });
  });

  test('J: cross-tenant INSERT bloqueado -- sesión de ORG B no puede insertar una fila con organizacion_id=ORG A (policy WITH CHECK)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      await assert.rejects(
        () => insertPotrero(client, { organizacionId: orgA, predioId: predioIdA }),
        (error) => /row-level security/i.test(error.message),
      );
    });
  });

  test('K: mismo tenant permitido -- ORG A crea un potrero sobre su propio predio', async () => {
    const orgA = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      const potreroId = await insertPotrero(client, { organizacionId: orgA, predioId: predioIdA });
      assert.ok(potreroId);
    });
  });

  // -----------------------------------------------------------------
  // L/M/N: CHECK constraints.
  // -----------------------------------------------------------------
  test('L: metodo_delimitacion fuera del catálogo aprobado es rechazado', async () => {
    const orgA = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    await assert.rejects(
      () => insertPotrero(adminPool, { organizacionId: orgA, predioId: predioIdA, metodo: 'shp' }),
      (error) => error.code === '23514',
    );
  });

  test('L: cada valor aprobado de metodo_delimitacion es aceptado', async () => {
    const orgA = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    for (const metodo of ['coordenadas', 'gps_movil', 'kml', 'kmz']) {
      const potreroId = await insertPotrero(adminPool, { organizacionId: orgA, predioId: predioIdA, metodo });
      assert.ok(potreroId);
    }
  });

  test('M: area_ha <= 0 es rechazado', async () => {
    const orgA = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    await assert.rejects(
      () => insertPotrero(adminPool, { organizacionId: orgA, predioId: predioIdA, areaHa: 0 }),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      () => insertPotrero(adminPool, { organizacionId: orgA, predioId: predioIdA, areaHa: -1 }),
      (error) => error.code === '23514',
    );
  });

  test('N: capacidad_animales negativa es rechazada; null es aceptado', async () => {
    const orgA = randomOrgId();
    const predioIdA = await seedPredio(orgA);

    await assert.rejects(
      () => insertPotrero(adminPool, { organizacionId: orgA, predioId: predioIdA, capacidad: -1 }),
      (error) => error.code === '23514',
    );

    const potreroId = await insertPotrero(adminPool, { organizacionId: orgA, predioId: predioIdA, capacidad: null });
    assert.ok(potreroId);
  });

  // -----------------------------------------------------------------
  // O/P: índices.
  // -----------------------------------------------------------------
  test('O/P: índices esperados existen, incluido GiST sobre geometry', async () => {
    const result = await adminPool.query(
      `select indexname, indexdef from pg_indexes where schemaname = 'agx' and tablename = 'potreros'`,
    );
    const byName = Object.fromEntries(result.rows.map((r) => [r.indexname, r.indexdef]));

    assert.ok(byName.potreros_organizacion_id_idx);
    assert.ok(byName.potreros_predio_id_idx);
    assert.ok(byName.potreros_organizacion_predio_idx, 'índice compuesto (organizacion_id, predio_id) para /predios/:predioId/potreros');
    assert.ok(byName.potreros_geometry_gix);
    assert.match(byName.potreros_geometry_gix, /USING gist/i);
  });

  // -----------------------------------------------------------------
  // Q/R: grants.
  // -----------------------------------------------------------------
  // SPRINT-3D9.2: DELETE fue revocado explícitamente (0010) -- el hard
  // DELETE nunca tuvo un endpoint que lo usara, y quedó reemplazado por
  // el archivado reversible (ARCHIVE_ONLY, ver potreroArchivoRepository.js).
  test('Q: grants mínimos de agx_app -- SELECT/INSERT/UPDATE, NUNCA DELETE (revocado en 3D9.2)', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
       where table_schema = 'agx' and table_name = 'potreros' and grantee = 'agx_app'
       order by privilege_type`,
    );
    const privileges = result.rows.map((r) => r.privilege_type).sort();
    assert.deepEqual(privileges, ['INSERT', 'SELECT', 'UPDATE']);
  });

  test('R: agx_app puede usar la sequence del bigserial', async () => {
    const result = await adminPool.query(
      `select
         has_sequence_privilege('agx_app', 'agx.potreros_potrero_id_seq', 'USAGE') as usage_ok,
         has_sequence_privilege('agx_app', 'agx.potreros_potrero_id_seq', 'SELECT') as select_ok`,
    );
    assert.equal(result.rows[0].usage_ok, true);
    assert.equal(result.rows[0].select_ok, true);
  });
});
