// SPRINT-3D6-FICHA-PRODUCTIVA: pruebas del repositorio
// (server/services/ganaderia/potreroFichaProductivaRepository.js) contra
// un Postgres/PostGIS REAL -- mismo patrón que
// potrerosRepositoryIntegration.test.js. Cubre: cálculo de biomasa
// server-side (área spoof desde el cliente ignorada), especie única vs
// mezcla vs "otra" personalizada, historial (actual + resumido),
// aislamiento cross-tenant de catálogo y de fichas, y validaciones de
// especie inválida/cruzada.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (nunca la variable de
// producción/runtime real). Ver db/agx-business/migrations/README.md.
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_fichas_productivas') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroFichaProductivaRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

function randomOrgId() {
  return crypto.randomUUID();
}

async function seedPredio(orgId, nombre) {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, nombre],
  );
  return result.rows[0].predio_id;
}

// areaHa = 0.387491 -> 3874.91 m^2, mismo ejemplo del informe del sprint.
async function seedPotrero(orgId, predioId, nombre, areaHa = 0.387491) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), $5, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT, areaHa],
  );
  return result.rows[0].potrero_id;
}

async function seedPasturaSistema(nombreComun, tipo = 'graminea') {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (nombre_comun, tipo, alcance) values ($1, $2, 'sistema') returning pastura_id`,
    [nombreComun, tipo],
  );
  return result.rows[0].pastura_id;
}

describe('SPRINT-3D6: potreroFichaProductivaRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    // Orden hijo-primero (ver misma nota en potreroFichaProductivaSchemaIntegration.test.js).
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D6R%'))
          or pastura_id in (select pastura_id from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D6R%')
    `);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D6R%')`);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D6R%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D6R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D6R%'`);
  });

  test('biomasa server-side: 0.387491 ha x 650 g/m² ~= 2518.69 kg (ejemplo del informe), área spoof del cliente ignorada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R BIOMASA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R BIOMASA', 0.387491);
    const pasturaId = await seedPasturaSistema('Pastura Sprint3D6R Biomasa');

    const ficha = await repo.createFichaProductiva(org, predioId, potreroId, {
      especies: [{ pasturaId: String(pasturaId), porcentajeEstimado: null }],
      aforoPromedioGM2: 650,
      numeroMuestras: 5,
      fechaAforo: '2026-08-01',
      observaciones: null,
      nombrePersonalizado: null,
      // Campos de spoof NUNCA existen en el contrato de la función --
      // este test documenta que ni areaHa ni biomasaTotalKg forman parte
      // de la firma aceptada (ver validateCreateFichaBody en el router,
      // que además los rechazaría con FORBIDDEN_FIELDS antes de llegar
      // aquí). El repositorio SIEMPRE relee area_ha de agx.potreros.
    });

    assert.ok(Math.abs(ficha.biomasaTotalKg - 2518.6915) < 0.01, `biomasaTotalKg inesperado: ${ficha.biomasaTotalKg}`);
    assert.equal(ficha.tipoCobertura, 'pastura');
  });

  test('mezcla: más de una especie -> tipoCobertura=mezcla, nombrePrincipal = primera especie en orden de entrada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R MEZCLA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R MEZCLA');
    const pasturaA = await seedPasturaSistema('Pastura Sprint3D6R Mezcla Brachiaria', 'graminea');
    const pasturaB = await seedPasturaSistema('Pastura Sprint3D6R Mezcla Arachis', 'leguminosa');

    const ficha = await repo.createFichaProductiva(org, predioId, potreroId, {
      especies: [
        { pasturaId: String(pasturaA), porcentajeEstimado: 70 },
        { pasturaId: String(pasturaB), porcentajeEstimado: 30 },
      ],
      aforoPromedioGM2: 500,
      numeroMuestras: null,
      fechaAforo: null,
      observaciones: null,
      nombrePersonalizado: null,
    });

    assert.equal(ficha.tipoCobertura, 'mezcla');
    assert.equal(ficha.nombrePrincipal, 'Pastura Sprint3D6R Mezcla Brachiaria');
    assert.equal(ficha.especies.length, 2);
    assert.equal(ficha.especies[0].porcentajeEstimado, 70);
    assert.equal(ficha.especies[1].porcentajeEstimado, 30);
  });

  test('otra: especie única personalizada -> tipoCobertura=otra', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R OTRA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R OTRA');
    const pastura = await repo.createPasturaPersonalizada(org, {
      nombreComun: 'Pastura Sprint3D6R Personalizada Otra',
      nombreCientifico: null,
      genero: null,
      especie: null,
      cultivar: null,
      tipo: 'otra',
    });

    const ficha = await repo.createFichaProductiva(org, predioId, potreroId, {
      especies: [{ pasturaId: pastura.pastura_id, porcentajeEstimado: null }],
      aforoPromedioGM2: 400,
      numeroMuestras: null,
      fechaAforo: null,
      observaciones: null,
      nombrePersonalizado: null,
    });

    assert.equal(ficha.tipoCobertura, 'otra');
    assert.equal(ficha.nombrePrincipal, 'Pastura Sprint3D6R Personalizada Otra');
  });

  // ---------------------------------------------------------------------
  // SPRINT-3D6-TENANT-INTEGRITY-HARDENING §7/§8: sistema compartido entre
  // organizaciones + atomicidad de la mezcla (una especie inválida rechaza
  // la ficha COMPLETA, nunca una inserción parcial).
  // ---------------------------------------------------------------------

  test('§7: mezcla sistema + personalizada de la MISMA organización -> PASS', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R MEZCLA-OK');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R MEZCLA-OK');
    const pasturaSistema = await seedPasturaSistema('Pastura Sprint3D6R MezclaOk Sistema');
    const pasturaPropia = await repo.createPasturaPersonalizada(org, {
      nombreComun: 'Pastura Sprint3D6R MezclaOk Propia',
      nombreCientifico: null, genero: null, especie: null, cultivar: null, tipo: 'otra',
    });

    const ficha = await repo.createFichaProductiva(org, predioId, potreroId, {
      especies: [
        { pasturaId: String(pasturaSistema), porcentajeEstimado: 60 },
        { pasturaId: pasturaPropia.pastura_id, porcentajeEstimado: 40 },
      ],
      aforoPromedioGM2: 500, numeroMuestras: null, fechaAforo: null, observaciones: null, nombrePersonalizado: null,
    });

    assert.equal(ficha.tipoCobertura, 'mezcla');
    assert.equal(ficha.especies.length, 2);
  });

  test('§8: mezcla sistema + personalizada de OTRA organización -> FAIL completo, atómico (ninguna fila queda creada, ni ficha ni especies)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D6R MEZCLA-FAIL');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D6R MEZCLA-FAIL');
    const pasturaSistema = await seedPasturaSistema('Pastura Sprint3D6R MezclaFail Sistema');
    const pasturaAjena = await repo.createPasturaPersonalizada(orgB, {
      nombreComun: 'Pastura Sprint3D6R MezclaFail Ajena',
      nombreCientifico: null, genero: null, especie: null, cultivar: null, tipo: 'otra',
    });

    await assert.rejects(
      () => repo.createFichaProductiva(orgA, predioA, potreroA, {
        especies: [
          { pasturaId: String(pasturaSistema), porcentajeEstimado: 60 },
          { pasturaId: pasturaAjena.pastura_id, porcentajeEstimado: 40 },
        ],
        aforoPromedioGM2: 500, numeroMuestras: null, fechaAforo: null, observaciones: null, nombrePersonalizado: null,
      }),
      (error) => error.status === 404 && error.code === 'ESPECIE_NOT_FOUND',
    );

    // Atomicidad: ni la ficha ni NINGUNA especie (ni siquiera la
    // sistema, válida por sí sola) quedaron persistidas -- todo el
    // INSERT vive en una única transacción (withOrganizacionTransaction).
    const { actual, historial } = await repo.getFichaProductivaByPotrero(orgA, predioA, potreroA);
    assert.equal(actual, null);
    assert.deepEqual(historial, []);
  });

  test('especie inexistente -> ESPECIE_NOT_FOUND', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R ESPNOTFOUND');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R ESPNOTFOUND');

    await assert.rejects(
      () => repo.createFichaProductiva(org, predioId, potreroId, {
        especies: [{ pasturaId: '999999999', porcentajeEstimado: null }],
        aforoPromedioGM2: 400,
        numeroMuestras: null,
        fechaAforo: null,
        observaciones: null,
        nombrePersonalizado: null,
      }),
      (error) => error.status === 404 && error.code === 'ESPECIE_NOT_FOUND',
    );
  });

  test('pastura personalizada de OTRA organización -> ESPECIE_NOT_FOUND (RLS la oculta, indistinguible de inexistente)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioB = await seedPredio(orgB, 'Predio Sprint3D6R CROSSPASTURA');
    const potreroB = await seedPotrero(orgB, predioB, 'Potrero Sprint3D6R CROSSPASTURA');

    const pasturaA = await repo.createPasturaPersonalizada(orgA, {
      nombreComun: 'Pastura Sprint3D6R CrossOrg',
      nombreCientifico: null,
      genero: null,
      especie: null,
      cultivar: null,
      tipo: 'otra',
    });

    await assert.rejects(
      () => repo.createFichaProductiva(orgB, predioB, potreroB, {
        especies: [{ pasturaId: pasturaA.pastura_id, porcentajeEstimado: null }],
        aforoPromedioGM2: 400,
        numeroMuestras: null,
        fechaAforo: null,
        observaciones: null,
        nombrePersonalizado: null,
      }),
      (error) => error.status === 404 && error.code === 'ESPECIE_NOT_FOUND',
    );
  });

  test('potrero de OTRO predio/organización -> POTRERO_NOT_FOUND', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D6R XPREDIO-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D6R XPREDIO-A');
    const pasturaSis = await seedPasturaSistema('Pastura Sprint3D6R XPredio');

    await assert.rejects(
      () => repo.createFichaProductiva(orgB, predioA, potreroA, {
        especies: [{ pasturaId: String(pasturaSis), porcentajeEstimado: null }],
        aforoPromedioGM2: 400,
        numeroMuestras: null,
        fechaAforo: null,
        observaciones: null,
        nombrePersonalizado: null,
      }),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('historial: getFichaProductivaByPotrero devuelve la más reciente como actual y el resto como historial', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R HIST');
    const pasturaId = await seedPasturaSistema('Pastura Sprint3D6R Hist');

    await repo.createFichaProductiva(org, predioId, potreroId, {
      especies: [{ pasturaId: String(pasturaId), porcentajeEstimado: null }],
      aforoPromedioGM2: 400, numeroMuestras: null, fechaAforo: null, observaciones: null, nombrePersonalizado: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const segunda = await repo.createFichaProductiva(org, predioId, potreroId, {
      especies: [{ pasturaId: String(pasturaId), porcentajeEstimado: null }],
      aforoPromedioGM2: 700, numeroMuestras: null, fechaAforo: null, observaciones: null, nombrePersonalizado: null,
    });

    const { actual, historial } = await repo.getFichaProductivaByPotrero(org, predioId, potreroId);
    assert.equal(actual.fichaId, segunda.fichaId);
    assert.equal(actual.aforoPromedioGM2, 700);
    assert.equal(historial.length, 1);
    assert.equal(historial[0].aforoPromedioGM2, 400);
  });

  test('potrero sin ficha -> { actual: null, historial: [] } (nunca 404)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D6R SINFICHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D6R SINFICHA');

    const result = await repo.getFichaProductivaByPotrero(org, predioId, potreroId);
    assert.equal(result.actual, null);
    assert.deepEqual(result.historial, []);
  });

  test('cross-tenant: fichas de ORG A no aparecen para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D6R CROSSFICHA-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D6R CROSSFICHA-A');
    const pasturaId = await seedPasturaSistema('Pastura Sprint3D6R CrossFicha');

    await repo.createFichaProductiva(orgA, predioA, potreroA, {
      especies: [{ pasturaId: String(pasturaId), porcentajeEstimado: null }],
      aforoPromedioGM2: 400, numeroMuestras: null, fechaAforo: null, observaciones: null, nombrePersonalizado: null,
    });

    await assert.rejects(
      () => repo.getFichaProductivaByPotrero(orgB, predioA, potreroA),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('catálogo: listCatalogoPasturas devuelve sistema + personalizado propio, nunca personalizado de otra organización', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    await repo.createPasturaPersonalizada(orgA, {
      nombreComun: 'Pastura Sprint3D6R Lista Propia A',
      nombreCientifico: null, genero: null, especie: null, cultivar: null, tipo: 'otra',
    });
    await repo.createPasturaPersonalizada(orgB, {
      nombreComun: 'Pastura Sprint3D6R Lista Propia B',
      nombreCientifico: null, genero: null, especie: null, cultivar: null, tipo: 'otra',
    });

    const listaA = await repo.listCatalogoPasturas(orgA, { search: 'Lista Propia' });
    const nombresA = listaA.map((p) => p.nombre_comun);
    assert.ok(nombresA.includes('Pastura Sprint3D6R Lista Propia A'));
    assert.ok(!nombresA.includes('Pastura Sprint3D6R Lista Propia B'));
  });
});

after(async () => {
  if (!adminPool) return;
  if (businessDb) await businessDb.closeAgxBusinessPool();
  await adminPool.end();
});
