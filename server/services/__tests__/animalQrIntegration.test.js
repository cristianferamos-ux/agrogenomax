// SPRINT-3D11.3 (R1) -- QR seguro del animal contra un Postgres/PostGIS
// REAL (0000-0023 aplicadas): esquema de agx.animal_identificadores (CHECK,
// índices únicos, grants, RLS FORCE) y animalQrRepository.js (asignar,
// resolver, revocar, reemplazar, aislamiento entre organizaciones).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL; se auto-omite si no están
// configuradas. Nunca inserta códigos legacy reales (AGX-000001, ...): los
// casos QR_LEGACY usan valores sintéticos dentro de transacciones revertidas.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let appPool;
let animalesRepo;
let qrRepo;
let businessDb;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  appPool = new pg.Pool({ connectionString: testConnectionString, max: 4 });
  const check = await adminPool.query("select to_regclass('agx.animal_identificadores') as t");
  dbAvailable = Boolean(check.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  qrRepo = await import('../ganaderia/animalQrRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
});

const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

async function seedPredio(orgId) {
  const result = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio 3D11.3', 'ACTIVO') returning predio_id`,
    [orgId],
  );
  return String(result.rows[0].predio_id);
}

async function seedAnimal(orgId) {
  const predioId = await seedPredio(orgId);
  const value = validateCreateAnimalBody({
    clientOperationId: crypto.randomUUID(),
    predioId,
    numeroVisual: `QR-${crypto.randomUUID().slice(0, 6)}`,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
  }, { hoy: HOY });
  const { animal } = await animalesRepo.createAnimalIdempotente(orgId, value, { actorCuentaId: ACTOR });
  return animal.animalId;
}

async function asApp(orgId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/** Como admin (BYPASSRLS) dentro de una transacción revertida. */
async function asAdminRolledBack(fn) {
  const client = await adminPool.connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

async function expectPgError(promise, code, constraint) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

function asignar(orgId, animalId, options = {}) {
  return qrRepo.asignarQr(orgId, animalId, { actorCuentaId: ACTOR, ...options });
}

function reemplazar(orgId, animalId, options = {}) {
  return qrRepo.reemplazarQr(orgId, animalId, {
    motivo: 'Chapeta dañada',
    clientOperationId: crypto.randomUUID(),
    actorCuentaId: ACTOR,
    ...options,
  });
}

async function eventos(animalId) {
  return (await adminPool.query(
    `select tipo_evento, metadata_json from agx.animal_eventos where animal_id = $1 and tipo_evento like 'QR_%' order by evento_id`,
    [animalId],
  )).rows;
}

async function insertRaw(client, { orgId, animalId, tipo = 'QR_AGX', valor, estado = 'ACTIVO', extra = {} }) {
  const columns = ['organizacion_id', 'animal_id', 'tipo', 'valor', 'estado', 'asignado_por', ...Object.keys(extra)];
  const values = [orgId, animalId, tipo, valor, estado, ACTOR, ...Object.values(extra)];
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  return client.query(
    `insert into agx.animal_identificadores (${columns.join(', ')}) values (${placeholders}) returning identificador_id`,
    values,
  );
}

function token() {
  return crypto.randomBytes(24).toString('base64url');
}

describe('SPRINT-3D11.3: QR del animal contra Postgres real', { skip: !dbAvailable }, () => {
  // ---------------------------------------------------------------------
  // Casos obligatorios R1 (1-10)
  // ---------------------------------------------------------------------

  test('1. organización A crea un QR para su animal: token opaco de 32 chars, ACTIVO, evento QR_ASIGNADO sin token', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const { identificador, yaExistia } = await asignar(orgA, animalId);
    assert.equal(yaExistia, false);
    assert.equal(identificador.tipo, 'QR_AGX');
    assert.equal(identificador.estado, 'ACTIVO');
    assert.match(identificador.valor, TOKEN_PATTERN);
    assert.equal(identificador.qrPath, `/qr/${identificador.valor}`);
    const evts = await eventos(animalId);
    assert.deepEqual(evts.map((e) => e.tipo_evento), ['QR_ASIGNADO']);
    assert.ok(!JSON.stringify(evts).includes(identificador.valor), 'el evento nunca guarda el token');
  });

  test('2. organización A resuelve su token -> su animal', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const { identificador } = await asignar(orgA, animalId);
    const resolved = await qrRepo.resolverQr(orgA, identificador.valor);
    assert.equal(resolved.animal.animalId, animalId);
  });

  test('3. organización B no resuelve el token de A (null -> 404)', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    await seedAnimal(orgB);
    const { identificador } = await asignar(orgA, animalId);
    assert.equal(await qrRepo.resolverQr(orgB, identificador.valor), null);
  });

  test('4. QR revocado no resuelve (null -> 404) y queda REVOCADO con motivo; reintento idempotente', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const { identificador } = await asignar(orgA, animalId);
    const revocado = await qrRepo.revocarQr(orgA, animalId, { motivo: 'Perdido', actorCuentaId: ACTOR });
    assert.equal(revocado.yaRevocado, false);
    assert.equal(revocado.identificador.estado, 'REVOCADO');
    assert.equal(revocado.identificador.motivo, 'Perdido');
    assert.equal(Object.hasOwn(revocado.identificador, 'valor'), false);
    assert.equal(await qrRepo.resolverQr(orgA, identificador.valor), null);
    const retry = await qrRepo.revocarQr(orgA, animalId, { motivo: 'Perdido', actorCuentaId: ACTOR });
    assert.equal(retry.yaRevocado, true);
    assert.deepEqual((await eventos(animalId)).map((e) => e.tipo_evento), ['QR_ASIGNADO', 'QR_REVOCADO']);
  });

  test('5+6. reemplazo genera token distinto; el anterior queda REEMPLAZADO (no resuelve) y el nuevo resuelve; historial conservado', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const original = (await asignar(orgA, animalId)).identificador;
    const { identificador: nuevo, yaExistia } = await reemplazar(orgA, animalId);
    assert.equal(yaExistia, false);
    assert.notEqual(nuevo.valor, original.valor);
    assert.match(nuevo.valor, TOKEN_PATTERN);
    assert.equal(nuevo.reemplazaA, original.identificadorId);
    assert.equal(await qrRepo.resolverQr(orgA, original.valor), null);
    assert.equal((await qrRepo.resolverQr(orgA, nuevo.valor)).animal.animalId, animalId);

    const qr = await qrRepo.getAnimalQr(orgA, animalId);
    assert.equal(qr.activo.identificadorId, nuevo.identificadorId);
    assert.deepEqual(qr.historial.map((h) => h.estado).sort(), ['ACTIVO', 'REEMPLAZADO']);
    for (const item of qr.historial) assert.equal(Object.hasOwn(item, 'valor'), false, 'el historial no expone tokens');
    const evts = await eventos(animalId);
    assert.deepEqual(evts.map((e) => e.tipo_evento), ['QR_ASIGNADO', 'QR_REEMPLAZADO']);
    assert.ok(!JSON.stringify(evts).includes(nuevo.valor) && !JSON.stringify(evts).includes(original.valor));
  });

  test('reemplazo idempotente por clientOperationId: reintento -> mismo QR, sin segundo reemplazo', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    await asignar(orgA, animalId);
    const clientOperationId = crypto.randomUUID();
    const first = await reemplazar(orgA, animalId, { clientOperationId });
    const retry = await reemplazar(orgA, animalId, { clientOperationId });
    assert.equal(retry.yaExistia, true);
    assert.equal(retry.identificador.identificadorId, first.identificador.identificadorId);
    assert.equal(retry.identificador.valor, first.identificador.valor);
    assert.equal((await qrRepo.getAnimalQr(orgA, animalId)).historial.length, 2);

    const otroAnimal = await seedAnimal(orgA);
    await asignar(orgA, otroAnimal);
    await expectSemantic(reemplazar(orgA, otroAnimal, { clientOperationId }), 'CLIENT_OPERATION_ID_REUSED', 409);
  });

  test('7. solo un QR activo por animal: asignar dos veces (y en concurrencia) devuelve el mismo; el índice impide un segundo ACTIVO', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const results = await Promise.all([asignar(orgA, animalId), asignar(orgA, animalId), asignar(orgA, animalId)]);
    assert.equal(new Set(results.map((r) => r.identificador.identificadorId)).size, 1);
    assert.equal(results.filter((r) => !r.yaExistia).length, 1);
    const activos = await adminPool.query(
      "select count(*)::int as n from agx.animal_identificadores where animal_id = $1 and estado = 'ACTIVO'",
      [animalId],
    );
    assert.equal(activos.rows[0].n, 1);
    await asAdminRolledBack((client) => expectPgError(
      insertRaw(client, { orgId: orgA, animalId, valor: token() }),
      '23505',
      'animal_identificadores_un_activo_por_animal_idx',
    ));
  });

  test('8. token duplicado imposible: mismo valor QR_AGX rechazado aunque el original esté revocado o sea de otra organización', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalA = await seedAnimal(orgA);
    const animalB = await seedAnimal(orgB);
    const { identificador } = await asignar(orgA, animalA);
    await asAdminRolledBack((client) => expectPgError(
      insertRaw(client, { orgId: orgB, animalId: animalB, valor: identificador.valor }),
      '23505',
    ));
    await qrRepo.revocarQr(orgA, animalA, { motivo: 'Perdido', actorCuentaId: ACTOR });
    await asAdminRolledBack((client) => expectPgError(
      insertRaw(client, { orgId: orgA, animalId: animalA, valor: identificador.valor }),
      '23505',
      'animal_identificadores_qr_agx_valor_key',
    ));
  });

  test('colisión de token generado: se reintenta con uno nuevo (nunca reutiliza)', async () => {
    const orgA = crypto.randomUUID();
    const animalA = await seedAnimal(orgA);
    const animalB = await seedAnimal(orgA);
    const existente = (await asignar(orgA, animalA)).identificador.valor;
    const fresco = token();
    const tokens = [existente, fresco];
    const { identificador } = await asignar(orgA, animalB, { tokenGenerator: () => tokens.shift() });
    assert.equal(identificador.valor, fresco);
  });

  test('9. un animal de otra organización no puede recibir QR (404); B tampoco puede revocar/reemplazar/ver el QR de A', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalA = await seedAnimal(orgA);
    await expectSemantic(asignar(orgB, animalA), 'ANIMAL_NOT_FOUND', 404);
    await asignar(orgA, animalA);
    await expectSemantic(qrRepo.revocarQr(orgB, animalA, { motivo: 'x', actorCuentaId: ACTOR }), 'ANIMAL_NOT_FOUND', 404);
    await expectSemantic(reemplazar(orgB, animalA), 'ANIMAL_NOT_FOUND', 404);
    assert.equal(await qrRepo.getAnimalQr(orgB, animalA), null);
    const activos = await adminPool.query(
      "select count(*)::int as n from agx.animal_identificadores where animal_id = $1 and estado = 'ACTIVO'",
      [animalA],
    );
    assert.equal(activos.rows[0].n, 1, 'el QR de A sigue activo');
  });

  test('10. RLS FORCE bloquea acceso cruzado directo como agx_app (SELECT invisible, INSERT/UPDATE de otra organización rechazados)', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalA = await seedAnimal(orgA);
    const { identificador } = await asignar(orgA, animalA);

    await asApp(orgB, async (client) => {
      const visible = await client.query('select count(*)::int as n from agx.animal_identificadores where valor = $1', [identificador.valor]);
      assert.equal(visible.rows[0].n, 0);
      const updated = await client.query(
        "update agx.animal_identificadores set estado = 'REVOCADO', revocado_at = now(), revocado_por = $2, motivo = 'x' where identificador_id = $1",
        [identificador.identificadorId, ACTOR],
      );
      assert.equal(updated.rowCount, 0);
      await expectPgError(insertRaw(client, { orgId: orgA, animalId: animalA, valor: token(), estado: 'REVOCADO' }), '42501');
    });
    const animalASinQr = await seedAnimal(orgA);
    await asApp(orgB, (client) => expectPgError(
      insertRaw(client, { orgId: orgB, animalId: animalASinQr, valor: token() }),
      '23503',
      'animal_identificadores_animal_organizacion_fkey',
    ));
    await asApp('', async (client) => {
      const sinOrg = await client.query('select count(*)::int as n from agx.animal_identificadores');
      assert.equal(sinOrg.rows[0].n, 0, 'sin app.current_org_id no se ve ninguna fila');
    });
    const flags = await adminPool.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.animal_identificadores'::regclass",
    );
    assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  });

  // ---------------------------------------------------------------------
  // Reglas adicionales
  // ---------------------------------------------------------------------

  test('animal ANULADO: no recibe QR nuevo ni reemplazo (409); revocar sigue permitido', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    await asignar(orgA, animalId);
    await animalesRepo.anularAnimal(orgA, animalId, { motivo: 'Error', actorCuentaId: ACTOR });
    await expectSemantic(reemplazar(orgA, animalId), 'ANIMAL_ANULADO', 409);
    await qrRepo.revocarQr(orgA, animalId, { motivo: 'Animal anulado', actorCuentaId: ACTOR });
    await expectSemantic(asignar(orgA, animalId), 'ANIMAL_ANULADO', 409);
  });

  test('revocar/reemplazar sin QR activo -> 409 QR_NO_ACTIVO', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    await expectSemantic(qrRepo.revocarQr(orgA, animalId, { motivo: 'x', actorCuentaId: ACTOR }), 'QR_NO_ACTIVO', 409);
    await expectSemantic(reemplazar(orgA, animalId), 'QR_NO_ACTIVO', 409);
  });

  test('resolver rechaza formato inválido y códigos legacy sin consultar QR_LEGACY', async () => {
    const orgA = crypto.randomUUID();
    for (const value of ['', 'AGX-000003', 'x'.repeat(31), `${token()}x`, null, undefined]) {
      assert.equal(await qrRepo.resolverQr(orgA, value), null);
    }
  });

  test('esquema: CHECK de tipo, formato de valor y consistencia de estado', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const cases = [
      [{ tipo: 'RFID', valor: token() }, 'animal_identificadores_tipo_check'],
      [{ valor: 'corto' }, 'animal_identificadores_valor_formato_check'],
      [{ valor: 'AGX-000003' }, 'animal_identificadores_valor_formato_check'],
      [{ tipo: 'QR_LEGACY', valor: token() }, 'animal_identificadores_valor_formato_check'],
      [{ valor: token(), estado: 'BORRADO' }, 'animal_identificadores_estado_check'],
      [{ valor: token(), estado: 'REVOCADO' }, 'animal_identificadores_estado_consistencia_check'],
      [{ valor: token(), extra: { motivo: 'x' } }, 'animal_identificadores_estado_consistencia_check'],
      [{ valor: token(), estado: 'REVOCADO', extra: { revocado_at: new Date(), revocado_por: ACTOR, motivo: '  ' } }, 'animal_identificadores_estado_consistencia_check'],
    ];
    for (const [row, constraint] of cases) {
      await asAdminRolledBack((client) => expectPgError(insertRaw(client, { orgId: orgA, animalId, ...row }), '23514', constraint));
    }
  });

  test('esquema: QR_LEGACY solo preparado -- acepta el formato sintético dentro de una transacción revertida; no hay filas legacy', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    await asAdminRolledBack(async (client) => {
      const inserted = await insertRaw(client, { orgId: orgA, animalId, tipo: 'QR_LEGACY', valor: 'AGX-999999999' });
      assert.equal(inserted.rowCount, 1);
    });
    const legacy = await adminPool.query("select count(*)::int as n from agx.animal_identificadores where tipo = 'QR_LEGACY'");
    assert.equal(legacy.rows[0].n, 0);
  });

  test('grants: agx_app sin DELETE; UPDATE solo de columnas de estado (valor/tipo/animal_id/organizacion_id inmutables)', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    const { identificador } = await asignar(orgA, animalId);
    await asApp(orgA, (client) => expectPgError(client.query('delete from agx.animal_identificadores'), '42501'));
    for (const assignment of [`valor = '${token()}'`, "tipo = 'QR_LEGACY'", 'animal_id = animal_id', 'organizacion_id = organizacion_id', 'reemplaza_a = null', 'client_operation_id = null']) {
      await asApp(orgA, (client) => expectPgError(
        client.query(`update agx.animal_identificadores set ${assignment} where identificador_id = $1`, [identificador.identificadorId]),
        '42501',
      ));
    }
  });

  test('animal_eventos acepta los tipos QR_* y sigue rechazando tipos desconocidos', async () => {
    const orgA = crypto.randomUUID();
    const animalId = await seedAnimal(orgA);
    await asApp(orgA, async (client) => {
      for (const tipo of ['QR_ASIGNADO', 'QR_REVOCADO', 'QR_REEMPLAZADO']) {
        await client.query(
          'insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, actor_cuenta_id) values ($1, $2, $3, $4)',
          [orgA, animalId, tipo, ACTOR],
        );
      }
      await expectPgError(client.query(
        "insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, actor_cuenta_id) values ($1, $2, 'QR_BORRADO', $3)",
        [orgA, animalId, ACTOR],
      ), '23514', 'animal_eventos_tipo_check');
    });
  });
});
