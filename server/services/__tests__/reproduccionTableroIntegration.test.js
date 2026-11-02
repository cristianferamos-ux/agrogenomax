// FASE 4C -- tablero reproductivo de la organización contra un Postgres REAL
// (0000-0026): estados y alertas derivados en SQL, PARIDAD con
// derivarEstadoReproductivo() (reproduccionEstado.js) animal a animal, KPIs
// coherentes con el listado, filtros, búsqueda, predio, paginación, cerrados
// y anulados fuera por defecto y aislamiento entre organizaciones (RLS).
//
// Fechas RELATIVAS a la fecha de negocio de hoy (las alertas dependen de
// ella). Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app),
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
import { CONFIGURACION_ALERTAS_REPRODUCCION, ESTADOS_TABLERO, validateListadoTableroQuery } from '../ganaderia/reproduccionAlertas.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let animalesRepo;
let cierreRepo;
let repo;
let tablero;
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
  tablero = await import('../ganaderia/reproduccionTableroRepository.js');
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
const C = CONFIGURACION_ALERTAS_REPRODUCCION;

function hace(dias) {
  const [y, m, d] = HOY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - dias * 86_400_000).toISOString().slice(0, 10);
}
const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

async function nuevoPredio(org) {
  const r = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio FASE 4C', 'ACTIVO') returning predio_id`,
    [org],
  );
  return String(r.rows[0].predio_id);
}

async function hembra(org, numeroVisual, { predioId, sexo = 'HEMBRA', ...extra } = {}) {
  const body = validateCreateAnimalBody({
    clientOperationId: op(),
    predioId: predioId ?? await nuevoPredio(org),
    numeroVisual,
    sexo,
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...extra,
  }, { hoy: HOY });
  const { animal } = await animalesRepo.createAnimalIdempotente(org, body, { actorCuentaId: ACTOR });
  return animal.animalId;
}

const reg = (org, animalId, body) => repo.registrarEventoReproductivoIdempotente(
  org, animalId, validateCrearEventoReproductivoBody({ clientOperationId: op(), ...body }, OPTS), { actorCuentaId: ACTOR, hoy: HOY },
);
const celo = (fecha) => ({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: fecha });
const ia = (fecha) => ({ tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: fecha, toroExterno: 'Gyr X' });
const te = (fecha) => ({ tipoEvento: 'TRANSFERENCIA_EMBRION', fechaEvento: fecha, embrionConservacion: 'CONGELADO' });
const diag = (fecha, diagnosticoResultado, diasGestacion) => ({
  tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: fecha, diagnosticoResultado, diagnosticoMetodo: 'ECOGRAFIA', ...(diasGestacion ? { diasGestacion } : {}),
});
const parto = (fecha) => ({ tipoEvento: 'PARTO', fechaEvento: fecha, partoTipo: 'NORMAL', numeroCrias: 1 });

const listar = (org, query = {}) => tablero.listarTableroReproductivo(org, validateListadoTableroQuery(query), { hoy: HOY });
const resumen = (org, filtros = {}) => tablero.resumenTableroReproductivo(org, filtros, { hoy: HOY });
const todas = async (org, query = {}) => (await listar(org, { limit: '200', ...query })).animales;
const porId = (lista) => new Map(lista.map((a) => [a.animalId, a]));
const codigos = (fila) => fila.alertas.map((a) => a.codigo).sort();

describe('FASE 4C: tablero reproductivo (Postgres real)', { skip: !dbAvailable && 'Postgres de integración no disponible o 0026 sin aplicar' }, () => {
  const ORG = crypto.randomUUID();
  const OTRA = crypto.randomUUID();
  const A = {};

  before(async () => {
    if (!dbAvailable) return;
    const predioComun = await nuevoPredio(ORG);
    A.adulta = await hembra(ORG, 'TB-01 sin eventos', { predioId: predioComun });
    A.ternera = await hembra(ORG, 'TB-02 ternera', { nacimientoTipo: 'EXACTA', fechaNacimiento: hace(60) });
    A.joven = await hembra(ORG, 'TB-03 joven aprox', { nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 6 });
    A.novilla = await hembra(ORG, 'TB-04 novilla aprox', { nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 13 });
    A.exacta12 = await hembra(ORG, 'TB-05 exacta 13m', { nacimientoTipo: 'EXACTA', fechaNacimiento: hace(400) });

    A.ciclando = await hembra(ORG, 'TB-06 ciclando', { predioId: predioComun });
    await reg(ORG, A.ciclando, celo(hace(5)));

    A.servidaReciente = await hembra(ORG, 'TB-07 servida reciente');
    await reg(ORG, A.servidaReciente, ia(hace(C.diasDiagnosticoPendiente - 1)));

    A.servidaPendiente = await hembra(ORG, 'TB-08 servida pendiente');
    await reg(ORG, A.servidaPendiente, celo(hace(41)));
    await reg(ORG, A.servidaPendiente, ia(hace(C.diasDiagnosticoPendiente)));

    A.dudosa = await hembra(ORG, 'TB-09 dudosa');
    await reg(ORG, A.dudosa, ia(hace(50)));
    await reg(ORG, A.dudosa, diag(hace(20), 'DUDOSA'));

    A.prenadaLejos = await hembra(ORG, 'TB-10 prenada lejos');
    await reg(ORG, A.prenadaLejos, ia(hace(60)));
    await reg(ORG, A.prenadaLejos, diag(hace(20), 'PRENADA', 40));

    // Concepción hace 270 días -> parto probable dentro de 13 días.
    A.prenadaProxima = await hembra(ORG, 'TB-11 prenada proxima');
    await reg(ORG, A.prenadaProxima, ia(hace(270)));
    await reg(ORG, A.prenadaProxima, diag(hace(200), 'PRENADA'));

    // Concepción hace 290 días -> parto probable hace 7 días (vencido, sigue PRENADA).
    A.prenadaVencida = await hembra(ORG, 'TB-12 prenada vencida');
    await reg(ORG, A.prenadaVencida, ia(hace(290)));
    await reg(ORG, A.prenadaVencida, diag(hace(250), 'PRENADA'));

    // Borde exacto de la ventana de parto (dias_para_parto = diasPartoProximo).
    A.prenadaBorde = await hembra(ORG, 'TB-13 prenada borde');
    await reg(ORG, A.prenadaBorde, ia(hace(283 - C.diasPartoProximo)));
    await reg(ORG, A.prenadaBorde, diag(hace(200), 'PRENADA'));

    A.prenadaTe = await hembra(ORG, 'TB-14 prenada te');
    await reg(ORG, A.prenadaTe, te(hace(100)));
    await reg(ORG, A.prenadaTe, diag(hace(60), 'PRENADA'));

    // PRENADA y luego un diagnóstico DUDOSA: sigue PRENADA, alerta dudosa.
    A.prenadaDudosa = await hembra(ORG, 'TB-15 prenada dudosa');
    await reg(ORG, A.prenadaDudosa, ia(hace(120)));
    await reg(ORG, A.prenadaDudosa, diag(hace(80), 'PRENADA', 40));
    await reg(ORG, A.prenadaDudosa, diag(hace(10), 'DUDOSA'));

    A.vacia = await hembra(ORG, 'TB-16 vacia');
    await reg(ORG, A.vacia, ia(hace(60)));
    await reg(ORG, A.vacia, diag(hace(20), 'VACIA'));

    A.posparto = await hembra(ORG, 'TB-17 posparto');
    await reg(ORG, A.posparto, ia(hace(300)));
    await reg(ORG, A.posparto, diag(hace(250), 'PRENADA'));
    await reg(ORG, A.posparto, parto(hace(10)));

    // Evento anulado: deja de contar (vuelve a SIN_ESTADO, con alerta de seguimiento).
    A.anuladoEvento = await hembra(ORG, 'TB-18 evento anulado');
    const { evento } = await reg(ORG, A.anuladoEvento, ia(hace(40)));
    await repo.anularEventoReproductivoIdempotente(
      ORG, A.anuladoEvento, evento.eventoId,
      validateAnularEventoReproductivoBody({ clientOperationId: op(), motivo: 'Error' }), { actorCuentaId: ACTOR, hoy: HOY },
    );

    A.salida = await hembra(ORG, 'TB-19 salida');
    await reg(ORG, A.salida, ia(hace(60)));
    await cierreRepo.registrarCierreIdempotente(ORG, A.salida, validateCierreBody('SALIDA', {
      fechaSalida: hace(1), motivoSalida: 'VENTA', clientOperationId: op(),
    }, { hoy: HOY }), { actorCuentaId: ACTOR });

    A.muerta = await hembra(ORG, 'TB-20 muerta');
    await cierreRepo.registrarCierreIdempotente(ORG, A.muerta, validateCierreBody('MUERTE', {
      fechaMuerte: hace(1), causaMuerte: 'ENFERMEDAD', clientOperationId: op(),
    }, { hoy: HOY }), { actorCuentaId: ACTOR });

    A.registroAnulado = await hembra(ORG, 'TB-21 registro anulado');
    await animalesRepo.anularAnimal(ORG, A.registroAnulado, { motivo: 'Duplicado', actorCuentaId: ACTOR });

    A.macho = await hembra(ORG, 'TB-22 macho', { sexo: 'MACHO' });

    A.otra = await hembra(OTRA, 'TB-99 otra org');
    await reg(OTRA, A.otra, ia(hace(60)));
  });

  test('organización sin animales: KPIs en cero y listado vacío', async () => {
    const vacia = crypto.randomUUID();
    const r = await resumen(vacia);
    assert.equal(r.hembrasEnSeguimiento, 0);
    assert.ok(Object.values(r.porEstado).every((n) => n === 0));
    assert.ok(Object.values(r.porAlerta).every((n) => n === 0));
    assert.deepEqual(await listar(vacia), { total: 0, animales: [] });
  });

  test('estados derivados: SIN_ESTADO, CICLANDO, SERVIDA, PRENADA, VACIA, POSPARTO', async () => {
    const m = porId(await todas(ORG));
    const esperado = {
      adulta: 'SIN_ESTADO', ternera: 'SIN_ESTADO', ciclando: 'CICLANDO', servidaReciente: 'SERVIDA', servidaPendiente: 'SERVIDA',
      dudosa: 'SERVIDA', prenadaLejos: 'PRENADA', prenadaProxima: 'PRENADA', prenadaVencida: 'PRENADA', prenadaTe: 'PRENADA',
      prenadaDudosa: 'PRENADA', vacia: 'VACIA', posparto: 'POSPARTO', anuladoEvento: 'SIN_ESTADO',
    };
    for (const [clave, estado] of Object.entries(esperado)) assert.equal(m.get(A[clave]).estadoReproductivo, estado, clave);
  });

  test('PARIDAD: el SQL coincide con derivarEstadoReproductivo() en cada hembra (incluidos cerrados y anulados)', async () => {
    const lista = await todas(ORG, { situacion: 'TODOS', registro: 'TODOS' });
    assert.ok(lista.length >= 20);
    for (const fila of lista) {
      const { estado: js } = await repo.obtenerEstadoReproductivo(ORG, fila.animalId, { hoy: HOY });
      const ref = (e) => (e ? { tipoEvento: e.tipoEvento, fechaEvento: e.fechaEvento } : null);
      assert.equal(fila.estadoReproductivo, js.estado, fila.numeroVisual);
      assert.deepEqual(fila.ultimoEvento, ref(js.ultimoEvento), `${fila.numeroVisual} ultimoEvento`);
      assert.deepEqual(fila.ultimoServicio, ref(js.ultimoServicio), `${fila.numeroVisual} ultimoServicio`);
      assert.deepEqual(
        fila.ultimoDiagnostico,
        js.ultimoDiagnostico ? { resultado: js.ultimoDiagnostico.resultado, fechaEvento: js.ultimoDiagnostico.fechaEvento, diasGestacion: js.ultimoDiagnostico.diasGestacion } : null,
        `${fila.numeroVisual} ultimoDiagnostico`,
      );
      assert.deepEqual(fila.ultimoParto, js.ultimoParto ? { fechaEvento: js.ultimoParto.fechaEvento, numeroCrias: js.ultimoParto.numeroCrias } : null, `${fila.numeroVisual} ultimoParto`);
      assert.deepEqual(fila.gestacion, js.gestacion, `${fila.numeroVisual} gestacion`);
    }
  });

  test('gestación y fecha probable de parto (diagnóstico con días, por servicio y por TE)', async () => {
    const m = porId(await todas(ORG));
    assert.deepEqual(m.get(A.prenadaLejos).gestacion, {
      base: 'DIAGNOSTICO', fechaConcepcionEstimada: hace(60), diasEstimados: 60, fechaProbableParto: hace(60 - 283),
    });
    assert.equal(m.get(A.prenadaProxima).gestacion.base, 'SERVICIO');
    assert.equal(m.get(A.prenadaProxima).gestacion.fechaProbableParto, hace(270 - 283));
    assert.equal(m.get(A.prenadaTe).gestacion.fechaConcepcionEstimada, hace(107));
    assert.equal(m.get(A.vacia).gestacion, null);
  });

  test('DIAGNOSTICO_PENDIENTE: SERVIDA desde >= 35 días sin diagnóstico posterior', async () => {
    const m = porId(await todas(ORG));
    assert.deepEqual(codigos(m.get(A.servidaPendiente)), ['DIAGNOSTICO_PENDIENTE']);
    const alerta = m.get(A.servidaPendiente).alertas[0];
    assert.deepEqual(alerta, { codigo: 'DIAGNOSTICO_PENDIENTE', nivel: 'PROXIMA_ACCION', fecha: hace(C.diasDiagnosticoPendiente), dias: C.diasDiagnosticoPendiente });
    assert.deepEqual(codigos(m.get(A.servidaReciente)), []);
    // Con un diagnóstico DUDOSA posterior no es "pendiente" sino "dudoso".
    assert.deepEqual(codigos(m.get(A.dudosa)), ['DIAGNOSTICO_DUDOSO']);
  });

  test('PARTO_PROXIMO: ventana de 30 días incluida, vencido incluido, lejana excluida', async () => {
    const m = porId(await todas(ORG));
    const proxima = m.get(A.prenadaProxima).alertas.find((a) => a.codigo === 'PARTO_PROXIMO');
    assert.deepEqual(proxima, { codigo: 'PARTO_PROXIMO', nivel: 'ATENCION', fecha: hace(270 - 283), dias: 13 });
    assert.equal(m.get(A.prenadaVencida).alertas.find((a) => a.codigo === 'PARTO_PROXIMO').dias, -7);
    assert.equal(m.get(A.prenadaBorde).alertas.find((a) => a.codigo === 'PARTO_PROXIMO').dias, C.diasPartoProximo);
    assert.deepEqual(codigos(m.get(A.prenadaLejos)), []);
  });

  test('DIAGNOSTICO_DUDOSO: último diagnóstico DUDOSA sin servicio/parto/aborto posterior (también sobre PRENADA)', async () => {
    const m = porId(await todas(ORG));
    assert.deepEqual(m.get(A.dudosa).alertas, [{ codigo: 'DIAGNOSTICO_DUDOSO', nivel: 'ATENCION', fecha: hace(20), dias: null }]);
    assert.ok(codigos(m.get(A.prenadaDudosa)).includes('DIAGNOSTICO_DUDOSO'));
  });

  test('SIN_SEGUIMIENTO_REPRODUCTIVO: sin eventos y edad >= 12 meses o desconocida; terneras excluidas', async () => {
    const m = porId(await todas(ORG));
    for (const clave of ['adulta', 'novilla', 'exacta12', 'anuladoEvento']) {
      assert.deepEqual(m.get(A[clave]).alertas, [{ codigo: 'SIN_SEGUIMIENTO_REPRODUCTIVO', nivel: 'INFORMATIVA', fecha: null, dias: null }], clave);
    }
    for (const clave of ['ternera', 'joven']) assert.deepEqual(m.get(A[clave]).alertas, [], clave);
    assert.deepEqual(m.get(A.ciclando).alertas, []);
  });

  test('por defecto solo ACTIVO + EN_HATO: SALIDO/MUERTO/ANULADO y machos fuera; filtro histórico sin alertas', async () => {
    const ids = new Set((await todas(ORG)).map((a) => a.animalId));
    for (const clave of ['salida', 'muerta', 'registroAnulado', 'macho']) assert.equal(ids.has(A[clave]), false, clave);
    const salidos = await todas(ORG, { situacion: 'SALIDO' });
    assert.deepEqual(salidos.map((a) => a.animalId), [A.salida]);
    assert.equal(salidos[0].estadoReproductivo, 'SERVIDA');
    assert.equal(salidos[0].estadoOperativo, 'SALIDO');
    assert.deepEqual(salidos[0].alertas, []);
    assert.deepEqual((await todas(ORG, { situacion: 'MUERTO' })).map((a) => a.animalId), [A.muerta]);
    assert.deepEqual((await todas(ORG, { registro: 'ANULADO' })).map((a) => a.animalId), [A.registroAnulado]);
    const historico = new Set((await todas(ORG, { situacion: 'TODOS', registro: 'TODOS' })).map((a) => a.animalId));
    assert.equal(historico.has(A.macho), false);
  });

  test('KPIs coherentes con el listado (misma CTE)', async () => {
    const r = await resumen(ORG);
    assert.equal(r.hembrasEnSeguimiento, (await listar(ORG)).total);
    for (const estado of ESTADOS_TABLERO) assert.equal(r.porEstado[estado], (await listar(ORG, { estadoReproductivo: estado })).total, estado);
    for (const alerta of Object.keys(r.porAlerta)) assert.equal(r.porAlerta[alerta], (await listar(ORG, { alerta })).total, alerta);
    assert.equal(r.porEstado.PRENADA, 6);
    assert.equal(r.porAlerta.PARTO_PROXIMO, 3);
    assert.equal(r.porAlerta.DIAGNOSTICO_PENDIENTE, 1);
    assert.equal(r.porAlerta.DIAGNOSTICO_DUDOSO, 2);
    assert.equal(Object.values(r.porEstado).reduce((a, b) => a + b, 0), r.hembrasEnSeguimiento);
  });

  test('filtros combinados, búsqueda por prefijo y predio', async () => {
    const prenadasProximas = await todas(ORG, { estadoReproductivo: 'PRENADA', alerta: 'PARTO_PROXIMO' });
    assert.deepEqual(new Set(prenadasProximas.map((a) => a.animalId)), new Set([A.prenadaProxima, A.prenadaVencida, A.prenadaBorde]));
    assert.deepEqual((await todas(ORG, { q: 'tb-06' })).map((a) => a.animalId), [A.ciclando]);
    assert.deepEqual(await todas(ORG, { q: '06' }), []);
    const { predioId } = (await todas(ORG, { q: 'tb-01' }))[0];
    assert.deepEqual(new Set((await todas(ORG, { predioId })).map((a) => a.animalId)), new Set([A.adulta, A.ciclando]));
    const r = await resumen(ORG, { predioId });
    assert.equal(r.hembrasEnSeguimiento, 2);
    assert.equal(r.porEstado.CICLANDO, 1);
  });

  test('paginación estable: total constante, páginas sin solape que cubren el listado', async () => {
    const completo = await todas(ORG);
    const vistos = [];
    for (let offset = 0; offset < completo.length; offset += 4) {
      const pagina = await listar(ORG, { limit: '4', offset: String(offset) });
      assert.equal(pagina.total, completo.length);
      vistos.push(...pagina.animales.map((a) => a.animalId));
    }
    assert.deepEqual(vistos, completo.map((a) => a.animalId));
    assert.deepEqual((await listar(ORG, { offset: '9999' })).animales, []);
  });

  test('aislamiento entre organizaciones (RLS): nunca filas ni conteos ajenos', async () => {
    const propias = await todas(ORG, { situacion: 'TODOS', registro: 'TODOS' });
    assert.equal(propias.some((a) => a.animalId === A.otra), false);
    const otra = await todas(OTRA);
    assert.deepEqual(otra.map((a) => a.animalId), [A.otra]);
    assert.equal((await resumen(OTRA)).hembrasEnSeguimiento, 1);
    assert.equal((await todas(ORG, { q: 'tb-99' })).length, 0);
  });

  test('fila pública: datos para operar y nada interno', async () => {
    const fila = porId(await todas(ORG)).get(A.prenadaProxima);
    assert.deepEqual(Object.keys(fila).sort(), [
      'alertas', 'animalId', 'estadoOperativo', 'estadoRegistro', 'estadoReproductivo', 'gestacion', 'nombre', 'numeroVisual',
      'predioId', 'predioNombre', 'ultimoDiagnostico', 'ultimoEvento', 'ultimoParto', 'ultimoServicio',
    ]);
    assert.equal(fila.estadoOperativo, 'EN_HATO');
    assert.equal(fila.estadoRegistro, 'ACTIVO');
    assert.equal(fila.predioNombre, 'Predio FASE 4C');
    assert.equal(diasEntre(HOY, fila.gestacion.fechaProbableParto), 13);
  });
});
