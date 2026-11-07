// HARDENING PRE-SANIDAD (PR A) -- pruebas puras del runner (sin base de datos).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  TARGETS, normalizeSql, sha256, stripSqlForScan, assertBundleSafe, psqlVariables, listMigrations,
  planFromLedger, destructiveTargets, assertRollbackAllowed, certificationMd5, certificationLines,
  extractFingerprintQuery, buildUpBundle, buildRollbackBundle, ledgerEntries, buildFreshBundle,
  sanitizedPgEnv, redact, inspectBackupEvidence, MIN_BACKUP_EVIDENCE_BYTES,
} from '../agx-migrate-lib.mjs';
import { parseArgs, connectionEnv, main, verifyLedgerExpectation } from '../agx-migrate.mjs';
import { normalizeForRestoreCompare, databaseLevelStatements } from '../agx-dr-verify.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const business = listMigrations(path.join(ROOT, TARGETS.business.dir));
const auth = listMigrations(path.join(ROOT, TARGETS.auth.dir));

test('las migraciones reales son contiguas, sin control de transacción y con rollback emparejado', () => {
  assert.equal(business.length, 28);
  assert.deepEqual(business.map((m) => m.version), [...Array(28).keys()]);
  assert.equal(business[27].filename, '0027_schema_migrations_ledger.sql');
  assert.equal(business[27].rollback, null);
  assert.ok(business.slice(1, 27).every((m) => m.rollback));
  assert.deepEqual(business[0].variables, ['agx_app_password']);
  assert.deepEqual(business[23].variables, ['agx_qr_admin_password']);
  assert.deepEqual(auth.map((m) => m.filename), ['0000_baseline_auth_schema.sql', '0001_organizaciones_membresias_auth.sql', '0002_client_provisioning_grants.sql']);
  assert.deepEqual(auth[0].variables, ['agx_auth_password']);
});

test('checksum sobre contenido LF: solo CRLF -> LF; BOM y CR suelto se rechazan; un byte real cambia el checksum', () => {
  const lf = 'create table x (id int);\nselect 1;\n';
  assert.equal(normalizeSql(lf), lf);
  assert.equal(sha256(normalizeSql(lf)), sha256(normalizeSql(lf.replace(/\n/g, '\r\n'))));
  assert.equal(normalizeSql("select 'a\tb';\n"), "select 'a\tb';\n");
  assert.notEqual(sha256(normalizeSql(lf)), sha256(normalizeSql(`${lf} `)));
  assert.throws(() => normalizeSql(`﻿${lf}`), (e) => e.code === 'AGX_MIGRATE_ENCODING');
  assert.throws(() => normalizeSql('select 1;\rselect 2;\n'), (e) => e.code === 'AGX_MIGRATE_ENCODING');
});

test('detección de control de transacción y metacomandos peligrosos', () => {
  for (const sql of ['begin;\nselect 1;', 'select 1;\ncommit;', 'select 1;\nEND;', 'start transaction;', 'select 1; rollback;', 'savepoint a;']) {
    assert.throws(() => assertBundleSafe(sql, 'x.sql'), (e) => e.code === 'AGX_MIGRATE_TX_CONTROL', sql);
  }
  for (const sql of ['\\connect otra', '\\c otra', '\\i otro.sql', '\\! rm -rf /', 'select 1 \\g /tmp/x']) {
    assert.throws(() => assertBundleSafe(sql, 'x.sql'), (e) => e.code === 'AGX_MIGRATE_META_COMMAND', sql);
  }
  // Válidos: plpgsql con begin/end dentro de $$, comentarios y cadenas con la palabra commit, \if/\gset.
  assertBundleSafe("create function f() returns void language plpgsql as $$\nbegin\n  perform 1;\nend;\n$$;\n-- commit;\nselect 'commit;';\nselect 1 as a \\gset\n\\if :a\n\\endif\n", 'ok.sql');
  assert.ok(!stripSqlForScan("select 'a;b' -- c;\n").includes('a;b'));
});

test('variables psql requeridas', () => {
  assert.deepEqual(psqlVariables("create role r password :'pw';\n-- :'comentario'\nselect :'otra';"), ['otra', 'pw']);
});

test('planFromLedger: pendientes, checksum cambiado, desconocida, hueco', () => {
  const ledger = ledgerEntries(business, 28);
  assert.equal(planFromLedger(business, ledger).length, 0);
  assert.equal(planFromLedger(business, ledger.slice(0, 27))[0].version, 27);
  assert.throws(() => planFromLedger(business, ledger.map((e, i) => (i === 5 ? { ...e, checksum: '0'.repeat(64) } : e))), (e) => e.code === 'AGX_MIGRATE_CHECKSUM_MISMATCH');
  assert.throws(() => planFromLedger(business, [...ledger, { version: 28, filename: '0028_x.sql', checksum: '0'.repeat(64) }]), (e) => e.code === 'AGX_MIGRATE_UNKNOWN_VERSION');
  assert.throws(() => planFromLedger(business, ledger.filter((e) => e.version !== 3)), (e) => e.code === 'AGX_MIGRATE_GAP');
});

test('precondiciones de rollback extraídas de los rollbacks reales', () => {
  const r22 = destructiveTargets(business[22].rollback.content);
  assert.deepEqual(r22.tables, ['agx.animal_eventos', 'agx.animal_pesajes', 'agx.animales', 'agx.catalogo_razas']);
  const r24 = destructiveTargets(business[24].rollback.content);
  assert.deepEqual(r24.columns, [
    { table: 'agx.animal_pesajes', column: 'observaciones' },
    { table: 'agx.animal_pesajes', column: 'client_operation_id' },
  ]);
  const r25 = destructiveTargets(business[25].rollback.content);
  assert.ok(r25.columns.some((c) => c.table === 'agx.animales' && c.column === 'estado_operativo'));
  const bundle = buildRollbackBundle({ target: 'business', migration: business[24], ledgerVersion: 27, historical: true });
  assert.match(bundle, /AGX_MIGRATE_ROLLBACK_PRECONDITION/);
  assert.match(bundle, /'agx\.animal_pesajes\|observaciones'/);
  assert.match(bundle, /AGX_MIGRATE_ROLLBACK_NOT_TOP/);
  // Precondiciones ANTES del SQL de rollback, baja del ledger DESPUÉS.
  assert.ok(bundle.indexOf('agx_migrate_pre') < bundle.indexOf('>>> 0024_animal_pesajes_manual_rollback.sql'));
  assert.ok(bundle.indexOf('<<< 0024') < bundle.indexOf('delete from agx_meta.schema_migrations'));
});

test('política de rollback: históricos bloqueados salvo opción extraordinaria exacta + evidencia PGDMP', () => {
  const config = TARGETS.business;
  const okEvidence = () => ({ sha256: 'a'.repeat(64), size: 1 << 20, entries: 10 });
  const call = (version, options, inspectEvidence = okEvidence) => assertRollbackAllowed({ config, version, options, inspectEvidence });
  assert.throws(() => call(25, {}), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { force: true }), (e) => e.code === 'AGX_MIGRATE_FORCE_NOT_SUPPORTED');
  assert.throws(() => call(25, { 'confirm-rollback': '25' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { 'allow-historical-destructive-rollback': '24', 'backup-evidence': 'x' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { 'allow-historical-destructive-rollback': '25' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { 'allow-historical-destructive-rollback': '25', 'backup-evidence': 'x' }, inspectBackupEvidence), (e) => e.code === 'AGX_MIGRATE_BACKUP_EVIDENCE');
  assert.deepEqual(call(25, { 'allow-historical-destructive-rollback': '25', 'backup-evidence': 'x' }), { historical: true, evidence: okEvidence() });
  assert.throws(() => call(27, { 'confirm-rollback': '27' }), (e) => e.code === 'AGX_MIGRATE_LEDGER_ROLLBACK_FORBIDDEN');
  assert.throws(() => call(28, {}), (e) => e.code === 'AGX_MIGRATE_ROLLBACK_NOT_CONFIRMED');
  assert.deepEqual(call(28, { 'confirm-rollback': '28' }), { historical: false, evidence: null });
  assert.throws(() => assertRollbackAllowed({ config: TARGETS.auth, version: 2, options: {} }), (e) => e.code === 'AGX_MIGRATE_NO_LEDGER');
});

test('bundles: transacción explícita, lock, verificaciones antes de la migración y registro al final', () => {
  const fpSql = fs.readFileSync(path.join(ROOT, 'db/verify/schema_fingerprint.sql'), 'utf8');
  const reference = fs.readFileSync(path.join(ROOT, TARGETS.business.baselineFingerprint), 'utf8');
  const boot = buildUpBundle({
    target: 'business', migration: business[27], kind: 'bootstrap', expected: ledgerEntries(business, 27),
    fingerprint: { query: extractFingerprintQuery(fpSql), schemas: 'agx', expectedMd5: certificationMd5(reference), expectedLines: certificationLines(reference).length },
  });
  const order = ['begin;', 'pg_advisory_xact_lock', 'pg_current_xact_id', 'AGX_MIGRATE_ALREADY_APPLIED', 'AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH', '>>> 0027', '<<< 0027', "'baseline_certificada', 'agx-migrate/1')", "'aplicada', 'agx-migrate/1')", 'commit;', 'AGX_MIGRATE_POST_VERIFY', 'AGX_MIGRATE_COMMITTED'];
  const pos = order.map((s) => boot.indexOf(s));
  assert.ok(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), JSON.stringify(pos));
  // ON_ERROR_STOP se reafirma entre el contenido de la migración y el registro en el ledger.
  const reassert = boot.indexOf('\\set ON_ERROR_STOP 1', boot.indexOf('<<< 0027'));
  assert.ok(reassert > 0 && reassert < boot.indexOf("'baseline_certificada', 'agx-migrate/1')"));
  assert.equal((boot.match(/, 'baseline_certificada', 'agx-migrate\/1'\)/g) || []).length, 27);
  assert.equal((boot.match(/, 'aplicada', 'agx-migrate\/1'\)/g) || []).length, 1);
  const next = { ...business[27], version: 28, filename: '0028_x.sql', content: 'select 1;\n', checksum: 'a'.repeat(64) };
  const normal = buildUpBundle({ target: 'business', migration: next, kind: 'ledger', expected: ledgerEntries(business, 28) });
  for (const code of ['AGX_MIGRATE_NO_LEDGER', 'AGX_MIGRATE_ALREADY_APPLIED', 'AGX_MIGRATE_CHECKSUM_MISMATCH', 'AGX_MIGRATE_GAP', 'AGX_MIGRATE_OUT_OF_ORDER']) assert.match(normal, new RegExp(code));
  assert.ok(normal.indexOf('AGX_MIGRATE_OUT_OF_ORDER') < normal.indexOf('>>> 0028_x.sql'));
  assert.ok(normal.indexOf("'aplicada'") < normal.indexOf('commit;'));
  assert.ok(normal.trimEnd().endsWith("\\echo 'AGX_MIGRATE_COMMITTED xid=' :agx_migrate_xid"));
  // Una migración anterior al ledger nunca tiene bundle individual.
  assert.throws(() => buildUpBundle({ target: 'business', migration: business[26], kind: 'plain' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_BUNDLE_BLOCKED');
});

test('certificación ignora extensiones de imagen (Railway) pero no otros cambios', () => {
  const base = 'relation|agx.a|kind=r\nextension|plpgsql|1.0|pg_catalog\n';
  assert.equal(certificationMd5(base), certificationMd5(`${base}extension|postgis_topology|3.4.3|topology\n`));
  assert.notEqual(certificationMd5(base), certificationMd5(`${base}relation|agx.b|kind=r\n`));
});

test('comparación post-restore: normaliza solo deparse/ACL equivalentes', () => {
  assert.equal(
    normalizeForRestoreCompare("constraint|agx.t|c|c|validated=true|CHECK (((x)::text = ANY ((ARRAY['A'::character varying])::text[])))"),
    normalizeForRestoreCompare("constraint|agx.t|c|c|validated=true|CHECK (((x)::text = ANY (ARRAY[('A'::character varying)::text])))"),
  );
  assert.equal(normalizeForRestoreCompare('relation|agx.s|kind=S|owner=o|rls=false|force=false|acl=o=rwU/o'), 'relation|agx.s|kind=S|owner=o|rls=false|force=false|acl=-');
  assert.notEqual(normalizeForRestoreCompare('relation|agx.t|kind=r|owner=o|rls=true|force=true|acl=agx_app=r/o,o=arwdDxt/o'), 'relation|agx.t|kind=r|owner=o|rls=true|force=true|acl=-');
  assert.equal(normalizeForRestoreCompare('policy|agx.t|p|PERMISSIVE|ALL|roles=public|using=(a = b)|check=-'), 'policy|agx.t|p|PERMISSIVE|ALL|roles=public|using=(a = b)|check=-');
  assert.deepEqual(
    databaseLevelStatements('CREATE DATABASE src;\nGRANT CONNECT ON DATABASE src TO agx_qr_admin;\nALTER DATABASE src SET x TO 1;\nGRANT x ON TABLE t TO y;\n', 'src', 'dst'),
    ['GRANT CONNECT ON DATABASE dst TO agx_qr_admin;', 'ALTER DATABASE dst SET x TO 1;'],
  );
});

test('CLI: --url nunca se acepta en línea de comandos; --force no existe como atajo', () => {
  const { options } = parseArgs(['rollback', '--target', 'business', '--url-env', 'X', '--force']);
  assert.equal(options.force, true);
  assert.equal(options['url-env'], 'X');
  assert.throws(() => parseArgs(['up', 'postgres://u:p@h/db']), (e) => e.code === 'AGX_MIGRATE_ARGS');
});

// ---------------------------------------------------------------------
// Guards del runner (hardening/migration-runner-guards).
// ---------------------------------------------------------------------

test('guard B: whitelist de metacomandos -- control del runner, SQL dinámico, conexión y shell rechazados', () => {
  const rejected = [
    '\\set ON_ERROR_STOP 0',            // 4
    '\\set ON_ERROR_STOP off',
    '\\unset ON_ERROR_STOP',
    '\\set AUTOCOMMIT off',             // 5
    '\\set AUTOCOMMIT on',
    '\\unset AUTOCOMMIT',
    '\\set ON_ERROR_ROLLBACK on',
    '\\set SINGLESTEP on',
    "select 'grant x' \\gexec",          // 6
    'select 1 \\gx',
    'select 1 \\g',
    '\\connect otra',
    '\\c otra',
    '\\i otro.sql',
    '\\ir otro.sql',
    '\\include otro.sql',
    '\\include_relative otro.sql',
    '\\! rm -rf /',
    '\\o /tmp/x',
    '\\copy t from x',
    '\\getenv a HOME',
    '\\setenv PGHOST x',
    '\\pset format csv',
    'select 1; \\! ls',                   // a mitad de línea
    'select 1 \\\\ select 2;',
    '\\set x `id`',
    '\\echo `id`',
    'select 1 as "ON_ERROR_ROLLBACK" \\gset',
    'select * from pg_settings limit 1 \\gset',
    'select 1 as a \\gset ON_',
  ];
  for (const sql of rejected) {
    assert.throws(() => assertBundleSafe(sql, '0099_x.sql'), (e) => e.code === 'AGX_MIGRATE_META_COMMAND', sql);
  }
  // Permitidos: variables en minúsculas, \set ON_ERROR_STOP on (refuerza), \if, \echo, \gset simple.
  assertBundleSafe("\\set ON_ERROR_STOP on\n\\set x 1\n\\unset x\nselect count(*) > 0 as hay \\gset\n\\if :hay\n\\echo 'si'\n\\elif :hay\n\\else\n\\warn 'no'\n\\endif\nselect 1 as a \\gset pre_\n", '0099_ok.sql');
  // Excepción histórica \gexec: solo 0023 con su checksum exacto.
  const m23 = business[23];
  assertBundleSafe(m23.content, m23.filename, m23.checksum);
  assert.throws(() => assertBundleSafe(`${m23.content}-- cambio\n`, m23.filename, sha256(`${m23.content}-- cambio\n`)), (e) => e.code === 'AGX_MIGRATE_META_COMMAND');
  assert.throws(() => assertBundleSafe(m23.content, '0099_copia.sql', m23.checksum), (e) => e.code === 'AGX_MIGRATE_META_COMMAND');
});

test('guard A (1): bundle de una versión anterior al ledger sin --fresh FAIL; con --fresh es una construcción desde cero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-unit-'));
  try {
    const out = path.join(dir, 'b.sql');
    for (const v of ['26', '0', '1']) {
      await assert.rejects(main(['bundle', '--target', 'business', '--version', v, '--out', out], { log: () => {} }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_BUNDLE_BLOCKED', v);
    }
    await assert.rejects(main(['bundle', '--target', 'auth', '--version', '1', '--out', out], { log: () => {} }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_BUNDLE_BLOCKED');
    await assert.rejects(main(['bundle', '--target', 'business', '--fresh', '--version', '26', '--out', out], { log: () => {} }), (e) => e.code === 'AGX_MIGRATE_ARGS');
    assert.equal(fs.existsSync(out), false);
    // 27 (bootstrap) y posteriores sí tienen bundle individual.
    await main(['bundle', '--target', 'business', '--version', '27', '--out', out], { log: () => {} });
    assert.match(fs.readFileSync(out, 'utf8'), /AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH/);
    await main(['bundle', '--target', 'business', '--fresh', '--to', '26', '--out', out], { log: () => {} });
    const fresh = fs.readFileSync(out, 'utf8');
    assert.equal((fresh.match(/^begin;$/gm) || []).length, 1);
    assert.equal((fresh.match(/^commit;$/gm) || []).length, 1);
    assert.ok(fresh.indexOf('AGX_MIGRATE_NOT_FRESH') < fresh.indexOf('>>> 0000_'));
    assert.ok(fresh.indexOf('<<< 0026_') < fresh.indexOf('commit;'));
    assert.doesNotMatch(fresh, />>> 0027_/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { sql, expectation } = buildFreshBundle({ target: 'business', config: TARGETS.business, migrations: business, to: 27, fingerprint: { query: 'select 1 as line', schemas: 'agx', expectedMd5: '0'.repeat(32), expectedLines: 1 } });
  assert.equal(expectation.present.length, 28);
  assert.ok(sql.indexOf('AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH') > sql.indexOf('<<< 0026_'));
  assert.ok(sql.indexOf('AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH') < sql.indexOf('>>> 0027_'));
});

test('guard C: verificación cliente del ledger tras psql (ausente, difiere, revertida)', () => {
  const row = { version: 28, filename: '0028_x.sql', checksum: 'a'.repeat(64), kind: 'aplicada' };
  verifyLedgerExpectation([row], { present: [row], absent: [] });
  assert.throws(() => verifyLedgerExpectation([], { present: [row], absent: [] }), (e) => e.code === 'AGX_MIGRATE_POST_VERIFY');
  assert.throws(() => verifyLedgerExpectation([{ ...row, checksum: 'b'.repeat(64) }], { present: [row], absent: [] }), (e) => e.code === 'AGX_MIGRATE_POST_VERIFY');
  assert.throws(() => verifyLedgerExpectation([{ ...row, kind: 'baseline_certificada' }], { present: [row], absent: [] }), (e) => e.code === 'AGX_MIGRATE_POST_VERIFY');
  assert.throws(() => verifyLedgerExpectation([row], { present: [], absent: [28] }), (e) => e.code === 'AGX_MIGRATE_POST_VERIFY');
});

test('guard D (8/9): variables PG* heredadas nunca llegan a psql', () => {
  const inherited = {
    PATH: 'p', PGHOST: 'evil', PGHOSTADDR: '203.0.113.9', PGPORT: '1', PGDATABASE: 'x', PGUSER: 'x', PGSERVICE: 's',
    PGSERVICEFILE: 'f', PGSSLMODE: 'disable', PGOPTIONS: '-c x=y', PGPASSFILE: 'pp', pgsysconfdir: 'c', PSQLRC: 'r',
    AGX_URL: 'postgres://runner:secreto@127.0.0.1:5544/agx',
  };
  const env = connectionEnv({ 'url-env': 'AGX_URL' }, inherited);
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLMODE', 'PGOPTIONS', 'pgsysconfdir', 'PSQLRC']) assert.equal(env[k], undefined, k);
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGPORT, '5544');
  assert.equal(env.PGDATABASE, 'agx');
  assert.equal(env.PGUSER, 'runner');
  assert.equal(env.PGPASSWORD, 'secreto');
  assert.notEqual(env.PGPASSFILE, 'pp');
  assert.equal(env.PATH, 'p');
  assert.deepEqual(Object.keys(sanitizedPgEnv({ PGHOST: 'a', Path: 'b' })), ['Path']);
});

test('guard E (10): URL -- parámetros no soportados FAIL, sslmode explícito, host comparado tal como se usa', () => {
  const env = (url) => ({ U: url });
  const ce = (url, opts = {}) => connectionEnv({ 'url-env': 'U', ...opts }, env(url));
  for (const url of [
    'postgres://u:p@127.0.0.1/db?host=203.0.113.9',
    'postgres://u:p@127.0.0.1/db?hostaddr=203.0.113.9',
    'postgres://u:p@127.0.0.1/db?options=-c%20search_path%3Dx',
    'postgres://u:p@127.0.0.1/db?service=prod',
    'postgres://u:p@127.0.0.1/db?application_name=x',
    'postgres://u:p@127.0.0.1/db?sslmode=bogus',
    'postgres://u:p@127.0.0.1/db?sslmode=require&sslmode=disable',
  ]) {
    assert.throws(() => ce(url), (e) => e.code === 'AGX_MIGRATE_URL_PARAM', url);
  }
  assert.equal(ce('postgres://u:p@127.0.0.1/db?sslmode=require').PGSSLMODE, 'require');
  assert.equal(ce('postgres://u:p@127.0.0.1/db').PGSSLMODE, undefined);
  assert.equal(ce('postgres://u:p@[::1]:5433/db').PGHOST, '::1');
  assert.throws(() => ce('postgres://u:p@h1,h2/db', { 'allow-remote-host': 'h1,h2' }), (e) => e.code === 'AGX_MIGRATE_URL');
  assert.throws(() => ce('postgres://u:p@db.example.com/db'), (e) => e.code === 'AGX_MIGRATE_REMOTE_BLOCKED');
  assert.throws(() => ce('postgres://u:p@db.example.com/db', { 'allow-remote-host': 'otro.example.com' }), (e) => e.code === 'AGX_MIGRATE_REMOTE_BLOCKED');
  assert.equal(ce('postgres://u:p@DB.Example.com/db', { 'allow-remote-host': 'db.example.COM' }).PGHOST, 'db.example.com');
  assert.throws(() => ce('postgres://u:p@127.0.0.1/db#x'), (e) => e.code === 'AGX_MIGRATE_URL');
  assert.throws(() => ce('postgres://127.0.0.1/db'), (e) => e.code === 'AGX_MIGRATE_URL');
  assert.throws(() => ce('postgres://u:p@127.0.0.1/'), (e) => e.code === 'AGX_MIGRATE_URL');
  assert.throws(() => ce('mysql://u:p@127.0.0.1/db'), (e) => e.code === 'AGX_MIGRATE_URL');
});

test('guard (11): redacción de secretos en mensajes', () => {
  assert.equal(redact('invalid input syntax for type integer: "s3cr3t-pw"', ['s3cr3t-pw', undefined]), 'invalid input syntax for type integer: "***"');
});

test('guard F (12): evidencia de backup -- 5 bytes PGDMP, tamaño mínimo y dump ilegible FAIL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-mig-evidence-'));
  try {
    const tiny = path.join(dir, 'falso.dump');
    fs.writeFileSync(tiny, 'PGDMP');
    assert.throws(() => inspectBackupEvidence(tiny), (e) => e.code === 'AGX_MIGRATE_BACKUP_EVIDENCE' && /bytes/.test(e.message));
    const big = path.join(dir, 'falso-grande.dump');
    fs.writeFileSync(big, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(MIN_BACKUP_EVIDENCE_BYTES + 10, 7)]));
    assert.throws(() => inspectBackupEvidence(big), (e) => e.code === 'AGX_MIGRATE_BACKUP_EVIDENCE');
    const notDump = path.join(dir, 'texto.dump');
    fs.writeFileSync(notDump, 'x'.repeat(MIN_BACKUP_EVIDENCE_BYTES + 10));
    assert.throws(() => inspectBackupEvidence(notDump), (e) => e.code === 'AGX_MIGRATE_BACKUP_EVIDENCE' && /formato custom/.test(e.message));
    assert.throws(() => inspectBackupEvidence(path.join(dir, 'no-existe.dump')), (e) => e.code === 'AGX_MIGRATE_BACKUP_EVIDENCE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
