// SPRINT-3D6-FICHA-PRODUCTIVA: pruebas de la fundación tenant-safe de
// agx.potrero_fichas_productivas / agx.potrero_ficha_pasturas /
// agx.catalogo_pasturas (db/agx-business/migrations/0004_potrero_ficha_productiva.sql)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// potrerosSchemaIntegration.test.js (0003).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST -- nunca la variable
// de producción/runtime real. Ver db/agx-business/migrations/README.md.
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_fichas_productivas') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  businessDb = await import('../../db/agxBusinessPool.js');
}

function randomOrgId() {
  return crypto.randomUUID();
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

async function seedPredio(orgId, nombre) {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, nombre],
  );
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, nombre, areaHa = 1) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), $5, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT, areaHa],
  );
  return result.rows[0].potrero_id;
}

describe('SPRINT-3D6: legacy y sprints previos quedan intactos (sin DB)', () => {
  test('la migración 0004 es aditiva pura -- sin DROP/TRUNCATE, no toca 0001/0002/0003', () => {
    const migrationPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0004_potrero_ficha_productiva.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\s+if\s+exists\s+agx\.(?!catalogo_pasturas|potrero_fichas_productivas|potrero_ficha_pasturas)/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.predios\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potreros\b(?!\s+owner)/i);
    assert.doesNotMatch(sql, /catastrox/i);
  });

  test('server/services/ganaderia/potreroFichaProductivaRepository.js solo usa agxBusinessPool', () => {
    const repoPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'potreroFichaProductivaRepository.js');
    const content = fs.readFileSync(repoPath, 'utf8');
    assert.match(content, /agxBusinessPool\.js/);
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });
});

describe('SPRINT-3D6: esquema real -- catálogo, ficha e historial', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    // Orden hijo-primero: potrero_ficha_pasturas referencia tanto fichas
    // como catálogo -- debe vaciarse antes de poder borrar cualquiera de
    // las dos tablas padre (FK compuesta / FK simple, ver 0004).
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (
         select ficha_id from agx.potrero_fichas_productivas
          where nombre_principal like 'Ficha Sprint3D6S%' or nombre_principal = 'X'
            or potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D6S%')
       )
          or pastura_id in (select pastura_id from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D6S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where nombre_principal like 'Ficha Sprint3D6S%' or nombre_principal = 'X'
          or potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D6S%')
    `);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D6S%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D6S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D6S%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('catálogo de sistema sembrado con al menos las especies base del sprint', async () => {
    const result = await adminPool.query(
      `select nombre_comun from agx.catalogo_pasturas where alcance = 'sistema'`,
    );
    const nombres = result.rows.map((r) => r.nombre_comun);
    assert.ok(nombres.some((n) => n.includes('Brachiaria brizantha')));
    assert.ok(nombres.some((n) => n.includes('Maní forrajero')));
    assert.ok(nombres.some((n) => n.includes('Leucaena')));
  });

  test('RLS ENABLE/FORCE activo en las 3 tablas nuevas', async () => {
    const result = await adminPool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in ('catalogo_pasturas', 'potrero_fichas_productivas', 'potrero_ficha_pasturas')
         and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 3);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} debe tener RLS ENABLE`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} debe tener RLS FORCE`);
    }
  });

  test('catálogo personalizado de ORG A es invisible para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    await adminPool.query(
      `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
       values ($1, 'Pastura Sprint3D6S Personalizada A', 'graminea', 'personalizado')`,
      [orgA],
    );

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query(
        `select * from agx.catalogo_pasturas where nombre_comun = 'Pastura Sprint3D6S Personalizada A'`,
      );
      assert.equal(result.rows.length, 0);
    });

    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      const result = await client.query(
        `select * from agx.catalogo_pasturas where nombre_comun = 'Pastura Sprint3D6S Personalizada A'`,
      );
      assert.equal(result.rows.length, 1);
    });
  });

  test('agx_app no puede insertar una fila de catálogo de sistema (RLS with check bloquea organizacion_id NULL)', async () => {
    const org = randomOrgId();
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
           values (null, 'Pastura Sprint3D6S Sistema Falso', 'graminea', 'sistema')`,
        ),
        (error) => error.code === '23514' || /row-level security/i.test(error.message),
      );
    });
  });

  // -----------------------------------------------------------------
  // SPRINT-3D6-TENANT-INTEGRITY-HARDENING: invariante FÍSICO (no solo
  // RLS) de que una ficha de la organización A nunca puede enlazar una
  // pastura personalizada de la organización B, ni siquiera mediante un
  // INSERT directo como agx_app que conozca/adivine el pastura_id.
  // -----------------------------------------------------------------

  test('el rol validador y el trigger de invariante tenant existen (agx_ficha_pastura_validator NOLOGIN+BYPASSRLS, función SECURITY DEFINER)', async () => {
    const roleResult = await adminPool.query(
      `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         from pg_roles where rolname = 'agx_ficha_pastura_validator'`,
    );
    assert.equal(roleResult.rows.length, 1);
    const role = roleResult.rows[0];
    assert.equal(role.rolcanlogin, false, 'debe ser NOLOGIN');
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolcreatedb, false);
    assert.equal(role.rolcreaterole, false);
    assert.equal(role.rolreplication, false);
    assert.equal(role.rolbypassrls, true, 'debe tener BYPASSRLS');

    const triggerResult = await adminPool.query(
      `select tgname from pg_trigger
        where tgrelid = 'agx.potrero_ficha_pasturas'::regclass
          and tgname = 'potrero_ficha_pasturas_tenant_scope_trigger'`,
    );
    assert.equal(triggerResult.rows.length, 1);

    const funcResult = await adminPool.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
         from pg_proc p
        where p.proname = 'enforce_ficha_pastura_tenant_scope'`,
    );
    assert.equal(funcResult.rows.length, 1);
    assert.equal(funcResult.rows[0].prosecdef, true, 'debe ser SECURITY DEFINER');
    assert.equal(funcResult.rows[0].owner, 'agx_ficha_pastura_validator');
    // §2 del hardening: search_path explícito y seguro -- pg_catalog
    // primero (protege operadores/tipos builtin de ser interceptados),
    // pg_temp EXPLÍCITO al final (anula el "pg_temp siempre primero" por
    // defecto de Postgres para el esquema temporal del rol invocador).
    assert.deepEqual(funcResult.rows[0].proconfig, ['search_path=pg_catalog, agx, pg_temp']);
  });

  test('agx_owner NUNCA recibe BYPASSRLS -- el invariante se acota al rol validador dedicado, no se debilita la defensa en profundidad existente', async () => {
    const result = await adminPool.query(
      `select rolname, rolbypassrls from pg_roles where rolname in ('agx_owner', 'agx_app')`,
    );
    assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      assert.equal(row.rolbypassrls, false, `${row.rolname} nunca debe tener BYPASSRLS`);
    }
  });

  test('§4: el validador tiene EXCLUSIVAMENTE SELECT sobre agx.catalogo_pasturas -- nada de INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, ni grants sobre otras tablas', async () => {
    const onCatalogo = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'catalogo_pasturas' and grantee = 'agx_ficha_pastura_validator'`,
    );
    assert.deepEqual(onCatalogo.rows.map((r) => r.privilege_type), ['SELECT']);

    const onAnythingElse = await adminPool.query(
      `select table_schema, table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'agx_ficha_pastura_validator' and table_name <> 'catalogo_pasturas'`,
    );
    assert.deepEqual(onAnythingElse.rows, []);
  });

  test('§6: PUBLIC no tiene EXECUTE sobre la función SECURITY DEFINER -- revocado explícitamente, el trigger sigue disparando sin ese privilegio', async () => {
    const result = await adminPool.query(
      `select has_function_privilege('public', 'agx.enforce_ficha_pastura_tenant_scope()', 'EXECUTE') as public_can_execute`,
    );
    assert.equal(result.rows[0].public_can_execute, false);
  });

  test('§5: agx_ficha_pastura_validator no pertenece a ningún rol privilegiado y nadie pertenece a él -- sin membership que permita escalar a BYPASSRLS', async () => {
    const result = await adminPool.query(
      `select r.rolname as miembro, m.rolname as es_miembro_de
         from pg_auth_members am
         join pg_roles r on r.oid = am.member
         join pg_roles m on m.oid = am.roleid
        where r.rolname = 'agx_ficha_pastura_validator' or m.rolname = 'agx_ficha_pastura_validator'`,
    );
    assert.deepEqual(result.rows, []);
  });

  test('§5.E: agx_app NO puede SET ROLE agx_ficha_pastura_validator -- ninguna cadena de membership permite escalar en runtime', async () => {
    const org = randomOrgId();
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('set role agx_ficha_pastura_validator'),
        (error) => /permission denied to set role/i.test(error.message),
      );
    });
  });

  test('INSERT directo como agx_app (sesión tenant A) enlazando una pastura personalizada de la organización B -> RECHAZADO por el trigger (no solo por RLS de lectura)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D6S HARDEN-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D6S HARDEN-A');

    let fichaA;
    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      const result = await client.query(
        `insert into agx.potrero_fichas_productivas
           (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Ficha Sprint3D6S HARDEN-A', 500, 10) returning ficha_id`,
        [orgA, potreroA],
      );
      fichaA = result.rows[0].ficha_id;
    });

    let pasturaB;
    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query(
        `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
         values ($1, 'Pastura Sprint3D6S HARDEN-B', 'graminea', 'personalizado') returning pastura_id`,
        [orgB],
      );
      pasturaB = result.rows[0].pastura_id;
    });

    // El intento normal (repository/API real) ya se cubre en
    // potreroFichaProductivaRepositoryIntegration.test.js
    // ("pastura personalizada de OTRA organización -> ESPECIE_NOT_FOUND").
    // Este test cubre el camino que ESE test NO puede probar por sí solo:
    // un INSERT directo como agx_app que se salta por completo la
    // resolución de especies del repositorio (§6.B del hardening).
    // Transacción separada para el INSERT rechazado -- un statement que
    // falla dentro de una transacción Postgres la deja abortada (25P02)
    // hasta el ROLLBACK; reutilizar el mismo client para la verificación
    // posterior fallaría con "current transaction is aborted", no con la
    // ausencia de fila que se quiere comprobar (mismo criterio que el
    // test de CHECK aforo_promedio_g_m2 más arriba).
    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, orden)
           values ($1, $2, $3, 0)`,
          [orgA, fichaA, pasturaB],
        ),
        (error) => /no existe o no pertenece a tu organización/i.test(error.message),
      );
    });

    // Nunca debe quedar una fila huérfana -- el rechazo es total.
    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      const check = await client.query('select count(*) from agx.potrero_ficha_pasturas where ficha_id = $1', [fichaA]);
      assert.equal(Number(check.rows[0].count), 0);
    });
  });

  test('INSERT directo como agx_app enlazando una pastura personalizada de la MISMA organización -> permitido', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6S HARDEN-SAME');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6S HARDEN-SAME');

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      const ficha = await client.query(
        `insert into agx.potrero_fichas_productivas
           (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
         values ($1, $2, 'otra', 'Ficha Sprint3D6S HARDEN-SAME', 500, 10) returning ficha_id`,
        [org, potreroId],
      );
      const pastura = await client.query(
        `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
         values ($1, 'Pastura Sprint3D6S HARDEN-SAME', 'graminea', 'personalizado') returning pastura_id`,
        [org],
      );

      const insert = await client.query(
        `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, orden)
         values ($1, $2, $3, 0) returning ficha_pastura_id`,
        [org, ficha.rows[0].ficha_id, pastura.rows[0].pastura_id],
      );
      assert.ok(insert.rows[0].ficha_pastura_id);
    });
  });

  test('una pastura de SISTEMA puede usarse correctamente por fichas de dos organizaciones distintas, sin debilitar el bloqueo entre personalizados', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D6S HARDEN-SYS-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D6S HARDEN-SYS-A');
    const predioB = await seedPredio(orgB, 'Predio Sprint3D6S HARDEN-SYS-B');
    const potreroB = await seedPotrero(orgB, predioB, 'Potrero Sprint3D6S HARDEN-SYS-B');

    const pasturaSistema = await adminPool.query(
      `insert into agx.catalogo_pasturas (nombre_comun, tipo, alcance) values ('Pastura Sprint3D6S HARDEN-SYS', 'graminea', 'sistema') returning pastura_id`,
    );
    const pasturaId = pasturaSistema.rows[0].pastura_id;

    for (const [org, potreroId] of [[orgA, potreroA], [orgB, potreroB]]) {
      await businessDb.withOrganizacionTransaction(org, async (client) => {
        const ficha = await client.query(
          `insert into agx.potrero_fichas_productivas
             (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
           values ($1, $2, 'pastura', 'Ficha Sprint3D6S HARDEN-SYS', 500, 10) returning ficha_id`,
          [org, potreroId],
        );
        const insert = await client.query(
          `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, orden)
           values ($1, $2, $3, 0) returning ficha_pastura_id`,
          [org, ficha.rows[0].ficha_id, pasturaId],
        );
        assert.ok(insert.rows[0].ficha_pastura_id);
      });
    }
  });

  test('FK compuesta (potrero_id, organizacion_id) de fichas contra agx.potreros -- otra organización rechazada por integridad referencial', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D6S FK-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D6S FK-A');

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_fichas_productivas
             (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
           values ($1, $2, 'pastura', 'X', 500, 10)`,
          [orgB, potreroA],
        ),
        (error) => error.code === '23503',
      );
    });
  });

  test('CHECK aforo_promedio_g_m2: rechaza <=0 y > 10000', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6S CHECK-AFORO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6S CHECK-AFORO');

    // Dos transacciones separadas: un INSERT rechazado deja la
    // transacción abortada (Postgres) hasta el ROLLBACK implícito de
    // withOrganizacionTransaction -- reutilizar el mismo client para un
    // segundo INSERT en la misma transacción fallaría con "current
    // transaction is aborted", no con el 23514 que se quiere observar.
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_fichas_productivas
             (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
           values ($1, $2, 'pastura', 'X', 0, 0)`,
          [org, potreroId],
        ),
        (error) => error.code === '23514',
      );
    });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_fichas_productivas
             (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
           values ($1, $2, 'pastura', 'X', 10001, 0)`,
          [org, potreroId],
        ),
        (error) => error.code === '23514',
      );
    });
  });

  test('sin UNIQUE(potrero_id) -- se pueden insertar varias fichas históricas para el mismo potrero', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6S HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6S HIST');

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await client.query(
        `insert into agx.potrero_fichas_productivas
           (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Ficha Sprint3D6S Uno', 500, 10)`,
        [org, potreroId],
      );
      await client.query(
        `insert into agx.potrero_fichas_productivas
           (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Ficha Sprint3D6S Dos', 600, 12)`,
        [org, potreroId],
      );
      const result = await client.query('select count(*) from agx.potrero_fichas_productivas where potrero_id = $1', [potreroId]);
      assert.equal(Number(result.rows[0].count), 2);
    });
  });
});
