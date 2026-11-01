// FASE 4A -- reproducción bovina contra un Postgres/PostGIS REAL (0000-0026):
// migración (CHECKs, FKs tenant-safe, trigger de inmutabilidad, grants,
// RLS+FORCE, rollback), registro de los 8 tipos, máquina de estados
// derivada, invariantes del animal (tenant, ANULADO, SALIDO, MUERTO, sexo,
// toro), idempotencia (secuencial y concurrente), concurrencia entre
// eventos, anulación/corrección con recálculo del estado y línea de tiempo.
//
// Los valores pasan por reproduccionValidation.js (misma normalización que
// la ruta HTTP). Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST
// (agx_app), AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST (agx_qr_admin) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL; se auto-omite si faltan o si
// 0026 no está aplicada.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateCorregirAnimalBody, validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { validateCierreBody } from '../ganaderia/cierreValidation.js';
import {
  validateAnularEventoReproductivoBody,
  validateCorregirEventoReproductivoBody,
  validateCrearEventoReproductivoBody,
} from '../ganaderia/reproduccionValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'db', 'agx-business', 'migrations');

let dbAvailable = false;
let adminPool;
let appPool;
let animalesRepo;
let cierreRepo;
let repo;
let timeline;
let businessDb;
let qrAdminDb;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  const qrAdminConnectionString = process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST;
  if (!testConnectionString || !adminConnectionString || !qrAdminConnectionString) throw new Error('conexiones de prueba no configuradas');
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;
  process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL = qrAdminConnectionString;
  process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = process.env.AGX_QR_TOKEN_ENCRYPTION_KEY_TEST || crypto.randomBytes(32).toString('base64');
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});
  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  appPool = new pg.Pool({ connectionString: testConnectionString, max: 2 });
  const check = await adminPool.query(`select to_regclass('agx.reproduccion_eventos') is not null as ok`);
  dbAvailable = check.rows[0].ok === true;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  cierreRepo = await import('../ganaderia/cierreRepository.js');
  repo = await import('../ganaderia/reproduccionRepository.js');
  timeline = await import('../ganaderia/timeline/timelineService.js');
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
});

const HOY = resolveFechaHoyNegocio();
const OPTS = { hoy: HOY, horaAhora: '23:59' };
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const newOrg = () => crypto.randomUUID();
const op = () => crypto.randomUUID();

async function seedAnimal(org, extra = {}) {
  const predio = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio FASE 4A', 'ACTIVO') returning predio_id`,
    [org],
  );
  const body = validateCreateAnimalBody({
    clientOperationId: op(),
    predioId: String(predio.rows[0].predio_id),
    numeroVisual: `R-${crypto.randomUUID().slice(0, 8)}`,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...extra,
  }, { hoy: HOY });
  const { animal } = await animalesRepo.createAnimalIdempotente(org, body, { actorCuentaId: ACTOR });
  return animal.animalId;
}

const valor = (body) => validateCrearEventoReproductivoBody({ clientOperationId: op(), ...body }, OPTS);
const registrar = (org, animalId, value) => repo.registrarEventoReproductivoIdempotente(org, animalId, value, { actorCuentaId: ACTOR, hoy: HOY });
const reg = (org, animalId, body) => registrar(org, animalId, valor(body));
const anular = (org, animalId, eventoId, body = {}) => repo.anularEventoReproductivoIdempotente(
  org, animalId, eventoId, validateAnularEventoReproductivoBody({ clientOperationId: op(), motivo: 'Error de digitación', ...body }),
  { actorCuentaId: ACTOR, hoy: HOY },
);
const corregir = (org, animalId, eventoId, body) => repo.corregirEventoReproductivoIdempotente(
  org, animalId, eventoId, validateCorregirEventoReproductivoBody({ clientOperationId: op(), motivo: 'Corrección', ...body }, OPTS),
  { actorCuentaId: ACTOR, hoy: HOY },
);
const estadoDe = async (org, animalId) => (await repo.obtenerEstadoReproductivo(org, animalId, { hoy: HOY })).estado.estado;

const CELO = { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-01-05', intensidadCelo: 'ALTA', metodoDeteccion: 'VISUAL' };
const IA = { tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-01-06', semenCodigo: 'PAJ-01', tecnico: 'Técnico A', toroExterno: 'Gyr X' };
const PRENADA = { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-02-20', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA', diasGestacion: 45 };
const VACIA = { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-02-20', diagnosticoResultado: 'VACIA', diagnosticoMetodo: 'PALPACION' };
const PARTO = { tipoEvento: 'PARTO', fechaEvento: '2026-09-30', partoTipo: 'NORMAL', numeroCrias: 1 };

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

async function filas(animalId) {
  return (await adminPool.query(
    `select evento_id::text, tipo_evento, estado_registro, corrige_evento_id::text
       from agx.reproduccion_eventos where animal_id = $1 order by evento_id`,
    [animalId],
  )).rows;
}

/** Ejecuta `sql` como agx_app con app.current_org_id = org (transacción revertida). */
async function comoApp(org, sql, params = []) {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_org_id', $1, true)", [org]);
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

describe('FASE 4A: reproducción bovina (Postgres real)', { skip: !dbAvailable && 'Postgres de integración no disponible o 0026 sin aplicar' }, () => {
  describe('migración 0026', () => {
    test('RLS ENABLE + FORCE, dueño agx_owner y política tenant', async () => {
      const r = await adminPool.query(
        `select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner,
                (select count(*)::int from pg_policies p where p.schemaname = 'agx' and p.tablename = 'reproduccion_eventos') as politicas
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'agx' and c.relname = 'reproduccion_eventos'`,
      );
      assert.deepEqual(r.rows[0], { relrowsecurity: true, relforcerowsecurity: true, owner: 'agx_owner', politicas: 1 });
    });

    test('mínimo privilegio de agx_app: SELECT/INSERT, UPDATE solo de anulación, sin DELETE', async () => {
      const t = await adminPool.query(
        `select has_table_privilege('agx_app', 'agx.reproduccion_eventos', 'SELECT') as s,
                has_table_privilege('agx_app', 'agx.reproduccion_eventos', 'INSERT') as i,
                has_table_privilege('agx_app', 'agx.reproduccion_eventos', 'DELETE') as d,
                has_table_privilege('agx_app', 'agx.reproduccion_eventos', 'TRUNCATE') as tr,
                has_table_privilege('agx_app', 'agx.reproduccion_eventos', 'UPDATE') as u`,
      );
      assert.deepEqual(t.rows[0], { s: true, i: true, d: false, tr: false, u: false });
      const cols = await adminPool.query(
        `select column_name from information_schema.column_privileges
          where table_schema = 'agx' and table_name = 'reproduccion_eventos' and grantee = 'agx_app' and privilege_type = 'UPDATE'
          order by column_name`,
      );
      assert.deepEqual(cols.rows.map((r) => r.column_name), [
        'anulacion_client_operation_id', 'anulado_at', 'anulado_por', 'estado_registro', 'motivo_anulacion',
      ]);
    });

    test('agx_app no puede reescribir contenido ni borrar; el trigger protege también a otras conexiones', async () => {
      const org = newOrg();
      const animalId = await seedAnimal(org);
      const { evento } = await reg(org, animalId, CELO);
      await assert.rejects(comoApp(org, `update agx.reproduccion_eventos set fecha_evento = '2026-01-01' where evento_id = $1`, [evento.eventoId]), { code: '42501' });
      await assert.rejects(comoApp(org, `delete from agx.reproduccion_eventos where evento_id = $1`, [evento.eventoId]), { code: '42501' });
      await assert.rejects(adminPool.query(`update agx.reproduccion_eventos set observaciones = 'x' where evento_id = $1`, [evento.eventoId]), { code: '23514' });
      await assert.rejects(adminPool.query(`delete from agx.reproduccion_eventos where evento_id = $1`, [evento.eventoId]), { code: '23514' });
      await anular(org, animalId, evento.eventoId);
      await assert.rejects(
        adminPool.query(`update agx.reproduccion_eventos set motivo_anulacion = 'otro' where evento_id = $1`, [evento.eventoId]),
        { code: '23514' },
      );
    });

    test('CHECKs: tipo inválido, campos de otro tipo, observaciones > 500 y anulación incompleta', async () => {
      const org = newOrg();
      const animalId = await seedAnimal(org);
      const base = `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, client_operation_id, intent_hash`;
      const hash = `v1:${'0'.repeat(64)}`;
      const casos = [
        [`${base}) values ($1, $2, 'VACUNA', '2026-01-01', $3, gen_random_uuid(), '${hash}')`],
        [`${base}, parto_tipo, numero_crias) values ($1, $2, 'CELO_OBSERVADO', '2026-01-01', $3, gen_random_uuid(), '${hash}', 'NORMAL', 1)`],
        [`${base}) values ($1, $2, 'PARTO', '2026-01-01', $3, gen_random_uuid(), '${hash}')`],
        [`${base}, parto_tipo) values ($1, $2, 'PARTO', '2026-01-01', $3, gen_random_uuid(), '${hash}', 'NORMAL')`],
        [`${base}) values ($1, $2, 'TRANSFERENCIA_EMBRION', '2026-01-01', $3, gen_random_uuid(), '${hash}')`],
        [`${base}, diagnostico_metodo) values ($1, $2, 'DIAGNOSTICO_PRENEZ', '2026-01-01', $3, gen_random_uuid(), '${hash}', 'PALPACION')`],
        [`${base}, dias_gestacion) values ($1, $2, 'CELO_OBSERVADO', '2026-01-01', $3, gen_random_uuid(), '${hash}', 40)`],
        [`${base}) values ($1, $2, 'SERVICIO_MONTA', '2026-01-01', $3, gen_random_uuid(), '${hash}')`],
        [`${base}, observaciones) values ($1, $2, 'ABORTO', '2026-01-01', $3, gen_random_uuid(), '${hash}', repeat('x', 501))`],
        [`${base}, dias_gestacion, diagnostico_resultado, diagnostico_metodo) values ($1, $2, 'DIAGNOSTICO_PRENEZ', '2026-01-01', $3, gen_random_uuid(), '${hash}', 40, 'VACIA', 'PALPACION')`],
        [`${base}, estado_registro) values ($1, $2, 'ABORTO', '2026-01-01', $3, gen_random_uuid(), '${hash}', 'ANULADO')`],
        [`${base}) values ($1, $2, 'ABORTO', '1989-12-31', $3, gen_random_uuid(), '${hash}')`],
      ];
      for (const [sql] of casos) await assert.rejects(adminPool.query(sql, [org, animalId, ACTOR]), { code: '23514' }, sql);
    });

    test('FKs tenant-safe: animal/toro de otra organización y corrección de otro animal', async () => {
      const orgA = newOrg();
      const orgB = newOrg();
      const hembraA = await seedAnimal(orgA);
      const otraA = await seedAnimal(orgA);
      const toroB = await seedAnimal(orgB, { sexo: 'MACHO' });
      const hash = `v1:${'0'.repeat(64)}`;
      await assert.rejects(adminPool.query(
        `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, client_operation_id, intent_hash)
         values ($1, $2, 'ABORTO', '2026-01-01', $3, gen_random_uuid(), $4)`, [orgB, hembraA, ACTOR, hash],
      ), { code: '23503' });
      await assert.rejects(adminPool.query(
        `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, toro_animal_id, registrado_por, client_operation_id, intent_hash)
         values ($1, $2, 'IATF', '2026-01-01', $3, $4, gen_random_uuid(), $5)`, [orgA, hembraA, toroB, ACTOR, hash],
      ), { code: '23503' });
      const { evento } = await reg(orgA, hembraA, CELO);
      await assert.rejects(adminPool.query(
        `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, corrige_evento_id, registrado_por, client_operation_id, intent_hash)
         values ($1, $2, 'CELO_OBSERVADO', '2026-01-01', $3, $4, gen_random_uuid(), $5)`, [orgA, otraA, evento.eventoId, ACTOR, hash],
      ), { code: '23503' });
    });

    test('rollback se niega si hay historial (no borra datos)', async () => {
      const org = newOrg();
      await reg(org, await seedAnimal(org), CELO);
      const sql = fs.readFileSync(path.join(MIGRATIONS, '0026_reproduccion_bovina_rollback.sql'), 'utf8');
      const client = await adminPool.connect();
      try {
        await client.query('begin');
        await assert.rejects(client.query(sql), { code: '23514' });
      } finally {
        await client.query('rollback');
        client.release();
      }
      assert.equal((await adminPool.query(`select to_regclass('agx.reproduccion_eventos') is not null as ok`)).rows[0].ok, true);
    });
  });

  describe('registro de eventos y máquina de estados', () => {
    test('ciclo completo: celo -> IA -> preñada -> parto (cada paso recalcula el estado)', async () => {
      const org = newOrg();
      const animalId = await seedAnimal(org);
      assert.equal(await estadoDe(org, animalId), 'SIN_ESTADO');
      const pasos = [[CELO, 'CICLANDO'], [IA, 'SERVIDA'], [PRENADA, 'PRENADA'], [PARTO, 'POSPARTO']];
      for (const [body, esperado] of pasos) {
        const r = await reg(org, animalId, body);
        assert.equal(r.yaExistia, false);
        assert.equal(r.estado.estado, esperado, body.tipoEvento);
        assert.equal(r.evento.tipoEvento, body.tipoEvento);
        assert.equal(r.evento.estadoRegistro, 'ACTIVO');
        assert.equal(r.evento.organizacionId, undefined);
      }
      const data = await repo.obtenerReproduccionAnimal(org, animalId, { hoy: HOY });
      assert.equal(data.eventos.length, 4);
      assert.deepEqual(data.eventos[1].detalle, { toroExterno: 'Gyr X', semenCodigo: 'PAJ-01', tecnico: 'Técnico A' });
      assert.equal(data.estado.ultimoParto.numeroCrias, 1);
      for (const e of data.eventos) assert.ok(!('intentHash' in e) && !('registradoPor' in e) && !('clientOperationId' in e));
    });

    test('monta con toro propio, IATF con protocolo, diagnóstico VACIA y aborto', async () => {
      const org = newOrg();
      const toro = await seedAnimal(org, { sexo: 'MACHO' });
      const a = await seedAnimal(org);
      const monta = await reg(org, a, { tipoEvento: 'SERVICIO_MONTA', fechaEvento: '2026-01-10', tipoServicio: 'CONTROLADA', toroAnimalId: toro });
      assert.equal(monta.evento.detalle.toroAnimalId, toro);
      assert.equal((await reg(org, a, VACIA)).estado.estado, 'VACIA');
      assert.equal((await reg(org, a, { tipoEvento: 'IATF', fechaEvento: '2026-03-01', horaEvento: '07:30', protocoloIatf: 'J-Synch', tecnico: 'T' })).estado.estado, 'SERVIDA');
      assert.equal((await reg(org, a, { ...PRENADA, fechaEvento: '2026-04-10', diasGestacion: undefined })).estado.estado, 'PRENADA');
      const ab = await reg(org, a, { tipoEvento: 'ABORTO', fechaEvento: '2026-06-01', diasGestacion: 90, abortoCausa: 'Desconocida' });
      assert.equal(ab.estado.estado, 'VACIA');
      assert.equal(ab.evento.horaEvento, null);
    });

    test('caso PIDAR: receptora con TE de embrión fresco F1 Girolando y diagnóstico posterior', async () => {
      const org = newOrg();
      const receptora = await seedAnimal(org);
      const te = await reg(org, receptora, {
        tipoEvento: 'TRANSFERENCIA_EMBRION', fechaEvento: '2026-05-02', embrionConservacion: 'FRESCO',
        embrionCodigo: 'EMB-F1-001', embrionRaza: 'F1 Girolando', embrionDonadora: 'Donadora Holstein', toroExterno: 'Gyr lechero',
        embrionEstadio: 'Blastocisto', embrionCalidad: '1', tecnico: 'MVZ responsable',
      });
      assert.equal(te.estado.estado, 'SERVIDA');
      const diag = await reg(org, receptora, { ...PRENADA, fechaEvento: '2026-06-01', diasGestacion: 37 });
      assert.equal(diag.estado.estado, 'PRENADA');
      assert.equal(diag.estado.gestacion.base, 'DIAGNOSTICO');
      assert.equal(diag.estado.gestacion.fechaConcepcionEstimada, '2026-04-25');
    });

    test('sexo incompatible (macho) -> 409; toro hembra, propio inexistente o de otra organización -> 400', async () => {
      const org = newOrg();
      const macho = await seedAnimal(org, { sexo: 'MACHO' });
      await expectSemantic(reg(org, macho, CELO), 'SEXO_INCOMPATIBLE', 409);
      assert.equal(await estadoDe(org, macho), 'NO_APLICA');
      const hembra = await seedAnimal(org);
      const otraHembra = await seedAnimal(org);
      const orgB = newOrg();
      const toroB = await seedAnimal(orgB, { sexo: 'MACHO' });
      for (const toroAnimalId of [otraHembra, '999999999', toroB]) {
        await expectSemantic(reg(org, hembra, { ...IA, toroAnimalId }), 'INVALID_TORO', 400);
      }
      assert.equal((await filas(hembra)).length, 0);
    });

    test('animal inexistente y de otra organización -> 404 indistinguible; lecturas null', async () => {
      const orgA = newOrg();
      const orgB = newOrg();
      const animalA = await seedAnimal(orgA);
      await reg(orgA, animalA, CELO);
      await expectSemantic(reg(orgB, animalA, CELO), 'ANIMAL_NOT_FOUND', 404);
      await expectSemantic(reg(orgA, '999999999', CELO), 'ANIMAL_NOT_FOUND', 404);
      assert.equal(await repo.obtenerReproduccionAnimal(orgB, animalA, { hoy: HOY }), null);
      assert.equal(await repo.obtenerEstadoReproductivo(orgB, animalA, { hoy: HOY }), null);
      const { evento } = (await repo.obtenerReproduccionAnimal(orgA, animalA, { hoy: HOY })).eventos.map((e) => ({ evento: e }))[0];
      await expectSemantic(anular(orgB, animalA, evento.eventoId), 'ANIMAL_NOT_FOUND', 404);
      // RLS directo: org B no ve las filas de org A.
      assert.equal((await comoApp(orgB, 'select count(*)::int as n from agx.reproduccion_eventos where animal_id = $1', [animalA])).rows[0].n, 0);
      assert.equal((await comoApp(orgA, 'select count(*)::int as n from agx.reproduccion_eventos where animal_id = $1', [animalA])).rows[0].n, 1);
    });

    test('animal ANULADO -> 409; SALIDO / MUERTO -> 409 sin eventos ordinarios (anulación administrativa sí)', async () => {
      const org = newOrg();
      const anulado = await seedAnimal(org);
      await animalesRepo.anularAnimal(org, anulado, { motivo: 'Duplicado', actorCuentaId: ACTOR });
      await expectSemantic(reg(org, anulado, CELO), 'ANIMAL_ANULADO', 409);

      const salido = await seedAnimal(org);
      const { evento } = await reg(org, salido, CELO);
      await cierreRepo.registrarCierreIdempotente(org, salido, validateCierreBody('SALIDA', {
        fechaSalida: '2026-01-20', motivoSalida: 'VENTA', clientOperationId: op(),
      }, { hoy: HOY }), { actorCuentaId: ACTOR });
      await expectSemantic(reg(org, salido, { ...IA, fechaEvento: '2026-01-10' }), 'ANIMAL_YA_SALIDO', 409);
      assert.equal((await anular(org, salido, evento.eventoId)).estado.estado, 'SIN_ESTADO');

      const muerto = await seedAnimal(org);
      await cierreRepo.registrarCierreIdempotente(org, muerto, validateCierreBody('MUERTE', {
        fechaMuerte: '2026-01-20', causaMuerte: 'ENFERMEDAD', clientOperationId: op(),
      }, { hoy: HOY }), { actorCuentaId: ACTOR });
      await expectSemantic(reg(org, muerto, CELO), 'ANIMAL_YA_MUERTO', 409);
    });

    test('fechas: anterior al nacimiento -> 400; anterior al último evento -> 409', async () => {
      const org = newOrg();
      const a = await seedAnimal(org, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-03-01' });
      await expectSemantic(reg(org, a, { ...CELO, fechaEvento: '2024-02-28' }), 'INVALID_FECHA', 400);
      await reg(org, a, IA);
      await expectSemantic(reg(org, a, { ...CELO, fechaEvento: '2026-01-05' }), 'FECHA_ANTERIOR_A_HISTORIAL', 409);
      assert.equal((await reg(org, a, { ...CELO, fechaEvento: IA.fechaEvento })).estado.estado, 'CICLANDO');
    });

    test('evento no permitido por estado -> 409 (preñada: sin servicio; vacía/posparto: sin parto)', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      await reg(org, a, PRENADA);
      await expectSemantic(reg(org, a, { ...IA, fechaEvento: '2026-03-01' }), 'EVENTO_NO_PERMITIDO_POR_ESTADO', 409);
      await expectSemantic(reg(org, a, { ...CELO, fechaEvento: '2026-03-01' }), 'EVENTO_NO_PERMITIDO_POR_ESTADO', 409);
      await reg(org, a, PARTO);
      await expectSemantic(reg(org, a, { ...PARTO, fechaEvento: '2026-10-01' }), 'EVENTO_NO_PERMITIDO_POR_ESTADO', 409);
      const b = await seedAnimal(org);
      await reg(org, b, VACIA);
      await expectSemantic(reg(org, b, { tipoEvento: 'ABORTO', fechaEvento: '2026-03-01' }), 'EVENTO_NO_PERMITIDO_POR_ESTADO', 409);
    });
  });

  describe('idempotencia', () => {
    test('misma operación + misma intención -> yaExistia sin nueva fila; contenido o animal distinto -> 409', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const b = await seedAnimal(org);
      const value = valor(CELO);
      const primero = await registrar(org, a, value);
      const segundo = await registrar(org, a, { ...value });
      assert.equal(segundo.yaExistia, true);
      assert.equal(segundo.evento.eventoId, primero.evento.eventoId);
      assert.equal((await filas(a)).length, 1);
      await expectSemantic(registrar(org, a, { ...value, observaciones: 'otra' }), 'CLIENT_OPERATION_ID_REUSED', 409);
      await expectSemantic(registrar(org, b, value), 'CLIENT_OPERATION_ID_REUSED', 409);
      // El mismo UUID en OTRA organización es otra operación.
      const orgB = newOrg();
      assert.equal((await registrar(orgB, await seedAnimal(orgB), value)).yaExistia, false);
    });

    test('reintentos concurrentes de la misma operación -> una sola fila', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const value = valor(IA);
      const results = await Promise.all(Array.from({ length: 5 }, () => registrar(org, a, { ...value })));
      assert.equal(results.filter((r) => !r.yaExistia).length, 1);
      assert.equal(new Set(results.map((r) => r.evento.eventoId)).size, 1);
      assert.equal((await filas(a)).length, 1);
    });
  });

  describe('concurrencia entre eventos distintos', () => {
    test('dos partos simultáneos sobre una preñada: exactamente uno entra', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      await reg(org, a, PRENADA);
      const results = await Promise.allSettled([reg(org, a, PARTO), reg(org, a, PARTO)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
      assert.equal((await filas(a)).filter((f) => f.tipo_evento === 'PARTO').length, 1);
      assert.equal(await estadoDe(org, a), 'POSPARTO');
    });

    test('dos diagnósticos simultáneos: ambos serializados; el estado es el del último en el historial', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      await reg(org, a, IA);
      const [r1, r2] = await Promise.all([reg(org, a, PRENADA), reg(org, a, VACIA)]);
      const ultimo = Number(r1.evento.eventoId) > Number(r2.evento.eventoId) ? r1 : r2;
      assert.equal(await estadoDe(org, a), ultimo.evento.detalle.diagnosticoResultado);
      assert.equal(ultimo.estado.estado, ultimo.evento.detalle.diagnosticoResultado);
    });

    test('registro concurrente con la anulación del animal: nunca queda un evento posterior a ANULADO', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const [r, anul] = await Promise.allSettled([
        reg(org, a, CELO),
        animalesRepo.anularAnimal(org, a, { motivo: 'Duplicado', actorCuentaId: ACTOR }),
      ]);
      assert.equal(anul.status, 'fulfilled');
      if (r.status === 'rejected') assert.equal(r.reason.code, 'ANIMAL_ANULADO');
      await expectSemantic(reg(org, a, IA), 'ANIMAL_ANULADO', 409);
    });
  });

  describe('anulación y corrección', () => {
    test('anular el último evento recalcula el estado desde el historial válido', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      await reg(org, a, IA);
      const { evento } = await reg(org, a, PRENADA);
      const r = await anular(org, a, evento.eventoId, { motivo: 'Diagnóstico de otra vaca' });
      assert.equal(r.estado.estado, 'SERVIDA');
      assert.equal(r.evento.estadoRegistro, 'ANULADO');
      assert.equal(r.evento.anulacion.motivo, 'Diagnóstico de otra vaca');
      const fila = (await adminPool.query(`select anulado_por, anulado_at is not null as at from agx.reproduccion_eventos where evento_id = $1`, [evento.eventoId])).rows[0];
      assert.deepEqual(fila, { anulado_por: ACTOR, at: true });
      assert.equal((await filas(a)).length, 2, 'sin DELETE');
    });

    test('anular un evento intermedio recalcula (no "revierte") el estado', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      await reg(org, a, CELO);
      await reg(org, a, IA);
      const diag = await reg(org, a, VACIA);
      const iatf = await reg(org, a, { tipoEvento: 'IATF', fechaEvento: '2026-03-01' });
      assert.equal(iatf.estado.estado, 'SERVIDA');
      const r = await anular(org, a, diag.evento.eventoId);
      assert.equal(r.estado.estado, 'SERVIDA');
      assert.equal(r.estado.desde, IA.fechaEvento, 'servida desde la IA original: el diagnóstico anulado ya no corta el ciclo');
      const celo = (await repo.obtenerReproduccionAnimal(org, a, { hoy: HOY })).eventos[0];
      await anular(org, a, celo.eventoId);
      await anular(org, a, iatf.evento.eventoId);
      assert.equal(await estadoDe(org, a), 'SERVIDA');
    });

    test('anulación idempotente; reanular -> 409; operación reutilizada -> 409; evento de otro animal -> 404', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const b = await seedAnimal(org);
      const { evento } = await reg(org, a, CELO);
      const { evento: deB } = await reg(org, b, CELO);
      const clientOperationId = op();
      const r1 = await anular(org, a, evento.eventoId, { clientOperationId });
      const r2 = await anular(org, a, evento.eventoId, { clientOperationId });
      assert.deepEqual([r1.yaExistia, r2.yaExistia], [false, true]);
      await expectSemantic(anular(org, a, evento.eventoId, { clientOperationId, motivo: 'otro motivo' }), 'CLIENT_OPERATION_ID_REUSED', 409);
      await expectSemantic(anular(org, a, evento.eventoId), 'EVENTO_YA_ANULADO', 409);
      await expectSemantic(anular(org, a, deB.eventoId), 'EVENTO_NOT_FOUND', 404);
      await expectSemantic(anular(org, b, deB.eventoId, { clientOperationId }), 'CLIENT_OPERATION_ID_REUSED', 409);
    });

    test('corregir: anula + crea enlazado (puede cambiar tipo), recalcula, idempotente y una sola vez', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const { evento } = await reg(org, a, IA);
      const clientOperationId = op();
      const body = { clientOperationId, motivo: 'Era IATF', evento: { tipoEvento: 'IATF', fechaEvento: '2026-01-04', protocoloIatf: 'Ovsynch' } };
      const r = await corregir(org, a, evento.eventoId, body);
      assert.equal(r.yaExistia, false);
      assert.equal(r.evento.tipoEvento, 'IATF');
      assert.equal(r.evento.corrigeEventoId, evento.eventoId);
      assert.equal(r.eventoCorregido.estadoRegistro, 'ANULADO');
      assert.equal(r.eventoCorregido.corregidoPorEventoId, r.evento.eventoId);
      assert.equal(r.estado.estado, 'SERVIDA');
      const again = await corregir(org, a, evento.eventoId, body);
      assert.equal(again.yaExistia, true);
      assert.equal(again.evento.eventoId, r.evento.eventoId);
      await expectSemantic(corregir(org, a, evento.eventoId, { ...body, motivo: 'otro' }), 'CLIENT_OPERATION_ID_REUSED', 409);
      await expectSemantic(corregir(org, a, evento.eventoId, { ...body, clientOperationId: op() }), 'EVENTO_YA_ANULADO', 409);
      // La operación de corrección no sirve como anulación.
      await expectSemantic(anular(org, a, evento.eventoId, { clientOperationId, motivo: 'Era IATF' }), 'CLIENT_OPERATION_ID_REUSED', 409);
      assert.deepEqual((await filas(a)).map((f) => [f.tipo_evento, f.estado_registro, f.corrige_evento_id]), [
        ['INSEMINACION_ARTIFICIAL', 'ANULADO', null],
        ['IATF', 'ACTIVO', evento.eventoId],
      ]);
    });

    test('corregir no valida la regla de transición, pero sí sexo/toro/fecha', async () => {
      const org = newOrg();
      const a = await seedAnimal(org, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-01-01' });
      await reg(org, a, IA);
      const diag = await reg(org, a, PRENADA);
      // Corrección retroactiva: el diagnóstico era VACIA y de una fecha anterior.
      const r = await corregir(org, a, diag.evento.eventoId, { evento: { ...VACIA, fechaEvento: '2026-01-30' } });
      assert.equal(r.estado.estado, 'VACIA');
      await expectSemantic(corregir(org, a, r.evento.eventoId, { evento: { ...VACIA, fechaEvento: '2023-12-31' } }), 'INVALID_FECHA', 400);
    });
  });

  describe('corrección del animal frente al historial reproductivo', () => {
    const corregirAnimal = async (org, animalId, body) => {
      const animal = await animalesRepo.getAnimal(org, animalId);
      return animalesRepo.corregirAnimal(org, animalId, validateCorregirAnimalBody({
        fechaActualizacionEsperada: animal.fechaActualizacion, ...body,
      }, { hoy: HOY }), { actorCuentaId: ACTOR });
    };
    const sexoDe = async (animalId) => (await adminPool.query('select sexo from agx.animales where animal_id = $1', [animalId])).rows[0].sexo;
    const NAC = (fechaNacimiento) => ({ nacimientoTipo: 'EXACTA', fechaNacimiento, edadAproximadaMeses: null });

    test('A) hembra sin historial: HEMBRA -> MACHO sigue permitido', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      assert.equal((await corregirAnimal(org, a, { sexo: 'MACHO' })).sinCambios, false);
      assert.equal(await sexoDe(a), 'MACHO');
    });

    test('B) con evento ACTIVO: HEMBRA -> MACHO -> 409; sexo y evento intactos', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      await reg(org, a, CELO);
      const antes = await filas(a);
      await expectSemantic(corregirAnimal(org, a, { sexo: 'MACHO' }), 'HISTORIAL_REPRODUCTIVO_INCOMPATIBLE', 409);
      assert.equal(await sexoDe(a), 'HEMBRA');
      assert.deepEqual(await filas(a), antes);
      // Corregir otros datos sigue permitido.
      assert.equal((await corregirAnimal(org, a, { observaciones: 'Nota' })).sinCambios, false);
    });

    test('C) con único evento ANULADO: HEMBRA -> MACHO -> 409 (el historial auditado sigue existiendo)', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const { evento } = await reg(org, a, CELO);
      await anular(org, a, evento.eventoId);
      await expectSemantic(corregirAnimal(org, a, { sexo: 'MACHO' }), 'HISTORIAL_REPRODUCTIVO_INCOMPATIBLE', 409);
      assert.equal(await sexoDe(a), 'HEMBRA');
    });

    test('toro referenciado en un servicio: MACHO -> HEMBRA -> 409', async () => {
      const org = newOrg();
      const toro = await seedAnimal(org, { sexo: 'MACHO' });
      await reg(org, await seedAnimal(org), { ...IA, toroAnimalId: toro });
      await expectSemantic(corregirAnimal(org, toro, { sexo: 'HEMBRA' }), 'HISTORIAL_REPRODUCTIVO_INCOMPATIBLE', 409);
      assert.equal(await sexoDe(toro), 'MACHO');
    });

    test('D/E) fechaNacimiento: anterior o igual al primer evento (incluido ANULADO) -> permitido; posterior -> 409', async () => {
      const org = newOrg();
      const a = await seedAnimal(org, NAC('2024-01-01'));
      const { evento } = await reg(org, a, { ...CELO, fechaEvento: '2026-05-01' });
      await anular(org, a, evento.eventoId);
      await reg(org, a, { ...IA, fechaEvento: '2026-07-01' });
      assert.equal((await corregirAnimal(org, a, NAC('2023-06-01'))).sinCambios, false);
      assert.equal((await corregirAnimal(org, a, NAC('2026-05-01'))).sinCambios, false);
      await expectSemantic(corregirAnimal(org, a, NAC('2026-06-01')), 'HISTORIAL_REPRODUCTIVO_FECHA_INCOMPATIBLE', 409);
      const fecha = (await adminPool.query(`select to_char(fecha_nacimiento, 'YYYY-MM-DD') as f from agx.animales where animal_id = $1`, [a])).rows[0].f;
      assert.equal(fecha, '2026-05-01');
      assert.equal((await filas(a)).length, 2, 'eventos sin modificar');
      // Pasar a nacimiento DESCONOCIDA no contradice el historial.
      assert.equal((await corregirAnimal(org, a, { nacimientoTipo: 'DESCONOCIDA', fechaNacimiento: null, edadAproximadaMeses: null })).sinCambios, false);
    });

    test('F) concurrencia registro vs HEMBRA -> MACHO (ambos órdenes): nunca MACHO + historial', async () => {
      const org = newOrg();
      for (let i = 0; i < 6; i += 1) {
        const a = await seedAnimal(org);
        const correccion = () => corregirAnimal(org, a, { sexo: 'MACHO' });
        const registro = () => reg(org, a, CELO);
        const [r1, r2] = await Promise.allSettled(i % 2 ? [registro(), correccion()] : [correccion(), registro()]);
        const [reg_, corr] = i % 2 ? [r1, r2] : [r2, r1];
        assert.ok((reg_.status === 'fulfilled') !== (corr.status === 'fulfilled'), `exactamente uno gana (${reg_.status}/${corr.status})`);
        if (reg_.status === 'rejected') assert.equal(reg_.reason.code, 'SEXO_INCOMPATIBLE');
        if (corr.status === 'rejected') assert.ok(['HISTORIAL_REPRODUCTIVO_INCOMPATIBLE', 'ANIMAL_MODIFICADO'].includes(corr.reason.code), corr.reason.code);
        const sexo = await sexoDe(a);
        const n = (await filas(a)).length;
        assert.ok(!(sexo === 'MACHO' && n > 0), `estado inválido: ${sexo} con ${n} eventos`);
      }
    });

    /** Transacción agx_app abierta (tenant = org) que se confirma desde el test. */
    async function txAbierta(org) {
      const client = await appPool.connect();
      await client.query('begin');
      await client.query("select set_config('app.current_org_id', $1, true)", [org]);
      return {
        q: (sql, params) => client.query(sql, params),
        fin: async (sql = 'commit') => { await client.query(sql); client.release(); },
      };
    }
    const espera = (ms) => new Promise((r) => { setTimeout(r, ms); });

    test('F) determinista: corrección a MACHO en curso (FOR UPDATE) -> el registro espera y se rechaza', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const tx = await txAbierta(org);
      await tx.q('select 1 from agx.animales where animal_id = $1 for update', [a]);
      await tx.q(`update agx.animales set sexo = 'MACHO', updated_at = now() where animal_id = $1`, [a]);
      let terminado = false;
      const registro = reg(org, a, CELO).finally(() => { terminado = true; });
      await espera(300);
      assert.equal(terminado, false, 'el registro debe esperar al bloqueo de la corrección');
      await tx.fin();
      await expectSemantic(registro, 'SEXO_INCOMPATIBLE', 409);
      assert.equal((await filas(a)).length, 0);
    });

    test('F) determinista: registro en curso (FOR SHARE + INSERT) -> la corrección espera y se rechaza', async () => {
      const org = newOrg();
      const a = await seedAnimal(org);
      const tx = await txAbierta(org);
      await tx.q('select 1 from agx.animales where animal_id = $1 for share', [a]);
      await tx.q(
        `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, client_operation_id, intent_hash)
         values ($1, $2, 'CELO_OBSERVADO', '2026-01-05', $3, gen_random_uuid(), $4)`,
        [org, a, ACTOR, `v1:${'0'.repeat(64)}`],
      );
      let terminado = false;
      const correccion = corregirAnimal(org, a, { sexo: 'MACHO' }).finally(() => { terminado = true; });
      await espera(300);
      assert.equal(terminado, false, 'la corrección debe esperar al registro en curso');
      await tx.fin();
      await expectSemantic(correccion, 'HISTORIAL_REPRODUCTIVO_INCOMPATIBLE', 409);
      assert.equal(await sexoDe(a), 'HEMBRA');
    });

    test('F) concurrencia registro con toro vs MACHO -> HEMBRA del toro: nunca toro hembra referenciado', async () => {
      const org = newOrg();
      for (let i = 0; i < 4; i += 1) {
        const toro = await seedAnimal(org, { sexo: 'MACHO' });
        const hembra = await seedAnimal(org);
        await Promise.allSettled([reg(org, hembra, { ...IA, toroAnimalId: toro }), corregirAnimal(org, toro, { sexo: 'HEMBRA' })]);
        const sexo = await sexoDe(toro);
        const n = (await adminPool.query('select count(*)::int as n from agx.reproduccion_eventos where toro_animal_id = $1', [toro])).rows[0].n;
        assert.ok(!(sexo === 'HEMBRA' && n > 0), `estado inválido: toro ${sexo} con ${n} servicios`);
      }
    });

    test('G) otra organización: su historial no influye ni se revela', async () => {
      const orgA = newOrg();
      const orgB = newOrg();
      const deB = await seedAnimal(orgB);
      await reg(orgB, deB, CELO);
      // org A no ve el animal de B: 404 indistinguible, sin mencionar historial.
      await expectSemantic(animalesRepo.corregirAnimal(orgA, deB, validateCorregirAnimalBody({
        fechaActualizacionEsperada: '2026-01-01T00:00:00.000Z', sexo: 'MACHO',
      }, { hoy: HOY }), { actorCuentaId: ACTOR }), 'ANIMAL_NOT_FOUND', 404);
      // Un animal de A sin historial propio se corrige libremente.
      const deA = await seedAnimal(orgA);
      assert.equal((await corregirAnimal(orgA, deA, { sexo: 'MACHO' })).sinCambios, false);
      assert.equal(await sexoDe(deB), 'HEMBRA');
    });
  });

  test('línea de tiempo: incluye eventos reproductivos (activos y anulados) sin duplicar', async () => {
    const org = newOrg();
    const a = await seedAnimal(org);
    await reg(org, a, IA);
    const { evento } = await reg(org, a, PRENADA);
    await anular(org, a, evento.eventoId);
    const t = await timeline.obtenerTimelineAnimal(org, a, { limit: 50 });
    const repro = t.eventos.filter((e) => e.origen === 'reproduccion_eventos');
    assert.deepEqual(repro.map((e) => [e.tipo, e.datos.estadoRegistro]), [['PRENEZ', 'ANULADO'], ['INSEMINACION', 'ACTIVO']]);
    const ev = (await adminPool.query(`select count(*)::int as n from agx.animal_eventos where animal_id = $1`, [a])).rows[0].n;
    assert.equal(ev, 1, 'solo REGISTRADO: la reproducción no se copia a animal_eventos');
  });
});
