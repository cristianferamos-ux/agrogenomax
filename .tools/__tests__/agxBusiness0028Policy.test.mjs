// FASE 5A.1a -- política de contenido de 0028 (sin base de datos): SQL puro
// aceptado por el runner, versión exacta, rollback presente y contrato de
// objetos que la integración (agxBusiness0028Integration) ejercita en real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TARGETS, auditMigration, destructiveTargets, listMigrations, normalizeSql, psqlVariables, sha256 } from '../agx-migrate-lib.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = path.join(ROOT, TARGETS.business.dir);
const UP = '0028_animal_pesajes_anulacion.sql';
const DOWN = '0028_animal_pesajes_anulacion_rollback.sql';
const read = (f) => normalizeSql(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('0028: versión exacta tras el ledger 0027, con rollback', () => {
  const business = listMigrations(DIR, 'business');
  const m = business.find((x) => x.version === 28);
  assert.ok(m, '0028 presente');
  assert.equal(m.filename, UP);
  assert.equal(m.rollback?.filename, DOWN);
  assert.equal(business[27].filename, '0027_schema_migrations_ledger.sql');
  assert.ok(28 > TARGETS.business.ledgerVersion);
});

test('0028 y su rollback: SQL puro (sin barra invertida, sin metacomandos, sin variables psql)', () => {
  for (const f of [UP, DOWN]) {
    const content = read(f);
    assert.equal(content.includes(String.fromCharCode(92)), false, `${f} contiene barra invertida`);
    assert.deepEqual(psqlVariables(content), [], `${f} no interpola variables`);
    const lex = auditMigration({ content, filename: f, checksum: sha256(content), target: 'business' });
    assert.deepEqual(lex.metas, [], `${f} sin metacomandos`);
    assert.doesNotMatch(content, /agx_migrate_/i);
  }
});

test('0028: estructura congelada del diseño aprobado', () => {
  const sql = read(UP);
  for (const col of ['estado_registro', 'anulado_por', 'anulado_at', 'motivo_anulacion', 'anulacion_client_operation_id']) {
    assert.match(sql, new RegExp(`add column ${col} `));
  }
  assert.match(sql, /add column estado_registro varchar\(10\) not null default 'ACTIVO'/);
  assert.match(sql, /create unique index animal_pesajes_org_anulacion_client_operation_key\s+on agx\.animal_pesajes \(organizacion_id, anulacion_client_operation_id\)\s+where anulacion_client_operation_id is not null/);
  assert.match(sql, /before insert or update or delete on agx\.animal_pesajes/);
  assert.match(sql, /grant update \(estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id\)\s+on agx\.animal_pesajes to agx_app;/);
  // Sin FK a Auth, sin cambios de RLS/políticas, sin DELETE/TRUNCATE/UPDATE general.
  assert.doesNotMatch(sql, /references/i);
  assert.doesNotMatch(sql, /policy|row level security/i);
  assert.doesNotMatch(sql, /grant[^;]*(delete|truncate)/i);
  assert.equal((sql.match(/grant update/gi) || []).length, 1);
  // El trigger protege todo el contenido original del pesaje.
  for (const col of ['pesaje_id', 'organizacion_id', 'animal_id', 'fecha', 'peso_kg', 'metodo', 'origen', 'actor_cuenta_id', 'created_at', 'client_operation_id', 'observaciones']) {
    assert.match(sql, new RegExp(`new\\.${col}[,)]`), `trigger compara new.${col}`);
    assert.match(sql, new RegExp(`old\\.${col}[,)]`), `trigger compara old.${col}`);
  }
  assert.match(sql, /FORWARD-ONLY EN PRODUCCIÓN/);
});

test('rollback 0028: el runner lo precondiciona sobre todas las columnas que borra', () => {
  const { tables, columns } = destructiveTargets(read(DOWN));
  assert.deepEqual(tables, []);
  assert.deepEqual(columns.map((c) => `${c.table}.${c.column}`).sort(), [
    'agx.animal_pesajes.anulacion_client_operation_id',
    'agx.animal_pesajes.anulado_at',
    'agx.animal_pesajes.anulado_por',
    'agx.animal_pesajes.estado_registro',
    'agx.animal_pesajes.motivo_anulacion',
  ]);
  assert.match(read(DOWN), /if exists \(select 1 from agx\.animal_pesajes\) then/);
});
