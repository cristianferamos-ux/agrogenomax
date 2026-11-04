// FASE 4E.1 -- conciliación de una operación pendiente con el evento del pull:
// clientOperationId exacto + organización + cuenta de la sesión + intención. Motor y
// repositorio reales. La ida y vuelta contra PostgreSQL de los 8 tipos está en
// reproduccionSyncIntegration.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORG_STORES } from '../offlineSchema.js';
import { createMemoryStorage } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { RUN_RESULT, SINCRONIZANDO_LEASE_MS, createSyncEngine } from '../syncEngine.js';
import { OUTBOX_ESTADOS, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, newOperation } from '../outbox.js';
import { intencionCoincide, intencionReproductiva } from '../../engine/reproduccion.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTRA_ORG = '22222222-2222-4222-8222-222222222222';
const CUENTA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CUENTA_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ID = 'c0000000-0000-4000-8000-000000000001';
const OTRO_ID = 'c0000000-0000-4000-8000-000000000002';
const REPRO = '/api/ganaderia/sync/reproduccion';
const AHORA = '2026-10-20T15:00:00.000Z';
const IATF = Object.freeze({ tipoEvento: 'IATF', fechaEvento: '2026-10-01', protocoloIatf: 'J-Synch', tecnico: 'Ana' });

const crearRepo = () => createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: ORG, deviceId: 'd', now: () => new Date(AHORA) });

async function operacion(repo, cambios = {}) {
  const { animalId = '7', evento = IATF, clientOperationId = ID, ...resto } = cambios;
  const op = {
    ...newOperation({
      tipoOperacion: REPRODUCCION_EVENTO_CREAR, entidad: 'reproduccion_evento', localUuid: `l-${clientOperationId}`, clientOperationId,
      payload: { animalId, evento }, deviceId: 'd', now: new Date('2026-10-02T00:00:00Z'), uuid: () => `o-${clientOperationId}`,
      claveOrden: claveOrdenAnimal(animalId), origen: { organizacionId: ORG, cuentaId: CUENTA_A },
    }),
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...resto,
  };
  await repo.storage.put('outbox', op);
  return op;
}

/** Evento como lo serializa GET /sync/reproduccion. */
const delServidor = (cambios = {}) => ({
  eventoId: '1', animalId: '7', tipoEvento: 'IATF', fechaEvento: '2026-10-01', horaEvento: null, observaciones: null,
  detalle: { protocoloIatf: 'J-Synch', tecnico: 'Ana' }, estadoRegistro: 'ACTIVO', corrigeEventoId: null, corregidoPorEventoId: null,
  anulacion: null, registradoEn: '2026-10-01T10:00:00.000000Z', clientOperationId: ID, ...cambios,
});
const pagina = (eventos, cambios = {}) => ({
  organizacionId: ORG, cuentaId: CUENTA_A, eventos, cursor: 'cur', hayMas: false, completo: false,
  totales: { eventos: eventos.length, anulados: eventos.filter((e) => e.estadoRegistro === 'ANULADO').length }, ...cambios,
});

// A
test('A. mismo clientOperationId + misma cuenta + misma intención: confirma una vez', async () => {
  const repo = crearRepo();
  await operacion(repo);
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), []);
  const eventos = await repo.listEventosReproductivos('7');
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].eventoId, '1');
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.equal((await repo.listEventosReproductivos('7')).length, 1, 'la reentrega no duplica');
});

// B
test('B. mismo clientOperationId + otra cuenta en la sesión: NO confirma y la operación queda intacta', async () => {
  const repo = crearRepo();
  const op = await operacion(repo);
  await repo.aplicarPullReproduccion(pagina([delServidor()], { cuentaId: CUENTA_B }));
  assert.deepEqual(await repo.listOutbox(), [op]);
  assert.equal((await repo.listEventosReproductivos('7')).length, 1, 'el evento sí se guarda: es la verdad del servidor');
});

for (const [nombre, cuentaId] of [['ausente (servidor antiguo)', undefined], ['nula', null], ['vacía', '']]) {
  test(`B. cuenta de la sesión ${nombre}: no se puede verificar, NO confirma`, async () => {
    const repo = crearRepo();
    const op = await operacion(repo);
    await repo.aplicarPullReproduccion(pagina([delServidor()], { cuentaId }));
    assert.deepEqual(await repo.listOutbox(), [op]);
  });
}

// C
test('C. mismo clientOperationId + origen de otra organización: NO confirma', async () => {
  const repo = crearRepo();
  const op = await operacion(repo, { origen: { organizacionId: OTRA_ORG, cuentaId: CUENTA_A } });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), [op]);
});

test('C. página de otra organización: se rechaza entera y la operación sigue', async () => {
  const repo = crearRepo();
  const op = await operacion(repo);
  await assert.rejects(repo.aplicarPullReproduccion(pagina([delServidor()], { organizacionId: OTRA_ORG })), { code: 'ORGANIZACION_DISTINTA' });
  assert.deepEqual(await repo.listOutbox(), [op]);
  assert.deepEqual(await repo.listEventosReproductivos('7'), []);
});

for (const [nombre, origen] of [['sin origen', null], ['origen sin cuenta', { organizacionId: ORG }], ['origen sin organización', { cuentaId: CUENTA_A }]]) {
  test(`C. ${nombre}: no se puede demostrar de quién es, NO confirma`, async () => {
    const repo = crearRepo();
    const op = await operacion(repo, { origen });
    await repo.aplicarPullReproduccion(pagina([delServidor()]));
    assert.deepEqual(await repo.listOutbox(), [op]);
  });
}

// D
for (const [nombre, evento, cambios] of [
  ['tipoEvento', { ...IATF, tipoEvento: 'INSEMINACION_ARTIFICIAL' }, {}],
  ['fechaEvento', { ...IATF, fechaEvento: '2026-09-30' }, {}],
  ['horaEvento', { ...IATF, horaEvento: '08:30' }, {}],
  ['campo de detalle (tecnico)', { ...IATF, tecnico: 'Luis' }, {}],
  ['campo presente solo en lo local', { ...IATF, semenCodigo: 'PAJ-1' }, {}],
  ['observaciones', { ...IATF, observaciones: 'Otra nota' }, {}],
  ['animal', IATF, { animalId: '8' }],
]) {
  test(`D. mismo clientOperationId + intención distinta (${nombre}): NO confirma, CONFLICTO y lo local se conserva`, async () => {
    const repo = crearRepo();
    const op = await operacion(repo, { evento, ...cambios });
    await repo.aplicarPullReproduccion(pagina([delServidor()]));
    const [resultado] = await repo.listOutbox();
    assert.equal(resultado.estado, OUTBOX_ESTADOS.CONFLICTO);
    assert.equal(resultado.ultimoError.codigo, 'CONCILIACION_INTENCION_DISTINTA');
    assert.deepEqual(resultado.payload, op.payload, 'nunca se sobrescribe la intención');
    assert.deepEqual(resultado.origen, op.origen);
    assert.equal(resultado.clientOperationId, op.clientOperationId);
    assert.equal(resultado.intentos, op.intentos);
    assert.equal(resultado.siguienteIntentoAt, null);
  });
}

// Lista independiente de la del código: si se quita un campo de allí, esta prueba lo detecta.
for (const campo of [
  'tipoEvento', 'fechaEvento', 'horaEvento',
  'intensidadCelo', 'metodoDeteccion',
  'tipoServicio', 'toroAnimalId', 'toroExterno',
  'semenCodigo', 'protocoloIatf', 'tecnico',
  'embrionCodigo', 'embrionRaza', 'embrionDonadora', 'embrionEstadio', 'embrionCalidad', 'embrionConservacion',
  'diagnosticoResultado', 'diagnosticoMetodo', 'diasGestacion',
  'abortoCausa',
  'partoTipo', 'numeroCrias',
  'observaciones',
]) {
  test(`D. todo campo del intent_hash cuenta: ${campo} distinto impide confirmar`, async () => {
    const repo = crearRepo();
    const comun = { tipoEvento: 'IATF', fechaEvento: '2026-10-01', horaEvento: null, observaciones: null };
    const valor = (v) => (campo === 'diasGestacion' || campo === 'numeroCrias' ? v.length : v);
    const delCampo = ['tipoEvento', 'fechaEvento', 'horaEvento', 'observaciones'].includes(campo)
      ? { servidor: { ...comun, [campo]: valor('uno') }, detalle: {}, local: { ...comun, [campo]: valor('dos!') } }
      : { servidor: comun, detalle: { [campo]: valor('uno') }, local: { ...comun, [campo]: valor('dos!') } };
    await operacion(repo, { evento: delCampo.local });
    await repo.aplicarPullReproduccion(pagina([delServidor({ ...delCampo.servidor, detalle: delCampo.detalle })]));
    assert.equal((await repo.listOutbox())[0].estado, OUTBOX_ESTADOS.CONFLICTO, campo);
  });
}

test('D. el conflicto cancela el reintento programado: la cadena espera resolución', async () => {
  const repo = crearRepo();
  await operacion(repo, { evento: { ...IATF, tecnico: 'Luis' }, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: '2026-10-20T16:00:00.000Z' });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  const [resultado] = await repo.listOutbox();
  assert.equal(resultado.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(resultado.siguienteIntentoAt, null);
});

test('D. un evento de corrección con ese id no cierra un registro', async () => {
  const repo = crearRepo();
  await operacion(repo);
  await repo.aplicarPullReproduccion(pagina([delServidor({ corrigeEventoId: '99' })]));
  assert.equal((await repo.listOutbox())[0].estado, OUTBOX_ESTADOS.CONFLICTO);
});

test('D. intención distinta bajo OTRA cuenta: no la marca, no le corresponde decidir', async () => {
  const repo = crearRepo();
  const op = await operacion(repo, { evento: { ...IATF, tecnico: 'Luis' } });
  await repo.aplicarPullReproduccion(pagina([delServidor()], { cuentaId: CUENTA_B }));
  assert.deepEqual(await repo.listOutbox(), [op]);
});

test('D. el conflicto se escribe una vez y detiene su cadena en el siguiente ciclo', async () => {
  const repo = crearRepo();
  await operacion(repo, { evento: { ...IATF, tecnico: 'Luis' } });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  const [primera] = await repo.listOutbox();
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), [primera]);
});

test('intención equivalente tras normalizar: espacios, CRLF, vacíos y toro numérico no son diferencias', async () => {
  const repo = crearRepo();
  await operacion(repo, {
    evento: { tipoEvento: 'IATF', fechaEvento: '2026-10-01', horaEvento: '', protocoloIatf: '  J-Synch ', tecnico: 'Ana   María', toroAnimalId: 12, semenCodigo: '', observaciones: ' línea 1\r\nlínea 2 ' },
  });
  await repo.aplicarPullReproduccion(pagina([delServidor({
    observaciones: 'línea 1\nlínea 2',
    detalle: { protocoloIatf: 'J-Synch', tecnico: 'Ana María', toroAnimalId: '12' },
  })]));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('los campos generados por el servidor no entran en la intención', () => {
  const base = delServidor();
  const otro = delServidor({ eventoId: '2', estadoRegistro: 'ANULADO', anulacion: { motivo: 'x' }, registradoEn: 'y', corregidoPorEventoId: '3', clientOperationId: 'z' });
  assert.equal(intencionReproductiva(base), intencionReproductiva(otro));
  assert.equal(intencionCoincide(IATF, base), true);
});

// E
test('E. mismo animal, fecha y tipo con clientOperationId distinto: NO confirma, solo el exacto lo hace', async () => {
  const repo = crearRepo();
  const op = await operacion(repo);
  await repo.aplicarPullReproduccion(pagina([delServidor({ eventoId: '1', clientOperationId: OTRO_ID })]));
  assert.deepEqual(await repo.listOutbox(), [op], 'un evento similar nunca la cierra');

  await repo.aplicarPullReproduccion(pagina([delServidor({ eventoId: '1', clientOperationId: OTRO_ID }), delServidor({ eventoId: '2' })]));
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal((await repo.listEventosReproductivos('7')).length, 2);
});

test('E. un evento sin clientOperationId nunca empareja, ni con una operación sin id', async () => {
  const repo = crearRepo();
  for (const vacio of [null, '']) {
    const sinId = await operacion(repo, { clientOperationId: vacio, localUuid: 'l', operationId: 'sin-id' });
    await repo.aplicarPullReproduccion(pagina([delServidor({ clientOperationId: vacio })]));
    assert.deepEqual(await repo.listOutbox(), [sinId]);
  }
});

test('E. solo concilia operaciones de registro reproductivo, aunque otro tipo tenga ese id', async () => {
  const repo = crearRepo();
  const pesaje = await operacion(repo, { tipoOperacion: 'PESAJE_CREAR' });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), [pesaje]);
});

// F
function transporte(eventos, { posts = [] } = {}) {
  return {
    posts,
    async postJson(ruta, cuerpo) {
      posts.push(cuerpo);
      return { ok: true, status: 200, data: { ok: true, yaExistia: true, evento: eventos[0] } };
    },
    async getJson(ruta) {
      if (ruta.startsWith(REPRO)) return { ok: true, status: 200, data: pagina(eventos) };
      if (ruta === '/api/ganaderia/auth/session') return { ok: true, status: 200, data: { authenticated: true, cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: ORG } } };
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'g', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
}

test('F. ERROR_REINTENTABLE por respuesta incierta + pull correcto: confirma sin un POST más, en este ciclo ni en los siguientes', async () => {
  const repo = crearRepo();
  await operacion(repo, {
    estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE,
    posibleEnServidor: true,
    intentos: 1,
    ultimoError: { codigo: 'NETWORK_ERROR', tipo: 'http', status: 0 },
    siguienteIntentoAt: new Date(new Date(AHORA).getTime() + 3_600_000).toISOString(),
  });
  const t = transporte([delServidor()]);
  const motor = createSyncEngine({ repo, transport: t, now: () => new Date(AHORA), random: () => 0.5 });
  assert.equal(await motor.syncNow(), RUN_RESULT.OK);
  assert.deepEqual(t.posts, [], 'el backoff seguía vigente: solo el pull la resuelve');
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal((await repo.listEventosReproductivos('7')).length, 1);
  await motor.syncNow({ forzar: true });
  assert.deepEqual(t.posts, [], 'ya no queda nada que enviar');
  assert.equal((await repo.listEventosReproductivos('7')).length, 1);
});

test('F. PENDIENTE con respuesta perdida confirma igual', async () => {
  const repo = crearRepo();
  await operacion(repo, { posibleEnServidor: true });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('F. SINCRONIZANDO interrumpido (lease vencido) se concilia; en curso no', async () => {
  const vencido = new Date(new Date(AHORA).getTime() - SINCRONIZANDO_LEASE_MS).toISOString();
  const interrumpida = crearRepo();
  await operacion(interrumpida, { estado: OUTBOX_ESTADOS.SINCRONIZANDO, updatedAt: vencido });
  await interrumpida.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await interrumpida.listOutbox(), []);

  const reciente = new Date(new Date(AHORA).getTime() - SINCRONIZANDO_LEASE_MS + 1).toISOString();
  const enCurso = crearRepo();
  const op = await operacion(enCurso, { estado: OUTBOX_ESTADOS.SINCRONIZANDO, updatedAt: reciente });
  await enCurso.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await enCurso.listOutbox(), [op]);

  const sinFecha = crearRepo();
  const op2 = await operacion(sinFecha, { estado: OUTBOX_ESTADOS.SINCRONIZANDO, updatedAt: null });
  await sinFecha.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await sinFecha.listOutbox(), [op2]);
});

// G
for (const estado of [OUTBOX_ESTADOS.RECHAZADO, OUTBOX_ESTADOS.CONFLICTO]) {
  test(`G. ${estado} + pull con todo coincidente: no cambia`, async () => {
    const repo = crearRepo();
    const op = await operacion(repo, { estado, ultimoError: { codigo: 'X', status: 400 } });
    await repo.aplicarPullReproduccion(pagina([delServidor()]));
    assert.deepEqual(await repo.listOutbox(), [op]);
    assert.equal((await repo.listEventosReproductivos('7')).length, 1);
  });
}

test('G. operación cancelada localmente: el pull guarda el evento y no revive nada', async () => {
  const repo = crearRepo();
  const op = await operacion(repo);
  await repo.cancelarEventoReproductivoPendiente(op.operationId, { cuentaId: CUENTA_A });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal((await repo.listEventosReproductivos('7')).length, 1);
});

// H
test('H. BLOQUEADA_POR_IDENTIDAD + pull bajo otra cuenta: sigue bloqueada', async () => {
  const repo = crearRepo();
  const op = await operacion(repo, { estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, ultimoError: { codigo: 'IDENTIDAD_NO_COINCIDE', mensaje: null, status: 0 } });
  await repo.aplicarPullReproduccion(pagina([delServidor()], { cuentaId: CUENTA_B }));
  assert.deepEqual(await repo.listOutbox(), [op]);
});

test('H. BLOQUEADA_POR_IDENTIDAD no se concilia ni con su propia cuenta: el envío la resuelve con el servidor', async () => {
  const repo = crearRepo();
  const op = await operacion(repo, { estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD });
  await repo.aplicarPullReproduccion(pagina([delServidor()]));
  assert.deepEqual(await repo.listOutbox(), [op]);

  // Vuelve su cuenta: sale con el mismo id, el servidor responde yaExistia y se cierra sin duplicar.
  const t = transporte([delServidor()]);
  await createSyncEngine({ repo, transport: t, now: () => new Date(AHORA), random: () => 0.5 }).syncNow();
  assert.deepEqual(t.posts.map((p) => p.clientOperationId), [ID]);
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal((await repo.listEventosReproductivos('7')).length, 1);
});

test('H. motor bajo la cuenta B: la operación de A sigue bloqueada tras push y pull, sin POST', async () => {
  const repo = crearRepo();
  const op = await operacion(repo);
  const t = transporte([delServidor()]);
  const getJson = t.getJson;
  t.getJson = async (ruta) => {
    if (ruta === '/api/ganaderia/auth/session') return { ok: true, status: 200, data: { authenticated: true, cuenta: { cuentaId: CUENTA_B }, organizacionActiva: { organizacionId: ORG } } };
    if (ruta.startsWith(REPRO)) return { ok: true, status: 200, data: pagina([delServidor()], { cuentaId: CUENTA_B }) };
    return getJson(ruta);
  };
  await createSyncEngine({ repo, transport: t, now: () => new Date(AHORA), random: () => 0.5 }).syncNow();
  assert.deepEqual(t.posts, []);
  const [resultado] = await repo.listOutbox();
  assert.equal(resultado.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.deepEqual(resultado.origen, op.origen);
  assert.deepEqual(resultado.payload, op.payload);
});

// I
test('I. evento confirmado y luego ANULADO: la creación se concilia y el almacén refleja la anulación', async () => {
  const repo = crearRepo();
  await operacion(repo);
  const anulacion = { anuladoEn: '2026-10-05T10:00:00.000000Z', motivo: 'Error de digitación' };
  await repo.aplicarPullReproduccion(pagina([delServidor({ estadoRegistro: 'ANULADO', anulacion })]));
  assert.deepEqual(await repo.listOutbox(), [], 'no queda como fallida');
  const [evento] = await repo.listEventosReproductivos('7');
  assert.equal(evento.estadoRegistro, 'ANULADO');
  assert.deepEqual(evento.anulacion, anulacion);
  assert.equal(evento.protocoloIatf, 'J-Synch');
  assert.equal(evento.clientOperationId, ID);
});

test('I. ANULADO ya guardado + copia antigua ACTIVO: concilia sin revertir', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([delServidor({ clientOperationId: OTRO_ID, estadoRegistro: 'ANULADO' })]));
  await operacion(repo);
  await repo.aplicarPullReproduccion(pagina([delServidor()], { totales: { eventos: 1, anulados: 1 } }));
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal((await repo.listEventosReproductivos('7'))[0].estadoRegistro, 'ANULADO');
});

// Mientras espera a su cuenta, el mismo evento no se cuenta dos veces
test('un pendiente de otra cuenta ya confirmado cuenta como confirmado: advierte, no bloquea', async () => {
  const repo = crearRepo();
  await repo.storage.put('animales', { key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });
  await repo.putMeta({ reproduccionListaAt: AHORA });
  const prenada = { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-10-01', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA' };
  await operacion(repo, { evento: prenada, estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD });
  await repo.aplicarPullReproduccion(pagina([delServidor({ tipoEvento: 'DIAGNOSTICO_PRENEZ', detalle: { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA' } })], { cuentaId: CUENTA_B }));
  assert.equal((await repo.listOutbox()).length, 1);

  const res = await repo.registrarEventoReproductivoLocal({
    animalId: '7', cuentaId: CUENTA_B, confirmarAdvertencia: true,
    // Fecha anterior al evento: contado como pendiente sería un bloqueo; como confirmado, una advertencia.
    body: { clientOperationId: OTRO_ID, tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-09-01' },
  });
  assert.equal(res.yaEncolado, false);
  assert.equal(res.advertencia.code, 'FECHA_ANTERIOR_A_HISTORIAL');
});
