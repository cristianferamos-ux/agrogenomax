// SPRINT-3D10.7 -- pruebas de la migración aditiva
// 0021_predio_client_operation_id.sql contra un Postgres/PostGIS REAL.
// Mismo patrón que potreroRecomendacionCargaAutomaticaSchemaIntegration.test.js
// (0020).
//
// Cubre: columna uuid nullable sin default, índice UNIQUE parcial
// tenant-scoped, RLS ENABLE/FORCE y política intactas, grants de agx_app
// sobre la columna, y rollback -> re-forward de 0021 (dentro de una
// transacción que se revierte al final, para no interferir con suites
// que corren en paralelo sobre la misma DB).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST. Ver
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
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migrationsDir = path.join(repoRoot, 'db', 'agx-business', 'migrations');
const forwardSql = fs.readFileSync(path.join(migrationsDir, '0021_predio_client_operation_id.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(migrationsDir, '0021_predio_client_operation_id_rollback.sql'), 'utf8');

const INDEX_NAME = 'predios_org_client_operation_id_key';

let dbAvailable = false;
let adminPool;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  await adminPool.query('select 1');

  const columnCheck = await adminPool.query(
    `select column_name from information_schema.columns
      where table_schema = 'agx' and table_name = 'predios' and column_name = 'client_operation_id'`,
  );
  dbAvailable = columnCheck.rows.length > 0;
} catch {
  dbAvailable = false;
}

async function columnInfo(db) {
  const result = await db.query(
    `select data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'agx' and table_name = 'predios' and column_name = 'client_operation_id'`,
  );
  return result.rows[0] || null;
}

async function indexInfo(db) {
  const result = await db.query(
    `select i.indexdef, x.indisunique, x.indisvalid
       from pg_indexes i
       join pg_index x on x.indexrelid = format('%I.%I', i.schemaname, i.indexname)::regclass
      where i.schemaname = 'agx' and i.indexname = $1`,
    [INDEX_NAME],
  );
  return result.rows[0] || null;
}

describe('SPRINT-3D10.7: la migración 0021 es aditiva pura (sin DB)', () => {
  test('0021 no hace backfill/UPDATE/DROP/TRUNCATE ni toca RLS, políticas, grants, estado, geometría, codigo_predial o CatastroX', () => {
    // Sin comentarios SQL ni literales (el texto del COMMENT menciona
    // CatastroX a propósito).
    const code = forwardSql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
    assert.doesNotMatch(code, /\bupdate\b/i);
    assert.doesNotMatch(code, /\bdrop\b/i);
    assert.doesNotMatch(code, /\btruncate\b/i);
    assert.doesNotMatch(code, /\bdelete\b/i);
    assert.doesNotMatch(code, /\bdefault\b/i);
    assert.doesNotMatch(code, /\bset not null\b|\buuid not null\b/i);
    assert.doesNotMatch(code, /row level security|\bpolicy\b|\bgrant\b|\brevoke\b|\bowner\b/i);
    assert.doesNotMatch(code, /\bestado\b|\bgeometry\b|\bcodigo_predial\b|snapshots_catastrales|catastrox/i);
    assert.match(code, /alter table agx\.predios\s+add column if not exists client_operation_id uuid;/i);
    assert.match(
      code,
      /create unique index if not exists predios_org_client_operation_id_key\s+on agx\.predios \(organizacion_id, client_operation_id\)\s+where client_operation_id is not null;/i,
    );
    assert.match(code, /comment on column agx\.predios\.client_operation_id is/i);
  });

  test('el rollback de 0021 es un DROP directo del índice y la columna, sin dependencia de datos', () => {
    const code = rollbackSql.replace(/--.*$/gm, '');
    assert.match(code, /drop index if exists agx\.predios_org_client_operation_id_key;/i);
    assert.match(code, /alter table agx\.predios\s+drop column if exists client_operation_id;/i);
    assert.doesNotMatch(code, /\bupdate\b|\bdelete\b|\btruncate\b|drop table|\bpolicy\b|\bgrant\b/i);
  });
});

describe('SPRINT-3D10.7: esquema real -- client_operation_id de 0021', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.predios where nombre_predio = 'Predio Sprint3D107S Test'`);
    await adminPool.end();
  });

  test('columna uuid, nullable, sin DEFAULT', async () => {
    assert.deepEqual(await columnInfo(adminPool), { data_type: 'uuid', is_nullable: 'YES', column_default: null });
  });

  test('índice UNIQUE parcial (organizacion_id, client_operation_id) WHERE client_operation_id IS NOT NULL, válido', async () => {
    const info = await indexInfo(adminPool);
    assert.ok(info, 'el índice debe existir');
    assert.equal(info.indisunique, true);
    assert.equal(info.indisvalid, true);
    assert.equal(
      info.indexdef,
      'CREATE UNIQUE INDEX predios_org_client_operation_id_key ON agx.predios USING btree (organizacion_id, client_operation_id) WHERE (client_operation_id IS NOT NULL)',
    );
  });

  test('RLS ENABLE + FORCE intactos, owner agx_owner, única política predios_tenant_isolation intacta', async () => {
    const rel = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as owner
         from pg_class where oid = 'agx.predios'::regclass`,
    );
    assert.deepEqual(rel.rows[0], { relrowsecurity: true, relforcerowsecurity: true, owner: 'agx_owner' });

    const policies = await adminPool.query(
      `select policyname, cmd, qual, with_check from pg_policies where schemaname = 'agx' and tablename = 'predios'`,
    );
    assert.equal(policies.rows.length, 1);
    const [policy] = policies.rows;
    assert.equal(policy.policyname, 'predios_tenant_isolation');
    assert.equal(policy.cmd, 'ALL');
    for (const expr of [policy.qual, policy.with_check]) {
      assert.match(expr, /organizacion_id = \(NULLIF\(current_setting\('app\.current_org_id'::text, true\), ''::text\)\)::uuid/);
    }
  });

  test('agx_app puede SELECT/INSERT la columna (grants de tabla) y sigue sin DELETE', async () => {
    const result = await adminPool.query(
      `select has_column_privilege('agx_app', 'agx.predios', 'client_operation_id', 'SELECT') as sel,
              has_column_privilege('agx_app', 'agx.predios', 'client_operation_id', 'INSERT') as ins,
              has_table_privilege('agx_app', 'agx.predios', 'DELETE') as del`,
    );
    assert.deepEqual(result.rows[0], { sel: true, ins: true, del: false });
  });

  test('filas sin client_operation_id (histórico/CatastroX/legacy) quedan NULL y fuera del índice: varias por organización', async () => {
    const orgId = crypto.randomUUID();
    await adminPool.query(
      `insert into agx.predios (organizacion_id, nombre_predio) values ($1, 'Predio Sprint3D107S Test'), ($1, 'Predio Sprint3D107S Test')`,
      [orgId],
    );
    const result = await adminPool.query(
      `select count(*)::int as total, count(client_operation_id)::int as con_operacion
         from agx.predios where organizacion_id = $1`,
      [orgId],
    );
    assert.deepEqual(result.rows[0], { total: 2, con_operacion: 0 });
  });

  test('misma organización + mismo client_operation_id -> 23505; otra organización con el mismo UUID -> permitido', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const insert = (orgId) => adminPool.query(
      `insert into agx.predios (organizacion_id, nombre_predio, client_operation_id) values ($1, 'Predio Sprint3D107S Test', $2)`,
      [orgId, operationId],
    );
    await insert(orgA);
    await assert.rejects(insert(orgA), (error) => error.code === '23505' && error.constraint === INDEX_NAME);
    await insert(orgB);
  });

  test('rollback -> columna/índice eliminados; re-forward -> todo restaurado (transacción revertida al final)', async () => {
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');

      await client.query(rollbackSql);
      assert.equal(await columnInfo(client), null);
      assert.equal(await indexInfo(client), null);

      await client.query(forwardSql);
      assert.deepEqual(await columnInfo(client), { data_type: 'uuid', is_nullable: 'YES', column_default: null });
      const info = await indexInfo(client);
      assert.equal(info.indisunique, true);
      assert.equal(info.indisvalid, true);
      assert.match(info.indexdef, /\(organizacion_id, client_operation_id\) WHERE \(client_operation_id IS NOT NULL\)$/);

      // Reaplicar forward es idempotente (IF NOT EXISTS).
      await client.query(forwardSql);

      const rel = await client.query(
        `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.predios'::regclass`,
      );
      assert.deepEqual(rel.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    assert.deepEqual(await columnInfo(adminPool), { data_type: 'uuid', is_nullable: 'YES', column_default: null });
  });
});
