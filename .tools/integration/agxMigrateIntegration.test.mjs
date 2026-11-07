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
import { main as migrate } from '../agx-migrate.mjs';

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

/** Copia aislada del repo mínimo: migraciones reales + huella, para añadir migraciones sintéticas. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-it-'));
  for (const rel of ['db/agx-business/migrations', 'db/agx/migrations', 'db/agx-business/verify', 'db/agx/verify', 'db/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  }
  return root;
}

async function run(args, url, root) {
  const env = { ...process.env, ...secrets, AGX_MIG_URL: url };
  const logs = [];
  await migrate([...args, '--url-env', 'AGX_MIG_URL', ...(root ? ['--root', root] : [])], { env, log: (l) => logs.push(l) });
  return logs;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function psqlFile(url, file) {
  const u = new URL(url);
  return spawnSync(process.env.PSQL_BIN || 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8',
    env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port, PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGCLIENTENCODING: 'UTF8' },
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
    const evidence = path.join(root, 'evidencia.dump');
    fs.writeFileSync(evidence, Buffer.from('PGDMP\u0001\u000f'));
    // No es el tope: el servidor lo rechaza.
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '25', '--allow-historical-destructive-rollback', '25', '--backup-evidence', evidence], url, root), 'AGX_MIGRATE_ROLLBACK_NOT_TOP');
    // El ledger nunca se revierte con el runner.
    await rejectsWith(run(['rollback', '--target', 'business', '--version', '27', '--confirm-rollback', '27'], url, root), 'AGX_MIGRATE_LEDGER_ROLLBACK_FORBIDDEN');
    // Edición manual del ledger bloqueada por trigger, incluso para el superusuario.
    await assert.rejects(admin(url, 'delete from agx_meta.schema_migrations where version = 26'), /append-only|solo dentro de un rollback/);
    await assert.rejects(admin(url, "update agx_meta.schema_migrations set kind = 'aplicada' where version = 1"), /append-only/);
    await assert.rejects(admin(url, 'truncate agx_meta.schema_migration_eventos'), /append-only/);
    // Con la opción extraordinaria, evidencia y tabla vacía, el histórico 0026 sí corre.
    await run(['rollback', '--target', 'business', '--version', '26', '--allow-historical-destructive-rollback', '26', '--backup-evidence', evidence], url, root);
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
      env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port, PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) },
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
