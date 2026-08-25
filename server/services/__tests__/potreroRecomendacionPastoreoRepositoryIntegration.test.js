// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas del repositorio
// (server/services/ganaderia/potreroRecomendacionPastoreoRepository.js)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// potreroContextoAgroclimaticoRepositoryIntegration.test.js. Cubre:
// resolución de ficha/categoría/contexto server-side, estados READY/
// PARTIAL_CONTEXT/INSUFFICIENT_FORAGE_DATA/NO_PRODUCTIVE_PROFILE (§18 del
// sprint), aislamiento tenant, histórico append-only, y motor_version
// persistido (§15 del sprint).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (nunca la variable
// de producción/runtime real). Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

let dbAvailable = false;
let adminPool;
let repo;
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
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_recomendaciones_pastoreo') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroRecomendacionPastoreoRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

function randomOrgId() {
  return crypto.randomUUID();
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

async function seedPredio(orgId, nombre) {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, nombre],
  );
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, nombre) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), 1, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT],
  );
  return result.rows[0].potrero_id;
}

async function seedPasturaPersonalizada(orgId, nombre, tipo = 'graminea') {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
     values ($1, $2, $3, 'personalizado') returning pastura_id`,
    [orgId, nombre, tipo],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId, { biomasaTotalKg = 5000 } = {}) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas
       (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, $3)
     returning ficha_id`,
    [orgId, potreroId, biomasaTotalKg],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  await adminPool.query(
    `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden)
     values ($1, $2, $3, 100, 0)`,
    [orgId, fichaId, pasturaId],
  );
  return fichaId;
}

async function seedContexto(orgId, predioId, potreroId, { precipitacion7dMm = 20 } = {}) {
  const result = await adminPool.query(
    `insert into agx.potrero_contextos_agroclimaticos
       (organizacion_id, predio_id, potrero_id, fecha_referencia, precipitacion_7d_mm, fuente_principal, fuentes_json)
     values ($1, $2, $3, current_date, $4, 'ERA5_LAND', '[]')
     returning contexto_id`,
    [orgId, predioId, potreroId, precipitacion7dMm],
  );
  return result.rows[0].contexto_id;
}

describe('SPRINT-3D7.2: potreroRecomendacionPastoreoRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_contextos_agroclimaticos
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (
         select ficha_id from agx.potrero_fichas_productivas
          where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72R%')
       )
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72R%')
    `);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D72R%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D72R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D72R%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('GET sin recomendaciones previas -> { actual: null, historial: [] }, nunca 404', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R GET-EMPTY');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R GET-EMPTY');

    const result = await repo.getRecomendacionPastoreoByPotrero(org, predioId, potreroId);
    assert.deepEqual(result, { actual: null, historial: [] });
  });

  test('sin ficha productiva -> INSUFFICIENT_FORAGE_DATA (404), nunca calcula sobre biomasa asumida', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R NOFICHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R NOFICHA');

    await assert.rejects(
      () => repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
        categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
      }),
      (error) => error.status === 404 && error.code === 'INSUFFICIENT_FORAGE_DATA',
    );
  });

  test('categoría inexistente -> NO_PRODUCTIVE_PROFILE (400)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R NOCAT');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R NOCAT');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R NOCAT');
    await seedFicha(org, potreroId, pasturaId);

    await assert.rejects(
      () => repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
        categoriaCodigo: 'categoria_inexistente', numeroAnimales: 10, pesoPromedioKg: 420,
      }),
      (error) => error.status === 400 && error.code === 'NO_PRODUCTIVE_PROFILE',
    );
  });

  test('preview sin contexto agroclimático -> estado PARTIAL_CONTEXT, confianza degradada, NO es error fatal (§18 del sprint)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R NOCTX');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R NOCTX');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R NOCTX');
    await seedFicha(org, potreroId, pasturaId);

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    assert.equal(preview.estado, 'PARTIAL_CONTEXT');
    assert.equal(preview.nivelConfianza, 'MEDIA');
    assert.equal(preview.contexto, null);
    assert.ok(preview.resultado.diasOcupacionEstimados > 0);
  });

  test('preview con ficha + pastura + contexto -> READY, confianza ALTA', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R READY');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R READY');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R READY');
    await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId);

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    assert.equal(preview.estado, 'READY');
    assert.equal(preview.nivelConfianza, 'ALTA');
    assert.equal(preview.parametrosAplicados.consumoPctPesoVivo, 2.4);
    assert.equal(preview.parametrosAplicados.materiaSecaPct, 20);
  });

  test('déficit hídrico en el contexto reduce la utilización aplicada (§8 del sprint)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R DEFICIT');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R DEFICIT');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R DEFICIT');
    await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 2 });

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    assert.equal(preview.parametrosAplicados.utilizacionPct, 45);
  });

  test('preview NUNCA persiste -- GET sigue vacío después de varios preview', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R NOPERSIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R NOPERSIST');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R NOPERSIST');
    await seedFicha(org, potreroId, pasturaId);

    await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 15, pesoPromedioKg: 400,
    });

    const result = await repo.getRecomendacionPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(result.actual, null);
  });

  test('create persiste una fila NUEVA con motor_version, GET la refleja como actual', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R CREATE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R CREATE');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R CREATE');
    await seedFicha(org, potreroId, pasturaId);

    const created = await repo.createRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    assert.ok(created.recomendacionId);
    assert.equal(created.motorVersion, 'pastoreo-auto-v1');
    assert.equal(created.categoriaCodigo, 'novillo_ceba');

    const getResult = await repo.getRecomendacionPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(getResult.actual.recomendacionId, created.recomendacionId);
    assert.equal(getResult.historial.length, 0);
  });

  // ---------------------------------------------------------------------
  // Hardening ronda 5 -- corrige un bug real detectado en el primer preview
  // de producción: "remanente proyectado" NUNCA debe ser un alias de
  // "remanente objetivo". Confirma la separación end-to-end (preview,
  // create, y GET sobre una fila ya persistida -- que recalcula desde
  // columnas ya guardadas, sin columnas nuevas).
  // ---------------------------------------------------------------------

  test('preview: remanente proyectado usa los DÍAS RECOMENDADOS (floor), nunca es igual al remanente objetivo cuando los días exactos no son enteros', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R REMANENTE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R REMANENTE');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R REMANENTE');
    await seedFicha(org, potreroId, pasturaId, { biomasaTotalKg: 5900 });

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });

    // materiaSecaTotalKg = 5900*0.20 = 1180; utilizable = 590;
    // demandaDiaria = 420*0.024*10 = 100.8; días exactos = 590/100.8 ≈ 5.853.
    assert.ok(Math.abs(preview.resultado.diasOcupacionEstimados - 5.853) < 0.01);
    assert.equal(preview.resultado.diasOcupacionRecomendados, 5);
    assert.ok(Math.abs(preview.resultado.consumoProyectadoKg - 504) < 0.01);
    assert.ok(Math.abs(preview.resultado.remanenteObjetivoKg - 590) < 0.01);
    assert.ok(Math.abs(preview.resultado.remanenteProyectadoKg - 676) < 0.01);
    assert.notEqual(preview.resultado.remanenteProyectadoKg, preview.resultado.remanenteObjetivoKg);
  });

  test('create + GET: la recomendación persistida refleja el remanente proyectado correcto (recalculado desde columnas persistidas, sin columnas nuevas)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R REMANENTE-DB');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R REMANENTE-DB');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R REMANENTE-DB');
    await seedFicha(org, potreroId, pasturaId, { biomasaTotalKg: 5900 });

    const created = await repo.createRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    assert.equal(created.diasOcupacionRecomendados, 5);
    assert.ok(Math.abs(created.remanenteProyectadoKg - 676) < 0.01);

    const getResult = await repo.getRecomendacionPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(getResult.actual.diasOcupacionRecomendados, 5);
    assert.ok(Math.abs(getResult.actual.remanenteProyectadoKg - 676) < 0.01);
    assert.ok(Math.abs(getResult.actual.remanenteObjetivoKg - 590) < 0.01);
    assert.notEqual(getResult.actual.remanenteProyectadoKg, getResult.actual.remanenteObjetivoKg);
  });

  test('histórico: múltiples create del mismo potrero -- actual es el más reciente, historial preserva los anteriores (append-only)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R HIST');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R HIST');
    await seedFicha(org, potreroId, pasturaId);

    const first = await repo.createRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    const second = await repo.createRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 15, pesoPromedioKg: 400,
    });

    const getResult = await repo.getRecomendacionPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(getResult.actual.recomendacionId, second.recomendacionId);
    assert.equal(getResult.historial.length, 1);
    assert.equal(getResult.historial[0].recomendacionId, first.recomendacionId);
  });

  test('cross-tenant: ORG B no puede calcular ni leer sobre el potrero de ORG A', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D72R CROSS-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D72R CROSS-A');
    const pasturaId = await seedPasturaPersonalizada(orgA, 'Pastura Sprint3D72R CROSS-A');
    await seedFicha(orgA, potreroA, pasturaId);

    await assert.rejects(
      () => repo.previewRecomendacionPastoreo(orgB, predioA, potreroA, {
        categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
      }),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('vaca lechera: requiereAdvertenciaLeche=true viaja en la respuesta (§20 del sprint)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE');
    await seedFicha(org, potreroId, pasturaId);

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 18, diasEnLeche: 100, grasaLechePct: 3.8,
    });
    assert.equal(preview.requiereAdvertenciaLeche, true);
    assert.equal(preview.inputs.produccionLecheLDia, 18);
    assert.equal(preview.inputs.diasEnLeche, 100);
    assert.equal(preview.inputs.grasaLechePct, 3.8);
    assert.equal(preview.provenance.categoriaFuenteTecnica, 'NRC_2001_DAIRY_DMI');
    assert.equal(preview.provenance.dmiModel, 'NRC_2001_DAIRY_DMI');
  });

  // ---------------------------------------------------------------------
  // Hardening ronda 4 §1/§2/§3/§9: FCM real (Gaines 1923) -- litros NUNCA
  // se usan directamente como FCM. Sin %grasa, perfil genérico.
  // ---------------------------------------------------------------------

  test('vaca lechera sin %grasa -> perfil genérico (GENERIC_LACTATING_PROFILE), diasEnLeche NO es obligatorio, confianza topada en MEDIA (hardening ronda 4 §5)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE-SINGRASA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE-SINGRASA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE-SINGRASA');
    await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId);

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 18,
    });
    assert.equal(preview.provenance.dmiModel, 'GENERIC_LACTATING_PROFILE');
    assert.equal(preview.nivelConfianza, 'MEDIA');
    assert.deepEqual(preview.limitaciones, ['LECHE_SIN_GRASA_PERFIL_GENERICO']);
  });

  test('vaca lechera con %grasa pero SIN diasEnLeche -> MISSING_DIAS_EN_LECHE (400) -- ambos alimentan la ecuación completa (hardening §1/§2)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE-NODEL');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE-NODEL');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE-NODEL');
    await seedFicha(org, potreroId, pasturaId);

    await assert.rejects(
      () => repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
        categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 18, grasaLechePct: 3.8,
      }),
      (error) => error.status === 400 && error.code === 'MISSING_DIAS_EN_LECHE',
    );
  });

  test('vaca lechera SIN %grasa: 5 L/día vs 15 L/día producen la MISMA demanda -- litros nunca se usan directamente como FCM (hardening §1/§9, confirma la corrección del bug)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE-5V15-SINGRASA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE-5V15-SINGRASA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE-5V15-SINGRASA');
    await seedFicha(org, potreroId, pasturaId);

    const con5L = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 5,
    });
    const con15L = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 15,
    });

    assert.equal(con5L.resultado.demandaDiariaLoteKgMs, con15L.resultado.demandaDiariaLoteKgMs);
    assert.equal(con5L.provenance.dmiModel, 'GENERIC_LACTATING_PROFILE');
  });

  test('vaca lechera CON %grasa: 5 L/día vs 15 L/día (mismo peso, días en leche y %grasa) producen demanda y días de ocupación DIFERENTES vía la ecuación NRC (2001) real', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE-5V15');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE-5V15');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE-5V15');
    await seedFicha(org, potreroId, pasturaId);

    const con5L = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 5, diasEnLeche: 100, grasaLechePct: 3.8,
    });
    const con15L = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 15, diasEnLeche: 100, grasaLechePct: 3.8,
    });

    assert.notEqual(con5L.resultado.demandaDiariaLoteKgMs, con15L.resultado.demandaDiariaLoteKgMs);
    assert.ok(con15L.resultado.demandaDiariaLoteKgMs > con5L.resultado.demandaDiariaLoteKgMs);
    assert.notEqual(con5L.resultado.diasOcupacionEstimados, con15L.resultado.diasOcupacionEstimados);
    assert.equal(con5L.provenance.dmiModel, 'NRC_2001_DAIRY_DMI');
    // parametrosAplicados.consumoPctPesoVivo es el %PV EQUIVALENTE derivado
    // del resultado real (hardening §4) -- nunca un valor estático de catálogo.
    assert.notEqual(con5L.parametrosAplicados.consumoPctPesoVivo, con15L.parametrosAplicados.consumoPctPesoVivo);
    assert.ok(con5L.parametrosAplicados.consumoPctPesoVivo > 0 && con5L.parametrosAplicados.consumoPctPesoVivo <= 10);
  });

  test('vaca lechera CON %grasa: 3% vs 4.5% (mismos litros/peso/DIM) producen demanda DIFERENTE (hardening §9)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE-GRASA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE-GRASA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE-GRASA');
    await seedFicha(org, potreroId, pasturaId);

    const conGrasa3 = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 15, diasEnLeche: 100, grasaLechePct: 3,
    });
    const conGrasa45 = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 15, diasEnLeche: 100, grasaLechePct: 4.5,
    });
    assert.notEqual(conGrasa3.resultado.demandaDiariaLoteKgMs, conGrasa45.resultado.demandaDiariaLoteKgMs);
  });

  test('create persiste grasa_leche_pct y la auditoría completa de la ecuación en parametros_fuente_json cuando corrió realmente', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R LECHE-CREATE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R LECHE-CREATE');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R LECHE-CREATE');
    await seedFicha(org, potreroId, pasturaId);

    const created = await repo.createRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 500, produccionLecheLDia: 15, diasEnLeche: 100, grasaLechePct: 3.8,
    });
    assert.equal(created.grasaLechePct, 3.8);
    assert.equal(created.parametrosFuente.ecuacionLeche.dmiModel, 'NRC_2001_DAIRY_DMI');
    assert.equal(created.parametrosFuente.ecuacionLeche.milkFatPct, 3.8);
    assert.ok(created.parametrosFuente.ecuacionLeche.fcmKgDay > 0);
    assert.equal(created.parametrosFuente.ecuacionLeche.equationSource, 'NRC_2001_DAIRY_DMI');
  });

  test('peso promedio fuera del rango de referencia de la categoría -> PESO_FUERA_DE_RANGO_CATEGORIA (400) -- ya no decorativo (hardening ronda 3)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R PESOFUERA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R PESOFUERA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R PESOFUERA');
    await seedFicha(org, potreroId, pasturaId);

    // vaca_leche_produccion: peso_min_referencia_kg=400, peso_max=650.
    await assert.rejects(
      () => repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
        categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 5, pesoPromedioKg: 100, produccionLecheLDia: 15, diasEnLeche: 100,
      }),
      (error) => error.status === 400 && error.code === 'PESO_FUERA_DE_RANGO_CATEGORIA',
    );
  });

  // ---------------------------------------------------------------------
  // Hardening ronda 3 §4: ternero al pie ya NO suma una constante fija.
  // ---------------------------------------------------------------------

  test('vaca con ternero vs vaca sin ternero: MISMA demanda calculada, pero confianza degradada y limitación explícita (hardening §4)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R TERNERO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R TERNERO');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R TERNERO');
    await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId);

    const sinTernero = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_cria_con_ternero', numeroAnimales: 8, pesoPromedioKg: 450, terneroAlPie: false,
    });
    const conTernero = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'vaca_cria_con_ternero', numeroAnimales: 8, pesoPromedioKg: 450, terneroAlPie: true,
    });

    assert.equal(conTernero.resultado.demandaDiariaLoteKgMs, sinTernero.resultado.demandaDiariaLoteKgMs);
    assert.equal(sinTernero.nivelConfianza, 'ALTA');
    assert.equal(conTernero.nivelConfianza, 'MEDIA');
    assert.deepEqual(conTernero.limitaciones, ['TERNERO_AL_PIE_DEMANDA_NO_CUANTIFICADA']);
    assert.deepEqual(sinTernero.limitaciones, []);
  });

  test('vaca_cria_con_ternero sin terneroAlPie -> MISSING_TERNERO_AL_PIE (400)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R NOTERNERO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R NOTERNERO');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72R NOTERNERO');
    await seedFicha(org, potreroId, pasturaId);

    await assert.rejects(
      () => repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
        categoriaCodigo: 'vaca_cria_con_ternero', numeroAnimales: 8, pesoPromedioKg: 450,
      }),
      (error) => error.status === 400 && error.code === 'MISSING_TERNERO_AL_PIE',
    );
  });

  // ---------------------------------------------------------------------
  // Hardening ronda 3 §5/§6: Brachiaria humidicola resuelve
  // PASTURE_SPECIFIC_BASELINE con el dato real (26% MS), y dryMatterSource
  // viaja en la respuesta.
  // ---------------------------------------------------------------------

  test('pastura Brachiaria humidicola resuelve dryMatterSource=PASTURE_SPECIFIC_BASELINE con %MS real (26%)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72R HUMIDICOLA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72R HUMIDICOLA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Brachiaria humidicola');
    await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId);

    const preview = await repo.previewRecomendacionPastoreo(org, predioId, potreroId, {
      categoriaCodigo: 'novillo_ceba', numeroAnimales: 10, pesoPromedioKg: 420,
    });
    assert.equal(preview.provenance.dryMatterSource, 'PASTURE_SPECIFIC_BASELINE');
    assert.equal(preview.parametrosAplicados.materiaSecaPct, 26);
    assert.equal(preview.nivelConfianza, 'ALTA');
  });
});
