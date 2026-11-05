// Issue #116: la ficha del animal no puede degradarse a error por un fallo remoto
// cuando ya hay copia local. La página monta sin repositorio (el proveedor offline
// aún abre IndexedDB) y lanza una carga remota; al llegar el repositorio lanza otra.
// Sin jsdom en el repo, se prueba la lógica real de `load` (cargarFicha) replicando
// el orden de efectos de HatoDetallePage con promesas controladas a mano.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';
import { MENSAJE_SIN_CONEXION } from '../../api/errorModel.js';
import { ESTADO_INICIAL_FICHA, cargarFicha, crearControlCargas, debeRefrescarAlReconectar } from '../fichaCargaModel.js';

// Una promesa que nunca se resuelve debe fallar, no colgar la suite.
const test = (nombre, fn) => nodeTest(nombre, { timeout: 5000 }, fn);

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const pagina = fs.readFileSync(path.join(AQUI, '..', 'HatoDetallePage.jsx'), 'utf8').replace(/\r\n/g, '\n');

const COPIA = Object.freeze({ animalId: '1', numeroVisual: 'A-1', estado: 'ACTIVO', ultimoPeso: 400 });
const OTRA_COPIA = Object.freeze({ animalId: '2', numeroVisual: 'B-2', estado: 'ACTIVO', ultimoPeso: 500 });
const DEL_SERVIDOR = Object.freeze({ animalId: '1', numeroVisual: 'A-1', estado: 'ACTIVO', ultimoPeso: 450 });
const ERROR_RED = () => new TypeError('Failed to fetch');

function diferida() {
  let resolver;
  let rechazar;
  const promesa = new Promise((res, rej) => { resolver = res; rechazar = rej; });
  return { promesa, resolver, rechazar };
}

const repo = (animales = { 1: COPIA, 2: OTRA_COPIA }) => ({
  getAnimal: async (id) => animales[id] ?? null,
  getChapetaDeAnimal: async () => null,
});

// Monta la "página": estado React, control de cargas y una cola de peticiones remotas.
function montar() {
  const f = {
    state: ESTADO_INICIAL_FICHA,
    historial: [],
    chapeta: undefined,
    control: crearControlCargas(),
    peticiones: [],
  };
  const setState = (siguiente) => {
    f.state = typeof siguiente === 'function' ? siguiente(f.state) : siguiente;
    f.historial.push(f.state.status);
  };
  f.load = ({ routeId = '1', local = null, esLocal = false, silencioso = false } = {}) => cargarFicha({
    routeId,
    esLocal,
    local,
    silencioso,
    control: f.control,
    setState,
    setChapetaLocal: (c) => { f.chapeta = c; },
    obtenerRemoto: () => {
      const d = diferida();
      f.peticiones.push(d);
      return d.promesa;
    },
  });
  return f;
}

const okDe = (animal) => ({ ok: true, status: 200, data: { animal } });

// Secuencia exacta del issue: 1) monta sin repo y pide al servidor; 2) llega el repo y
// la segunda carga pone la copia local; 3) el fallo tardío de la PRIMERA llega después.
test('#116 B: copia local primero y fallo remoto tardío: la ficha sigue visible', async () => {
  const f = montar();
  const primera = f.load({ local: null });
  await Promise.resolve();
  assert.equal(f.state.status, 'loading');
  assert.equal(f.peticiones.length, 1, 'la primera carga queda con su petición en curso');

  const segunda = f.load({ local: repo() });
  await new Promise((r) => { setImmediate(r); });
  assert.equal(f.state.status, 'ok');
  assert.equal(f.state.origen, 'local');
  assert.equal(f.peticiones.length, 2);

  f.peticiones[0].rechazar(ERROR_RED());
  await primera;
  assert.equal(f.state.status, 'ok', 'el fallo tardío no puede pasar la ficha a error');
  assert.deepEqual(f.state.animal, COPIA);
  assert.ok(!f.historial.includes('error'));

  f.peticiones[1].rechazar(ERROR_RED());
  await segunda;
  assert.equal(f.state.status, 'ok', 'el fallo de la carga vigente tampoco');
  assert.deepEqual(f.state.animal, COPIA);
  assert.ok(f.state.avisoRemoto, 'el fallo queda como aviso sobre la copia');
  assert.ok(!f.historial.includes('error'));
});

test('#116 B: también si la tardía es una respuesta 5xx y no una excepción', async () => {
  const f = montar();
  const primera = f.load({ local: null });
  const segunda = f.load({ local: repo() });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[0].resolver({ ok: false, status: 503, data: { error: 'SERVICE_UNAVAILABLE' } });
  f.peticiones[1].resolver({ ok: false, status: 503, data: { error: 'SERVICE_UNAVAILABLE' } });
  await Promise.all([primera, segunda]);
  assert.equal(f.state.status, 'ok');
  assert.deepEqual(f.state.animal, COPIA);
});

test('#116 A: copia local y red caída desde el inicio: ficha local con aviso', async () => {
  const f = montar();
  const carga = f.load({ local: repo() });
  await new Promise((r) => { setImmediate(r); });
  assert.equal(f.state.status, 'ok');
  assert.equal(f.state.avisoRemoto, undefined, 'mientras la petición sigue en curso no se avisa de nada');
  f.peticiones[0].rechazar(ERROR_RED());
  await carga;
  assert.equal(f.state.status, 'ok');
  assert.equal(f.state.origen, 'local');
  assert.match(f.state.avisoRemoto, /copia guardada en este dispositivo/i);
  assert.ok(!f.historial.includes('error'));
});

test('#116 C: el remoto falla primero y la copia aparece después: termina visible', async () => {
  const f = montar();
  const primera = f.load({ local: null });
  await Promise.resolve();
  f.peticiones[0].rechazar(ERROR_RED());
  await primera;
  assert.equal(f.state.status, 'error', 'sin copia todavía, el error es correcto');

  const segunda = f.load({ local: repo() });
  await new Promise((r) => { setImmediate(r); });
  assert.equal(f.state.status, 'ok');
  assert.deepEqual(f.state.animal, COPIA);
  f.peticiones[1].rechazar(ERROR_RED());
  await segunda;
  assert.equal(f.state.status, 'ok');
  assert.equal(f.state.mensaje, undefined);
});

test('#116 D: sin copia local un fallo sí muestra el error actual', async () => {
  const f = montar();
  const carga = f.load({ local: repo({}) });
  await new Promise((r) => { setImmediate(r); });
  assert.equal(f.state.status, 'loading');
  f.peticiones[0].rechazar(ERROR_RED());
  await carga;
  assert.equal(f.state.status, 'error');
  assert.equal(f.state.animal, null);
  assert.equal(f.state.mensaje, MENSAJE_SIN_CONEXION);
});

test('#116 D: sin copia, 404 es "no disponible" y 5xx es error', async () => {
  const f = montar();
  const a = f.load({ local: repo({}) });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[0].resolver({ ok: false, status: 404, data: { error: 'NOT_FOUND' } });
  await a;
  assert.equal(f.state.status, 'not_found');

  const b = f.load({ local: repo({}) });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[1].resolver({ ok: false, status: 503, data: {} });
  await b;
  assert.equal(f.state.status, 'error');
});

test('#116 E: la red vuelve y el reintento reemplaza la copia por los datos del servidor', async () => {
  const f = montar();
  const local = repo();
  const caida = f.load({ local });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[0].rechazar(ERROR_RED());
  await caida;
  assert.ok(f.state.avisoRemoto);

  const reintento = f.load({ local, silencioso: true });
  await new Promise((r) => { setImmediate(r); });
  assert.ok(f.state.avisoRemoto, 'el aviso no parpadea mientras se reintenta');
  f.peticiones[1].resolver(okDe(DEL_SERVIDOR));
  await reintento;
  assert.equal(f.state.origen, 'servidor');
  assert.deepEqual(f.state.animal, DEL_SERVIDOR);
  assert.equal(f.state.avisoRemoto, undefined, 'el aviso desaparece con datos del servidor');
});

test('#116 E: reintento desde la pantalla de error sin copia', async () => {
  const f = montar();
  const a = f.load({ local: null });
  await Promise.resolve();
  f.peticiones[0].rechazar(ERROR_RED());
  await a;
  assert.equal(f.state.status, 'error');
  const b = f.load({ local: null });
  await Promise.resolve();
  assert.equal(f.state.status, 'loading');
  f.peticiones[1].resolver(okDe(DEL_SERVIDOR));
  await b;
  assert.equal(f.state.status, 'ok');
  assert.deepEqual(f.state.animal, DEL_SERVIDOR);
});

test('respuesta vieja: una respuesta correcta de la carga anterior no pisa la actual', async () => {
  const f = montar();
  const vieja = f.load({ local: null });
  await Promise.resolve();
  const nueva = f.load({ local: null });
  await Promise.resolve();
  f.peticiones[1].resolver(okDe(DEL_SERVIDOR));
  await nueva;
  f.peticiones[0].resolver(okDe({ ...DEL_SERVIDOR, ultimoPeso: 1 }));
  await vieja;
  assert.equal(f.state.animal.ultimoPeso, 450, 'gana la carga más reciente aunque termine antes');
});

test('respuesta vieja: un fallo de la carga anterior no pisa la respuesta actual', async () => {
  const f = montar();
  const vieja = f.load({ local: null });
  await Promise.resolve();
  const nueva = f.load({ local: null });
  await Promise.resolve();
  f.peticiones[1].resolver(okDe(DEL_SERVIDOR));
  await nueva;
  f.peticiones[0].rechazar(ERROR_RED());
  await vieja;
  assert.equal(f.state.status, 'ok');
  assert.deepEqual(f.state.animal, DEL_SERVIDOR);
});

test('cambio de animal con petición en curso: la respuesta del animal anterior se ignora', async () => {
  const f = montar();
  const del1 = f.load({ routeId: '1', local: null });
  await Promise.resolve();
  const del2 = f.load({ routeId: '2', local: null });
  await Promise.resolve();
  f.peticiones[0].resolver(okDe(DEL_SERVIDOR));
  await del1;
  assert.notEqual(f.state.animal?.animalId, '1', 'nunca se muestra el animal 1 en la ruta del 2');
  assert.equal(f.state.status, 'loading');
  f.peticiones[1].resolver(okDe(OTRA_COPIA));
  await del2;
  assert.deepEqual(f.state.animal, OTRA_COPIA);
});

test('cambio de animal: un fallo tardío del anterior no pone en error al nuevo', async () => {
  const f = montar();
  const del1 = f.load({ routeId: '1', local: null });
  await Promise.resolve();
  const del2 = f.load({ routeId: '2', local: repo() });
  await new Promise((r) => { setImmediate(r); });
  assert.deepEqual(f.state.animal, OTRA_COPIA);
  f.peticiones[0].rechazar(ERROR_RED());
  await del1;
  assert.deepEqual(f.state.animal, OTRA_COPIA);
  assert.equal(f.state.status, 'ok');
  assert.equal(f.state.avisoRemoto, undefined, 'el fallo ajeno ni siquiera deja aviso');
  f.peticiones[1].resolver(okDe(OTRA_COPIA));
  await del2;
  assert.equal(f.state.origen, 'servidor');
});

test('reconexión: solo en la transición, sin animal local ni edición abierta', () => {
  const base = { onlineAntes: false, online: true, esLocal: false, modo: 'ver' };
  assert.equal(debeRefrescarAlReconectar(base), true);
  assert.equal(debeRefrescarAlReconectar({ ...base, onlineAntes: true }), false, 'seguir con red no refresca');
  assert.equal(debeRefrescarAlReconectar({ ...base, online: false }), false, 'perder la red no refresca');
  assert.equal(debeRefrescarAlReconectar({ ...base, esLocal: true }), false);
  assert.equal(debeRefrescarAlReconectar({ ...base, modo: 'corregir' }), false, 'no cambia la base de una corrección abierta');
});

test('cambio de animal: una lectura local lenta del anterior no pisa al nuevo', async () => {
  const f = montar();
  const lectura = diferida();
  const lenta = { getAnimal: () => lectura.promesa, getChapetaDeAnimal: async () => 'chapeta-vieja' };
  const del1 = f.load({ routeId: '1', local: lenta });
  const del2 = f.load({ routeId: '2', local: repo() });
  await new Promise((r) => { setImmediate(r); });
  assert.deepEqual(f.state.animal, OTRA_COPIA);
  const pendientes = f.peticiones.length;
  lectura.resolver(COPIA);
  await del1;
  assert.deepEqual(f.state.animal, OTRA_COPIA);
  assert.equal(f.peticiones.length, pendientes, 'la carga obsoleta no llega a pedir al servidor');
  f.peticiones[0].rechazar(ERROR_RED());
  await del2;
  assert.deepEqual(f.state.animal, OTRA_COPIA);
});

test('cambio de animal: el fallo del nuevo sin copia es error, no la ficha del anterior', async () => {
  const f = montar();
  const a = f.load({ routeId: '1', local: repo({ 1: COPIA }) });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[0].rechazar(ERROR_RED());
  await a;
  assert.deepEqual(f.state.animal, COPIA);

  const b = f.load({ routeId: '2', local: repo({ 1: COPIA }) });
  assert.equal(f.state.animal, null, 'la ficha anterior se retira en cuanto cambia la ruta');
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[1].rechazar(ERROR_RED());
  await b;
  assert.equal(f.state.status, 'error');
  assert.equal(f.state.animal, null);
});

test('invalidar (al desmontar o tras guardar): la carga en curso ya no toca el estado', async () => {
  const f = montar();
  const carga = f.load({ local: null });
  await Promise.resolve();
  f.control.invalidar();
  const antes = f.state;
  f.peticiones[0].rechazar(ERROR_RED());
  await carga;
  assert.equal(f.state, antes);
});

test('fallo al leer la copia en un refresco: se conserva la ficha ya visible', async () => {
  const f = montar();
  const a = f.load({ local: repo() });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[0].rechazar(ERROR_RED());
  await a;
  const rota = { getAnimal: async () => { throw new Error('IDB'); }, getChapetaDeAnimal: async () => null };
  const b = f.load({ local: rota });
  await new Promise((r) => { setImmediate(r); });
  f.peticiones[1].rechazar(ERROR_RED());
  await b;
  assert.equal(f.state.status, 'ok');
  assert.deepEqual(f.state.animal, COPIA);
});

test('refresco silencioso sin repositorio que falla: no borra la ficha servida', async () => {
  const f = montar();
  const a = f.load({ local: null });
  await Promise.resolve();
  f.peticiones[0].resolver(okDe(DEL_SERVIDOR));
  await a;
  const b = f.load({ local: null, silencioso: true });
  await Promise.resolve();
  f.peticiones[1].rechazar(ERROR_RED());
  await b;
  assert.equal(f.state.status, 'ok');
  assert.deepEqual(f.state.animal, DEL_SERVIDOR);
  assert.match(f.state.avisoRemoto, /últimos datos disponibles/);
});

test('animal local no sincronizado: redirección, not_found y sin petición remota', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const f = montar();
  await f.load({ routeId: `local:${uuid}`, esLocal: true, local: { getAnimal: async () => ({ redirectTo: '9' }), getChapetaDeAnimal: async () => null } });
  assert.deepEqual(f.state, { status: 'redirect', animal: null, to: '9' });
  const g = montar();
  await g.load({ routeId: `local:${uuid}`, esLocal: true, local: repo({}) });
  assert.equal(g.state.status, 'not_found');
  const h = montar();
  const registro = { animalId: null, localUuid: uuid, numeroVisual: 'L-1', estadoSync: 'PENDIENTE' };
  await h.load({ routeId: `local:${uuid}`, esLocal: true, local: { getAnimal: async () => registro, getChapetaDeAnimal: async () => null } });
  assert.deepEqual(h.state.animal, registro);
  assert.equal(h.peticiones.length, 0);
});

test('la chapeta local de una carga obsoleta no se aplica', async () => {
  const f = montar();
  const chapeta = diferida();
  const lenta = { getAnimal: async () => COPIA, getChapetaDeAnimal: () => chapeta.promesa };
  const del1 = f.load({ routeId: '1', local: lenta });
  await new Promise((r) => { setImmediate(r); });
  f.load({ routeId: '2', local: repo() });
  await new Promise((r) => { setImmediate(r); });
  const actual = f.chapeta;
  chapeta.resolver({ codigoVisible: 'VIEJA' });
  await del1;
  assert.equal(f.chapeta, actual);
});

test('HatoDetallePage usa cargarFicha: sin setState de error propio y con invalidación', () => {
  assert.match(pagina, /import \{[^}]*cargarFicha[^}]*\} from '\.\/fichaCargaModel\.js'/);
  assert.match(pagina, /cargarFicha\(\{/);
  assert.doesNotMatch(pagina, /localEncontrado/, 'la decisión vive en el modelo');
  assert.doesNotMatch(pagina, /setState\(\{ status: 'error'/, 'la página no decide por su cuenta poner error');
  assert.doesNotMatch(pagina, /await getAnimal\(/, 'la página no pide al servidor fuera del modelo');
  assert.match(pagina, /return \(\) => cargas\.invalidar\(\)/, 'una carga en curso se invalida al cambiar de ruta o desmontar');
});

test('HatoDetallePage marca la copia y ofrece actualizar sin tapar la ficha', () => {
  assert.match(pagina, /state\.avisoRemoto \?/);
  assert.match(pagina, /load\(\{ silencioso: true \}\)\}>Actualizar<\/button>/);
  assert.match(pagina, /debeRefrescarAlReconectar\(/, 'al volver la conexión la ficha se refresca sola');
});

test('los paneles se reinician al cambiar de animal (sin datos ajenos en curso)', () => {
  for (const panel of ['HatoPesajesPanel', 'HatoReproduccionPanel', 'HatoActividadPanel', 'HatoQrPanel']) {
    assert.match(pagina, new RegExp(`<${panel}\\n\\s+key=\\{animal\\.animalId\\}|<${panel} key=\\{animal\\.animalId\\}`), panel);
  }
});
