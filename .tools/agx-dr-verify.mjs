#!/usr/bin/env node
// HARDENING PRE-SANIDAD (PR A) -- verificación DR reproducible y LOCAL.
//
//   node .tools/agx-dr-verify.mjs --target business|auth|all [--keep]
//
// Por cada target, con dos clusters Docker desechables (origen y destino
// VACÍO, misma versión mayor que producción):
//   1. origen: base construida desde cero con el runner (--fresh) + fixtures
//      sintéticos escritos POR EL ROL RUNTIME (nunca datos reales);
//   2. roles-only sin contraseñas (pg_dumpall --roles-only --no-role-passwords,
//      filtrado a los roles de la aplicación) + pg_dump -Fc;
//   3. control negativo: pg_restore estricto SIN roles en el destino debe fallar;
//   4. destino: roles -> pg_restore --exit-on-error --single-transaction;
//   5. huella de catálogo origen == destino (schemas, extensiones, tablas,
//      secuencias, columnas, PK/FK/UNIQUE/CHECK, índices, funciones, triggers,
//      RLS/FORCE, policies, grants de tabla y columna, ownership, roles);
//   6. mismas filas por tabla;
//   7. smoke con el rol runtime (agx_app / agx_auth), nunca postgres.
// Nunca toca producción: solo contenedores creados por este script.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startCluster, stopCluster } from './agx-docker-pg.mjs';
import { main as migrate } from './agx-migrate.mjs';
import { TARGETS, listMigrations, sanitizedPgEnv } from './agx-migrate-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DB = 'agx_dr_test';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const SPECS = {
  business: {
    schemas: 'agx,agx_meta',
    roles: ['agx_owner', 'agx_app', 'agx_qr_admin', 'agx_ficha_pastura_validator'],
    runtimeRole: 'agx_app',
    vars: { agx_app_password: 'AGX_DR_APP_PASSWORD', agx_qr_admin_password: 'AGX_DR_QR_PASSWORD' },
  },
  auth: {
    schemas: 'agx',
    roles: ['agx_owner', 'agx_auth'],
    runtimeRole: 'agx_auth',
    vars: { agx_auth_password: 'AGX_DR_AUTH_PASSWORD' },
  },
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) throw new Error(`verificación fallida: ${name}`);
}

function randomSecret() {
  return crypto.randomBytes(18).toString('hex');
}

function fingerprint(cluster, schemas, password = cluster.password, user = 'postgres') {
  const res = spawnSync(process.env.PSQL_BIN || 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `schemas=${schemas}`,
    '-f', path.join(ROOT, 'db/verify/schema_fingerprint.sql')], {
    encoding: 'utf8',
    env: sanitizedPgEnv(process.env, { PGHOST: '127.0.0.1', PGPORT: cluster.port, PGUSER: user, PGPASSWORD: password, PGDATABASE: DB, PGCLIENTENCODING: 'UTF8' }),
  });
  if (res.status !== 0) throw new Error(`huella falló: ${(res.stderr || '').trim().split('\n')[0]}`);
  return res.stdout.replace(/\r/g, '').split('\n').filter(Boolean);
}

/**
 * pg_restore vuelve a parsear los CHECK y PostgreSQL los deparsea con
 * casts distintos (p. ej. ARRAY[...]::text[] vs ARRAY[('X'::varchar)::text]).
 * Semánticamente idénticos; se normalizan SOLO esas líneas para comparar.
 */
export function normalizeForRestoreCompare(line) {
  const [type] = line.split('|');
  if ((type === 'constraint' && line.includes('CHECK')) || (type === 'index' && line.includes(' WHERE '))) {
    return line.replace(/::(character varying|text)(\[\])?/g, '').replace(/[()\s]/g, '');
  }
  // Un ACL materializado idéntico al default del dueño (p. ej. tras
  // `revoke ... from public`) es equivalente a NULL, y pg_dump no lo emite.
  if (type === 'relation') {
    const owner = /\|owner=([^|]+)\|/.exec(line)?.[1];
    const kind = /\|kind=([^|]+)\|/.exec(line)?.[1];
    const defaults = kind === 'S' ? [`${owner}=rwU/${owner}`] : [`${owner}=arwdDxt/${owner}`, `${owner}=arwdDxtm/${owner}`];
    return defaults.reduce((l, d) => l.replace(`|acl=${d}`, '|acl=-'), line);
  }
  if (type === 'schema') {
    const owner = /\|owner=([^|]+)\|/.exec(line)?.[1];
    return line.replace(`|acl={${owner}=UC/${owner}}`, '|acl=-');
  }
  if (type === 'function') {
    const owner = /\|owner=([^|]+)\|/.exec(line)?.[1];
    return line.replace(`|acl==X/${owner},${owner}=X/${owner}|`, '|acl=-|');
  }
  return line;
}

/** Sentencias de nivel base de datos que pg_restore solo aplica con -C (incompatible con --single-transaction). */
export function databaseLevelStatements(createSql, sourceDb, targetDb) {
  const esc = sourceDb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return createSql.replace(/\r/g, '').split('\n')
    .filter((l) => new RegExp(`^(GRANT|REVOKE) .+ ON DATABASE ${esc} |^ALTER DATABASE ${esc} SET `).test(l))
    .map((l) => l.replace(new RegExp(`(ON DATABASE|ALTER DATABASE) ${esc}\\b`), `$1 ${targetDb}`));
}

async function withClient(cluster, { user = 'postgres', password = cluster.password } = {}, fn) {
  const client = new pg.Client({ host: '127.0.0.1', port: Number(cluster.port), user, password, database: DB });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function expectError(client, sql, code, params = []) {
  await client.query('savepoint agx_dr');
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query('rollback to savepoint agx_dr');
    return error.code === code ? true : `código ${error.code}`;
  }
  await client.query('rollback to savepoint agx_dr');
  return 'no falló';
}

async function inOrg(client, org, fn) {
  await client.query('begin');
  try {
    await client.query("select set_config('app.current_org_id', $1, true)", [org]);
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

async function seedBusiness(cluster, appPassword) {
  await withClient(cluster, { user: 'agx_app', password: appPassword }, async (c) => {
    for (const [org, nombre, visual] of [[ORG_A, 'Predio fixture A', 'A-001'], [ORG_B, 'Predio fixture B', 'B-001']]) {
      await c.query('begin');
      await c.query("select set_config('app.current_org_id', $1, true)", [org]);
      const { rows } = await c.query('insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id', [org, nombre]);
      await c.query(
        `insert into agx.animales (organizacion_id, predio_id, sexo, numero_visual, client_operation_id, creation_intent_hash)
         values ($1, $2, 'HEMBRA', $3, $4, $5)`,
        [org, rows[0].predio_id, visual, crypto.randomUUID(), `v1:${crypto.randomBytes(32).toString('hex')}`],
      );
      await c.query('commit');
    }
  });
}

async function seedAuth(cluster, authPassword) {
  const tokenHash = crypto.randomBytes(32).toString('hex');
  await withClient(cluster, { user: 'agx_auth', password: authPassword }, async (c) => {
    await c.query('begin');
    const org = (await c.query("insert into agx.organizaciones (nombre) values ('Org fixture DR') returning organizacion_id")).rows[0].organizacion_id;
    const cuenta = (await c.query("insert into agx.cuentas (email, nombre) values ('fixture.dr@example.test', 'Fixture DR') returning cuenta_id")).rows[0].cuenta_id;
    await c.query("insert into agx.membresias (cuenta_id, organizacion_id, rol, estado) values ($1, $2, 'owner', 'activa')", [cuenta, org]);
    await c.query("insert into agx.sesiones (cuenta_id, organizacion_id, token_hash, fecha_expiracion) values ($1, $2, $3, now() + interval '1 day')", [cuenta, org, tokenHash]);
    await c.query('commit');
  });
  return tokenHash;
}

async function rowCounts(cluster, schemas) {
  return withClient(cluster, {}, async (c) => {
    const { rows } = await c.query(
      `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = any ($1::text[]) order by 1`, [schemas.split(',')]);
    const out = {};
    for (const { t } of rows) out[t] = Number((await c.query(`select count(*) from ${t}`)).rows[0].count);
    return out;
  });
}

function filterRoles(rolesSql, keep) {
  const re = new RegExp(`^(CREATE ROLE|ALTER ROLE|GRANT [a-z_]+ TO) (${keep.join('|')})\\b`);
  const lines = rolesSql.replace(/\r/g, '').split('\n').filter((l) => re.test(l));
  return `\\set ON_ERROR_STOP 1\n${lines.join('\n')}\n`;
}

async function smokeBusiness(dst, appPassword) {
  await withClient(dst, { user: 'agx_app', password: appPassword }, async (c) => {
    const who = (await c.query("select current_user as u, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user")).rows[0];
    check('business: conexión runtime = agx_app sin SUPERUSER/BYPASSRLS', who.u === 'agx_app' && !who.rolsuper && !who.rolbypassrls);
    check('business: sin organización fijada no se ve ninguna fila', Number((await c.query('select count(*) from agx.predios')).rows[0].count) === 0);
    await inOrg(c, ORG_A, async () => {
      const own = Number((await c.query('select count(*) from agx.animales')).rows[0].count);
      const other = Number((await c.query('select count(*) from agx.predios where organizacion_id = $1', [ORG_B])).rows[0].count);
      check('business: tenant A ve sus filas (SELECT permitido)', own === 1);
      check('business: tenant B invisible para A', other === 0);
      await c.query("insert into agx.predios (organizacion_id, nombre_predio) values ($1, 'Smoke permitido')", [ORG_A]);
      check('business: INSERT permitido dentro del tenant', true);
      check('business: INSERT con organización ajena rechazado por RLS', (await expectError(c, "insert into agx.predios (organizacion_id, nombre_predio) values ($1, 'x')", '42501', [ORG_B])) === true);
      check('business: mover fila a otra organización rechazado por RLS', (await expectError(c, 'update agx.predios set organizacion_id = $1', '42501', [ORG_B])) === true);
      check('business: DELETE sin privilegio (predios)', (await expectError(c, 'delete from agx.predios', '42501')) === true);
      check('business: UPDATE de columna no concedida (animales.organizacion_id)', (await expectError(c, 'update agx.animales set organizacion_id = organizacion_id', '42501')) === true);
      check('business: agx_app no lee agx_meta', (await expectError(c, 'select count(*) from agx_meta.schema_migrations', '42501')) === true);
      check('business: agx_app no escribe agx_meta', (await expectError(c, "insert into agx_meta.schema_migrations (version, filename, checksum_sha256, kind, runner_version) values (9999, '9999_x.sql', repeat('0', 64), 'aplicada', 'x')", '42501')) === true);
      check('business: agx_app sin acceso a lotes QR', (await expectError(c, 'select count(*) from agx.qr_lotes', '42501')) === true);
    });
  });
  await withClient(dst, {}, async (c) => {
    // Una fila por migración UP del repo (0000..última): el origen se construyó con --fresh.
    const esperadas = listMigrations(path.join(ROOT, TARGETS.business.dir), 'business').length;
    const n = Number((await c.query('select count(*) from agx_meta.schema_migrations')).rows[0].count);
    check(`business: ledger restaurado completo (0000-${String(esperadas - 1).padStart(4, '0')})`, n === esperadas, `${n} filas`);
  });
}

async function smokeAuth(dst, authPassword, tokenHash) {
  await withClient(dst, { user: 'agx_auth', password: authPassword }, async (c) => {
    const who = (await c.query("select current_user as u, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user")).rows[0];
    check('auth: conexión runtime = agx_auth sin SUPERUSER/BYPASSRLS', who.u === 'agx_auth' && !who.rolsuper && !who.rolbypassrls);
    const resolved = (await c.query('select * from agx.fn_resolver_autorizacion_sesion($1)', [tokenHash])).rows;
    check('auth: fn_resolver_autorizacion_sesion resuelve la sesión restaurada', resolved.length === 1 && resolved[0].rol === 'owner');
    await c.query('begin');
    await c.query("insert into agx.eventos_seguridad_auth (tipo, email_fingerprint) values ('LOGOUT', repeat('a', 64))");
    check('auth: INSERT permitido (eventos_seguridad_auth)', true);
    check('auth: DELETE sin privilegio (cuentas)', (await expectError(c, 'delete from agx.cuentas', '42501')) === true);
    check('auth: UPDATE sin privilegio (membresias)', (await expectError(c, "update agx.membresias set rol = 'lector'", '42501')) === true);
    check('auth: staff_crh solo lectura', (await expectError(c, "insert into agx.staff_crh (cuenta_id, rol_interno) values (gen_random_uuid(), 'soporte')", '42501')) === true);
    await c.query('rollback');
  });
  await withClient(dst, {}, async (c) => {
    await c.query('begin');
    await c.query("update agx.membresias set estado = 'revocada'");
    const n = Number((await c.query('select count(*) from agx.sesiones where fecha_revocacion is null')).rows[0].count);
    await c.query('rollback');
    check('auth: trigger de revocación restaurado y operativo', n === 0);
  });
}

async function verifyTarget(kind, { keep }) {
  const spec = SPECS[kind];
  const env = { ...process.env };
  const passwords = {};
  for (const [v, e] of Object.entries(spec.vars)) { env[e] = randomSecret(); passwords[v] = env[e]; }
  const runtimePassword = kind === 'business' ? passwords.agx_app_password : passwords.agx_auth_password;
  console.log(`\n=== DR ${kind} ===`);
  let src;
  let dst;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-dr-'));
  try {
    [src, dst] = [await startCluster(kind, `dr-src-${kind}`), await startCluster(kind, `dr-dst-${kind}`)];
    src.exec(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qc', `create database ${DB}`]);
    env.AGX_DR_SRC_URL = src.adminUrl(DB);
    await migrate(['up', '--target', kind, '--url-env', 'AGX_DR_SRC_URL', '--fresh',
      ...Object.entries(spec.vars).flatMap(([v, e]) => ['--var', `${v}=${e}`])], { env, log: () => {} });
    check(`${kind}: origen construido desde cero con el runner`, true);
    const tokenHash = kind === 'business' ? (await seedBusiness(src, runtimePassword), null) : await seedAuth(src, runtimePassword);
    check(`${kind}: fixtures sintéticos escritos por el rol runtime`, true);

    const rolesSql = filterRoles(src.exec(['pg_dumpall', '-U', 'postgres', '--roles-only', '--no-role-passwords']).stdout, spec.roles);
    check(`${kind}: roles-only sin contraseñas`, !/PASSWORD/i.test(rolesSql) && spec.roles.every((r) => rolesSql.includes(`CREATE ROLE ${r};`)));
    // --create: guarda también propiedades/ACL de la base (p. ej. GRANT CONNECT de 0023).
    src.exec(['pg_dump', '-U', 'postgres', '-Fc', '--create', '-d', DB, '-f', '/tmp/agx_dr.dump']);
    const dump = src.exec(['cat', '/tmp/agx_dr.dump'], { encoding: 'buffer' }).stdout;
    check(`${kind}: pg_dump -Fc generado`, dump.subarray(0, 5).toString('latin1') === 'PGDMP', `${dump.length} bytes`);
    dst.exec(['sh', '-c', 'cat > /tmp/agx_dr.dump'], { input: dump, encoding: 'buffer' });

    const preRoles = dst.exec(['psql', '-U', 'postgres', '-tAc', "select count(*) from pg_roles where rolname like 'agx\\_%'"]).stdout.trim();
    check(`${kind}: destino es un cluster vacío (sin roles agx_*)`, preRoles === '0');
    dst.exec(['psql', '-U', 'postgres', '-qc', 'create database agx_dr_negative_test']);
    const negative = dst.exec(['pg_restore', '-U', 'postgres', '--exit-on-error', '--single-transaction', '-d', 'agx_dr_negative_test', '/tmp/agx_dr.dump'], { allowFail: true });
    check(`${kind}: control negativo -- pg_dump sin roles NO restaura en modo estricto`, negative.status !== 0 && /role .* does not exist/.test(negative.stderr));

    fs.writeFileSync(path.join(tmp, 'roles.sql'), rolesSql);
    dst.exec(['psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '-'], { input: rolesSql });
    dst.exec(['psql', '-U', 'postgres', '-qc', `create database ${DB}`]);
    dst.exec(['pg_restore', '-U', 'postgres', '--exit-on-error', '--single-transaction', '-d', DB, '/tmp/agx_dr.dump']);
    check(`${kind}: roles primero + pg_restore --exit-on-error --single-transaction`, true);
    const createSql = dst.exec(['pg_restore', '--create', '--schema-only', '-f', '-', '/tmp/agx_dr.dump']).stdout;
    const dbStatements = databaseLevelStatements(createSql, DB, DB);
    if (dbStatements.length) {
      dst.exec(['psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '-'], { input: `${dbStatements.join('\n')}\n` });
    }
    check(`${kind}: ACL/propiedades de la base reaplicadas desde el dump`, true, `${dbStatements.length} sentencias`);

    const a = fingerprint(src, spec.schemas);
    const b = fingerprint(dst, spec.schemas);
    const na = a.map(normalizeForRestoreCompare);
    const nb = b.map(normalizeForRestoreCompare);
    const missing = na.filter((l) => !nb.includes(l));
    const extra = nb.filter((l) => !na.includes(l));
    const cosmetic = a.filter((l, i) => l !== b[i]).length;
    if (missing.length || extra.length) {
      for (const l of missing.slice(0, 10)) console.log(`  - ${l.slice(0, 200)}`);
      for (const l of extra.slice(0, 10)) console.log(`  + ${l.slice(0, 200)}`);
    }
    const kinds = [...new Set(a.map((l) => l.split('|')[0]))].join(',');
    check(`${kind}: huella de catálogo origen == destino`, !missing.length && !extra.length && a.length === b.length,
      `${a.length} objetos (${kinds}); ${cosmetic} líneas con deparse/ACL equivalente normalizadas`);

    const [ca, cb] = [await rowCounts(src, spec.schemas), await rowCounts(dst, spec.schemas)];
    check(`${kind}: mismas filas por tabla`, JSON.stringify(ca) === JSON.stringify(cb), `${Object.values(ca).reduce((x, y) => x + y, 0)} filas`);

    dst.exec(['psql', '-U', 'postgres', '-qc', `alter role ${spec.runtimeRole} password '${runtimePassword}'`]);
    if (kind === 'business') await smokeBusiness(dst, runtimePassword);
    else await smokeAuth(dst, runtimePassword, tokenHash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!keep) { stopCluster(src); stopCluster(dst); } else console.log(`(--keep) contenedores: ${src?.name} ${dst?.name}`);
  }
}

export async function runDrVerify(argv = process.argv.slice(2)) {
  const target = argv[argv.indexOf('--target') + 1];
  const keep = argv.includes('--keep');
  if (!argv.includes('--target') || !['business', 'auth', 'all'].includes(target)) {
    throw new Error('uso: node .tools/agx-dr-verify.mjs --target business|auth|all [--keep]');
  }
  for (const kind of target === 'all' ? ['business', 'auth'] : [target]) await verifyTarget(kind, { keep });
  console.log(`\nDR: ${results.filter((r) => r.ok).length}/${results.length} PASS`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDrVerify().catch((error) => { console.error(`AGX_DR_FAIL: ${error.message}`); process.exitCode = 1; });
}
