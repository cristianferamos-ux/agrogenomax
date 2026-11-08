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
  auditMigration, FROZEN, FROZEN_MANIFEST_PATH, newNonce, parseCommitMarker,
} from '../agx-migrate-lib.mjs';
import { lexPsql } from '../agx-psql-lexer.mjs';
import { parseArgs, connectionEnv, main, verifyLedgerExpectation } from '../agx-migrate.mjs';
import { normalizeForRestoreCompare, databaseLevelStatements } from '../agx-dr-verify.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const business = listMigrations(path.join(ROOT, TARGETS.business.dir), 'business');
const auth = listMigrations(path.join(ROOT, TARGETS.auth.dir), 'auth');

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
    assert.throws(() => assertBundleSafe(sql, '0099_x.sql'), (e) => e.code === 'AGX_MIGRATE_TX_CONTROL', sql);
  }
  for (const sql of ['\\connect otra', '\\c otra', '\\i otro.sql', '\\! rm -rf /', 'select 1 \\g /tmp/x']) {
    assert.throws(() => assertBundleSafe(sql, '0099_x.sql'), (e) => e.code === 'AGX_MIGRATE_META_COMMAND', sql);
  }
  // Válido: plpgsql con begin/end dentro de $$, comentarios y cadenas con la palabra commit (SQL puro).
  assertBundleSafe("create function f() returns void language plpgsql as $$\nbegin\n  perform 1;\nend;\n$$;\n-- commit;\nselect 'commit;';\nselect 1 as a;\n", '0099_ok.sql');
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
  assert.match(normal.trimEnd().split('\n').pop(), /^\\echo 'AGX_MIGRATE_COMMITTED [0-9a-f]{32} xid=' :agx_migrate_xid$/);
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
  // SQL puro: en una migración nueva ya no se admite NINGÚN metacomando, ni siquiera los "inocuos".
  for (const sql of ['\\set ON_ERROR_STOP on', '\\set x 1', '\\unset x', 'select 1 as a \\gset', '\\if :a\n\\endif', "\\echo 'si'", "\\warn 'no'", 'select 1 as a \\gset pre_']) {
    assert.throws(() => assertBundleSafe(`${sql}\n`, '0099_x.sql'), (e) => e.code === 'AGX_MIGRATE_META_COMMAND', sql);
  }
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

// ---------------------------------------------------------------------
// Fix del bypass (PR #119, revisión final): lexer compatible con psql,
// SQL puro para migraciones nuevas, historial congelado, nonce.
// ---------------------------------------------------------------------

// Corpus adversarial: cada entrada contiene un metacomando que psql SÍ
// ejecutaría. En una migración nueva todas deben fallar.
const ADVERSARIAL = {
  'A identificador con apóstrofo': 'select 1 as "it\'s"; \\set ON_ERROR_STOP 0\n',
  'A bis (exploit real)': 'select 1 as "it\'s";\n\\set ON_ERROR_STOP 0\n\\set ON_ERROR_ROLLBACK on\nselect \'x\';\ncreate table agx.bypass_a (id integer);\nselect 1 / 0;\ncreate table agx.bypass_b (id integer);\n',
  'B identificador con --': 'select 1 as "a--b"; \\gexec\n',
  'C x$q$...y$q$': 'select 1 as x$q$;\n\\set ON_ERROR_ROLLBACK on\nselect 1 as y$q$;\n',
  "D E'\\'' + meta": "select E'\\'';\n\\set ON_ERROR_STOP 0\nselect 'x';\n",
  "D bis e'\\\\' + meta": "select e'\\\\';\n\\set ON_ERROR_STOP 0\n",
  'comentario anidado /* /* */ */ seguido de meta': '/* a /* b */ c */ \\set ON_ERROR_STOP 0\n',
  'dollar quote cerrado y meta': 'select $f$ a \' b $f$; \\o /tmp/x\n',
  'dollar quote con tag y meta dentro de otro tag': 'select $a$ $b$ $a$; \\gexec\n',
  'meta tras ;': 'select 1; \\set ON_ERROR_STOP 0\n',
  'meta con tabs': 'select 1;\t\\set\tON_ERROR_STOP\t0\n',
  'meta tras espacio Unicode (NBSP)': 'select 1;\u00a0\\set ON_ERROR_STOP 0\n',
  'CRLF': 'select 1;\r\n\\set ON_ERROR_STOP 0\r\n',
  'varias \\set en una línea': '\\set A 1 \\set ON_ERROR_STOP 0\n',
  '\\gexec oculto en "a--b"': 'select \'select 1\' as "x--y" \\gexec\n',
  '\\connect oculto': 'select 1 as "it\'s"; \\connect otra\n',
  '\\!': '\\! id\n',
  '\\o': '\\o /tmp/salida\n',
  '\\copy': '\\copy agx.t from \'/etc/passwd\'\n',
  '\\gset malicioso (TABLE)': 'create temp table t ("ON_ERROR_ROLLBACK" text);\ninsert into t values (\'on\');\ntable t \\gset\n',
  'agx_migrate_* reservado (\\set)': '\\set agx_migrate_xid 3\n',
  'marcador COMMIT falso (\\echo)': "\\echo 'AGX_MIGRATE_COMMITTED 00000000000000000000000000000000 xid=' 3\n",
  'U&"..." con apóstrofo': 'select 1 as U&"it\'s"; \\set ON_ERROR_STOP 0\n',
  'N\'...\' y meta': "select N'x'; \\set ON_ERROR_STOP 0\n",
  // PG >= 15: 1E'...' es token basura 1E + cadena ESTÁNDAR: el \' NO escapa y el meta queda en código.
  "número basura 1E'\\' + meta": "select 1E'\\' \\set ON_ERROR_STOP 0\n",
  "comentario -- con comilla": "-- 'x\n\\set ON_ERROR_STOP 0\n",
};

test('lexer: detecta el metacomando que psql ejecutaría en cada caso del corpus', () => {
  for (const [name, sql] of Object.entries(ADVERSARIAL)) {
    const { metas } = lexPsql(normalizeSql(sql.replace(/\r(?!\n)/g, '')));
    assert.ok(metas.length >= 1, `${name}: el lexer no vio el metacomando`);
  }
  // Y NO inventa metacomandos dentro de construcciones que psql trata como texto.
  for (const sql of [
    "select 'a \\set x';", 'select "id \\set";', "select $$ \\set x $$;", "select $t$ \\gexec $t$;",
    '-- \\set ON_ERROR_STOP 0\nselect 1;', '/* \\gexec */ select 1;', '/* /* */ \\set x */ select 1;',
    "select E'\\\\';", "select E'\\'\\set';", "select U&'\\0041';",
  ]) {
    assert.deepEqual(lexPsql(sql).metas, [], sql);
  }
  // Construcciones sin cerrar: error explícito, nunca una suposición.
  for (const sql of ["select 'abierta", 'select "abierto', 'select $q$ abierto', '/* /* */ abierto', "select E'\\'"]) {
    assert.throws(() => lexPsql(sql), (e) => e.code === 'AGX_MIGRATE_LEXER', sql);
  }
  // $ dentro de identificadores no abre dollar-quote; tras un número sí.
  assert.deepEqual(lexPsql('select x$q$ \\set a 1\n').metas.map((m) => m.cmd), ['set']);
  assert.deepEqual(lexPsql('select 1$q$ \\set a 1 $q$;').metas, []);
  // Variables psql: literal, identificador, raw y {?}.
  assert.deepEqual(lexPsql("select :'a', :\"b\", :c, :{?d}, x::text;").vars.map((v) => `${v.kind}:${v.name}`), ['literal:a', 'identifier:b', 'raw:c', 'defined:d']);
});

test('política SQL puro: todo el corpus adversarial FALLA en una migración nueva (0028+)', () => {
  for (const [name, raw] of Object.entries(ADVERSARIAL)) {
    const content = normalizeSql(raw.replace(/\r(?!\n)/g, ''));
    assert.throws(() => auditMigration({ content, filename: '0028_x.sql', checksum: sha256(content), target: 'business' }),
      (e) => ['AGX_MIGRATE_META_COMMAND', 'AGX_MIGRATE_RESERVED_VAR'].includes(e.code), name);
    assert.throws(() => auditMigration({ content, filename: '0003_x.sql', checksum: sha256(content), target: 'auth' }),
      (e) => ['AGX_MIGRATE_META_COMMAND', 'AGX_MIGRATE_RESERVED_VAR'].includes(e.code), `auth ${name}`);
  }
  // Ninguna barra invertida, ni siquiera dentro de cadenas o comentarios.
  for (const sql of ["select 'a\\b';\n", "-- comentario \\ con barra\nselect 1;\n", "select E'\\n';\n"]) {
    assert.throws(() => assertBundleSafe(sql, '0028_x.sql'), (e) => e.code === 'AGX_MIGRATE_META_COMMAND', sql);
  }
  // Variables reservadas aunque sean solo interpolación (sin metacomando).
  for (const sql of ["select :'agx_migrate_xid';\n", 'select :agx_migrate_xid;\n', 'select :"AGX_MIGRATE_X";\n', 'select :{?agx_migrate_x};\n']) {
    assert.throws(() => assertBundleSafe(sql, '0028_x.sql'), (e) => e.code === 'AGX_MIGRATE_RESERVED_VAR', sql);
  }
  // SQL puro válido, incluida interpolación de una variable no reservada.
  assertBundleSafe("create table agx.t (id integer check (id > 0));\ncomment on table agx.t is 'it''s';\nselect $$ a $$, :'pw', x$y from agx.t;\n", '0028_ok.sql');
});

test('historial congelado: solo los archivos y checksums exactos, con sus metacomandos exactos', () => {
  const frozenB = FROZEN.business.files;
  assert.equal(FROZEN.business.maxVersion, 27);
  assert.equal(FROZEN.auth.maxVersion, 2);
  assert.equal(Object.keys(frozenB).length, 54);
  assert.equal(Object.keys(FROZEN.auth.files).length, 5);
  // Solo tres archivos históricos tienen metacomandos.
  const withMeta = (t) => Object.entries(FROZEN[t].files).filter(([, e]) => e.metas.length).map(([f]) => f);
  assert.deepEqual(withMeta('business'), ['0000_bootstrap_roles.sql', '0023_qr_inventario_chapetas.sql']);
  assert.deepEqual(withMeta('auth'), ['0000_baseline_auth_schema.sql']);
  assert.deepEqual(frozenB['0023_qr_inventario_chapetas.sql'].metas.map((m) => m.split(/\s/)[0]), ['\\gset', '\\if', '\\else', '\\echo', '\\endif', '\\gexec']);
  assert.equal(frozenB['0023_qr_inventario_chapetas.sql'].sha256, 'a1c630e8ee7c31194e79d9e613b35a18d1a8ef9404325c73d83d8a5a321bf861');
  assert.deepEqual(FROZEN.auth.files['0000_baseline_auth_schema.sql'].metas.filter((m) => m.startsWith('\\set')), ['\\set ON_ERROR_STOP on']);

  const m23 = business[23];
  const a0 = auth[0];
  auditMigration({ ...m23, target: 'business' });
  auditMigration({ ...a0, target: 'auth' });
  const tampered = (m, extra) => ({ content: `${m.content}${extra}`, filename: m.filename, checksum: sha256(`${m.content}${extra}`) });
  // 0023: un byte significativo, un \gexec extra, otro archivo, otro checksum.
  assert.throws(() => auditMigration({ ...tampered(m23, '-- cambio\n'), target: 'business' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_TAMPERED');
  assert.throws(() => auditMigration({ ...tampered(m23, "select 'select 1' \\gexec\n"), target: 'business' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_TAMPERED');
  assert.throws(() => auditMigration({ content: m23.content, filename: '0028_copia.sql', checksum: m23.checksum, target: 'business' }), (e) => e.code === 'AGX_MIGRATE_META_COMMAND');
  assert.throws(() => auditMigration({ content: m23.content, filename: '0022_otro.sql', checksum: m23.checksum, target: 'business' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_NOT_FROZEN');
  assert.throws(() => auditMigration({ content: m23.content, filename: m23.filename, checksum: '0'.repeat(64), target: 'business' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_TAMPERED');
  // Auth 0000: \set ON_ERROR_STOP on es el ÚNICO \set; debilitarlo o variarlo cambia el checksum.
  for (const variant of ['\\set ON_ERROR_STOP off', '\\set ON_ERROR_STOP 0', '\\unset ON_ERROR_STOP', '\\set ON_ERROR_STOP  on']) {
    const content = a0.content.replace('\\set ON_ERROR_STOP on', variant);
    assert.notEqual(content, a0.content);
    assert.throws(() => auditMigration({ content, filename: a0.filename, checksum: sha256(content), target: 'auth' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_TAMPERED', variant);
  }
  // Aunque el checksum "cuadrara" (manifiesto alterado), la secuencia de metacomandos se compara exacta.
  const fakeEntry = { ...FROZEN.auth.files['0000_baseline_auth_schema.sql'] };
  const weakened = a0.content.replace('\\set ON_ERROR_STOP on', '\\set ON_ERROR_STOP off');
  FROZEN.auth.files['0000_baseline_auth_schema.sql'] = { ...fakeEntry, sha256: sha256(weakened) };
  try {
    assert.throws(() => auditMigration({ content: weakened, filename: a0.filename, checksum: sha256(weakened), target: 'auth' }), (e) => e.code === 'AGX_MIGRATE_META_COMMAND');
  } finally {
    FROZEN.auth.files['0000_baseline_auth_schema.sql'] = fakeEntry;
  }
  // El manifiesto vive junto al runner, no en el directorio de migraciones.
  assert.ok(FROZEN_MANIFEST_PATH.replace(/\\/g, '/').endsWith('.tools/agx-migrate-frozen.json'));
});

test('historial congelado: --root/--migrations-dir no pueden retirar ni sustituir un archivo histórico', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-frozen-'));
  try {
    for (const f of fs.readdirSync(path.join(ROOT, TARGETS.business.dir))) fs.copyFileSync(path.join(ROOT, TARGETS.business.dir, f), path.join(dir, f));
    listMigrations(dir, 'business');
    fs.rmSync(path.join(dir, '0026_reproduccion_bovina_rollback.sql'));
    assert.throws(() => listMigrations(dir, 'business'), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_NOT_FROZEN');
    fs.copyFileSync(path.join(ROOT, TARGETS.business.dir, '0026_reproduccion_bovina_rollback.sql'), path.join(dir, '0026_reproduccion_bovina_rollback.sql'));
    fs.appendFileSync(path.join(dir, '0005_potrero_capacidad_pastoreo.sql'), 'select 1;\n');
    assert.throws(() => listMigrations(dir, 'business'), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_TAMPERED');
    assert.throws(() => listMigrations(dir), (e) => e.code === 'AGX_MIGRATE_ARGS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime: cada migración termina con la comprobación de error acumulado antes del ledger', () => {
  const next = { ...business[27], version: 28, filename: '0028_x.sql', content: 'select 1;\n', checksum: 'a'.repeat(64) };
  const sql = buildUpBundle({ target: 'business', migration: next, kind: 'ledger', expected: ledgerEntries(business, 28), nonce: 'f'.repeat(32) });
  const content = sql.indexOf('<<< 0028_x.sql');
  const check = sql.indexOf("set_config('agx_migrate.last_error_sqlstate', :'LAST_ERROR_SQLSTATE', true)", content);
  const insert = sql.indexOf("'aplicada', 'agx-migrate/1')");
  assert.ok(content > 0 && check > content && check < insert, JSON.stringify({ content, check, insert }));
  assert.match(sql.slice(check, insert), /AGX_MIGRATE_SUPPRESSED_ERROR/);
  // También al inicio de la sesión y justo antes del COMMIT.
  assert.ok(sql.indexOf('AGX_MIGRATE_SUPPRESSED_ERROR') < sql.indexOf('begin;'));
  assert.ok(sql.lastIndexOf('AGX_MIGRATE_SUPPRESSED_ERROR') < sql.indexOf('\ncommit;'));
  assert.ok(sql.lastIndexOf('AGX_MIGRATE_SUPPRESSED_ERROR') > insert);
});

test('marcador de COMMIT: nonce por ejecución, solo la última marca válida cuenta', () => {
  const n = newNonce();
  const other = newNonce();
  assert.match(n, /^[0-9a-f]{32}$/);
  assert.notEqual(n, other);
  assert.equal(parseCommitMarker('AGX_MIGRATE_COMMITTED xid= 5\n', n), null);
  assert.equal(parseCommitMarker(`AGX_MIGRATE_COMMITTED ${other} xid= 5\n`, n), null);
  assert.equal(parseCommitMarker(`AGX_MIGRATE_COMMITTED ${n} xid= 7\n`, n), '7');
  // Falso anterior (incluso con el nonce correcto) + real posterior: cuenta el último.
  assert.equal(parseCommitMarker(`AGX_MIGRATE_COMMITTED ${n} xid= 3\nruido\nAGX_MIGRATE_COMMITTED ${n} xid= 912\n`, n), '912');
  // Una marca incrustada en otra línea no cuenta.
  assert.equal(parseCommitMarker(`x AGX_MIGRATE_COMMITTED ${n} xid= 3\n`, n), null);
  assert.throws(() => parseCommitMarker('', 'abc'), (e) => e.code === 'AGX_MIGRATE_BAD_NONCE');
  const bundle = buildUpBundle({ target: 'business', migration: business[27], kind: 'bootstrap', expected: ledgerEntries(business, 27), nonce: n,
    fingerprint: { query: 'select 1 as line', schemas: 'agx', expectedMd5: '0'.repeat(32), expectedLines: 1 } });
  assert.ok(bundle.trimEnd().endsWith(`\\echo 'AGX_MIGRATE_COMMITTED ${n} xid=' :agx_migrate_xid`));
});

// Mutation testing del detector: cada mutación que reintroduce una
// interpretación errónea (la del escáner anterior) debe hacer fallar el
// corpus. Se simula con el escáner antiguo, que es exactamente esa mutación.
test('mutación: el escáner anterior (sin identificadores, E-strings ni $ en identificadores) pierde casos del corpus', () => {
  const oldStrip = (sql) => {
    let out = ''; let i = 0;
    while (i < sql.length) {
      const ch = sql[i];
      if (ch === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; continue; }
      if (ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 2; continue; }
      if (ch === '$') { const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i)); if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e === -1 ? sql.length : e + m[0].length; continue; } }
      if (ch === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } if (sql[j] === "'") break; j += 1; } i = j + 1; continue; }
      out += ch; i += 1;
    }
    return out;
  };
  const missedByOld = Object.entries(ADVERSARIAL).filter(([, sql]) => !oldStrip(sql).includes('\\')).map(([k]) => k);
  assert.ok(missedByOld.length >= 4, missedByOld.join(', '));
  for (const k of missedByOld) assert.ok(lexPsql(normalizeSql(ADVERSARIAL[k].replace(/\r(?!\n)/g, ''))).metas.length, k);
});
