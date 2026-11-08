#!/usr/bin/env node
// HARDENING PRE-SANIDAD (PR A) + guards -- runner de migraciones AGX.
//
// Uso (ver docs/runbooks/agx-db-dr-migraciones.md):
//   node .tools/agx-migrate.mjs status   --target business|auth
//   node .tools/agx-migrate.mjs plan     --target business --url-env VAR
//   node .tools/agx-migrate.mjs up       --target business --url-env VAR [--to N] [--var nombre=ENV_VAR]...
//   node .tools/agx-migrate.mjs up       --target business --url-env VAR --fresh [--to N] [--var ...]
//   node .tools/agx-migrate.mjs bundle   --target business --version N --out archivo.sql      (N >= ledger)
//   node .tools/agx-migrate.mjs bundle   --target business --fresh [--to N] --out archivo.sql (base vacía)
//   node .tools/agx-migrate.mjs rollback --target business --url-env VAR --version N [opciones de rollback]
//   node .tools/agx-migrate.mjs bundle-rollback --target business --version N --out archivo.sql [opciones]
//
// La URL nunca va en la línea de comandos: --url-env nombra la variable de
// entorno que la contiene. Solo hosts loopback salvo --allow-remote-host
// <host> exacto. El entorno de psql se construye sin variables PG* heredadas.
// Producción (sin TCP público) se migra con `bundle` + psql en el contenedor.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TARGETS, RUNNER_VERSION, SSL_MODES, fail, pad, listMigrations, ledgerEntries, planFromLedger,
  buildUpBundle, buildFreshBundle, buildRollbackBundle, assertRollbackAllowed, extractFingerprintQuery,
  certificationMd5, certificationLines, kindFor, ledgerExpectation, rollbackExpectation, sanitizedPgEnv, redact,
  newNonce, parseCommitMarker,
} from './agx-migrate-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const VAR_ENV_PREFIX = 'AGX_MIGRATE_VAR_';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { var: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw fail('AGX_MIGRATE_ARGS', `argumento inesperado: ${arg}`);
    const key = arg.slice(2);
    if (key === 'fresh') { options.fresh = true; continue; }
    if (key === 'force') { options.force = true; continue; }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw fail('AGX_MIGRATE_ARGS', `falta valor para --${key}`);
    i += 1;
    if (key === 'var') options.var.push(value);
    else options[key] = value;
  }
  return { command, options };
}

export function resolveTarget(options) {
  const base = TARGETS[options.target];
  if (!base) throw fail('AGX_MIGRATE_ARGS', '--target debe ser business o auth');
  const root = options.root ? path.resolve(options.root) : ROOT;
  return {
    name: options.target,
    ...base,
    dir: path.resolve(root, options['migrations-dir'] ?? base.dir),
    baselineFingerprint: base.baselineFingerprint && path.resolve(root, options['baseline-fingerprint'] ?? base.baselineFingerprint),
    fingerprintSql: path.resolve(root, 'db/verify/schema_fingerprint.sql'),
  };
}

const normalizeHost = (h) => String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');

/**
 * Entorno de conexión derivado SOLO de la URL aprobada: sin PG* heredadas,
 * host comparado tal como se usará (PGHOST), parámetros de URL no
 * soportados rechazados (solo `sslmode`).
 */
export function connectionEnv(options, env = process.env) {
  const name = options['url-env'];
  if (!name) throw fail('AGX_MIGRATE_ARGS', 'falta --url-env <VARIABLE> con la URL de conexión');
  const raw = env[name];
  if (!raw) throw fail('AGX_MIGRATE_ARGS', `la variable ${name} está vacía`);
  let url;
  try { url = new URL(raw); } catch { throw fail('AGX_MIGRATE_URL', `${name} no es una URL válida`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw fail('AGX_MIGRATE_URL', `${name} no es una URL PostgreSQL`);
  if (url.hash) throw fail('AGX_MIGRATE_URL', `${name}: fragmento (#) no soportado`);
  const params = [...url.searchParams.keys()];
  const unsupported = [...new Set(params.filter((k) => k !== 'sslmode'))];
  if (unsupported.length) throw fail('AGX_MIGRATE_URL_PARAM', `${name}: parámetros de URL no soportados por el runner: ${unsupported.join(', ')}`);
  const sslmodes = url.searchParams.getAll('sslmode');
  if (sslmodes.length > 1 || (sslmodes.length && !SSL_MODES.has(sslmodes[0]))) {
    throw fail('AGX_MIGRATE_URL_PARAM', `${name}: sslmode no válido`);
  }
  const host = normalizeHost(url.hostname);
  if (!host || /[,%/\\@\s]/.test(host)) throw fail('AGX_MIGRATE_URL', `${name}: host no válido (uno solo, sin socket ni lista)`);
  if (url.port && !/^\d+$/.test(url.port)) throw fail('AGX_MIGRATE_URL', `${name}: puerto no válido`);
  const allowed = options['allow-remote-host'] === undefined ? null : normalizeHost(options['allow-remote-host']);
  if (!LOOPBACK.has(host) && allowed !== host) {
    throw fail('AGX_MIGRATE_REMOTE_BLOCKED', `host no loopback; requiere --allow-remote-host ${host}`);
  }
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!user) throw fail('AGX_MIGRATE_URL', `${name}: falta el usuario`);
  if (!database || database.includes('/')) throw fail('AGX_MIGRATE_URL', `${name}: falta la base de datos`);
  const pgVars = {
    PGHOST: host,
    PGPORT: url.port || '5432',
    PGUSER: user,
    PGDATABASE: database,
    PGCLIENTENCODING: 'UTF8',
    PGAPPNAME: RUNNER_VERSION,
    PGCONNECT_TIMEOUT: '15',
    // Sin contraseña en la URL no se recurre a ~/.pgpass.
    PGPASSFILE: path.join(os.tmpdir(), 'agx-migrate-sin-pgpass'),
  };
  if (url.password) pgVars.PGPASSWORD = decodeURIComponent(url.password);
  if (sslmodes.length) pgVars.PGSSLMODE = sslmodes[0];
  return sanitizedPgEnv(env, pgVars);
}

function psqlVars(options, env = process.env) {
  const out = {};
  for (const spec of options.var) {
    const m = /^([a-z_][a-z0-9_]*)=([A-Z_][A-Z0-9_]*)$/.exec(spec);
    if (!m) throw fail('AGX_MIGRATE_ARGS', `--var debe ser nombre=VARIABLE_DE_ENTORNO (${spec})`);
    if (!env[m[2]]) throw fail('AGX_MIGRATE_ARGS', `la variable de entorno ${m[2]} (para ${m[1]}) está vacía`);
    out[m[1]] = env[m[2]];
  }
  return out;
}

export function defaultExecPsql(env, args) {
  const bin = process.env.PSQL_BIN || 'psql';
  const res = spawnSync(bin, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw fail('AGX_MIGRATE_PSQL', `no se pudo ejecutar psql (${res.error.code})`);
  return res;
}

const secretsOf = (env, vars = {}) => [env.PGPASSWORD, ...Object.values(vars)];

function query(env, sql) {
  const res = defaultExecPsql(env, ['-At', '-c', sql]);
  if (res.status !== 0) throw fail('AGX_MIGRATE_PSQL', redact((res.stderr || '').trim().split('\n')[0], secretsOf(env)));
  return res.stdout.replace(/\r/g, '').trim();
}

function readLedger(env) {
  const json = query(env, "select coalesce(json_agg(json_build_object('version', version, 'filename', filename, 'checksum', checksum_sha256, 'kind', kind) order by version), '[]') from agx_meta.schema_migrations");
  return JSON.parse(json);
}

export function readDbState(env) {
  const flags = query(env, "select (to_regnamespace('agx') is not null)::text || '|' || (to_regclass('agx_meta.schema_migrations') is not null)::text");
  const [hasAgx, hasLedger] = flags.split('|').map((v) => v === 'true');
  return { hasAgx, hasLedger, ledger: hasLedger ? readLedger(env) : null };
}

/** Comprobación cliente tras psql: mismo criterio que el post-check del bundle. */
export function verifyLedgerExpectation(ledger, expectation) {
  const byVersion = new Map((ledger ?? []).map((r) => [r.version, r]));
  const bad = [];
  for (const e of expectation.present) {
    const r = byVersion.get(e.version);
    if (!r) bad.push(`${pad(e.version)} ausente`);
    else if (r.filename !== e.filename || r.checksum !== e.checksum || r.kind !== e.kind) bad.push(`${pad(e.version)} difiere (${r.filename}/${r.kind})`);
  }
  for (const v of expectation.absent) if (byVersion.has(v)) bad.push(`${pad(v)} sigue registrada`);
  if (bad.length) throw fail('AGX_MIGRATE_POST_VERIFY', `el ledger no refleja la ejecución: ${bad.slice(0, 5).join('; ')}`);
}

function runBundle({ env, sql, nonce, vars, label, log, expectation, execPsql }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-migrate-'));
  const file = path.join(dir, 'bundle.sql');
  // Las variables (contraseñas) viajan por el entorno del proceso psql y
  // \getenv, nunca en argv ni en el archivo.
  const childEnv = { ...env };
  const getenv = [];
  for (const [k, v] of Object.entries(vars)) {
    childEnv[`${VAR_ENV_PREFIX}${k}`] = v;
    getenv.push(`\\getenv ${k} ${VAR_ENV_PREFIX}${k}`);
  }
  fs.writeFileSync(file, `${getenv.join('\n')}${getenv.length ? '\n' : ''}${sql}`, 'utf8');
  const secrets = secretsOf(env, vars);
  try {
    const res = execPsql(childEnv, ['-f', file]);
    if (res.status !== 0) {
      // El error que detuvo psql es el ÚLTIMO (con ON_ERROR_STOP, psql se detiene en él).
      const err = (res.stderr || '').replace(/\r/g, '').split('\n').filter((l) => /ERROR|FATAL/.test(l)).pop() || `psql salió con ${res.status}`;
      const code = /AGX_MIGRATE_[A-Z_]+/.exec(err)?.[0] ?? 'AGX_MIGRATE_SQL_ERROR';
      const detail = err.replace(/^.*?(ERROR|FATAL):\s*/, '').replace(/^AGX_MIGRATE_[A-Z_]+:\s*/, '');
      throw fail(code, redact(`${label}: ${detail} (transacción revertida, ledger sin cambios)`, secrets));
    }
    // psql pudo terminar con 0 aunque la transacción no hiciera COMMIT:
    // se verifica el ledger y el estado real del xid.
    if (expectation) {
      const state = readDbState(env);
      verifyLedgerExpectation(state.ledger, expectation);
    }
    // Solo cuenta la ÚLTIMA marca con el nonce de esta ejecución.
    const xid = parseCommitMarker(res.stdout, nonce);
    if (!xid) throw fail('AGX_MIGRATE_POST_VERIFY', `${label}: psql no emitió la marca de COMMIT`);
    const status = query(env, `select pg_xact_status('${xid}'::xid8)`);
    if (status !== 'committed') throw fail('AGX_MIGRATE_POST_VERIFY', `${label}: la transacción ${xid} terminó ${status || 'sin estado'}, no committed`);
    log(`OK ${label}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fingerprintSpec(target) {
  if (!target.baselineFingerprint) return null;
  const reference = fs.readFileSync(target.baselineFingerprint, 'utf8');
  return {
    query: extractFingerprintQuery(fs.readFileSync(target.fingerprintSql, 'utf8')),
    schemas: target.fingerprintSchemas,
    expectedMd5: certificationMd5(reference),
    expectedLines: certificationLines(reference).length,
  };
}

/** Bundle de UNA migración con ledger (bootstrap o normal). Las anteriores al ledger: solo --fresh. */
export function bundleFor(target, migrations, version) {
  const migration = migrations.find((m) => m.version === version);
  if (!migration) throw fail('AGX_MIGRATE_ARGS', `no existe la migración ${pad(version)}`);
  const kind = kindFor(target, version);
  if (kind === 'plain') {
    throw fail('AGX_MIGRATE_HISTORICAL_BUNDLE_BLOCKED', `${migration.filename} es anterior al ledger: solo se construye con --fresh sobre una base vacía`);
  }
  const expected = ledgerEntries(migrations, version);
  const nonce = newNonce();
  const sql = buildUpBundle({ target: target.name, migration, kind, expected, fingerprint: kind === 'bootstrap' ? fingerprintSpec(target) : null, nonce });
  return { migration, kind, sql, nonce, expectation: ledgerExpectation({ migration, kind, expected }) };
}

export function freshBundleFor(target, migrations, options) {
  if (options.version !== undefined) throw fail('AGX_MIGRATE_ARGS', '--fresh construye 0000..N: use --to N, no --version');
  const to = options.to === undefined ? migrations.length - 1 : Number(options.to);
  if (!Number.isInteger(to) || to < 0 || to >= migrations.length) throw fail('AGX_MIGRATE_ARGS', `--to fuera de rango: ${options.to}`);
  const needsFp = target.ledgerVersion !== null && to >= target.ledgerVersion;
  const built = buildFreshBundle({ target: target.name, config: target, migrations, to, fingerprint: needsFp ? fingerprintSpec(target) : null });
  return { ...built, to, chosen: migrations.filter((m) => m.version <= to) };
}

function requireVars(list, vars) {
  for (const migration of list) {
    const missing = migration.variables.filter((v) => !(v in vars));
    if (missing.length) throw fail('AGX_MIGRATE_ARGS', `${migration.filename} requiere --var ${missing.map((v) => `${v}=ENV`).join(' --var ')}`);
  }
}

function rollbackPlan(target, migrations, options, log) {
  const version = Number(options.version);
  const migration = migrations.find((m) => m.version === version);
  if (!migration) throw fail('AGX_MIGRATE_ARGS', `no existe ${pad(version)}`);
  const { historical, evidence } = assertRollbackAllowed({ config: target, version, options });
  if (evidence) log(`backup-evidence sha256=${evidence.sha256} bytes=${evidence.size} entradas_toc=${evidence.entries}`);
  const nonce = newNonce();
  return { version, migration, historical, nonce, sql: buildRollbackBundle({ target: target.name, migration, ledgerVersion: target.ledgerVersion, historical, evidence, nonce }) };
}

export async function main(argv, { env = process.env, log = console.log, execPsql = defaultExecPsql } = {}) {
  const { command, options } = parseArgs(argv);
  const target = resolveTarget(options);
  const migrations = listMigrations(target.dir, target.name);

  if (command === 'status') {
    for (const m of migrations) log(`${pad(m.version)} ${m.filename} sha256=${m.checksum}${m.rollback ? ' [rollback]' : ''}${m.variables.length ? ` vars=${m.variables.join(',')}` : ''}`);
    return 0;
  }

  if (command === 'bundle' || command === 'bundle-rollback') {
    if (!options.out) throw fail('AGX_MIGRATE_ARGS', 'requiere --out archivo');
    let sql;
    if (command === 'bundle' && options.fresh) {
      sql = freshBundleFor(target, migrations, options).sql;
    } else if (command === 'bundle') {
      const version = Number(options.version);
      if (!Number.isInteger(version)) throw fail('AGX_MIGRATE_ARGS', 'requiere --version N');
      sql = bundleFor(target, migrations, version).sql;
    } else {
      sql = rollbackPlan(target, migrations, options, log).sql;
    }
    fs.writeFileSync(options.out, sql, 'utf8');
    log(`bundle escrito: ${options.out}`);
    return 0;
  }

  const conn = connectionEnv(options, env);
  const vars = psqlVars(options, env);
  const state = readDbState(conn);

  if (command === 'plan' || command === 'up') {
    if (options.fresh) {
      if (state.hasAgx || state.hasLedger) throw fail('AGX_MIGRATE_NOT_FRESH', '--fresh exige una base sin esquema agx ni ledger');
      const fresh = freshBundleFor(target, migrations, options);
      if (command === 'plan') {
        log(fresh.chosen.map((m) => `PENDIENTE ${m.filename}`).join('\n'));
        return 0;
      }
      requireVars(fresh.chosen, vars);
      runBundle({ env: conn, sql: fresh.sql, nonce: fresh.nonce, vars, label: `fresh 0000..${pad(fresh.to)}`, log, expectation: fresh.expectation, execPsql });
      return 0;
    }
    const to = options.to === undefined ? migrations.length - 1 : Number(options.to);
    if (!Number.isInteger(to) || to < 0 || to >= migrations.length) throw fail('AGX_MIGRATE_ARGS', `--to fuera de rango: ${options.to}`);
    let pending;
    if (state.hasLedger) {
      pending = planFromLedger(migrations, state.ledger);
    } else if (target.ledgerVersion !== null && state.hasAgx) {
      // Base existente sin ledger: lo único posible es certificar y crear el ledger.
      pending = migrations.filter((m) => m.version >= target.ledgerVersion);
    } else if (!state.hasAgx) {
      throw fail('AGX_MIGRATE_NOT_INITIALIZED', 'base sin esquema agx: use --fresh para construirla desde 0000');
    } else {
      throw fail('AGX_MIGRATE_NO_LEDGER', 'este target no tiene ledger: solo se admite --fresh sobre una base vacía');
    }
    pending = pending.filter((m) => m.version <= to);
    if (command === 'plan') {
      log(pending.length ? pending.map((m) => `PENDIENTE ${m.filename}`).join('\n') : 'sin migraciones pendientes');
      return 0;
    }
    if (options.version !== undefined) {
      const v = Number(options.version);
      if (!pending.length || pending[0].version !== v) throw fail('AGX_MIGRATE_OUT_OF_ORDER', `la siguiente migración aplicable es ${pending[0] ? pad(pending[0].version) : 'ninguna'}, no ${pad(v)}`);
      pending = [pending[0]];
    }
    requireVars(pending, vars);
    for (const m of pending) {
      const { sql, nonce, kind, expectation } = bundleFor(target, migrations, m.version);
      runBundle({ env: conn, sql, nonce, vars, label: `${m.filename} (${kind})`, log, expectation, execPsql });
    }
    if (!pending.length) log('sin migraciones pendientes');
    return 0;
  }

  if (command === 'rollback') {
    const plan = rollbackPlan(target, migrations, options, log);
    if (!state.hasLedger) throw fail('AGX_MIGRATE_NO_LEDGER', 'sin ledger no se ejecutan rollbacks');
    planFromLedger(migrations, state.ledger);
    runBundle({
      env: conn, sql: plan.sql, nonce: plan.nonce, vars, label: `${plan.migration.rollback.filename}${plan.historical ? ' (histórico)' : ''}`,
      log, expectation: rollbackExpectation(plan.version), execPsql,
    });
    return 0;
  }

  throw fail('AGX_MIGRATE_ARGS', `comando desconocido: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error.code ? error.message : `AGX_MIGRATE_ERROR: ${error.message}`); process.exitCode = 1; },
  );
}
