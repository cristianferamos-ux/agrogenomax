// SPRINT-3D11.2 -- pruebas de la migración 0022_animales_foundation.sql
// contra un Postgres/PostGIS REAL: RLS ENABLE+FORCE, aislamiento entre
// organizaciones, FK compuestas tenant-safe, grants (sin DELETE, columnas
// inmutables, pesajes/eventos append-only, catálogo de solo lectura) y los
// CHECK de consistencia (nacimiento, raza con raza_otro_nombre, estado,
// hash de intención).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL (siembra). Se auto-omite si no
// están configuradas o si 0022 no está aplicada. Ver
// db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '..', '..', '..', 'db', 'agx-business', 'migrations');
const forwardSql = fs.readFileSync(path.join(migrationsDir, '0022_animales_foundation.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(migrationsDir, '0022_animales_foundation_rollback.sql'), 'utf8');

let dbAvailable = false;
let adminPool;
let appPool;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }
  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  appPool = new pg.Pool({ connectionString: testConnectionString, max: 4 });
  const check = await adminPool.query("select to_regclass('agx.animales') as t");
  dbAvailable = Boolean(check.rows[0]?.t);
} catch {
  dbAvailable = false;
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
});

const VALID_HASH = `v1:${'a'.repeat(64)}`;
const SEED_RAZAS = Object.freeze([
  'brahman', 'nelore', 'angus', 'brangus', 'senepol', 'romosinuano',
  'gyr', 'holstein', 'jersey', 'girolando',
  'guzera', 'simmental', 'normando', 'pardo_suizo', 'blanco_orejinegro',
]);

function randomOrgId() {
  return crypto.randomUUID();
}

async function seedPredio(orgId) {
  const result = await adminPool.query(
    "insert into agx.predios (organizacion_id, nombre_predio) values ($1, 'Predio 3D11.2 schema') returning predio_id",
    [orgId],
  );
  return String(result.rows[0].predio_id);
}

async function seedAnimal(orgId, predioId, overrides = {}) {
  const row = {
    numero_visual: `N-${crypto.randomUUID().slice(0, 8)}`,
    nombre: null,
    sexo: 'HEMBRA',
    raza_tipo: 'DESCONOCIDA',
    estado: 'ACTIVO',
    ...overrides,
  };
  const result = await adminPool.query(
    `insert into agx.animales (organizacion_id, predio_id, numero_visual, nombre, sexo, raza_tipo, estado,
                               estado_at, estado_por, estado_motivo, client_operation_id, creation_intent_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning animal_id`,
    [
      orgId, predioId, row.numero_visual, row.nombre, row.sexo, row.raza_tipo, row.estado,
      row.estado === 'ANULADO' ? new Date() : null,
      row.estado === 'ANULADO' ? crypto.randomUUID() : null,
      row.estado === 'ANULADO' ? 'motivo de prueba' : null,
      crypto.randomUUID(), VALID_HASH,
    ],
  );
  return String(result.rows[0].animal_id);
}

/** Ejecuta `fn` como agx_app con app.current_org_id fijado, y revierte. */
async function asApp(orgId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

async function expectPgError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    return true;
  });
}

/** Inserta como admin dentro de una transacción revertida (prueba de CHECK). */
async function adminInsertAnimalExpecting(code, columns) {
  const client = await adminPool.connect();
  try {
    await client.query('begin');
    const orgId = randomOrgId();
    const predio = await client.query(
      "insert into agx.predios (organizacion_id, nombre_predio) values ($1, 'Predio check') returning predio_id",
      [orgId],
    );
    const base = {
      organizacion_id: orgId,
      predio_id: predio.rows[0].predio_id,
      numero_visual: 'CHK-1',
      sexo: 'MACHO',
      client_operation_id: crypto.randomUUID(),
      creation_intent_hash: VALID_HASH,
      ...columns,
    };
    const keys = Object.keys(base);
    const insert = client.query(
      `insert into agx.animales (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((key) => base[key]),
    );
    if (code) await expectPgError(insert, code);
    else await insert;
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

describe('SPRINT-3D11.2: 0022 es aditiva y su rollback es exacto (sin DB)', () => {
  test('0022 no altera ni elimina tablas existentes (solo crea + referencia)', () => {
    // Literales primero (los COMMENT contienen '--'), luego comentarios.
    const code = forwardSql.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/gm, '');
    assert.doesNotMatch(code, /\bdrop\b/i);
    assert.doesNotMatch(code, /\btruncate\b/i);
    assert.doesNotMatch(code, /\bdelete\b\s+from/i);
    assert.doesNotMatch(code, /\bupdate\s+agx\./i);
    const altered = [...code.matchAll(/alter table (agx\.[a-z_]+)/gi)].map((m) => m[1]);
    for (const table of altered) {
      assert.ok(
        ['agx.catalogo_razas', 'agx.animales', 'agx.animal_pesajes', 'agx.animal_eventos'].includes(table),
        `0022 no debe alterar ${table}`,
      );
    }
    const created = [...code.matchAll(/create table (agx\.[a-z_]+)/gi)].map((m) => m[1]);
    assert.deepEqual(created, ['agx.catalogo_razas', 'agx.animales', 'agx.animal_pesajes', 'agx.animal_eventos']);
  });

  test('rollback elimina exactamente las 4 tablas en orden inverso de dependencias', () => {
    const drops = [...rollbackSql.replace(/--.*$/gm, '').matchAll(/drop table if exists (agx\.[a-z_]+)/gi)].map((m) => m[1]);
    assert.deepEqual(drops, ['agx.animal_eventos', 'agx.animal_pesajes', 'agx.animales', 'agx.catalogo_razas']);
  });

  test('el seed no contiene razas ficticias (OTRA/NO_DEFINIDA/CEBU_COMERCIAL)', () => {
    assert.doesNotMatch(forwardSql, /'(otra|no_definida|cebu_comercial)'/i);
  });
});

describe('SPRINT-3D11.2: 0022 contra Postgres real', { skip: !dbAvailable }, () => {
  test('RLS ENABLE + FORCE en las 4 tablas y políticas presentes', async () => {
    const result = await adminPool.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::int from pg_policies p where p.schemaname = 'agx' and p.tablename = c.relname) as policies
         from pg_class c
        where c.relnamespace = 'agx'::regnamespace
          and c.relname in ('catalogo_razas', 'animales', 'animal_pesajes', 'animal_eventos')
        order by c.relname`,
    );
    assert.equal(result.rows.length, 4);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} FORCE`);
      assert.equal(row.policies, 1, `${row.relname} política`);
    }
  });

  test('catálogo: 15 razas de sistema legibles por agx_app; INSERT/UPDATE/DELETE rechazados (42501)', async () => {
    const orgId = randomOrgId();
    await asApp(orgId, async (client) => {
      // El seed exacto de 0022 (otras suites pueden agregar filas de prueba
      // como superusuario a esta DB desechable, nunca agx_app).
      const rows = (await client.query(
        'select codigo from agx.catalogo_razas where organizacion_id is null and activo = true and codigo = any($1)',
        [SEED_RAZAS],
      )).rows.map((r) => r.codigo);
      assert.deepEqual(rows.sort(), [...SEED_RAZAS].sort());
      const ficticias = await client.query(
        "select 1 from agx.catalogo_razas where codigo in ('otra', 'no_definida', 'cebu_comercial')",
      );
      assert.equal(ficticias.rows.length, 0);
    });
    await asApp(orgId, (client) => expectPgError(
      client.query("insert into agx.catalogo_razas (codigo, nombre, tipo_productivo) values ('x', 'X', 'carne')"), '42501',
    ));
    await asApp(orgId, (client) => expectPgError(client.query("update agx.catalogo_razas set nombre = 'X'"), '42501'));
    await asApp(orgId, (client) => expectPgError(client.query('delete from agx.catalogo_razas'), '42501'));
  });

  test('aislamiento: otra organización no ve animales, pesajes ni eventos ajenos', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA);
    const animalA = await seedAnimal(orgA, predioA);
    await asApp(orgB, async (client) => {
      assert.equal((await client.query('select 1 from agx.animales where animal_id = $1', [animalA])).rows.length, 0);
    });
    await asApp(orgA, async (client) => {
      assert.equal((await client.query('select 1 from agx.animales where animal_id = $1', [animalA])).rows.length, 1);
    });
  });

  test('FK compuesta: un animal de la org B no puede apuntar a un predio de la org A (23503)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA);
    await asApp(orgB, (client) => expectPgError(
      client.query(
        `insert into agx.animales (organizacion_id, predio_id, numero_visual, sexo, client_operation_id, creation_intent_hash)
         values ($1, $2, 'X1', 'MACHO', $3, $4)`,
        [orgB, predioA, crypto.randomUUID(), VALID_HASH],
      ),
      '23503',
    ));
  });

  test('RLS WITH CHECK: agx_app no puede insertar un animal declarando otra organización', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA);
    await asApp(orgB, (client) => expectPgError(
      client.query(
        `insert into agx.animales (organizacion_id, predio_id, numero_visual, sexo, client_operation_id, creation_intent_hash)
         values ($1, $2, 'X2', 'MACHO', $3, $4)`,
        [orgA, predioA, crypto.randomUUID(), VALID_HASH],
      ),
      '42501',
    ));
  });

  test('FK compuesta en pesajes/eventos: no pueden referenciar un animal de otra organización (23503)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const animalA = await seedAnimal(orgA, await seedPredio(orgA));
    await asApp(orgB, (client) => expectPgError(
      client.query(
        `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id)
         values ($1, $2, current_date, 300, 'BASCULA', 'REGISTRO_INICIAL', $3)`,
        [orgB, animalA, crypto.randomUUID()],
      ),
      '23503',
    ));
    await asApp(orgB, (client) => expectPgError(
      client.query(
        `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, actor_cuenta_id)
         values ($1, $2, 'REGISTRADO', $3)`,
        [orgB, animalA, crypto.randomUUID()],
      ),
      '23503',
    ));
  });

  test('sin DELETE para agx_app en animales, pesajes y eventos (42501)', async () => {
    const orgA = randomOrgId();
    await seedAnimal(orgA, await seedPredio(orgA));
    for (const table of ['animales', 'animal_pesajes', 'animal_eventos']) {
      await asApp(orgA, (client) => expectPgError(client.query(`delete from agx.${table}`), '42501'));
    }
  });

  test('columnas inmutables: agx_app no puede actualizar organizacion_id, predio_id, client_operation_id, creation_intent_hash, created_at ni animal_id', async () => {
    const orgA = randomOrgId();
    const predioA = await seedPredio(orgA);
    const animalA = await seedAnimal(orgA, predioA);
    const attempts = [
      ['organizacion_id', randomOrgId()],
      ['predio_id', predioA],
      ['client_operation_id', crypto.randomUUID()],
      ['creation_intent_hash', `v1:${'b'.repeat(64)}`],
      ['created_at', new Date()],
      ['animal_id', '999999'],
    ];
    for (const [column, value] of attempts) {
      await asApp(orgA, (client) => expectPgError(
        client.query(`update agx.animales set ${column} = $1 where animal_id = $2`, [value, animalA]),
        '42501',
      ));
    }
  });

  test('columnas corregibles sí son actualizables por agx_app', async () => {
    const orgA = randomOrgId();
    const animalA = await seedAnimal(orgA, await seedPredio(orgA));
    await asApp(orgA, async (client) => {
      const result = await client.query(
        "update agx.animales set nombre = 'Lucero', updated_at = now() where animal_id = $1",
        [animalA],
      );
      assert.equal(result.rowCount, 1);
    });
  });

  test('pesajes y eventos son append-only: UPDATE rechazado (42501)', async () => {
    const orgA = randomOrgId();
    await seedAnimal(orgA, await seedPredio(orgA));
    await asApp(orgA, (client) => expectPgError(client.query('update agx.animal_pesajes set peso_kg = 1'), '42501'));
    await asApp(orgA, (client) => expectPgError(
      client.query("update agx.animal_eventos set metadata_json = '{}'::jsonb"), '42501',
    ));
  });

  test('raza PURA: exactamente uno de catálogo / raza_otro_nombre; sin descripción de cruce', async () => {
    const brahman = (await adminPool.query("select raza_id from agx.catalogo_razas where codigo = 'brahman'")).rows[0].raza_id;
    await adminInsertAnimalExpecting(null, { raza_tipo: 'PURA', raza_principal_id: brahman });
    await adminInsertAnimalExpecting(null, { raza_tipo: 'PURA', raza_otro_nombre: 'Charolais' });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'PURA', raza_principal_id: brahman, raza_otro_nombre: 'Charolais' });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'PURA' });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'PURA', raza_principal_id: brahman, cruce_descripcion: 'x' });
  });

  test('raza CRUCE: predominante y/o descripción; nunca raza_otro_nombre', async () => {
    const angus = (await adminPool.query("select raza_id from agx.catalogo_razas where codigo = 'angus'")).rows[0].raza_id;
    await adminInsertAnimalExpecting(null, { raza_tipo: 'CRUCE', raza_principal_id: angus, cruce_descripcion: 'Angus × Brahman' });
    await adminInsertAnimalExpecting(null, { raza_tipo: 'CRUCE', cruce_descripcion: 'Mestizo comercial' });
    await adminInsertAnimalExpecting(null, { raza_tipo: 'CRUCE', raza_principal_id: angus });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'CRUCE' });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'CRUCE', raza_otro_nombre: 'Charolais', cruce_descripcion: 'x' });
  });

  test('raza DESCONOCIDA: ningún dato de raza', async () => {
    const angus = (await adminPool.query("select raza_id from agx.catalogo_razas where codigo = 'angus'")).rows[0].raza_id;
    await adminInsertAnimalExpecting(null, { raza_tipo: 'DESCONOCIDA' });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'DESCONOCIDA', raza_principal_id: angus });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'DESCONOCIDA', raza_otro_nombre: 'Charolais' });
    await adminInsertAnimalExpecting('23514', { raza_tipo: 'DESCONOCIDA', cruce_descripcion: 'Mestizo' });
  });

  test('nacimiento: EXACTA / APROXIMADA / DESCONOCIDA mutuamente excluyentes', async () => {
    await adminInsertAnimalExpecting(null, { nacimiento_tipo: 'EXACTA', fecha_nacimiento: '2024-03-10' });
    await adminInsertAnimalExpecting(null, {
      nacimiento_tipo: 'APROXIMADA', edad_aproximada_meses: 18, edad_referencia_fecha: '2026-10-15',
    });
    await adminInsertAnimalExpecting('23514', { nacimiento_tipo: 'EXACTA' });
    await adminInsertAnimalExpecting('23514', { nacimiento_tipo: 'APROXIMADA', edad_aproximada_meses: 18 });
    await adminInsertAnimalExpecting('23514', {
      nacimiento_tipo: 'APROXIMADA', fecha_nacimiento: '2024-03-10', edad_aproximada_meses: 18, edad_referencia_fecha: '2026-10-15',
    });
    await adminInsertAnimalExpecting('23514', { nacimiento_tipo: 'DESCONOCIDA', fecha_nacimiento: '2024-03-10' });
  });

  test('identidad, sexo, estado y hash de intención', async () => {
    await adminInsertAnimalExpecting('23514', { numero_visual: null, nombre: null });
    await adminInsertAnimalExpecting('23514', { numero_visual: '  A-12' });
    await adminInsertAnimalExpecting('23514', { sexo: 'OTRO' });
    await adminInsertAnimalExpecting('23514', { estado: 'VENDIDO' });
    await adminInsertAnimalExpecting('23514', { estado: 'ANULADO' });
    await adminInsertAnimalExpecting('23514', { creation_intent_hash: 'sha256:abc' });
    await adminInsertAnimalExpecting('23514', { origen_tipo: 'NACIDO_EN_PREDIO', procedencia: 'Finca vecina' });
  });

  test('creation_intent_hash: solo v1:<64 hex minúsculas> (CHECK de la base)', async () => {
    const hex = 'a'.repeat(64);
    await adminInsertAnimalExpecting(null, { creation_intent_hash: `v1:${hex}` });
    await adminInsertAnimalExpecting(null, { creation_intent_hash: `v1:${'0123456789abcdef'.repeat(4)}` });
    const invalid = {
      'v2 prefix': `v2:${hex}`,
      'v10 prefix': `v10:${hex}`,
      'sin prefijo': hex,
      'V1 en mayúscula': `V1:${hex}`,
      '63 hex': `v1:${'a'.repeat(63)}`,
      '65 hex': `v1:${'a'.repeat(65)}`,
      'hex en mayúsculas': `v1:${'A'.repeat(64)}`,
      'no hexadecimal': `v1:${'g'.repeat(64)}`,
      vacío: '',
    };
    for (const value of Object.values(invalid)) {
      await adminInsertAnimalExpecting('23514', { creation_intent_hash: value });
    }
    await adminInsertAnimalExpecting('23502', { creation_intent_hash: null });
  });

  test('raza: matriz completa de permutaciones a nivel de base (3 tipos × catálogo/otro nombre/cruce)', async () => {
    const brahman = (await adminPool.query("select raza_id from agx.catalogo_razas where codigo = 'brahman'")).rows[0].raza_id;
    for (const razaTipo of ['PURA', 'CRUCE', 'DESCONOCIDA']) {
      for (const razaPrincipalId of [null, brahman]) {
        for (const razaOtroNombre of [null, 'Charolais']) {
          for (const cruceDescripcion of [null, 'Angus × Brahman']) {
            let valid;
            if (razaTipo === 'PURA') valid = (razaPrincipalId !== null) !== (razaOtroNombre !== null) && cruceDescripcion === null;
            if (razaTipo === 'CRUCE') valid = razaOtroNombre === null && (razaPrincipalId !== null || cruceDescripcion !== null);
            if (razaTipo === 'DESCONOCIDA') valid = razaPrincipalId === null && razaOtroNombre === null && cruceDescripcion === null;
            await adminInsertAnimalExpecting(valid ? null : '23514', {
              raza_tipo: razaTipo,
              raza_principal_id: razaPrincipalId,
              raza_otro_nombre: razaOtroNombre,
              cruce_descripcion: cruceDescripcion,
            });
          }
        }
      }
    }
  });

  test('eventos: inserciones concurrentes de REGISTRADO y de ANULADO -> exactamente una de cada una (23505 en el resto)', async () => {
    const concurrentPool = new pg.Pool({ connectionString: process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL, max: 6 });
    try {
      const orgA = randomOrgId();
      const animalA = await seedAnimal(orgA, await seedPredio(orgA));
      for (const tipo of ['REGISTRADO', 'ANULADO']) {
        const settled = await Promise.allSettled(Array.from({ length: 6 }, () => concurrentPool.query(
          'insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, actor_cuenta_id) values ($1, $2, $3, $4)',
          [orgA, animalA, tipo, crypto.randomUUID()],
        )));
        assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, `${tipo}: una sola inserción gana`);
        for (const rejected of settled.filter((s) => s.status === 'rejected')) {
          assert.equal(rejected.reason.code, '23505', tipo);
        }
      }
    } finally {
      await concurrentPool.end();
    }
  });

  test('número visual: único sin distinguir mayúsculas entre ACTIVO; reutilizable tras ANULADO', async () => {
    const orgA = randomOrgId();
    const predioA = await seedPredio(orgA);
    await seedAnimal(orgA, predioA, { numero_visual: 'AB-12', estado: 'ANULADO' });
    await seedAnimal(orgA, predioA, { numero_visual: 'ab-12' });
    await expectPgError(seedAnimal(orgA, predioA, { numero_visual: 'AB-12' }), '23505');
    // Otra organización puede usar el mismo número.
    const orgB = randomOrgId();
    await seedAnimal(orgB, await seedPredio(orgB), { numero_visual: 'AB-12' });
  });

  test('como máximo un pesaje REGISTRO_INICIAL, un evento REGISTRADO y un ANULADO por animal (23505)', async () => {
    const orgA = randomOrgId();
    const animalA = await seedAnimal(orgA, await seedPredio(orgA));
    const actor = crypto.randomUUID();
    const pesaje = `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id)
                    values ($1, $2, current_date, 280, 'ESTIMADO', 'REGISTRO_INICIAL', $3)`;
    await adminPool.query(pesaje, [orgA, animalA, actor]);
    await expectPgError(adminPool.query(pesaje, [orgA, animalA, actor]), '23505');
    for (const tipo of ['REGISTRADO', 'ANULADO']) {
      const evento = `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, actor_cuenta_id) values ($1, $2, '${tipo}', $3)`;
      await adminPool.query(evento, [orgA, animalA, actor]);
      await expectPgError(adminPool.query(evento, [orgA, animalA, actor]), '23505');
    }
  });

  test('peso: > 0, <= 2000 y como máximo un decimal; método BASCULA/ESTIMADO', async () => {
    const orgA = randomOrgId();
    const animalA = await seedAnimal(orgA, await seedPredio(orgA));
    const actor = crypto.randomUUID();
    for (const [peso, metodo] of [[0, 'BASCULA'], [2000.5, 'BASCULA'], [280.25, 'BASCULA'], [280, 'CINTA']]) {
      await expectPgError(
        adminPool.query(
          `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id)
           values ($1, $2, current_date, $3, $4, 'REGISTRO_INICIAL', $5)`,
          [orgA, animalA, peso, metodo, actor],
        ),
        '23514',
      );
    }
  });
});
