// HARDENING PRE-SANIDAD (PR A) -- pruebas puras del runner (sin base de datos).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  TARGETS, normalizeSql, sha256, stripSqlForScan, assertBundleSafe, psqlVariables, listMigrations,
  planFromLedger, destructiveTargets, assertRollbackAllowed, certificationMd5, certificationLines,
  extractFingerprintQuery, buildUpBundle, buildRollbackBundle, ledgerEntries,
} from '../agx-migrate-lib.mjs';
import { parseArgs } from '../agx-migrate.mjs';
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
  const head = () => Buffer.from('PGDMP');
  const call = (version, options, readFileHead = head) => assertRollbackAllowed({ config, version, options, readFileHead });
  assert.throws(() => call(25, {}), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { force: true }), (e) => e.code === 'AGX_MIGRATE_FORCE_NOT_SUPPORTED');
  assert.throws(() => call(25, { 'confirm-rollback': '25' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { 'allow-historical-destructive-rollback': '24', 'backup-evidence': 'x' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { 'allow-historical-destructive-rollback': '25' }), (e) => e.code === 'AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED');
  assert.throws(() => call(25, { 'allow-historical-destructive-rollback': '25', 'backup-evidence': 'x' }, () => Buffer.from('hola!')), (e) => e.code === 'AGX_MIGRATE_BACKUP_EVIDENCE');
  assert.deepEqual(call(25, { 'allow-historical-destructive-rollback': '25', 'backup-evidence': 'x' }), { historical: true });
  assert.throws(() => call(27, { 'confirm-rollback': '27' }), (e) => e.code === 'AGX_MIGRATE_LEDGER_ROLLBACK_FORBIDDEN');
  assert.throws(() => call(28, {}), (e) => e.code === 'AGX_MIGRATE_ROLLBACK_NOT_CONFIRMED');
  assert.deepEqual(call(28, { 'confirm-rollback': '28' }), { historical: false });
  assert.throws(() => assertRollbackAllowed({ config: TARGETS.auth, version: 2, options: {} }), (e) => e.code === 'AGX_MIGRATE_NO_LEDGER');
});

test('bundles: transacción explícita, lock, verificaciones antes de la migración y registro al final', () => {
  const fpSql = fs.readFileSync(path.join(ROOT, 'db/verify/schema_fingerprint.sql'), 'utf8');
  const reference = fs.readFileSync(path.join(ROOT, TARGETS.business.baselineFingerprint), 'utf8');
  const boot = buildUpBundle({
    target: 'business', migration: business[27], kind: 'bootstrap', expected: ledgerEntries(business, 27),
    fingerprint: { query: extractFingerprintQuery(fpSql), schemas: 'agx', expectedMd5: certificationMd5(reference), expectedLines: certificationLines(reference).length },
  });
  const order = ['begin;', 'pg_advisory_xact_lock', 'AGX_MIGRATE_ALREADY_APPLIED', 'AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH', '>>> 0027', "'baseline_certificada'", "'aplicada'", 'commit;'];
  const pos = order.map((s) => boot.indexOf(s));
  assert.ok(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), JSON.stringify(pos));
  assert.equal((boot.match(/, 'baseline_certificada', 'agx-migrate\/1'\)/g) || []).length, 27);
  assert.equal((boot.match(/, 'aplicada', 'agx-migrate\/1'\)/g) || []).length, 1);
  const next = { ...business[27], version: 28, filename: '0028_x.sql', content: 'select 1;\n', checksum: 'a'.repeat(64) };
  const normal = buildUpBundle({ target: 'business', migration: next, kind: 'ledger', expected: ledgerEntries(business, 28) });
  for (const code of ['AGX_MIGRATE_NO_LEDGER', 'AGX_MIGRATE_ALREADY_APPLIED', 'AGX_MIGRATE_CHECKSUM_MISMATCH', 'AGX_MIGRATE_GAP', 'AGX_MIGRATE_OUT_OF_ORDER']) assert.match(normal, new RegExp(code));
  assert.ok(normal.indexOf('AGX_MIGRATE_OUT_OF_ORDER') < normal.indexOf('>>> 0028_x.sql'));
  assert.ok(normal.trimEnd().endsWith('commit;'));
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
