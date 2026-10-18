// SPRINT-3D11.3 (R1) -- public/service-worker.js REAL en node:vm
// (swHarness.js): comportamiento offline de GANADERÍA -- precache bajo
// demanda, shell sin red, timeout de navegación, assets del precache y
// Background Sync. La no regresión de CatastroX está en
// serviceWorkerCatastroxRegression.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, loadServiceWorker } from './swHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'public', 'service-worker.js'), 'utf8');

async function swPreparado() {
  const sw = loadServiceWorker(SW_SOURCE);
  await sw.dispatch('install');
  assert.deepEqual(await sw.precache(), { ok: true, version: 'abc123', assets: 3 });
  return sw;
}

test('17. la instalación NO precachea el build: solo Ganadería lo pide (AGX_PRECACHE)', async () => {
  const sw = loadServiceWorker(SW_SOURCE);
  await sw.dispatch('install');
  assert.ok(!sw.red.peticiones.includes('/agx-precache.json'));
  assert.ok(!Object.keys(sw.cacheSnapshot()).some((name) => name.startsWith('agrogenomax-assets-')));
  assert.deepEqual(await sw.precache(), { ok: true, version: 'abc123', assets: 3 });
  const assets = sw.cacheSnapshot()['agrogenomax-assets-abc123'];
  for (const asset of [...MANIFEST.assets, '/agx-offline-sync.js']) assert.ok(assets.includes(asset), asset);
});

/** Shell válido para una navegación: 200, sin redirección (el navegador acepta la respuesta). */
function assertShell(resultado, ruta) {
  assert.equal(resultado.networkError, false, `${ruta}: error de red (ERR_FAILED)`);
  assert.equal(resultado.status, 200, ruta);
  assert.equal(resultado.redirected, false, ruta);
  assert.equal(resultado.body, 'red /', ruta);
}

test('arnés fiel a Cloudflare Pages: /index.html llega redirigido y una navegación no acepta una respuesta redirigida', async () => {
  const ingenuo = loadServiceWorker(`
    self.addEventListener('install', (e) => e.waitUntil(caches.open('x').then((c) => c.addAll(['/index.html']))));
    self.addEventListener('fetch', (e) => e.respondWith(caches.match('/index.html')));
  `);
  await ingenuo.dispatch('install');
  assert.equal((await ingenuo.get('/index.html')).redirected, true);
  const navegacion = await ingenuo.navegar('/ganaderia/qr/AGX-000001');
  assert.equal(navegacion.networkError, true);
  assert.equal(navegacion.body, null);
});

test('17. dispositivo preparado y sin red: toda ruta de Ganadería sirve el shell', async () => {
  const sw = await swPreparado();
  sw.red.modo = 'offline';
  for (const ruta of ['/ganaderia/animales', '/ganaderia/predios', '/ganaderia/escanear-qr', '/ganaderia/animales/nuevo?chapeta=AGX-7KM4-P2XZ-R', '/qr/AGX-000003']) {
    assertShell(await sw.navegar(ruta), ruta);
  }
});

test('17. regresión ERR_FAILED: navegar con red -> preparar -> sin red -> navegación completa sirve el shell 200 no redirigido', async () => {
  const sw = loadServiceWorker(SW_SOURCE);
  await sw.dispatch('install');
  await sw.dispatch('activate');
  // Secuencia real: abrir Ganadería con red y luego preparar (o refrescar) el precache.
  await sw.navegar('/ganaderia/sincronizacion');
  const antesDelPrecache = sw.red.peticiones.length;
  assert.deepEqual(await sw.precache(), { ok: true, version: 'abc123', assets: 3 });
  assert.ok(!sw.red.peticiones.slice(antesDelPrecache).includes('/index.html'), 'el precache no pide /index.html (Pages lo redirige)');
  sw.red.modo = 'offline';
  for (const ruta of ['/ganaderia/qr/AGX-000001', '/ganaderia/sincronizacion', '/qr/AGX-000003']) {
    assertShell(await sw.navegar(ruta), ruta);
  }
});

test('17. solo instalado (sin navegación previa ni precache) y sin red: el shell redirigido de la instalación se sirve saneado', async () => {
  const sw = loadServiceWorker(SW_SOURCE);
  await sw.dispatch('install');
  sw.red.modo = 'offline';
  assertShell(await sw.navegar('/ganaderia/qr/AGX-000001'), '/ganaderia/qr/AGX-000001');
});

test('17. "lie-fi" en Ganadería: timeout y shell, la app no se queda esperando', async () => {
  const sw = await swPreparado();
  sw.red.modo = 'lie-fi';
  const inicio = Date.now();
  assertShell(await sw.navegar('/ganaderia/animales'), '/ganaderia/animales');
  assert.ok(Date.now() - inicio < 1000);
});

test('con red, la navegación devuelve la respuesta de la red tal cual (sin pasar por el shell)', async () => {
  const sw = await swPreparado();
  const online = await sw.navegar('/ganaderia/qr/AGX-000001');
  assert.equal(online.status, 200);
  assert.equal(online.body, 'red /ganaderia/qr/AGX-000001');
});

test('17. assets del precache: caché primero sin red, incluido <script type="module" crossorigin> con Vary: Origin', async () => {
  const sw = await swPreparado();
  sw.red.modo = 'offline';
  assert.equal((await sw.get('/assets/lazy-C3.js', { destination: 'script' })).body, 'red /assets/lazy-C3.js');
  const modulo = await sw.get('/assets/index-A1.js', { mode: 'cors', destination: 'script', headers: { origin: 'https://agrogenomax.test' } });
  assert.equal(modulo.body, 'red /assets/index-A1.js');
});

test('/api/* nunca se cachea (datos y sesión siempre de la red)', async () => {
  const sw = await swPreparado();
  await sw.get('/api/ganaderia/sync/pull');
  for (const [name, keys] of Object.entries(sw.cacheSnapshot())) {
    assert.ok(!keys.some((key) => key.startsWith('/api/')), name);
  }
});

test('Background Sync: con la app abierta pide a la página sincronizar; cerrada, ejecuta el PUSH en el SW', async () => {
  const mensajes = [];
  const abierta = loadServiceWorker(SW_SOURCE, { clients: [{ postMessage: (m) => mensajes.push(JSON.parse(JSON.stringify(m))) }] });
  await abierta.dispatch('sync', { tag: 'agx-ganaderia-outbox' });
  assert.deepEqual(mensajes, [{ type: 'AGX_SYNC_REQUEST' }]);
  assert.deepEqual(abierta.pushes, []);
  const cerrada = loadServiceWorker(SW_SOURCE, { clients: [] });
  await cerrada.dispatch('sync', { tag: 'agx-ganaderia-outbox' });
  assert.deepEqual(cerrada.pushes, ['push']);
  const otra = loadServiceWorker(SW_SOURCE, { clients: [] });
  await otra.dispatch('sync', { tag: 'otra' });
  assert.deepEqual(otra.pushes, []);
});
