// FASE 4D -- analítica reproductiva contra un Postgres REAL (0000-0026):
// eventos reales por los repositorios, ANULADO fuera, SALIDO y MUERTO dentro,
// machos y animales anulados fuera, filtro de predio, periodo, solo lectura y
// aislamiento entre organizaciones (RLS+FORCE).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app),
// AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL; se auto-omite sin ellas o sin 0026.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { validateCierreBody } from '../ganaderia/cierreValidation.js';
import { validateAnularEventoReproductivoBody, validateCrearEventoReproductivoBody } from '../ganaderia/reproduccionValidation.js';
import { periodoPorDefecto, validateAnaliticaQuery } from '../ganaderia/reproduccionAnalitica.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let animalesRepo;
let cierreRepo;
let repo;
let analitica;
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
  const check = await adminPool.query(`select to_regclass('agx.reproduccion_eventos') is not null as ok`);
  dbAvailable = check.rows[0].ok === true;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  cierreRepo = await import('../ganaderia/cierreRepository.js');
  repo = await import('../ganaderia/reproduccionRepository.js');
  analitica = await import('../ganaderia/reproduccionAnaliticaRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
});

const HOY = resolveFechaHoyNegocio();
const OPTS = { hoy: HOY, horaAhora: '23:59' };
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const op = () => crypto.randomUUID();

function hace(dias) {
  const [y, m, d] = HOY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - dias * 86_400_000).toISOString().slice(0, 10);
}

async function nuevoPredio(org) {
  const r = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio FASE 4D', 'ACTIVO') returning predio_id`,
    [org],
  );
  return String(r.rows[0].predio_id);
}

async function animal(org, numeroVisual, predioId, extra = {}) {
  const body = validateCreateAnimalBody({
    clientOperationId: op(), predioId, numeroVisual, sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA', ...extra,
  }, { hoy: HOY });
  const { animal: creado } = await animalesRepo.createAnimalIdempotente(org, body, { actorCuentaId: ACTOR });
  return creado.animalId;
}

const reg = (org, animalId, body) => repo.registrarEventoReproductivoIdempotente(
  org, animalId, validateCrearEventoReproductivoBody({ clientOperationId: op(), ...body }, OPTS), { actorCuentaId: ACTOR, hoy: HOY },
);
const ia = (fecha) => ({ tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: fecha, toroExterno: 'Gyr X' });
const libre = (fecha) => ({ tipoEvento: 'SERVICIO_MONTA', fechaEvento: fecha, tipoServicio: 'LIBRE' });
const diag = (fecha, diagnosticoResultado, diasGestacion) => ({
  tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: fecha, diagnosticoResultado, diagnosticoMetodo: 'ECOGRAFIA', ...(diasGestacion ? { diasGestacion } : {}),
});
const parto = (fecha, partoTipo = 'NORMAL') => ({ tipoEvento: 'PARTO', fechaEvento: fecha, partoTipo, numeroCrias: 1 });
const aborto = (fecha) => ({ tipoEvento: 'ABORTO', fechaEvento: fecha });

const leer = (org, query = {}) => analitica.analiticaReproductiva(org, validateAnaliticaQuery(query, { hoy: HOY }), { hoy: HOY });
const item = (m, grupo, codigo) => m.M14.find((g) => g.metrica === grupo).items.find((i) => i.codigo === codigo).conteo;

describe('FASE 4D: analítica reproductiva (Postgres real)', { skip: !dbAvailable && 'Postgres de integración no disponible o 0026 sin aplicar' }, () => {
  const ORG = crypto.randomUUID();
  const OTRA = crypto.randomUUID();
  const VACIA = crypto.randomUUID();
  let predioA;
  let predioB;

  before(async () => {
    if (!dbAvailable) return;
    predioA = await nuevoPredio(ORG);
    predioB = await nuevoPredio(ORG);

    // CONCEPCION + TERMINO en el periodo.
    const a = await animal(ORG, 'AN-01 ciclo completo', predioA);
    await reg(ORG, a, ia(hace(320)));
    await reg(ORG, a, diag(hace(275), 'PRENADA'));
    await reg(ORG, a, parto(hace(40), 'ASISTIDO'));

    // NO_CONCEPCION por VACIA + nuevo intento a más de 17 días + DUDOSA transparente -> PERDIDA.
    const b = await animal(ORG, 'AN-02 perdida con dudosa', predioA);
    await reg(ORG, b, ia(hace(200)));
    await reg(ORG, b, diag(hace(160), 'VACIA'));
    await reg(ORG, b, ia(hace(140)));
    await reg(ORG, b, diag(hace(100), 'PRENADA'));
    await reg(ORG, b, diag(hace(80), 'DUDOSA'));
    await reg(ORG, b, diag(hace(60), 'VACIA'));

    // Evento ANULADO: su servicio no cuenta.
    const c = await animal(ORG, 'AN-03 anulado', predioB);
    const { evento } = await reg(ORG, c, ia(hace(100)));
    await repo.anularEventoReproductivoIdempotente(
      ORG, c, evento.eventoId,
      validateAnularEventoReproductivoBody({ clientOperationId: op(), motivo: 'Error' }), { actorCuentaId: ACTOR, hoy: HOY },
    );

    // Hembra SALIDA y MUERTA: cuentan en históricos.
    const d = await animal(ORG, 'AN-04 salida', predioB);
    await reg(ORG, d, ia(hace(150)));
    await reg(ORG, d, diag(hace(110), 'PRENADA'));
    await cierreRepo.registrarCierreIdempotente(ORG, d, validateCierreBody('SALIDA', {
      fechaSalida: hace(5), motivoSalida: 'VENTA', clientOperationId: op(),
    }, { hoy: HOY }), { actorCuentaId: ACTOR });
    const e = await animal(ORG, 'AN-05 muerta', predioB);
    await reg(ORG, e, parto(hace(90)));
    await cierreRepo.registrarCierreIdempotente(ORG, e, validateCierreBody('MUERTE', {
      fechaMuerte: hace(5), causaMuerte: 'ENFERMEDAD', clientOperationId: op(),
    }, { hoy: HOY }), { actorCuentaId: ACTOR });

    // Monta libre seguida de aborto; nacida en el predio con fecha exacta.
    const f = await animal(ORG, 'AN-06 nacida', predioB, {
      nacimientoTipo: 'EXACTA', fechaNacimiento: hace(900), origenTipo: 'NACIDO_EN_PREDIO',
    });
    await reg(ORG, f, libre(hace(120)));
    await reg(ORG, f, aborto(hace(60)));

    // Otra organización: nunca debe verse.
    const predioOtra = await nuevoPredio(OTRA);
    const g = await animal(OTRA, 'AN-99 ajena', predioOtra);
    await reg(OTRA, g, ia(hace(200)));
    await reg(OTRA, g, parto(hace(10)));
  });

  test('conteos M1-M4 con eventos reales; ANULADO fuera', async () => {
    const { metricas: m } = await leer(ORG);
    // AN-01 (1), AN-02 (2), AN-04 (1), AN-06 libre (1); AN-03 anulado no cuenta.
    assert.equal(m.M1.total, 5);
    assert.equal(m.M1.montaLibre, 1);
    assert.equal(m.M2.totalIntentos, 5);
    assert.deepEqual([m.M2.concepciones, m.M2.noConcepciones, m.M2.pendientes, m.M2.noAtribuibles, m.M2.montaLibre, m.M2.nEvaluable], [3, 1, 0, 0, 1, 4]);
    assert.equal(m.M2.indicador.estado, 'DATOS_INSUFICIENTES');
    assert.equal(m.M4.nEvaluable, m.M2.nEvaluable);
  });

  test('M3: compradas sin apertura quedan en INICIO_CICLO_DESCONOCIDO; la nacida en predio entra', async () => {
    const { metricas: m } = await leer(ORG);
    assert.equal(m.M3.inicioCicloDesconocido, 3); // AN-01, AN-02, AN-04
    assert.equal(m.M3.montaLibre, 1); // AN-06 (NACIDO_EN_PREDIO)
    assert.equal(item(m, 'M2-M4', 'INICIO_CICLO_DESCONOCIDO'), 3);
  });

  test('M12: DUDOSA transparente y salidas contadas', async () => {
    const { metricas: m } = await leer(ORG);
    assert.deepEqual([m.M12.perdidas, m.M12.terminos, m.M12.n], [1, 1, 2]);
    assert.equal(m.M12.conDudosa, 1);
    assert.equal(m.M12.censuradasCerradas, 1); // AN-04
    assert.equal(m.M12.indicador.estado, 'DATOS_INSUFICIENTES');
  });

  test('SALIDO y MUERTO en históricos; "abiertas hoy" solo EN_HATO', async () => {
    const { metricas: m, poblacion } = await leer(ORG);
    assert.deepEqual(poblacion, { hembrasConEventos: 5, enHato: 3, salidas: 1, muertas: 1 });
    assert.equal(m.M13.partos, 2); // AN-01 y AN-05 (muerta)
    assert.equal(m.M13.conIntervencion, 1);
    assert.equal(m.M8.censuradasCerradas, 1); // AN-05
    assert.equal(m.M8.abiertasHoy.n, 1); // AN-01
  });

  test('filtro por predio actual', async () => {
    const a = await leer(ORG, { predioId: predioA });
    assert.equal(a.poblacion.hembrasConEventos, 2);
    assert.equal(a.metricas.M1.total, 3);
    const b = await leer(ORG, { predioId: predioB });
    assert.equal(b.poblacion.hembrasConEventos, 3);
    assert.equal(b.metricas.M1.total, 2);
  });

  test('periodo: ventana por defecto y clasificación con historial fuera de la ventana', async () => {
    assert.deepEqual(validateAnaliticaQuery({}, { hoy: HOY }), { predioId: null, ...periodoPorDefecto(HOY) });
    const reciente = await leer(ORG, { desde: hace(50), hasta: HOY });
    assert.equal(reciente.metricas.M1.total, 0);
    assert.equal(reciente.metricas.M13.partos, 1); // AN-01
    // El servicio es anterior a la ventana estrecha y se resuelve dentro: conserva su resultado.
    const antigua = await leer(ORG, { desde: hace(330), hasta: hace(300) });
    assert.equal(antigua.metricas.M2.concepciones, 1);
  });

  test('aislamiento entre organizaciones (RLS): nunca filas ni conteos ajenos', async () => {
    const ajena = await leer(OTRA);
    assert.equal(ajena.poblacion.hembrasConEventos, 1);
    assert.equal(ajena.metricas.M1.total, 1);
    const vacia = await leer(VACIA);
    assert.equal(vacia.poblacion.hembrasConEventos, 0);
    assert.equal(vacia.metricas.M1.total, 0);
    // Un predio ajeno no filtra datos: RLS lo deja vacío.
    const cruzada = await leer(OTRA, { predioId: predioA });
    assert.equal(cruzada.poblacion.hembrasConEventos, 0);
  });

  test('sin contexto de organización, RLS+FORCE no devuelve eventos a agx_app', async () => {
    const client = await businessDb.getAgxBusinessPool().connect();
    try {
      const { rows } = await client.query('select count(*)::int as total from agx.reproduccion_eventos');
      assert.equal(rows[0].total, 0);
    } finally {
      client.release();
    }
  });

  test('un macho o un animal anulado no entra en el plegado', async () => {
    const org = crypto.randomUUID();
    const predio = await nuevoPredio(org);
    const macho = await animal(org, 'AN-M macho', predio, { sexo: 'MACHO' });
    // La aplicación no registra eventos sobre machos: se fuerza por admin.
    await adminPool.query(
      `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, client_operation_id, intent_hash)
       values ($1, $2, 'CELO_OBSERVADO', $3, $4, $5, $6)`,
      [org, macho, hace(10), ACTOR, op(), `v1:${'a'.repeat(64)}`],
    );
    assert.equal((await leer(org)).poblacion.hembrasConEventos, 0);

    const anulada = await animal(org, 'AN-A anulada', predio);
    await reg(org, anulada, ia(hace(50)));
    assert.equal((await leer(org)).metricas.M1.total, 1);
    await animalesRepo.anularAnimal(org, anulada, { motivo: 'Registro erróneo', actorCuentaId: ACTOR });
    const r = await leer(org);
    assert.equal(r.poblacion.hembrasConEventos, 0);
    assert.equal(r.metricas.M1.total, 0);
  });

  describe('salvaguarda de volumen', () => {
    const leerConMaximo = (org, maxEventosProcesables, query = {}) => analitica.analiticaReproductiva(
      org, validateAnaliticaQuery(query, { hoy: HOY }), { hoy: HOY, config: { maxEventosProcesables } },
    );
    const excedido = (e) => e.code === 'ANALITICA_VOLUMEN_EXCEDIDO' && e.status === 422;
    // Población real de la organización, medida aparte con admin: mismas condiciones.
    const contarAdmin = async (org, predioId = null) => (await adminPool.query(
      `select count(*)::int as total
         from agx.reproduccion_eventos e join agx.animales a on a.animal_id = e.animal_id
        where e.organizacion_id = $1 and a.sexo = 'HEMBRA' and a.estado = 'ACTIVO' and e.estado_registro = 'ACTIVO'
          and ($2::bigint is null or a.predio_id = $2)`,
      [org, predioId],
    )).rows[0].total;

    test('debajo y exactamente en el límite procesa; límite + 1 da el error funcional', async () => {
      const total = await contarAdmin(ORG);
      assert.ok(total > 1);
      assert.equal((await leerConMaximo(ORG, total + 1)).metricas.M1.total, 5);
      assert.equal((await leerConMaximo(ORG, total)).metricas.M1.total, 5);
      await assert.rejects(leerConMaximo(ORG, total - 1), excedido);
    });

    test('tenant: el COUNT no incluye otra organización', async () => {
      const propios = await contarAdmin(OTRA);
      const ajenos = await contarAdmin(ORG);
      assert.ok(ajenos > propios);
      // Justo en su propio total: si contara eventos ajenos, excedería.
      assert.equal((await leerConMaximo(OTRA, propios)).poblacion.hembrasConEventos, 1);
      await assert.rejects(leerConMaximo(OTRA, propios - 1), excedido);
    });

    test('predio: el COUNT usa el mismo predio que la consulta principal', async () => {
      const delPredio = await contarAdmin(ORG, predioA);
      const totalOrg = await contarAdmin(ORG);
      assert.ok(totalOrg > delPredio);
      assert.equal((await leerConMaximo(ORG, delPredio, { predioId: predioA })).poblacion.hembrasConEventos, 2);
      await assert.rejects(leerConMaximo(ORG, delPredio - 1, { predioId: predioA }), excedido);
      // El mismo máximo excede sin filtro: reducir por predio sí desbloquea la consulta.
      await assert.rejects(leerConMaximo(ORG, delPredio), excedido);
    });

    test('un evento ANULADO no cuenta para el máximo', async () => {
      // AN-03 tiene un servicio anulado: la población admin lo excluye y el COUNT también.
      const total = await contarAdmin(ORG);
      const conAnulados = (await adminPool.query('select count(*)::int as n from agx.reproduccion_eventos where organizacion_id = $1', [ORG])).rows[0].n;
      assert.ok(conAnulados > total);
      assert.equal((await leerConMaximo(ORG, total)).metricas.M1.total, 5);
    });
  });

  test('la analítica no escribe: el historial no cambia al leer', async () => {
    // Acotado a la organización: otras suites insertan en paralelo en la misma base.
    const contar = async () => (await adminPool.query(
      `select count(*)::int as total, max(evento_id)::text as ultimo, count(*) filter (where estado_registro = 'ANULADO')::int as anulados
         from agx.reproduccion_eventos where organizacion_id = $1`,
      [ORG],
    )).rows[0];
    const antes = await contar();
    await leer(ORG);
    assert.deepEqual(await contar(), antes);
  });
});
