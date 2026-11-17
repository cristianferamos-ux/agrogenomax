// FASE 5A.1a -- integración REAL de 0028 (anulación auditada de pesajes) con
// el runner endurecido y las migraciones reales del repo. Se ejecuta con
// `npm run test:agx-migrations-integration` (cluster PostGIS 16 desechable
// PROPIO, AGX_MIG_0028_BUSINESS_ADMIN_URL solo loopback; no compartir con
// otra integración: los roles son globales del cluster). Sin la variable, se
// omite (y el runner la exige: requiredPasses).
//
// Base A: 0000-0027 + fixtures escritos por agx_app -> 0028 -> invariantes
//         (trigger, constraints, índice, RLS, grants) -> rollback bloqueado.
// Base B: 0000-0028 vacía -> rollback -> huella = 0027 -> reaplicación.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { main as migrate } from '../agx-migrate.mjs';
import { normalizeSql, sanitizedPgEnv, sha256 } from '../agx-migrate-lib.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUSINESS = process.env.AGX_MIG_0028_BUSINESS_ADMIN_URL;
const skip = !BUSINESS ? 'AGX_MIG_0028_BUSINESS_ADMIN_URL no configurada' : false;
if (BUSINESS && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BUSINESS).hostname)) {
  throw new Error('la integración de 0028 solo admite loopback');
}

const UP = '0028_animal_pesajes_anulacion.sql';
const UP_CHECKSUM = sha256(normalizeSql(fs.readFileSync(path.join(ROOT, 'db/agx-business/migrations', UP), 'utf8')));
const ROLLBACK_SQL = normalizeSql(fs.readFileSync(path.join(ROOT, 'db/agx-business/migrations/0028_animal_pesajes_anulacion_rollback.sql'), 'utf8'));

const secrets = {
  AGX_0028_APP_PW: crypto.randomBytes(16).toString('hex'),
  AGX_0028_QR_PW: crypto.randomBytes(16).toString('hex'),
};
const VARS = ['--var', 'agx_app_password=AGX_0028_APP_PW', '--var', 'agx_qr_admin_password=AGX_0028_QR_PW'];
const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();
const ACTOR = crypto.randomUUID();
const ANULADOR = crypto.randomUUID();
const ANULACION_COLS = ['anulacion_client_operation_id', 'anulado_at', 'anulado_por', 'estado_registro', 'motivo_anulacion'];

function dbUrl(admin, db, user = null, password = null) {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = password; }
  return u.toString();
}

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const q = (url, sql, params) => withClient(url, (c) => c.query(sql, params));

async function createDb(prefix) {
  const name = `${prefix}_${crypto.randomBytes(3).toString('hex')}_test`;
  await q(BUSINESS, `create database ${name}`);
  return name;
}

async function run(args, url) {
  const env = { ...process.env, ...secrets, AGX_0028_URL: url };
  const logs = [];
  await migrate([...args, '--target', 'business', '--url-env', 'AGX_0028_URL'], { env, log: (l) => logs.push(l) });
  return logs;
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

/** Error de Postgres esperado: SQLSTATE y (opcional) texto/constraint. */
async function pgRejects(promise, sqlstate, { message, constraint } = {}) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, sqlstate, error.message);
    if (message) assert.match(error.message, message);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

function fingerprint(url) {
  const u = new URL(url);
  const res = spawnSync(process.env.PSQL_BIN || 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'schemas=agx', '-f', path.join(ROOT, 'db/verify/schema_fingerprint.sql')], {
    encoding: 'utf8',
    env: sanitizedPgEnv(process.env, { PGHOST: u.hostname, PGPORT: u.port, PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGCLIENTENCODING: 'UTF8' }),
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.replace(/\r/g, '').trim();
}

async function ledger(url) {
  return (await q(url, 'select version, filename, checksum_sha256, kind from agx_meta.schema_migrations order by version')).rows;
}

describe('0028 animal_pesajes anulación (integración real)', { skip }, () => {
  let urlA;
  let appA;
  let urlB;
  let urlRef;
  const ids = {};

  /** Transacción de agx_app con la organización activa (como withOrganizacionTransaction). */
  async function app(org, fn) {
    return withClient(appA, async (c) => {
      await c.query('begin');
      try {
        await c.query("select set_config('app.current_org_id', $1, true)", [org]);
        const out = await fn(c);
        await c.query('commit');
        return out;
      } catch (error) {
        await c.query('rollback');
        throw error;
      }
    });
  }

  const anular = (c, pesajeId, { motivo = 'Error de digitación', op = crypto.randomUUID(), por = ANULADOR } = {}) => c.query(
    `update agx.animal_pesajes
        set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = now(),
            motivo_anulacion = $3, anulacion_client_operation_id = $4
      where pesaje_id = $1`,
    [pesajeId, por, motivo, op],
  );

  const insertarPesaje = (c, org, animalId, fecha, peso, origen = 'MANUAL') => c.query(
    `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id)
     values ($1, $2, $3, $4, 'BASCULA', $5, $6, $7) returning pesaje_id::text as id`,
    [org, animalId, fecha, peso, origen, ACTOR, origen === 'MANUAL' ? crypto.randomUUID() : null],
  );

  before(async () => {
    urlA = dbUrl(BUSINESS, await createDb('agx_0028a'));
    appA = dbUrl(BUSINESS, new URL(urlA).pathname.slice(1), 'agx_app', secrets.AGX_0028_APP_PW);
    await run(['up', '--fresh', '--to', '27', ...VARS], urlA);
    // Fixtures sintéticos escritos por el rol runtime ANTES de 0028 (datos "existentes").
    for (const [org, key] of [[ORG_A, 'A'], [ORG_B, 'B']]) {
      await app(org, async (c) => {
        const predio = (await c.query("insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id", [org, `Predio 0028 ${key}`])).rows[0].predio_id;
        const animal = (await c.query(
          `insert into agx.animales (organizacion_id, predio_id, sexo, numero_visual, client_operation_id, creation_intent_hash)
           values ($1, $2, 'HEMBRA', $3, $4, $5) returning animal_id::text as id`,
          [org, predio, `${key}-0028`, crypto.randomUUID(), `v1:${crypto.randomBytes(32).toString('hex')}`],
        )).rows[0].id;
        ids[`animal${key}`] = animal;
        if (key === 'A') {
          ids.ri = (await insertarPesaje(c, org, animal, '2026-10-18', 340, 'REGISTRO_INICIAL')).rows[0].id;
          ids.p350 = (await insertarPesaje(c, org, animal, '2026-10-19', 350)).rows[0].id;
          ids.p355 = (await insertarPesaje(c, org, animal, '2026-10-20', 355)).rows[0].id;
          ids.p360 = (await insertarPesaje(c, org, animal, '2026-10-20', 360)).rows[0].id;
        } else {
          ids.pB = (await insertarPesaje(c, org, animal, '2026-10-20', 400)).rows[0].id;
        }
      });
    }
  });

  test('A/B: 0028 se aplica sobre 0000-0027 y el ledger pasa de 28 a 29 filas', async () => {
    const antes = await ledger(urlA);
    assert.equal(antes.length, 28);
    assert.equal(antes.at(-1).version, 27);
    const logs = await run(['up'], urlA);
    assert.ok(logs.some((l) => l.includes(UP)), logs.join('\n'));
    const despues = await ledger(urlA);
    assert.equal(despues.length, 29);
    assert.deepEqual(despues.at(-1), { version: 28, filename: UP, checksum_sha256: UP_CHECKSUM, kind: 'aplicada' });
    await rejectsWithCode(run(['up', '--version', '28'], urlA), 'AGX_MIGRATE_OUT_OF_ORDER');
  });

  test('C: las filas existentes quedan ACTIVO sin datos de anulación', async () => {
    const { rows } = await q(urlA, `select count(*)::int as n,
      count(*) filter (where estado_registro = 'ACTIVO' and anulado_por is null and anulado_at is null
                         and motivo_anulacion is null and anulacion_client_operation_id is null)::int as activos
      from agx.animal_pesajes`);
    assert.deepEqual(rows[0], { n: 5, activos: 5 });
  });

  test('D: un INSERT como el del código actual (sin columnas nuevas) nace ACTIVO', async () => {
    const r = await app(ORG_A, (c) => insertarPesaje(c, ORG_A, ids.animalA, '2026-10-21', 362));
    ids.p362 = r.rows[0].id;
    const row = (await q(urlA, 'select estado_registro, anulado_at from agx.animal_pesajes where pesaje_id = $1', [ids.p362])).rows[0];
    assert.deepEqual(row, { estado_registro: 'ACTIVO', anulado_at: null });
  });

  test('D2: INSERT directamente ANULADO falla (trigger), también como superusuario', async () => {
    await pgRejects(q(urlA, `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id,
        client_operation_id, estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id)
      values ($1, $2, '2026-10-21', 361, 'BASCULA', 'MANUAL', $3, $4, 'ANULADO', $3, now(), 'x', $5)`,
    [ORG_A, ids.animalA, ACTOR, crypto.randomUUID(), crypto.randomUUID()]), '23514', { message: /se registra ACTIVO/ });
  });

  test('E/V: agx_app anula (ACTIVO -> ANULADO) usando solo las columnas de anulación', async () => {
    const op = crypto.randomUUID();
    ids.op355 = op;
    const r = await app(ORG_A, (c) => anular(c, ids.p355, { op }));
    assert.equal(r.rowCount, 1);
    const row = (await q(urlA, 'select estado_registro, anulado_por::text, anulado_at is not null as con_fecha, motivo_anulacion, anulacion_client_operation_id::text, peso_kg::text, fecha::text, actor_cuenta_id::text from agx.animal_pesajes where pesaje_id = $1', [ids.p355])).rows[0];
    assert.deepEqual(row, {
      estado_registro: 'ANULADO', anulado_por: ANULADOR, con_fecha: true, motivo_anulacion: 'Error de digitación',
      anulacion_client_operation_id: op, peso_kg: '355', fecha: '2026-10-20', actor_cuenta_id: ACTOR,
    });
  });

  test('F: ANULADO -> ACTIVO falla (sin reactivación)', async () => {
    await pgRejects(app(ORG_A, (c) => c.query(
      `update agx.animal_pesajes set estado_registro = 'ACTIVO', anulado_por = null, anulado_at = null,
              motivo_anulacion = null, anulacion_client_operation_id = null where pesaje_id = $1`, [ids.p355])),
    '23514', { message: /ANULADO es inmutable/ });
  });

  test('G: una segunda modificación de un ANULADO falla (otro motivo / otra operación)', async () => {
    await pgRejects(app(ORG_A, (c) => anular(c, ids.p355, { motivo: 'Otro motivo' })), '23514', { message: /ANULADO es inmutable/ });
    await pgRejects(app(ORG_A, (c) => c.query("update agx.animal_pesajes set motivo_anulacion = 'Editado' where pesaje_id = $1", [ids.p355])),
      '23514', { message: /ANULADO es inmutable/ });
  });

  test('ACTIVO -> otra cosa distinta de ANULADO falla', async () => {
    await pgRejects(q(urlA, "update agx.animal_pesajes set estado_registro = 'BORRADO' where pesaje_id = $1", [ids.p360]),
      '23514', { message: /solo se admite la transición ACTIVO -> ANULADO/ });
    await pgRejects(q(urlA, "update agx.animal_pesajes set fecha = '2026-10-22' where pesaje_id = $1", [ids.p360]),
      '23514', { message: /solo se admite la transición ACTIVO -> ANULADO/ });
  });

  test('H: DELETE falla por trigger, también como superusuario', async () => {
    await pgRejects(q(urlA, 'delete from agx.animal_pesajes where pesaje_id = $1', [ids.p360]), '23514', { message: /no admite DELETE/ });
  });

  for (const [letra, columna, valor] of [
    ['I', 'peso_kg', () => 365],
    ['J', 'fecha', () => '2026-10-22'],
    ['K', 'animal_id', () => ids.animalB],
    ['L', 'organizacion_id', () => ORG_B],
    ['M', 'origen', () => 'REGISTRO_INICIAL'],
    ['N', 'client_operation_id', () => crypto.randomUUID()],
    ['N2', 'actor_cuenta_id', () => crypto.randomUUID()],
    ['N3', 'metodo', () => 'ESTIMADO'],
    ['N4', 'observaciones', () => 'nota nueva'],
  ]) {
    test(`${letra}: cambiar ${columna} durante la anulación falla (trigger, superusuario)`, async () => {
      await pgRejects(q(urlA,
        `update agx.animal_pesajes set ${columna} = $2, estado_registro = 'ANULADO', anulado_por = $3, anulado_at = now(),
                motivo_anulacion = 'x', anulacion_client_operation_id = $4 where pesaje_id = $1`,
        [ids.p360, valor(), ANULADOR, crypto.randomUUID()]), '23514', { message: /contenido del pesaje es inmutable/ });
    });
  }

  test('O: anulación sin motivo (NULL o en blanco) falla', async () => {
    await pgRejects(app(ORG_A, (c) => anular(c, ids.p360, { motivo: null })), '23514', { constraint: 'animal_pesajes_anulacion_consistency_check' });
    await pgRejects(app(ORG_A, (c) => anular(c, ids.p360, { motivo: '   ' })), '23514', { constraint: 'animal_pesajes_anulacion_consistency_check' });
  });

  test('P: motivo de 501 caracteres falla; 500 es válido', async () => {
    await pgRejects(app(ORG_A, (c) => anular(c, ids.p360, { motivo: 'm'.repeat(501) })), '23514', { constraint: 'animal_pesajes_anulacion_consistency_check' });
    const r = await app(ORG_A, (c) => anular(c, ids.p362, { motivo: 'm'.repeat(500) }));
    assert.equal(r.rowCount, 1);
  });

  test('estados parcialmente anulados fallan (ANULADO sin actor/fecha/operación; ACTIVO con datos)', async () => {
    const chk = { constraint: 'animal_pesajes_anulacion_consistency_check' };
    await pgRejects(app(ORG_A, (c) => anular(c, ids.p360, { por: null })), '23514', chk);
    await pgRejects(app(ORG_A, (c) => c.query(`update agx.animal_pesajes set estado_registro = 'ANULADO', anulado_por = $2, motivo_anulacion = 'x', anulacion_client_operation_id = $3 where pesaje_id = $1`, [ids.p360, ANULADOR, crypto.randomUUID()])), '23514', chk);
    await pgRejects(app(ORG_A, (c) => c.query(`update agx.animal_pesajes set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = now(), motivo_anulacion = 'x' where pesaje_id = $1`, [ids.p360, ANULADOR])), '23514', chk);
    // ACTIVO con campos de anulación: el trigger lo rechaza antes que el CHECK.
    await pgRejects(app(ORG_A, (c) => c.query("update agx.animal_pesajes set motivo_anulacion = 'x' where pesaje_id = $1", [ids.p360])),
      '23514', { message: /solo se admite la transición ACTIVO -> ANULADO/ });
  });

  test('Q: la misma operación de anulación en la organización falla por índice; en otra organización es independiente', async () => {
    await pgRejects(app(ORG_A, (c) => anular(c, ids.p360, { op: ids.op355 })), '23505', { constraint: 'animal_pesajes_org_anulacion_client_operation_key' });
    const r = await app(ORG_B, (c) => anular(c, ids.pB, { op: ids.op355 }));
    assert.equal(r.rowCount, 1);
  });

  test('R/S: cross-tenant -- otra organización no ve ni anula ni inserta pesajes ajenos', async () => {
    const visto = await app(ORG_B, (c) => c.query('select pesaje_id from agx.animal_pesajes where pesaje_id = $1', [ids.p360]));
    assert.equal(visto.rowCount, 0);
    const upd = await app(ORG_B, (c) => anular(c, ids.p360));
    assert.equal(upd.rowCount, 0);
    assert.equal((await q(urlA, 'select estado_registro from agx.animal_pesajes where pesaje_id = $1', [ids.p360])).rows[0].estado_registro, 'ACTIVO');
    await pgRejects(app(ORG_B, (c) => insertarPesaje(c, ORG_A, ids.animalA, '2026-10-21', 370)), '42501', { message: /row-level security/ });
    // Sin organización activa no se ve nada.
    const sinOrg = await withClient(appA, (c) => c.query('select count(*)::int as n from agx.animal_pesajes'));
    assert.equal(sinOrg.rows[0].n, 0);
  });

  test('RLS ENABLE + FORCE y política tenant sin cambios', async () => {
    const rls = (await q(urlA, "select relrowsecurity as e, relforcerowsecurity as f from pg_class where oid = 'agx.animal_pesajes'::regclass")).rows[0];
    assert.deepEqual(rls, { e: true, f: true });
    const pol = (await q(urlA, "select policyname, cmd from pg_policies where schemaname = 'agx' and tablename = 'animal_pesajes'")).rows;
    assert.deepEqual(pol, [{ policyname: 'animal_pesajes_tenant_isolation', cmd: 'ALL' }]);
  });

  test('T: agx_app no puede UPDATE de peso ni de otras columnas no concedidas', async () => {
    await pgRejects(app(ORG_A, (c) => c.query('update agx.animal_pesajes set peso_kg = 361 where pesaje_id = $1', [ids.p360])), '42501', { message: /permission denied/ });
    await pgRejects(app(ORG_A, (c) => c.query('update agx.animal_pesajes set organizacion_id = organizacion_id where pesaje_id = $1', [ids.p360])), '42501', { message: /permission denied/ });
  });

  test('U: agx_app no puede DELETE ni TRUNCATE', async () => {
    await pgRejects(app(ORG_A, (c) => c.query('delete from agx.animal_pesajes where pesaje_id = $1', [ids.p360])), '42501', { message: /permission denied/ });
    await pgRejects(app(ORG_A, (c) => c.query('truncate agx.animal_pesajes')), '42501', { message: /permission denied/ });
  });

  test('V: grants de agx_app = SELECT/INSERT de tabla + UPDATE solo en las 5 columnas de anulación', async () => {
    const tabla = (await q(urlA, "select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.table_privileges where table_schema = 'agx' and table_name = 'animal_pesajes' and grantee = 'agx_app'")).rows[0].p;
    assert.equal(tabla, 'INSERT,SELECT');
    const cols = (await q(urlA, "select column_name from information_schema.column_privileges where table_schema = 'agx' and table_name = 'animal_pesajes' and grantee = 'agx_app' and privilege_type = 'UPDATE' order by column_name")).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ANULACION_COLS);
  });

  test('X: rollback con pesajes -> bloqueado por la precondición del runner; nada cambia', async () => {
    await rejectsWithCode(run(['rollback', '--version', '28', '--confirm-rollback', '28'], urlA), 'AGX_MIGRATE_ROLLBACK_PRECONDITION');
    assert.equal((await ledger(urlA)).length, 29);
    assert.equal((await q(urlA, "select count(*)::int as n from pg_trigger where tgname = 'animal_pesajes_guard'")).rows[0].n, 1);
    assert.equal((await q(urlA, "select count(*)::int as n from agx.animal_pesajes where estado_registro = 'ANULADO'")).rows[0].n, 3);
  });

  test('X2: el SQL de rollback fuera del runner también aborta si hay filas', async () => {
    await withClient(urlA, async (c) => {
      await c.query('begin');
      try {
        await pgRejects(c.query(ROLLBACK_SQL), 'P0001', { message: /forward-only/ });
      } finally {
        await c.query('rollback');
      }
    });
    assert.equal((await q(urlA, "select count(*)::int as n from information_schema.columns where table_schema = 'agx' and table_name = 'animal_pesajes' and column_name = 'estado_registro'")).rows[0].n, 1);
  });

  describe('base segura (sin pesajes)', () => {
    before(async () => {
      urlRef = dbUrl(BUSINESS, await createDb('agx_0028ref'));
      urlB = dbUrl(BUSINESS, await createDb('agx_0028b'));
      await run(['up', '--fresh', '--to', '27', ...VARS], urlRef);
      await run(['up', '--fresh', '--to', '28', ...VARS], urlB);
    });

    test('W: rollback de 0028 en base vacía pasa y deja el esquema idéntico a 0027', async () => {
      assert.equal((await ledger(urlB)).length, 29);
      await run(['rollback', '--version', '28', '--confirm-rollback', '28'], urlB);
      assert.equal((await ledger(urlB)).length, 28);
      const ev = (await q(urlB, "select count(*)::int as n from agx_meta.schema_migration_eventos where version = 28 and accion = 'revertida'")).rows[0].n;
      assert.equal(ev, 1);
      assert.equal(fingerprint(urlB), fingerprint(urlRef));
    });

    test('Y: reaplicar 0028 tras el rollback seguro pasa', async () => {
      await run(['up', '--version', '28'], urlB);
      const l = await ledger(urlB);
      assert.equal(l.length, 29);
      assert.equal(l.at(-1).checksum_sha256, UP_CHECKSUM);
      assert.equal((await q(urlB, "select count(*)::int as n from pg_trigger where tgname = 'animal_pesajes_guard'")).rows[0].n, 1);
    });
  });
});
