#!/usr/bin/env node
// HARDENING PRE-SANIDAD (PR A) -- runner de migraciones AGX.
//
// Uso (ver docs/runbooks/agx-db-dr-migraciones.md):
//   node .tools/agx-migrate.mjs status   --target business|auth
//   node .tools/agx-migrate.mjs plan     --target business --url-env VAR
//   node .tools/agx-migrate.mjs up       --target business --url-env VAR [--to N] [--fresh] [--var nombre=ENV_VAR]...
//   node .tools/agx-migrate.mjs bundle   --target business --version N --out archivo.sql
//   node .tools/agx-migrate.mjs rollback --target business --url-env VAR --version N [opciones de rollback]
//   node .tools/agx-migrate.mjs bundle-rollback --target business --version N --out archivo.sql [opciones]
//
// La URL nunca va en la línea de comandos: --url-env nombra la variable de
// entorno que la contiene. Solo hosts loopback salvo --allow-remote-host
// <host> exacto. Producción (sin TCP público) se migra con `bundle` +
// ejecución del bundle por psql dentro del contenedor.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TARGETS, RUNNER_VERSION, fail, pad, listMigrations, ledgerEntries, planFromLedger,
  buildUpBundle, buildRollbackBundle, assertRollbackAllowed, extractFingerprintQuery,
  certificationMd5, certificationLines,
} from './agx-migrate-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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

function connectionEnv(options, env = process.env) {
  const name = options['url-env'];
  if (!name) throw fail('AGX_MIGRATE_ARGS', 'falta --url-env <VARIABLE> con la URL de conexión');
  const raw = env[name];
  if (!raw) throw fail('AGX_MIGRATE_ARGS', `la variable ${name} está vacía`);
  let url;
  try { url = new URL(raw); } catch { throw fail('AGX_MIGRATE_ARGS', `${name} no es una URL válida`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw fail('AGX_MIGRATE_ARGS', `${name} no es una URL PostgreSQL`);
  if (!LOOPBACK.has(url.hostname) && options['allow-remote-host'] !== url.hostname) {
    throw fail('AGX_MIGRATE_REMOTE_BLOCKED', `host no loopback; requiere --allow-remote-host ${url.hostname}`);
  }
  return {
    ...env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGCLIENTENCODING: 'UTF8',
    PGAPPNAME: RUNNER_VERSION,
  };
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

function psql(env, args, input) {
  const bin = process.env.PSQL_BIN || 'psql';
  const res = spawnSync(bin, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { env, input, encoding: 'utf8' });
  if (res.error) throw fail('AGX_MIGRATE_PSQL', `no se pudo ejecutar psql (${res.error.code})`);
  return res;
}

function query(env, sql) {
  const res = psql(env, ['-At', '-c', sql]);
  if (res.status !== 0) throw fail('AGX_MIGRATE_PSQL', (res.stderr || '').trim().split('\n')[0]);
  return res.stdout.replace(/\r/g, '').trim();
}

export function readDbState(env) {
  const flags = query(env, "select (to_regnamespace('agx') is not null)::text || '|' || (to_regclass('agx_meta.schema_migrations') is not null)::text");
  const [hasAgx, hasLedger] = flags.split('|').map((v) => v === 'true');
  let ledger = null;
  if (hasLedger) {
    const json = query(env, "select coalesce(json_agg(json_build_object('version', version, 'filename', filename, 'checksum', checksum_sha256, 'kind', kind) order by version), '[]') from agx_meta.schema_migrations");
    ledger = JSON.parse(json);
  }
  return { hasAgx, hasLedger, ledger };
}

function runBundle(env, sql, vars, label, log) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-migrate-')), 'bundle.sql');
  fs.writeFileSync(file, sql, 'utf8');
  try {
    const args = ['-f', file];
    for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
    const res = psql(env, args);
    if (res.status !== 0) {
      const err = (res.stderr || '').replace(/\r/g, '').split('\n').find((l) => /ERROR|FATAL/.test(l)) || `psql salió con ${res.status}`;
      const code = /AGX_MIGRATE_[A-Z_]+/.exec(err)?.[0] ?? 'AGX_MIGRATE_SQL_ERROR';
      const detail = err.replace(/^.*?(ERROR|FATAL):\s*/, '').replace(/^AGX_MIGRATE_[A-Z_]+:\s*/, '');
      throw fail(code, `${label}: ${detail} (transacción revertida, ledger sin cambios)`);
    }
    log(`OK ${label}`);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function fingerprintSpec(target) {
  const reference = fs.readFileSync(target.baselineFingerprint, 'utf8');
  return {
    query: extractFingerprintQuery(fs.readFileSync(target.fingerprintSql, 'utf8')),
    schemas: target.fingerprintSchemas,
    expectedMd5: certificationMd5(reference),
    expectedLines: certificationLines(reference).length,
  };
}

export function bundleFor(target, migrations, version) {
  const migration = migrations.find((m) => m.version === version);
  if (!migration) throw fail('AGX_MIGRATE_ARGS', `no existe la migración ${pad(version)}`);
  if (target.ledgerVersion === null || version < target.ledgerVersion) {
    return { migration, kind: 'plain', sql: buildUpBundle({ target: target.name, migration, kind: 'plain' }) };
  }
  const expected = ledgerEntries(migrations, version);
  if (version === target.ledgerVersion) {
    return { migration, kind: 'bootstrap', sql: buildUpBundle({ target: target.name, migration, kind: 'bootstrap', expected, fingerprint: fingerprintSpec(target) }) };
  }
  return { migration, kind: 'ledger', sql: buildUpBundle({ target: target.name, migration, kind: 'ledger', expected }) };
}

function requireVars(migration, vars) {
  const missing = migration.variables.filter((v) => !(v in vars));
  if (missing.length) throw fail('AGX_MIGRATE_ARGS', `${migration.filename} requiere --var ${missing.map((v) => `${v}=ENV`).join(' --var ')}`);
}

export async function main(argv, { env = process.env, log = console.log } = {}) {
  const { command, options } = parseArgs(argv);
  const target = resolveTarget(options);
  const migrations = listMigrations(target.dir);

  if (command === 'status') {
    for (const m of migrations) log(`${pad(m.version)} ${m.filename} sha256=${m.checksum}${m.rollback ? ' [rollback]' : ''}${m.variables.length ? ` vars=${m.variables.join(',')}` : ''}`);
    return 0;
  }

  if (command === 'bundle' || command === 'bundle-rollback') {
    const version = Number(options.version);
    if (!Number.isInteger(version) || !options.out) throw fail('AGX_MIGRATE_ARGS', 'requiere --version N y --out archivo');
    let sql;
    if (command === 'bundle') {
      sql = bundleFor(target, migrations, version).sql;
    } else {
      const migration = migrations.find((m) => m.version === version);
      if (!migration) throw fail('AGX_MIGRATE_ARGS', `no existe ${pad(version)}`);
      const { historical } = assertRollbackAllowed({ config: target, version, options });
      sql = buildRollbackBundle({ target: target.name, migration, ledgerVersion: target.ledgerVersion, historical });
    }
    fs.writeFileSync(options.out, sql, 'utf8');
    log(`bundle escrito: ${options.out}`);
    return 0;
  }

  const conn = connectionEnv(options, env);
  const vars = psqlVars(options, env);
  const state = readDbState(conn);

  if (command === 'plan' || command === 'up') {
    const to = options.to === undefined ? migrations.length - 1 : Number(options.to);
    if (!Number.isInteger(to) || to < 0 || to >= migrations.length) throw fail('AGX_MIGRATE_ARGS', `--to fuera de rango: ${options.to}`);
    let pending;
    if (options.fresh) {
      if (state.hasAgx || state.hasLedger) throw fail('AGX_MIGRATE_NOT_FRESH', '--fresh exige una base sin esquema agx ni ledger');
      pending = migrations;
    } else if (state.hasLedger) {
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
    for (const m of pending) requireVars(m, vars);
    for (const m of pending) {
      const { sql, kind } = bundleFor(target, migrations, m.version);
      runBundle(conn, sql, vars, `${m.filename} (${kind})`, log);
    }
    if (!pending.length) log('sin migraciones pendientes');
    return 0;
  }

  if (command === 'rollback') {
    const version = Number(options.version);
    const migration = migrations.find((m) => m.version === version);
    if (!migration) throw fail('AGX_MIGRATE_ARGS', `no existe ${pad(version)}`);
    const { historical } = assertRollbackAllowed({ config: target, version, options });
    if (!state.hasLedger) throw fail('AGX_MIGRATE_NO_LEDGER', 'sin ledger no se ejecutan rollbacks');
    planFromLedger(migrations, state.ledger);
    const sql = buildRollbackBundle({ target: target.name, migration, ledgerVersion: target.ledgerVersion, historical });
    runBundle(conn, sql, vars, `${migration.rollback.filename}${historical ? ' (histórico)' : ''}`, log);
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
