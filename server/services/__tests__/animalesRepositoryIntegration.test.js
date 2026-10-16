// SPRINT-3D11.2 -- animalesRepository.js contra un Postgres/PostGIS REAL
// (0022 aplicada): creación (nacimiento, raza con raza_otro_nombre, peso
// inicial), idempotencia por creation_intent_hash (secuencial, concurrente,
// doble colisión, tras corrección, tras anulación), corrección con
// concurrencia optimista, anulación terminal, listado y aislamiento entre
// organizaciones.
//
// Los valores de entrada pasan por validateCreateAnimalBody (misma
// normalización que la ruta HTTP). Lee EXCLUSIVAMENTE
// AGX_BUSINESS_DATABASE_URL_TEST / AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
// se auto-omite si no están configuradas. Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody, validateCorregirAnimalBody } from '../ganaderia/animalValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let repo;
let razasRepo;
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
  const check = await adminPool.query("select to_regclass('agx.animales') as t");
  dbAvailable = Boolean(check.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/animalesRepository.js');
  razasRepo = await import('../ganaderia/catalogoRazasRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
});

const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

function randomOrgId() {
  return crypto.randomUUID();
}

async function seedPredio(orgId, { estado = 'ACTIVO' } = {}) {
  const archivado = estado === 'ARCHIVADO';
  const result = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado, archivado_at, motivo_archivado)
     values ($1, 'Predio 3D11.2', $2, $3, $4) returning predio_id`,
    [orgId, estado, archivado ? new Date() : null, archivado ? 'prueba' : null],
  );
  return String(result.rows[0].predio_id);
}

async function razaId(codigo) {
  return String((await adminPool.query('select raza_id from agx.catalogo_razas where codigo = $1', [codigo])).rows[0].raza_id);
}

async function categoriaId(codigo) {
  return String(
    (await adminPool.query('select categoria_id from agx.catalogo_categorias_productivas where codigo = $1', [codigo])).rows[0].categoria_id,
  );
}

function body(predioId, overrides = {}) {
  return {
    clientOperationId: crypto.randomUUID(),
    predioId,
    numeroVisual: `CH-${crypto.randomUUID().slice(0, 6)}`,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...overrides,
  };
}

function create(orgId, rawBody) {
  return repo.createAnimalIdempotente(orgId, validateCreateAnimalBody(rawBody, { hoy: HOY }), { actorCuentaId: ACTOR });
}

function corregir(orgId, animalId, rawBody) {
  return repo.corregirAnimal(orgId, animalId, validateCorregirAnimalBody(rawBody, { hoy: HOY }), { actorCuentaId: ACTOR });
}

async function countRows(table, animalId, extra = '') {
  return (await adminPool.query(`select count(*)::int as n from agx.${table} where animal_id = $1 ${extra}`, [animalId])).rows[0].n;
}

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

describe('SPRINT-3D11.2: animalesRepository contra Postgres real', { skip: !dbAvailable }, () => {
  // ---------------------------------------------------------------------
  // Creación
  // ---------------------------------------------------------------------

  test('crea un animal básico ACTIVO con un único evento REGISTRADO y sin pesaje', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal, yaExistia } = await create(orgId, body(predioId, { numeroVisual: '  045 ', nombre: 'Lucero' }));
    assert.equal(yaExistia, false);
    assert.equal(animal.estado, 'ACTIVO');
    assert.equal(animal.numeroVisual, '045');
    assert.equal(animal.nombre, 'Lucero');
    assert.equal(animal.predioId, predioId);
    assert.equal(animal.predioNombre, 'Predio 3D11.2');
    assert.equal(animal.ultimoPeso, null);
    for (const hidden of ['organizacionId', 'clientOperationId', 'creationIntentHash']) {
      assert.equal(Object.hasOwn(animal, hidden), false, `no debe exponer ${hidden}`);
    }
    assert.equal(await countRows('animal_eventos', animal.animalId, "and tipo_evento = 'REGISTRADO'"), 1);
    assert.equal(await countRows('animal_pesajes', animal.animalId), 0);
  });

  test('nacimiento EXACTA conserva la fecha; APROXIMADA guarda meses + fecha de referencia del servidor sin fabricar nacimiento; DESCONOCIDA sin datos', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const exacta = (await create(orgId, body(predioId, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-03-10' }))).animal;
    assert.equal(exacta.fechaNacimiento, '2024-03-10');
    assert.equal(exacta.edadAproximadaMeses, null);

    const aprox = (await create(orgId, body(predioId, { nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 18 }))).animal;
    assert.equal(aprox.fechaNacimiento, null);
    assert.equal(aprox.edadAproximadaMeses, 18);
    assert.equal(aprox.edadReferenciaFecha, HOY);

    const desconocida = (await create(orgId, body(predioId))).animal;
    assert.equal(desconocida.nacimientoTipo, 'DESCONOCIDA');
    assert.equal(desconocida.fechaNacimiento, null);
    assert.equal(desconocida.edadAproximadaMeses, null);
    assert.equal(desconocida.edadReferenciaFecha, null);
  });

  test('raza: PURA de catálogo, PURA con raza_otro_nombre, CRUCE con predominante, CRUCE solo descripción, DESCONOCIDA', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const brahman = await razaId('brahman');
    const angus = await razaId('angus');

    const puraCatalogo = (await create(orgId, body(predioId, { razaTipo: 'PURA', razaPrincipalId: brahman }))).animal;
    assert.equal(puraCatalogo.razaPrincipalNombre, 'Brahman');
    assert.equal(puraCatalogo.razaOtroNombre, null);

    const puraOtra = (await create(orgId, body(predioId, { razaTipo: 'PURA', razaOtroNombre: '  Charolais ' }))).animal;
    assert.equal(puraOtra.razaTipo, 'PURA');
    assert.equal(puraOtra.razaPrincipalId, null);
    assert.equal(puraOtra.razaOtroNombre, 'Charolais');

    const cruce = (await create(orgId, body(predioId, {
      razaTipo: 'CRUCE', razaPrincipalId: angus, cruceDescripcion: 'Angus × Brahman',
    }))).animal;
    assert.equal(cruce.razaPrincipalNombre, 'Angus');
    assert.equal(cruce.cruceDescripcion, 'Angus × Brahman');

    const mestizo = (await create(orgId, body(predioId, { razaTipo: 'CRUCE', cruceDescripcion: 'Mestizo comercial' }))).animal;
    assert.equal(mestizo.razaPrincipalId, null);
    assert.equal(mestizo.cruceDescripcion, 'Mestizo comercial');

    const desconocida = (await create(orgId, body(predioId, { razaTipo: 'DESCONOCIDA' }))).animal;
    assert.equal(desconocida.razaTipo, 'DESCONOCIDA');
  });

  test('peso inicial: báscula y estimado crean un pesaje REGISTRO_INICIAL con la fecha de negocio; sin peso no hay fila', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const bascula = (await create(orgId, body(predioId, { pesoInicialKg: 280.5, pesoInicialMetodo: 'BASCULA' }))).animal;
    assert.deepEqual(bascula.ultimoPeso, { pesoKg: 280.5, metodo: 'BASCULA', fecha: HOY });
    const estimado = (await create(orgId, body(predioId, { pesoInicialKg: 300, pesoInicialMetodo: 'ESTIMADO' }))).animal;
    assert.equal(estimado.ultimoPeso.metodo, 'ESTIMADO');
    const pesajes = await adminPool.query('select origen, actor_cuenta_id from agx.animal_pesajes where animal_id = $1', [bascula.animalId]);
    assert.deepEqual(pesajes.rows, [{ origen: 'REGISTRO_INICIAL', actor_cuenta_id: ACTOR }]);
    const sinPeso = (await create(orgId, body(predioId))).animal;
    assert.equal(await countRows('animal_pesajes', sinPeso.animalId), 0);
  });

  test('predio archivado -> 409 PREDIO_ARCHIVADO; predio de otra organización -> 404 PREDIO_NOT_FOUND', async () => {
    const orgA = randomOrgId();
    const archivado = await seedPredio(orgA, { estado: 'ARCHIVADO' });
    await expectSemantic(create(orgA, body(archivado)), 'PREDIO_ARCHIVADO', 409);
    const orgB = randomOrgId();
    const predioB = await seedPredio(orgB);
    await expectSemantic(create(orgA, body(predioB)), 'PREDIO_NOT_FOUND', 404);
  });

  test('raza inexistente o inactiva -> 400 INVALID_RAZA', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    await expectSemantic(create(orgId, body(predioId, { razaTipo: 'PURA', razaPrincipalId: '999999999' })), 'INVALID_RAZA', 400);
    const inactiva = await adminPool.query(
      "insert into agx.catalogo_razas (codigo, nombre, tipo_productivo, activo) values ($1, 'Raza inactiva', 'carne', false) returning raza_id",
      [`inactiva_${crypto.randomUUID().slice(0, 8)}`],
    );
    await expectSemantic(
      create(orgId, body(predioId, { razaTipo: 'PURA', razaPrincipalId: String(inactiva.rows[0].raza_id) })),
      'INVALID_RAZA',
      400,
    );
  });

  test('categoría inexistente -> INVALID_CATEGORIA; sexo incompatible -> CATEGORIA_INCOMPATIBLE_SEXO; ternero_emposte válido para ambos sexos', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    await expectSemantic(create(orgId, body(predioId, { categoriaProductivaId: '999999999' })), 'INVALID_CATEGORIA', 400);
    await expectSemantic(
      create(orgId, body(predioId, { sexo: 'MACHO', categoriaProductivaId: await categoriaId('vaca_seca') })),
      'CATEGORIA_INCOMPATIBLE_SEXO',
      400,
    );
    const emposte = await categoriaId('ternero_emposte');
    for (const sexo of ['MACHO', 'HEMBRA']) {
      const { animal } = await create(orgId, body(predioId, { sexo, categoriaProductivaId: emposte }));
      assert.equal(animal.categoriaProductivaCodigo, 'ternero_emposte');
    }
  });

  // ---------------------------------------------------------------------
  // Idempotencia
  // ---------------------------------------------------------------------

  test('reintento secuencial idéntico -> yaExistia, mismo animal, sin pesaje ni evento duplicados', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const raw = body(predioId, { pesoInicialKg: 250, pesoInicialMetodo: 'ESTIMADO' });
    const first = await create(orgId, raw);
    const second = await create(orgId, { ...raw, numeroVisual: `  ${raw.numeroVisual}  ` });
    assert.equal(first.yaExistia, false);
    assert.equal(second.yaExistia, true);
    assert.equal(second.animal.animalId, first.animal.animalId);
    assert.equal(await countRows('animal_pesajes', first.animal.animalId), 1);
    assert.equal(await countRows('animal_eventos', first.animal.animalId), 1);
  });

  test('misma operación con payload distinto (280 -> 300 kg) -> 409 CLIENT_OPERATION_ID_REUSED', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const raw = body(predioId, { pesoInicialKg: 280, pesoInicialMetodo: 'BASCULA' });
    await create(orgId, raw);
    await expectSemantic(create(orgId, { ...raw, pesoInicialKg: 300 }), 'CLIENT_OPERATION_ID_REUSED', 409);
  });

  test('reintentos concurrentes de la misma intención -> un solo animal, un solo evento, uno creado y el resto yaExistia', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const raw = body(predioId, { pesoInicialKg: 310, pesoInicialMetodo: 'BASCULA' });
    const results = await Promise.all(Array.from({ length: 5 }, () => create(orgId, raw)));
    assert.equal(results.filter((r) => !r.yaExistia).length, 1);
    assert.equal(new Set(results.map((r) => r.animal.animalId)).size, 1);
    const animalId = results[0].animal.animalId;
    assert.equal(await countRows('animal_eventos', animalId), 1);
    assert.equal(await countRows('animal_pesajes', animalId), 1);
  });

  test('operaciones distintas con el mismo número visual -> 409 ANIMAL_NUMERO_VISUAL_DUPLICADO (sin distinguir mayúsculas)', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    await create(orgId, body(predioId, { numeroVisual: 'A-77' }));
    await expectSemantic(create(orgId, body(predioId, { numeroVisual: 'a-77' })), 'ANIMAL_NUMERO_VISUAL_DUPLICADO', 409);
  });

  test('concurrencia: operaciones distintas con el mismo número visual -> exactamente un 201 y el resto DUPLICADO', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => create(orgId, body(predioId, { numeroVisual: 'CONC-1' }))),
    );
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
    for (const rejected of settled.filter((s) => s.status === 'rejected')) {
      assert.equal(rejected.reason.code, 'ANIMAL_NUMERO_VISUAL_DUPLICADO');
    }
  });

  test('doble colisión concurrente (misma operación + mismo número) -> nunca DUPLICADO: un creado y el resto yaExistia', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const raw = body(predioId, { numeroVisual: 'DOBLE-1' });
    const results = await Promise.all(Array.from({ length: 4 }, () => create(orgId, raw)));
    assert.equal(results.filter((r) => !r.yaExistia).length, 1);
    assert.equal(new Set(results.map((r) => r.animal.animalId)).size, 1);
  });

  test('doble colisión concurrente (misma operación + número distinto) -> un creado y el resto CLIENT_OPERATION_ID_REUSED, nunca DUPLICADO', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const op = crypto.randomUUID();
    const settled = await Promise.allSettled([
      create(orgId, body(predioId, { clientOperationId: op, numeroVisual: 'OP-A' })),
      create(orgId, body(predioId, { clientOperationId: op, numeroVisual: 'OP-B' })),
      create(orgId, body(predioId, { clientOperationId: op, numeroVisual: 'OP-C' })),
    ]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
    for (const rejected of settled.filter((s) => s.status === 'rejected')) {
      assert.equal(rejected.reason.code, 'CLIENT_OPERATION_ID_REUSED');
    }
  });

  test('reintento tras corrección -> yaExistia, resuelto contra animales.creation_intent_hash (NO contra el evento)', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const raw = body(predioId, { nombre: 'Original' });
    const { animal } = await create(orgId, raw);
    await corregir(orgId, animal.animalId, {
      fechaActualizacionEsperada: animal.fechaActualizacion, numeroVisual: animal.numeroVisual, nombre: 'Corregido',
    });

    // 1) El evento REGISTRADO se altera (como superusuario): el reintento
    //    sigue resolviéndose igual -> el protocolo no lee el evento.
    await adminPool.query(
      `update agx.animal_eventos set metadata_json = '{"intentHash":"v1:${'0'.repeat(64)}"}'::jsonb
        where animal_id = $1 and tipo_evento = 'REGISTRADO'`,
      [animal.animalId],
    );
    const retry = await create(orgId, raw);
    assert.equal(retry.yaExistia, true);
    assert.equal(retry.animal.animalId, animal.animalId);
    assert.equal(retry.animal.nombre, 'Corregido');

    // 2) Solo cambiando creation_intent_hash cambia la decisión.
    await adminPool.query(
      `update agx.animales set creation_intent_hash = 'v1:${'f'.repeat(64)}' where animal_id = $1`,
      [animal.animalId],
    );
    await expectSemantic(create(orgId, raw), 'CLIENT_OPERATION_ID_REUSED', 409);
  });

  test('reintento tras anulación -> yaExistia con estado ANULADO; nunca crea otro animal', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const raw = body(predioId);
    const { animal } = await create(orgId, raw);
    await repo.anularAnimal(orgId, animal.animalId, { motivo: 'Registro duplicado', actorCuentaId: ACTOR });
    const retry = await create(orgId, raw);
    assert.equal(retry.yaExistia, true);
    assert.equal(retry.animal.estado, 'ANULADO');
    assert.equal(retry.animal.animalId, animal.animalId);
  });

  // ---------------------------------------------------------------------
  // Corrección
  // ---------------------------------------------------------------------

  test('corrección: crea DATOS_CORREGIDOS con solo los nombres de columnas cambiadas; sin cambios -> sinCambios sin evento', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal } = await create(orgId, body(predioId, { razaTipo: 'DESCONOCIDA' }));
    const corregido = await corregir(orgId, animal.animalId, {
      fechaActualizacionEsperada: animal.fechaActualizacion,
      razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre: 'Charolais', cruceDescripcion: null,
    });
    assert.equal(corregido.sinCambios, false);
    assert.equal(corregido.animal.razaOtroNombre, 'Charolais');
    const evento = await adminPool.query(
      "select metadata_json from agx.animal_eventos where animal_id = $1 and tipo_evento = 'DATOS_CORREGIDOS'",
      [animal.animalId],
    );
    assert.deepEqual(evento.rows[0].metadata_json, { campos: ['raza_tipo', 'raza_otro_nombre'] });

    // Reintento idéntico (aunque la fecha esperada quedó vieja): sin cambios, sin evento.
    const retry = await corregir(orgId, animal.animalId, {
      fechaActualizacionEsperada: animal.fechaActualizacion,
      razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre: 'Charolais', cruceDescripcion: null,
    });
    assert.equal(retry.sinCambios, true);
    assert.equal(await countRows('animal_eventos', animal.animalId, "and tipo_evento = 'DATOS_CORREGIDOS'"), 1);
  });

  test('corrección con fecha esperada obsoleta y cambios reales -> 409 ANIMAL_MODIFICADO', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal } = await create(orgId, body(predioId, { nombre: 'Uno' }));
    await corregir(orgId, animal.animalId, {
      fechaActualizacionEsperada: animal.fechaActualizacion, numeroVisual: animal.numeroVisual, nombre: 'Dos',
    });
    await expectSemantic(
      corregir(orgId, animal.animalId, {
        fechaActualizacionEsperada: animal.fechaActualizacion, numeroVisual: animal.numeroVisual, nombre: 'Tres',
      }),
      'ANIMAL_MODIFICADO',
      409,
    );
  });

  test('corrección: edad aproximada nueva fija la fecha de referencia de hoy; cambio de sexo valida la categoría vigente', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal } = await create(orgId, body(predioId, {
      sexo: 'HEMBRA', categoriaProductivaId: await categoriaId('novilla_levante'),
    }));
    const aprox = await corregir(orgId, animal.animalId, {
      fechaActualizacionEsperada: animal.fechaActualizacion,
      nacimientoTipo: 'APROXIMADA', fechaNacimiento: null, edadAproximadaMeses: 20,
    });
    assert.equal(aprox.animal.edadReferenciaFecha, HOY);
    assert.equal(aprox.animal.fechaNacimiento, null);
    await expectSemantic(
      corregir(orgId, animal.animalId, { fechaActualizacionEsperada: aprox.animal.fechaActualizacion, sexo: 'MACHO' }),
      'CATEGORIA_INCOMPATIBLE_SEXO',
      400,
    );
  });

  test('corrección a un número visual ya usado por otro animal activo -> 409 DUPLICADO', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    await create(orgId, body(predioId, { numeroVisual: 'USADO-1' }));
    const { animal } = await create(orgId, body(predioId, { numeroVisual: 'LIBRE-1' }));
    await expectSemantic(
      corregir(orgId, animal.animalId, { fechaActualizacionEsperada: animal.fechaActualizacion, numeroVisual: 'usado-1', nombre: null }),
      'ANIMAL_NUMERO_VISUAL_DUPLICADO',
      409,
    );
  });

  // ---------------------------------------------------------------------
  // Anulación y ciclo de vida
  // ---------------------------------------------------------------------

  test('anular: un único evento ANULADO; el reintento devuelve yaAnulado y conserva el primer motivo', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal } = await create(orgId, body(predioId));
    const first = await repo.anularAnimal(orgId, animal.animalId, { motivo: 'Error de digitación', actorCuentaId: ACTOR });
    assert.equal(first.yaAnulado, false);
    assert.equal(first.animal.estado, 'ANULADO');
    const second = await repo.anularAnimal(orgId, animal.animalId, { motivo: 'Otro motivo', actorCuentaId: ACTOR });
    assert.equal(second.yaAnulado, true);
    assert.equal(second.animal.estadoMotivo, 'Error de digitación');
    assert.equal(await countRows('animal_eventos', animal.animalId, "and tipo_evento = 'ANULADO'"), 1);
  });

  test('anulaciones concurrentes -> un único evento ANULADO', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal } = await create(orgId, body(predioId));
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => repo.anularAnimal(orgId, animal.animalId, {
      motivo: `Motivo ${i}`, actorCuentaId: ACTOR,
    })));
    assert.equal(results.filter((r) => !r.yaAnulado).length, 1);
    assert.equal(await countRows('animal_eventos', animal.animalId, "and tipo_evento = 'ANULADO'"), 1);
  });

  test('ciclo de vida: anulado fuera de la lista por defecto, consultable directamente, número reutilizable, corrección rechazada', async () => {
    const orgId = randomOrgId();
    const predioId = await seedPredio(orgId);
    const { animal } = await create(orgId, body(predioId, { numeroVisual: 'REUSO-9' }));
    await repo.anularAnimal(orgId, animal.animalId, { motivo: 'Registrado por error', actorCuentaId: ACTOR });

    const activos = await repo.listAnimales(orgId, { predioId: null, estado: 'ACTIVO', sexo: null, q: null, limit: 50, offset: 0 });
    assert.equal(activos.animales.some((a) => a.animalId === animal.animalId), false);
    const anulados = await repo.listAnimales(orgId, { predioId: null, estado: 'ANULADO', sexo: null, q: null, limit: 50, offset: 0 });
    assert.equal(anulados.animales.some((a) => a.animalId === animal.animalId), true);

    const detalle = await repo.getAnimal(orgId, animal.animalId);
    assert.equal(detalle.estado, 'ANULADO');

    const nuevo = await create(orgId, body(predioId, { numeroVisual: 'REUSO-9' }));
    assert.notEqual(nuevo.animal.animalId, animal.animalId);

    await expectSemantic(
      corregir(orgId, animal.animalId, { fechaActualizacionEsperada: detalle.fechaActualizacion, numeroVisual: 'X-1', nombre: null }),
      'ANIMAL_ANULADO',
      409,
    );
  });

  // ---------------------------------------------------------------------
  // Listado y aislamiento
  // ---------------------------------------------------------------------

  test('listado: filtros predio/sexo, búsqueda por prefijo sin distinguir mayúsculas (q escapa % y _), total y paginación', async () => {
    const orgId = randomOrgId();
    const predio1 = await seedPredio(orgId);
    const predio2 = await seedPredio(orgId);
    await create(orgId, body(predio1, { numeroVisual: 'LOTE-01', sexo: 'HEMBRA' }));
    await create(orgId, body(predio1, { numeroVisual: 'LOTE-02', sexo: 'MACHO' }));
    await create(orgId, body(predio2, { numeroVisual: '500', nombre: 'Lola', sexo: 'HEMBRA' }));
    await create(orgId, body(predio2, { numeroVisual: '50%', sexo: 'HEMBRA' }));

    const base = { predioId: null, estado: 'ACTIVO', sexo: null, q: null, limit: 50, offset: 0 };
    assert.equal((await repo.listAnimales(orgId, base)).total, 4);
    assert.equal((await repo.listAnimales(orgId, { ...base, predioId: predio1 })).total, 2);
    assert.equal((await repo.listAnimales(orgId, { ...base, sexo: 'MACHO' })).total, 1);
    assert.equal((await repo.listAnimales(orgId, { ...base, q: 'lote' })).total, 2);
    assert.equal((await repo.listAnimales(orgId, { ...base, q: 'lo' })).total, 3);
    assert.equal((await repo.listAnimales(orgId, { ...base, q: '50%' })).total, 1);
    assert.equal((await repo.listAnimales(orgId, { ...base, q: '5_' })).total, 0);

    const page = await repo.listAnimales(orgId, { ...base, limit: 3, offset: 3 });
    assert.equal(page.total, 4);
    assert.equal(page.animales.length, 1);
  });

  test('aislamiento: otra organización no lista, no consulta, no corrige ni anula animales ajenos', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const { animal } = await create(orgA, body(await seedPredio(orgA)));
    await seedPredio(orgB);
    const listB = await repo.listAnimales(orgB, { predioId: null, estado: 'TODOS', sexo: null, q: null, limit: 50, offset: 0 });
    assert.equal(listB.total, 0);
    assert.equal(await repo.getAnimal(orgB, animal.animalId), null);
    await expectSemantic(
      corregir(orgB, animal.animalId, { fechaActualizacionEsperada: animal.fechaActualizacion, nombre: 'X', numeroVisual: null }),
      'ANIMAL_NOT_FOUND',
      404,
    );
    await expectSemantic(
      repo.anularAnimal(orgB, animal.animalId, { motivo: 'x', actorCuentaId: ACTOR }),
      'ANIMAL_NOT_FOUND',
      404,
    );
    assert.equal((await repo.getAnimal(orgA, animal.animalId)).estado, 'ACTIVO');
  });

  test('catálogo entre organizaciones: una raza propia de otra organización no se acepta ni al crear ni al corregir (la FK sola no honra RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA);
    const ajena = await adminPool.query(
      "insert into agx.catalogo_razas (organizacion_id, codigo, nombre, tipo_productivo) values ($1, $2, 'Raza de B', 'carne') returning raza_id",
      [orgB, `org_b_${crypto.randomUUID().slice(0, 8)}`],
    );
    const razaAjenaId = String(ajena.rows[0].raza_id);

    // La organización dueña sí la ve (control positivo de la fila).
    const propiaB = await create(orgB, body(await seedPredio(orgB), { razaTipo: 'PURA', razaPrincipalId: razaAjenaId }));
    assert.equal(propiaB.animal.razaPrincipalId, razaAjenaId);

    await expectSemantic(
      create(orgA, body(predioA, { razaTipo: 'PURA', razaPrincipalId: razaAjenaId })),
      'INVALID_RAZA',
      400,
    );
    await expectSemantic(
      create(orgA, body(predioA, { razaTipo: 'CRUCE', razaPrincipalId: razaAjenaId, cruceDescripcion: 'x' })),
      'INVALID_RAZA',
      400,
    );

    const { animal } = await create(orgA, body(predioA));
    await expectSemantic(
      corregir(orgA, animal.animalId, {
        fechaActualizacionEsperada: animal.fechaActualizacion,
        razaTipo: 'PURA', razaPrincipalId: razaAjenaId, razaOtroNombre: null, cruceDescripcion: null,
      }),
      'INVALID_RAZA',
      400,
    );
    assert.equal((await repo.getAnimal(orgA, animal.animalId)).razaTipo, 'DESCONOCIDA');
  });

  test('catálogo de razas: solo razas activas, con el seed de sistema y sin razas ficticias', async () => {
    const razas = await razasRepo.listRazas(randomOrgId());
    const codigos = razas.map((r) => r.codigo);
    assert.ok(codigos.includes('brahman'));
    for (const ficticia of ['otra', 'no_definida', 'cebu_comercial']) assert.ok(!codigos.includes(ficticia));
    assert.ok(razas.every((r) => ['carne', 'leche', 'doble_proposito'].includes(r.tipoProductivo)));
  });
});
