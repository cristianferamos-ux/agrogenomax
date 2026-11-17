// HARDENING PRE-SANIDAD (PR A) -- integración REAL del runner de migraciones.
// Se ejecuta con `npm run test:agx-migrations-integration`, que levanta
// clusters Docker desechables y fija AGX_MIG_BUSINESS_ADMIN_URL /
// AGX_MIG_AUTH_ADMIN_URL (solo loopback). Sin ellas, se omite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { main as migrate, defaultExecPsql } from '../agx-migrate.mjs';
import { sanitizedPgEnv } from '../agx-migrate-lib.mjs';
import { lexPsql } from '../agx-psql-lexer.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUSINESS = process.env.AGX_MIG_BUSINESS_ADMIN_URL;
const AUTH = process.env.AGX_MIG_AUTH_ADMIN_URL;
const skip = !BUSINESS || !AUTH ? 'AGX_MIG_BUSINESS_ADMIN_URL/AGX_MIG_AUTH_ADMIN_URL no configuradas' : false;

for (const u of [BUSINESS, AUTH].filter(Boolean)) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname)) throw new Error('la integración del runner solo admite loopback');
}

const secrets = {
  AGX_MIG_APP_PW: crypto.randomBytes(16).toString('hex'),
  AGX_MIG_QR_PW: crypto.randomBytes(16).toString('hex'),
  AGX_MIG_AUTH_PW: crypto.randomBytes(16).toString('hex'),
};
const BUSINESS_VARS = ['--var', 'agx_app_password=AGX_MIG_APP_PW', '--var', 'agx_qr_admin_password=AGX_MIG_QR_PW'];

function dbUrl(admin, db) {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin(url, sql, params) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

async function createDb(adminUrl, prefix) {
  const name = `${prefix}_${crypto.randomBytes(3).toString('hex')}_test`;
  await admin(adminUrl, `create database ${name}`);
  return name;
}

/**
 * Copia aislada del repo mínimo: migraciones reales + huella, para añadir migraciones sintéticas.
 * La mecánica del runner se prueba sobre el historial congelado hasta el ledger (Business
 * 0000-0027): las migraciones reales posteriores (0028+) se excluyen del sandbox para que las
 * sintéticas 0028/0029 de estas pruebas no choquen con ellas. Cada migración real >= 0028 tiene
 * su propia integración (p. ej. agxBusiness0028Integration.test.mjs).
 */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-it-'));
  for (const rel of ['db/agx-business/migrations', 'db/agx/migrations', 'db/agx-business/verify', 'db/agx/verify', 'db/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  }
  const businessDir = path.join(root, 'db/agx-business/migrations');
  for (const f of fs.readdirSync(businessDir)) {
    const m = /^(\d{4})_/.exec(f);
    if (m && Number(m[1]) > 27) fs.rmSync(path.join(businessDir, f));
  }
  return root;
}

async function run(args, url, root, { extraEnv = {}, execPsql, logs = [] } = {}) {
  const env = { ...process.env, ...secrets, ...extraEnv, AGX_MIG_URL: url };
  await migrate([...args, '--url-env', 'AGX_MIG_URL', ...(root ? ['--root', root] : [])], { env, log: (l) => logs.push(l), ...(execPsql ? { execPsql } : {}) });
  return logs;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function psqlFile(url, file, extra = []) {
  const u = new URL(url);
  return spawnSync(process.env.PSQL_BIN || 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...extra, '-f', file], {
    encoding: 'utf8',
    env: sanitizedPgEnv(process.env, { PGHOST: u.hostname, PGPORT: u.port, PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGCLIENTENCODING: 'UTF8' }),
  });
}

async function ledger(url) {
  return (await admin(url, 'select version, kind from agx_meta.schema_migrations order by version')).rows;
}

const MIG_DIR = (root) => path.join(root, 'db/agx-business/migrations');

describe('runner de migraciones AGX (integración real)', { skip }, () => {
  let root;
  let url;

  before(async () => {
    root = sandbox();
    url = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_mig'));
    await run(['up', '--target', 'business', '--fresh', ...BUSINESS_VARS], url, root);
  });

  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('fresh: 0000-0026 certificadas por huella y 0027 aplicada en la misma transacción', async () => {
    const rows = await ledger(url);
    assert.equal(rows.length, 28);
    assert.ok(rows.slice(0, 27).every((r) => r.kind === 'baseline_certificada'));
    assert.equal(rows[27].kind, 'aplicada');
    const ev = await admin(url, 'select count(*)::int as n from agx_meta.schema_migration_eventos');
    assert.equal(ev.rows[0].n, 28);
  });

  test('1. migración nueva PASS y queda registrada', async () => {
    fs.writeFileSync(path.join(MIG_DIR(root), '0028_it_alpha.sql'), 'create table agx.it_alpha (id integer primary key);\n');
    fs.writeFileSync(path.join(MIG_DIR(root), '0028_it_alpha_rollback.sql'), 'drop table if exists agx.it_alpha;\n');
    await run(['up', '--target', 'business'], url, root);
    const rows = await ledger(url);
    assert.deepEqual(rows.at(-1), { version: 28, kind: 'aplicada' });
    assert.ok((await admin(url, "select to_regclass('agx.it_alpha') as r")).rows[0].r);
  });

  test('2. repetición FAIL: el mismo bundle ejecutado dos veces y el bootstrap repetido', async () => {
    const out = path.join(root, 'b28.sql');
    // bundle generado como si 0028 no estuviera aplicada (lo que haría un operador con un bundle viejo)
    await migrate(['bundle', '--target', 'business', '--version', '28', '--out', out, '--root', root], { log: () => {} });
    const res = psqlFile(url, out);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /AGX_MIGRATE_ALREADY_APPLIED/);
    const boot = path.join(root, 'b27.sql');
    await migrate(['bundle', '--target', 'business', '--version', '27', '--out', boot, '--root', root], { log: () => {} });
    const res27 = psqlFile(url, boot);
    assert.match(res27.stderr, /AGX_MIGRATE_ALREADY_APPLIED/);
    assert.equal((await ledger(url)).length, 29);
    await rejectsWith(run(['up', '--target', 'business', '--version', '28'], url, root), 'AGX_MIGRATE_OUT_OF_ORDER');
  });

  test('3. checksum cambiado FAIL (cliente y servidor)', async () => {
    const file = path.join(MIG_DIR(root), '0028_it_alpha.sql');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${original}-- cambio posterior\n`);
    fs.writeFileSync(path.join(MIG_DIR(root), '0029_it_beta.sql'), 'create table agx.it_beta (id integer);\n');
    try {
      await rejectsWith(run(['plan', '--target', 'business'], url, root), 'AGX_MIGRATE_CHECKSUM_MISMATCH');
      const out = path.join(root, 'b29.sql');
      await migrate(['bundle', '--target', 'business', '--version', '29', '--out', out, '--root', root], { log: () => {} });
      const res = psqlFile(url, out);
      assert.match(res.stderr, /AGX_MIGRATE_CHECKSUM_MISMATCH/);
      assert.equal((await admin(url, "select to_regclass('agx.it_beta') as r")).rows[0].r, null);
      // Un archivo histórico con CRLF NO cuenta como cambio (checksum sobre LF).
      const f26 = path.join(MIG_DIR(root), '0026_reproduccion_bovina.sql');
      const lf = fs.readFileSync(f26, 'utf8');
      fs.writeFileSync(f26, lf.replace(/\r?\n/g, '\r\n'));
      fs.writeFileSync(file, original);
      await run(['plan', '--target', 'business'], url, root);
      fs.writeFileSync(f26, lf);
    } finally {
      fs.writeFileSync(file, original);
      fs.rmSync(path.join(MIG_DIR(root), '0029_it_beta.sql'), { force: true });
    }
  });

  test('4. hueco y ejecución fuera de orden FAIL', async () => {
    fs.writeFileSync(path.join(MIG_DIR(root), '0030_it_gamma.sql'), 'create table agx.it_gamma (id integer);\n');
    await rejectsWith(run(['plan', '--target', 'business'], url, root), 'AGX_MIGRATE_GAP');
    fs.writeFileSync(path.join(MIG_DIR(root), '0029_it_beta.sql'), 'create table agx.it_beta (id integer);\n');
    try {
      await rejectsWith(run(['up', '--target', 'business', '--version', '30'], url, root), 'AGX_MIGRATE_OUT_OF_ORDER');
      const out = path.join(root, 'b30.sql');
      await migrate(['bundle', '--target', 'business', '--version', '30', '--out', out, '--root', root], { log: () => {} });
      const res = psqlFile(url, out);
      assert.match(res.stderr, /AGX_MIGRATE_GAP/);
      assert.equal((await admin(url, "select to_regclass('agx.it_gamma') as r")).rows[0].r, null);
    } finally {
      fs.rmSync(path.join(MIG_DIR(root), '0029_it_beta.sql'), { force: true });
      fs.rmSync(path.join(MIG_DIR(root), '0030_it_gamma.sql'), { force: true });
    }
  });

  test('5/6. SQL que falla a mitad: rollback completo y el ledger no registra', async () => {
    fs.writeFileSync(path.join(MIG_DIR(root), '0029_it_falla.sql'), [
      'create table agx.it_parcial (id integer);',
      'insert into agx.it_parcial values (1);',
      "grant select on agx.it_parcial to agx_app;",
      'select 1 / 0;',
      'create table agx.it_nunca (id integer);',
      '',
    ].join('\n'));
    try {
      await rejectsWith(run(['up', '--target', 'business'], url, root), 'AGX_MIGRATE_SQL_ERROR');
      const r = await admin(url, "select to_regclass('agx.it_parcial') as a, to_regclass('agx.it_nunca') as b");
      assert.deepEqual(r.rows[0], { a: null, b: null });
      assert.equal((await ledger(url)).length, 29);
      const ev = await admin(url, 'select count(*)::int as n from agx_meta.schema_migration_eventos where version = 29');
      assert.equal(ev.rows[0].n, 0);
    } finally {
      fs.rmSync(path.join(MIG_DIR(root), '0029_it_falla.sql'), { force: true });
    }
  });

  test('archivo con BEGIN/COMMIT propio o \\connect es rechazado antes de tocar la base', async () => {
    const f = path.join(MIG_DIR(root), '0029_it_tx.sql');
    fs.writeFileSync(f, 'begin;\ncreate table agx.it_tx (id integer);\ncommit;\n');
    try {
      await rejectsWith(run(['plan', '--target', 'business'], url, root), 'AGX_MIGRATE_TX_CONTROL');
      fs.writeFileSync(f, '\\connect postgres\ncreate table it_tx (id integer);\n');
      await rejectsWith(run(['plan', '--target', 'business'], url, root), 'AGX_MIGRATE_META_COMMAND');
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  test('7. rollbacks: históricos bloqueados; precondiciones de datos; solo el último; ledger irreversible', async () => {
    // 0028 (no histórico) con datos: la precondición lo bloquea en servidor.
    await admin(url, 'insert into agx.it_alpha values (1)');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '28'], url, root), 'AGX_MIGRATE_ROLLBACK_NOT_CONFIRMED');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '28', '--confirm-rollback', '28'], url, root), 'AGX_MIGRATE_ROLLBACK_PRECONDITION');
    assert.ok((await admin(url, "select to_regclass('agx.it_alpha') as r")).rows[0].r);
    await admin(url, 'delete from agx.it_alpha');
    await run(['rollback', '--target', 'business', '--version', '28', '--confirm-rollback', '28'], url, root);
    assert.equal((await ledger(url)).length, 28);
    const rev = await admin(url, "select count(*)::int as n from agx_meta.schema_migration_eventos where version = 28 and accion = 'revertida'");
    assert.equal(rev.rows[0].n, 1);

    // Ahora el tope es 0026 (histórico).
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26'], url, root), 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26', '--force'], url, root), 'AGX_MIGRATE_FORCE_NOT_SUPPORTED');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26', '--confirm-rollback', '26'], url, root), 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26', '--allow-historical-destructive-rollback', '25'], url, root), 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26', '--allow-historical-destructive-rollback', '26'], url, root), 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
    const fake = path.join(root, 'no-es-dump.bin');
    fs.writeFileSync(fake, 'hola');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26', '--allow-historical-destructive-rollback', '26', '--backup-evidence', fake], url, root), 'AGX_MIGRATE_BACKUP_EVIDENCE');
    // 5 bytes PGDMP ya no bastan (12): la evidencia es un pg_dump -Fc real, legible por pg_restore --list.
    const fakeDump = path.join(root, 'falso.dump');
    fs.writeFileSync(fakeDump, 'PGDMP');
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '26', '--allow-historical-destructive-rollback', '26', '--backup-evidence', fakeDump], url, root), 'AGX_MIGRATE_BACKUP_EVIDENCE');
    const evidence = path.join(root, 'evidencia.dump');
    const u = new URL(url);
    const dump = spawnSync(process.env.PG_DUMP_BIN || 'pg_dump', ['-Fc', '-f', evidence], {
      encoding: 'utf8',
      env: sanitizedPgEnv(process.env, { PGHOST: u.hostname, PGPORT: u.port, PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) }),
    });
    assert.equal(dump.status, 0, dump.stderr);
    // No es el tope: el servidor lo rechaza.
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '25', '--allow-historical-destructive-rollback', '25', '--backup-evidence', evidence], url, root), 'AGX_MIGRATE_ROLLBACK_NOT_TOP');
    // El ledger nunca se revierte con el runner.
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '27', '--confirm-rollback', '27'], url, root), 'AGX_MIGRATE_LEDGER_ROLLBACK_FORBIDDEN');
    // Edición manual del ledger bloqueada por trigger, incluso para el superusuario.
    await assert.rejects(admin(url, 'delete from agx_meta.schema_migrations where version = 26'), /append-only|solo dentro de un rollback/);
    await assert.rejects(admin(url, "update agx_meta.schema_migrations set kind = 'aplicada' where version = 1"), /append-only/);
    await assert.rejects(admin(url, 'truncate agx_meta.schema_migration_eventos'), /append-only/);
    // Con la opción extraordinaria, evidencia y tabla vacía, el histórico 0026 sí corre.
    const rbLogs = await run(['rollback', '--target', 'business', '--version', '26', '--allow-historical-destructive-rollback', '26', '--backup-evidence', evidence], url, root);
    assert.ok(rbLogs.some((l) => /backup-evidence sha256=[0-9a-f]{64} bytes=\d+ entradas_toc=\d+/.test(l)), rbLogs.join('\n'));
    assert.equal((await admin(url, "select to_regclass('agx.reproduccion_eventos') as r")).rows[0].r, null);
    assert.equal((await ledger(url)).length, 27);
  });

  test('8. el rol runtime agx_app no puede leer ni escribir agx_meta (agx_qr_admin tampoco)', async () => {
    await admin(BUSINESS, `alter role agx_app password '${secrets.AGX_MIG_APP_PW}'`);
    const u = new URL(url);
    for (const [role, pw] of [['agx_app', secrets.AGX_MIG_APP_PW], ['agx_qr_admin', secrets.AGX_MIG_QR_PW]]) {
      if (role === 'agx_qr_admin') await admin(BUSINESS, `alter role agx_qr_admin password '${pw}'`);
      u.username = role;
      u.password = pw;
      await assert.rejects(admin(u.toString(), 'select * from agx_meta.schema_migrations'), (e) => e.code === '42501');
      await assert.rejects(admin(u.toString(), "insert into agx_meta.schema_migrations values (9999, '9999_x.sql', repeat('0', 64), 'aplicada', now(), 'x', 'x')"), (e) => e.code === '42501');
      await assert.rejects(admin(u.toString(), 'create table agx_meta.intruso (id integer)'), (e) => e.code === '42501');
    }
  });
});

describe('ruta de producción: bundle ejecutado por psql sobre una base existente sin ledger', { skip }, () => {
  test('certifica, crea el ledger y es repetible solo una vez', async () => {
    const url = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_prodpath'));
    await run(['up', '--target', 'business', '--fresh', '--to', '26', ...BUSINESS_VARS], url);
    assert.equal((await admin(url, "select to_regnamespace('agx_meta') as r")).rows[0].r, null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-b-'));
    try {
      const out = path.join(dir, 'b27.sql');
      await migrate(['bundle', '--target', 'business', '--version', '27', '--out', out], { log: () => {} });
      // Base divergente (un grant de más) -> la certificación aborta sin crear el ledger.
      await admin(url, 'grant select on agx.qr_lotes to agx_app');
      let res = psqlFile(url, out);
      assert.match(res.stderr, /AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH/);
      assert.equal((await admin(url, "select to_regnamespace('agx_meta') as r")).rows[0].r, null);
      await admin(url, 'revoke select on agx.qr_lotes from agx_app');
      res = psqlFile(url, out);
      assert.equal(res.status, 0, res.stderr);
      assert.equal((await ledger(url)).length, 28);
      res = psqlFile(url, out);
      assert.match(res.stderr, /AGX_MIGRATE_ALREADY_APPLIED/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('10. baseline Auth reconstruye la estructura de producción desde cero', { skip }, () => {
  test('0000+0001+0002 == huella de Postgres-AGX producción (2026-11-06)', async () => {
    const url = dbUrl(AUTH, await createDb(AUTH, 'agx_auth'));
    await run(['up', '--target', 'auth', '--fresh', '--var', 'agx_auth_password=AGX_MIG_AUTH_PW'], url);
    const u = new URL(url);
    const res = spawnSync(process.env.PSQL_BIN || 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'db/verify/schema_fingerprint.sql')], {
      encoding: 'utf8',
      env: sanitizedPgEnv(process.env, { PGHOST: u.hostname, PGPORT: u.port, PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) }),
    });
    assert.equal(res.status, 0, res.stderr);
    const got = res.stdout.replace(/\r/g, '').trim().split('\n');
    const expected = fs.readFileSync(path.join(ROOT, 'db/agx/verify/prod_auth_20261106.fingerprint'), 'utf8').replace(/\r/g, '').trim().split('\n');
    assert.deepEqual(got, expected);
    for (const t of ['cuentas', 'sesiones', 'staff_crh', 'auth_rate_limits', 'credenciales_reset_tokens', 'eventos_seguridad_auth', 'organizaciones', 'membresias']) {
      assert.ok(got.some((l) => l.startsWith(`relation|agx.${t}|kind=r|owner=agx_owner`)), t);
    }
    // Sobre una base Auth existente, el baseline aborta (nunca se aplica en producción).
    await rejectsWith(run(['up', '--target', 'auth', '--var', 'agx_auth_password=AGX_MIG_AUTH_PW'], url), 'AGX_MIGRATE_NO_LEDGER');
    await rejectsWith(run(['up', '--target', 'auth', '--fresh', '--var', 'agx_auth_password=AGX_MIG_AUTH_PW'], url), 'AGX_MIGRATE_NOT_FRESH');
  });
});

// ---------------------------------------------------------------------
// Guards del runner (hardening/migration-runner-guards), base propia.
// ---------------------------------------------------------------------
describe('guards del runner (integración real)', { skip }, () => {
  let root;
  let url;
  const tmpFiles = [];

  before(async () => {
    root = sandbox();
    url = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_guard'));
    await run(['up', '--target', 'business', '--fresh', ...BUSINESS_VARS], url, root);
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    for (const f of tmpFiles) fs.rmSync(f, { recursive: true, force: true });
  });

  test('A (2/3): bundle --fresh 0000..0026 PASS sobre base vacía; FAIL sobre base existente o con ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-fresh-'));
    tmpFiles.push(dir);
    const out = path.join(dir, 'fresh26.sql');
    await migrate(['bundle', '--target', 'business', '--fresh', '--to', '26', '--out', out], { log: () => {} });
    const empty = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_fresh'));
    const vars = ['-v', `agx_app_password=${secrets.AGX_MIG_APP_PW}`, '-v', `agx_qr_admin_password=${secrets.AGX_MIG_QR_PW}`];
    let res = psqlFile(empty, out, vars);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /AGX_MIGRATE_COMMITTED [0-9a-f]{32} xid=/);
    const r = (await admin(empty, "select to_regnamespace('agx') is not null as agx, to_regnamespace('agx_meta') is null as sin_ledger, to_regclass('agx.reproduccion_eventos') is not null as t26")).rows[0];
    assert.deepEqual(r, { agx: true, sin_ledger: true, t26: true });
    // Mismo bundle sobre la base ya construida (sin ledger) y sobre una base con ledger: NOT_FRESH, nada cambia.
    res = psqlFile(empty, out, vars);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /AGX_MIGRATE_NOT_FRESH/);
    res = psqlFile(url, out, vars);
    assert.match(res.stderr, /AGX_MIGRATE_NOT_FRESH/);
    assert.equal((await ledger(url)).length, 28);
    // El runner tampoco admite --fresh sobre una base existente.
    await rejectsWith(run(['up', '--target', 'business', '--fresh', ...BUSINESS_VARS], empty, root), 'AGX_MIGRATE_NOT_FRESH');
  });

  test('B (4/5/6): migraciones con \\set ON_ERROR_STOP 0, AUTOCOMMIT o \\gexec se rechazan antes de tocar la base', async () => {
    for (const [i, body] of [
      ['a', '\\set ON_ERROR_STOP 0\ncreate table agx.it_guard_a (id integer);\n'],
      ['b', '\\set AUTOCOMMIT off\ncreate table agx.it_guard_b (id integer);\n'],
      ['c', "select 'create table agx.it_guard_c (id integer)' \\gexec\n"],
    ]) {
      const f = path.join(MIG_DIR(root), `0028_it_guard_${i}.sql`);
      fs.writeFileSync(f, body);
      try {
        await rejectsWith(run(['up', '--target', 'business'], url, root), 'AGX_MIGRATE_META_COMMAND');
        assert.equal((await admin(url, `select to_regclass('agx.it_guard_${i}') as r`)).rows[0].r, null);
      } finally {
        fs.rmSync(f, { force: true });
      }
    }
    assert.equal((await ledger(url)).length, 28);
  });

  test('C (7): psql termina con rc=0 pero la transacción no hizo COMMIT -> el runner FALLA', async () => {
    const f = path.join(MIG_DIR(root), '0028_it_post.sql');
    fs.writeFileSync(f, 'create table agx.it_post (id integer);\n');
    // psql "manipulado": convierte el COMMIT en ROLLBACK y quita el post-check del bundle.
    const execPsql = (env, args) => {
      const file = args[args.indexOf('-f') + 1];
      const sql = fs.readFileSync(file, 'utf8')
        .replace(/-- <agx-migrate-commit>[\s\S]*?-- <\/agx-migrate-commit>/, 'rollback;')
        .replace(/-- <agx-migrate-post-check>[\s\S]*?-- <\/agx-migrate-post-check>/, '');
      fs.writeFileSync(file, sql);
      const res = defaultExecPsql(env, args);
      assert.equal(res.status, 0, res.stderr);
      return res;
    };
    try {
      await rejectsWith(run(['up', '--target', 'business'], url, root, { execPsql }), 'AGX_MIGRATE_POST_VERIFY');
      assert.equal((await admin(url, "select to_regclass('agx.it_post') as r")).rows[0].r, null);
      assert.equal((await ledger(url)).length, 28);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  test('D (8/9): PGHOSTADDR/PGSERVICE/PGOPTIONS heredadas no cambian el destino ni la sesión', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-svc-'));
    tmpFiles.push(dir);
    const serviceFile = path.join(dir, 'pg_service.conf');
    fs.writeFileSync(serviceFile, '[agx_trampa]\nhost=203.0.113.9\nport=1\ndbname=no_existe\nuser=nadie\n');
    const hostile = {
      PGHOSTADDR: '203.0.113.9', PGSERVICE: 'agx_trampa', PGSERVICEFILE: serviceFile, PGPORT: '1',
      PGDATABASE: 'no_existe', PGOPTIONS: '-c default_transaction_read_only=on', PGSSLMODE: 'require',
    };
    const f = path.join(MIG_DIR(root), '0028_it_env.sql');
    fs.writeFileSync(f, 'create table agx.it_env (id integer);\n');
    fs.writeFileSync(path.join(MIG_DIR(root), '0028_it_env_rollback.sql'), 'drop table if exists agx.it_env;\n');
    try {
      const logs = await run(['up', '--target', 'business'], url, root, { extraEnv: hostile });
      assert.ok(logs.some((l) => /OK 0028_it_env\.sql/.test(l)), logs.join('\n'));
      assert.ok((await admin(url, "select to_regclass('agx.it_env') as r")).rows[0].r);
      assert.equal((await ledger(url)).length, 29);
      await run(['rollback', '--target', 'business', '--version', '28', '--confirm-rollback', '28'], url, root, { extraEnv: hostile });
      assert.equal((await ledger(url)).length, 28);
    } finally {
      fs.rmSync(f, { force: true });
      fs.rmSync(path.join(MIG_DIR(root), '0028_it_env_rollback.sql'), { force: true });
    }
  });

  test('(11): la contraseña no aparece en stdout/stderr/mensajes ni en argv de psql', async () => {
    const secret = secrets.AGX_MIG_APP_PW;
    const f = path.join(MIG_DIR(root), '0028_it_secret.sql');
    // Error que en psql incluiría el valor: invalid input syntax for type integer: "<secreto>".
    fs.writeFileSync(f, "select :'agx_app_password'::integer;\n");
    const seen = [];
    const execPsql = (env, args) => {
      seen.push(...args);
      const res = defaultExecPsql(env, args);
      seen.push(res.stdout || '');
      return res;
    };
    try {
      const logs = [];
      let error;
      try {
        await run(['up', '--target', 'business', '--var', 'agx_app_password=AGX_MIG_APP_PW'], url, root, { execPsql, logs });
      } catch (e) { error = e; }
      assert.equal(error?.code, 'AGX_MIGRATE_SQL_ERROR');
      assert.ok(!error.message.includes(secret), 'el mensaje de error contiene la contraseña');
      assert.match(error.message, /\*\*\*/);
      assert.ok(!logs.join('\n').includes(secret));
      assert.ok(!seen.join('\n').includes(secret), 'la contraseña viajó en argv o stdout de psql');
      const adminPw = decodeURIComponent(new URL(url).password);
      assert.ok(!seen.join('\n').includes(adminPw) && !error.message.includes(adminPw));
      assert.equal((await ledger(url)).length, 28);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});

// ---------------------------------------------------------------------
// Fix del bypass de la revisión final del PR #119.
// ---------------------------------------------------------------------
const EXPLOIT = fs.readFileSync(path.join(ROOT, '.tools/integration/fixtures/exploit_0028_quoted_identifier.sql'), 'utf8').replace(/\r\n/g, '\n');
const BUSINESS_CONTAINER = process.env.AGX_MIG_BUSINESS_CONTAINER;
const AUTH_CONTAINER = process.env.AGX_MIG_AUTH_CONTAINER;

function containerPsql(container, db, input) {
  return spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-At', '-f', '-'], { input, encoding: 'utf8' });
}

describe('bypass del escáner: exploit, SQL puro y defensa en runtime', { skip }, () => {
  let root;
  let url;

  before(async () => {
    root = sandbox();
    url = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_exploit'));
    await run(['up', '--target', 'business', '--fresh', ...BUSINESS_VARS], url, root);
  });

  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('exploit ANTES (clase de fallo en psql): exit 0, error 1/0, COMMIT real y ledger 0028 con aplicación parcial', async () => {
    // Base aparte: lo que hacía el bundle sin el fix (contenido + reafirmación + ledger + commit).
    const demo = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_exploit_before'));
    await run(['up', '--target', 'business', '--fresh', ...BUSINESS_VARS], demo, root);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-exploit-'));
    try {
      const f = path.join(dir, 'antes.sql');
      fs.writeFileSync(f, [
        '\\set ON_ERROR_STOP 1', 'begin;', EXPLOIT, '\\set ON_ERROR_STOP 1', '\\unset ON_ERROR_ROLLBACK',
        "insert into agx_meta.schema_migrations (version, filename, checksum_sha256, kind, runner_version) values (28, '0028_bypass_quoted_identifier.sql', repeat('a', 64), 'aplicada', 'pre-fix');",
        'commit;', '',
      ].join('\n'));
      const res = psqlFile(demo, f);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /division by zero/);
      assert.deepEqual((await ledger(demo)).filter((r) => r.version === 28), [{ version: 28, kind: 'aplicada' }]);
      const t = (await admin(demo, "select to_regclass('agx.bypass_a') is not null as a, to_regclass('agx.bypass_b') is not null as b")).rows[0];
      assert.deepEqual(t, { a: true, b: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exploit DESPUÉS: el mismo archivo aborta ANTES de ejecutar nada (sin ledger 0028, sin bypass_a/b)', async () => {
    const f = path.join(MIG_DIR(root), '0028_bypass_quoted_identifier.sql');
    fs.writeFileSync(f, EXPLOIT);
    try {
      await rejectsWith(run(['up', '--target', 'business'], url, root), 'AGX_MIGRATE_META_COMMAND');
      await rejectsWith(run(['plan', '--target', 'business'], url, root), 'AGX_MIGRATE_META_COMMAND');
      // Ni siquiera se conecta: con una URL inalcanzable falla igual por política, no por conexión.
      await rejectsWith(run(['up', '--target', 'business'], 'postgres://x:y@127.0.0.1:1/nada', root), 'AGX_MIGRATE_META_COMMAND');
      const out = path.join(root, 'b28.sql');
      await rejectsWith(migrate(['bundle', '--target', 'business', '--version', '28', '--out', out, '--root', root], { log: () => {} }), 'AGX_MIGRATE_META_COMMAND');
      assert.equal(fs.existsSync(out), false);
      assert.equal((await ledger(url)).length, 28);
      const t = (await admin(url, "select to_regclass('agx.bypass_a') as a, to_regclass('agx.bypass_b') as b")).rows[0];
      assert.deepEqual(t, { a: null, b: null });
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  test('LAST_ERROR_SQLSTATE es acumulativo en psql 16 y 18 (OK, ERROR ignorado, OK, OK)', () => {
    const script = [
      '\\set ON_ERROR_STOP 0',
      "\\echo 'inicio=' :LAST_ERROR_SQLSTATE",
      'select 1;', 'select 1 / 0;', 'select 2;', 'select 3;',
      "\\echo 'tras_exitos=' :LAST_ERROR_SQLSTATE",
      'begin;', '\\set ON_ERROR_ROLLBACK on', 'select 4;', "select 'x'::integer;", 'select 5;', 'commit;',
      "\\echo 'tras_on_error_rollback=' :LAST_ERROR_SQLSTATE", '',
    ].join('\n');
    const runs = [['local', null]];
    if (BUSINESS_CONTAINER) runs.push(['psql 16 (contenedor business)', BUSINESS_CONTAINER]);
    if (AUTH_CONTAINER) runs.push(['psql 18 (contenedor auth)', AUTH_CONTAINER]);
    assert.ok(runs.length === 3, 'faltan los contenedores para probar psql 16 y 18');
    for (const [label, container] of runs) {
      let res;
      if (container) {
        res = containerPsql(container, 'postgres', script);
      } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-lasterr-'));
        const f = path.join(dir, 's.sql');
        fs.writeFileSync(f, script);
        res = psqlFile(BUSINESS, f, ['-At']);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const lines = Object.fromEntries(res.stdout.replace(/\r/g, '').split('\n').filter((l) => l.includes('=')).map((l) => l.split('= ').map((x) => x.trim())));
      assert.equal(lines.inicio, '00000', `${label}: ${res.stdout}`);
      assert.equal(lines.tras_exitos, '22012', `${label}: el error se perdió tras sentencias exitosas`);
      assert.equal(lines.tras_on_error_rollback, '22P02', label);
    }
  });

  test('runtime: aunque la política estática fallara, el error acumulado aborta antes del ledger (OK, ERROR ignorado, OK, ledger, COMMIT -> FAIL)', async () => {
    const f = path.join(MIG_DIR(root), '0028_it_runtime.sql');
    fs.writeFileSync(f, 'create table agx.it_rt_ok1 (id integer);\n');
    // psql "manipulado": sustituye el contenido SQL puro por el exploit, como si el lexer no lo hubiera visto.
    const execPsql = (env, args) => {
      const file = args[args.indexOf('-f') + 1];
      const sql = fs.readFileSync(file, 'utf8').replace('create table agx.it_rt_ok1 (id integer);\n', `${EXPLOIT}create table agx.it_rt_ok2 (id integer);\n`);
      fs.writeFileSync(file, sql);
      return defaultExecPsql(env, args);
    };
    try {
      await rejectsWith(run(['up', '--target', 'business'], url, root, { execPsql }), 'AGX_MIGRATE_SUPPRESSED_ERROR');
      assert.equal((await ledger(url)).length, 28);
      const t = (await admin(url, "select to_regclass('agx.bypass_a') as a, to_regclass('agx.bypass_b') as b, to_regclass('agx.it_rt_ok2') as c")).rows[0];
      assert.deepEqual(t, { a: null, b: null, c: null });
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  test('marcador de COMMIT falso anterior al real (mismo nonce, xid committed ajeno) no engaña al runner', async () => {
    const empty = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_marker'));
    const foreignXid = (await admin(empty, 'select pg_current_xact_id()::text as x')).rows[0].x; // transacción ajena, committed
    const execPsql = (env, args) => {
      const file = args[args.indexOf('-f') + 1];
      let sql = fs.readFileSync(file, 'utf8');
      const nonce = /AGX_MIGRATE_COMMITTED ([0-9a-f]{32}) xid=/.exec(sql)[1];
      sql = sql
        .replace(/-- <agx-migrate-commit>[\s\S]*?-- <\/agx-migrate-commit>/, 'rollback;')
        .replace('begin;', `\\echo 'AGX_MIGRATE_COMMITTED ${nonce} xid=' ${foreignXid}\nbegin;`);
      fs.writeFileSync(file, sql);
      const res = defaultExecPsql(env, args);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(res.stdout.indexOf(`xid= ${foreignXid}`) < res.stdout.lastIndexOf('AGX_MIGRATE_COMMITTED'));
      return res;
    };
    // fresh sin ledger (0000..0026): solo el xid puede probar el COMMIT.
    await rejectsWith(run(['up', '--target', 'business', '--fresh', '--to', '26', ...BUSINESS_VARS], empty, root, { execPsql }), 'AGX_MIGRATE_POST_VERIFY');
    assert.equal((await admin(empty, "select to_regnamespace('agx') as r")).rows[0].r, null);
  });

  test('diferencial lexer vs psql real: si psql ejecuta el metacomando, el lexer lo detecta (o rechaza el archivo)', () => {
    const fragments = [
      '"it\'s"', '"a--b"', 'x$q$', '$q$', "E'\\''", "e'\\\\'", "'it''s'", "'a\\'", '$$', '$t$ \' $t$', '/* /* */ */', '/* */',
      '--', ';', '\n', ' ', '\t', ' ', "U&'x'", 'U&"a\'b"', "N'x'", "B'1'", ":'v'", ':v', '::text', 'select 1', '"', "'", '$', 'x', '1', '/*', '*/', "E'", '\\\\',
      "-- 'x\n", '-- "x\n', '-- $q$\n', "/* ' */", "1E'\\'", "2x'\\'", 'a1$q$', '1$q$',
    ];
    let seed = 42;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-diff-'));
    let executed = 0;
    let rejected = 0;
    try {
      for (let c = 0; c < 160; c += 1) {
        let prefix = '';
        for (let k = 0, len = 1 + rnd(6); k < len; k += 1) prefix += fragments[rnd(fragments.length)];
        const mark = `AGXMARK${c}`;
        const sql = `${prefix} \\echo ${mark}\nselect 1;\n`;
        const f = path.join(dir, `c${c}.sql`);
        fs.writeFileSync(f, sql);
        const res = psqlFile(BUSINESS, f, ['-v', 'ON_ERROR_STOP=0']);
        const ran = res.stdout.replace(/\r/g, '').split('\n').some((l) => l.trim() === mark);
        let detected;
        try {
          detected = lexPsql(sql).metas.some((m) => m.text.includes(mark));
        } catch (e) {
          assert.equal(e.code, 'AGX_MIGRATE_LEXER');
          detected = 'rechazado';
          rejected += 1;
        }
        if (ran) {
          executed += 1;
          assert.ok(detected, `psql ejecutó el metacomando y el lexer no lo vio: ${JSON.stringify(prefix)}`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // El corpus aleatorio debe ejercer ambos lados (casos que psql ejecuta y casos ocultos/rechazados).
    assert.ok(executed > 20, `solo ${executed} casos ejecutados`);
    assert.ok(rejected > 5, `solo ${rejected} casos rechazados`);
  });
});

// ---------------------------------------------------------------------
// Interpolación psql :var sin comillas (revisión final PR #119).
// ---------------------------------------------------------------------
describe('interpolación psql: solo :\'nombre\' en migraciones nuevas (payload real \\echo PWNED)', { skip }, () => {
  const PAYLOAD = '\\echo PWNED';
  let root;
  let url;

  before(async () => {
    root = sandbox();
    url = dbUrl(BUSINESS, await createDb(BUSINESS, 'agx_var'));
    await run(['up', '--target', 'business', '--fresh', ...BUSINESS_VARS], url, root);
  });

  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('psql real: :payload ejecuta el metacomando; :\'payload\' y :"payload" no', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-var-'));
    try {
      const runCase = (sql) => {
        const f = path.join(dir, 'c.sql');
        fs.writeFileSync(f, sql);
        const r = psqlFile(url, f, ['-v', 'ON_ERROR_STOP=0', '-v', `payload=${PAYLOAD}`, '-At']);
        return { out: r.stdout.replace(/\r/g, '').split('\n').map((l) => l.trim()), err: r.stderr };
      };
      const raw = runCase('select 1 :payload\nselect 2;\n');
      assert.ok(raw.out.includes('PWNED'), 'con :payload psql debería ejecutar el \\echo (motivo de la regla)');
      const lit = runCase("select :'payload';\n");
      assert.ok(!lit.out.includes('PWNED'), ':\'payload\' no debe ejecutar el metacomando');
      assert.ok(lit.out.includes(PAYLOAD), ':\'payload\' se devuelve como dato literal');
      const ident = runCase('select :"payload";\n');
      assert.ok(!ident.out.includes('PWNED'));
      assert.match(ident.err, /column ".*echo PWNED" does not exist|no existe la columna/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A. migración nueva con :payload: el runner la rechaza ANTES de conectar o ejecutar', async () => {
    const f = path.join(MIG_DIR(root), '0028_var_raw.sql');
    fs.writeFileSync(f, 'select 1 :payload;\n');
    const env = { extraEnv: { AGX_MIG_PAYLOAD: PAYLOAD } };
    try {
      await rejectsWith(run(['up', '--target', 'business', '--var', 'payload=AGX_MIG_PAYLOAD'], url, root, env), 'AGX_MIGRATE_UNSAFE_VAR');
      await rejectsWith(run(['up', '--target', 'business', '--var', 'payload=AGX_MIG_PAYLOAD'], 'postgres://x:y@127.0.0.1:1/nada', root, env), 'AGX_MIGRATE_UNSAFE_VAR');
      const out = path.join(root, 'b28.sql');
      await rejectsWith(migrate(['bundle', '--target', 'business', '--version', '28', '--out', out, '--root', root], { log: () => {} }), 'AGX_MIGRATE_UNSAFE_VAR');
      assert.equal(fs.existsSync(out), false);
      assert.equal((await ledger(url)).length, 28);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  test('C. migración nueva con :"payload": rechazada', async () => {
    const f = path.join(MIG_DIR(root), '0028_var_ident.sql');
    fs.writeFileSync(f, 'select 1 from :"payload";\n');
    try {
      await rejectsWith(run(['plan', '--target', 'business'], url, root), 'AGX_MIGRATE_UNSAFE_VAR');
      assert.equal((await ledger(url)).length, 28);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  test("B. migración nueva con :'payload': se aplica y el valor es un dato, nunca un metacomando", async () => {
    const f = path.join(MIG_DIR(root), '0028_var_literal.sql');
    fs.writeFileSync(f, "create table agx.it_var (v text);\ninsert into agx.it_var values (:'payload');\nselect :'payload' as eco;\n");
    const seen = [];
    const execPsql = (env, args) => {
      const res = defaultExecPsql(env, args);
      seen.push(res.stdout || '', res.stderr || '');
      return res;
    };
    try {
      await run(['up', '--target', 'business', '--var', 'payload=AGX_MIG_PAYLOAD'], url, root, { extraEnv: { AGX_MIG_PAYLOAD: PAYLOAD }, execPsql });
      const text = seen.join('\n').replace(/\r/g, '');
      assert.ok(!text.split('\n').some((l) => l.trim() === 'PWNED'), 'el \\echo no debe ejecutarse');
      assert.equal((await admin(url, 'select v from agx.it_var')).rows[0].v, PAYLOAD);
      const rows = await ledger(url);
      assert.deepEqual(rows[rows.length - 1], { version: 28, kind: 'aplicada' });
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});
