// SPRINT-3D11.3 (R1) -- NO REGRESIÓN de CatastroX y del resto del sitio por
// el service worker nuevo. Prueba DIFERENCIAL: el SW nuevo
// (public/service-worker.js) y el SW v18 que está hoy en producción
// (fixtures/service-worker.v18.js, copia exacta de public/service-worker.js
// en 2523a48 / 57fd398) se ejecutan en el mismo sandbox con los mismos
// escenarios, y deben producir EXACTAMENTE las mismas respuestas, la misma
// decisión de interceptar o no y el mismo contenido de caché.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServiceWorker } from './swHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUEVO = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'public', 'service-worker.js'), 'utf8');
const V18 = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'service-worker.v18.js'), 'utf8');

const sinVersion = (snapshot) => Object.fromEntries(Object.entries(snapshot).map(([name, keys]) => [name.replace(/agrogenomax-pwa-v\d+[^]*$/, 'shell'), keys]));

/** Ejecuta el mismo guion en ambos SW (dispositivo que nunca preparó Ganadería). */
async function comparar(guion) {
  const resultados = [];
  for (const source of [V18, NUEVO]) {
    const sw = loadServiceWorker(source);
    await sw.dispatch('install');
    await sw.dispatch('activate');
    resultados.push({ salida: await guion(sw), cache: sinVersion(sw.cacheSnapshot()) });
  }
  assert.deepEqual(resultados[1].salida, resultados[0].salida, 'mismas respuestas que v18');
  assert.deepEqual(resultados[1].cache, resultados[0].cache, 'mismo contenido de caché que v18');
  return resultados[1].salida;
}

test('CatastroX: instalación idéntica a v18 (solo shell; sin descargar el build ni agx-precache.json)', async () => {
  await comparar(async (sw) => sw.red.peticiones.filter((p) => p !== '/agx-offline-sync.js'));
});

test('CatastroX: navegación online a /catastrox y subrutas -> respuesta de la red, como v18', async () => {
  const salida = await comparar(async (sw) => Promise.all(['/catastrox', '/catastrox/resultado?id=1', '/', '/planes'].map((ruta) => sw.navegar(ruta))));
  for (const { body } of salida) assert.match(body, /^red /);
});

test('CatastroX: red lenta (más que el timeout de Ganadería) -> sigue esperando a la red, sin servir el shell', async () => {
  const salida = await comparar(async (sw) => {
    sw.red.modo = 'lenta';
    sw.red.demoraMs = 30; // > 4 ms (timeout de Ganadería acelerado x1000)
    return sw.navegar('/catastrox');
  });
  assert.equal(salida.body, 'red /catastrox');
});

test('CatastroX: sin red, navegación -> /index.html cacheado, como v18', async () => {
  await comparar(async (sw) => {
    await sw.navegar('/catastrox');
    sw.red.modo = 'offline';
    return sw.navegar('/catastrox');
  });
});

test('CatastroX: JS/CSS del build online -> red primero y caché de respaldo, como v18', async () => {
  const salida = await comparar(async (sw) => {
    const online = await sw.get('/assets/index-A1.js', { destination: 'script' });
    const css = await sw.get('/assets/index-B2.css', { destination: 'style' });
    sw.red.modo = 'offline';
    const offline = await sw.get('/assets/index-A1.js', { destination: 'script' });
    return { online, css, offline };
  });
  assert.equal(salida.online.body, 'red /assets/index-A1.js');
});

test('CatastroX: capas .geojson e imágenes -> caché con revalidación, como v18', async () => {
  await comparar(async (sw) => {
    const capa = await sw.get('/assets/ley_2_colombia_simplificada-X.geojson', { destination: '' });
    const img = await sw.get('/assets/module-bg-catastrox-X.webp', { destination: 'image' });
    sw.red.modo = 'offline';
    const capaOffline = await sw.get('/assets/ley_2_colombia_simplificada-X.geojson', { destination: '' });
    return { capa, img, capaOffline };
  });
});

test('CatastroX: /api/catastrox/* siempre a la red y nunca cacheado; POST no interceptado', async () => {
  const salida = await comparar(async (sw) => {
    const lookup = await sw.get('/api/catastrox/lookup?lat=1&lng=2');
    const post = await sw.dispatch('fetch', { request: { url: 'https://agrogenomax.test/api/catastrox/payments', method: 'POST', mode: 'cors', destination: '' } });
    return { lookup, postInterceptado: post.responded };
  });
  assert.equal(salida.postInterceptado, false);
});

test('CatastroX: teselas y recursos de otros orígenes (Esri/OSM) no se interceptan, como v18', async () => {
  const salida = await comparar(async (sw) => Promise.all([
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/10/12',
    'https://tile.openstreetmap.org/5/10/12.png',
  ].map((url) => sw.get(url, { destination: 'image' }))));
  for (const { responded } of salida) assert.equal(responded, false);
});

test('el único cambio fuera de Ganadería es aditivo: assets precacheados SOLO si Ganadería preparó el dispositivo', async () => {
  const sw = loadServiceWorker(NUEVO);
  await sw.dispatch('install');
  await sw.precache();
  sw.red.modo = 'offline';
  // Mismo archivo con hash (contenido idéntico al de la red), ahora disponible sin red.
  assert.equal((await sw.get('/assets/index-A1.js', { destination: 'script' })).body, 'red /assets/index-A1.js');
  // CatastroX sin red: respaldo /index.html como en v18, servido como shell
  // 200 no redirigido (el navegador lo acepta).
  const catastrox = await sw.navegar('/catastrox');
  assert.equal(catastrox.networkError, false);
  assert.equal(catastrox.status, 200);
  assert.equal(catastrox.redirected, false);
  assert.equal(catastrox.body, 'red /');
});

test('CatastroX: visitada con red, Ganadería preparada después y sin red -> /catastrox sigue abriendo (shell 200 no redirigido)', async () => {
  const sw = loadServiceWorker(NUEVO);
  await sw.dispatch('install');
  await sw.dispatch('activate');
  await sw.navegar('/catastrox');
  await sw.precache();
  sw.red.modo = 'offline';
  const catastrox = await sw.navegar('/catastrox');
  assert.equal(catastrox.networkError, false);
  assert.equal(catastrox.status, 200);
  assert.equal(catastrox.redirected, false);
});

test('fixture v18 = SW de producción (sin estrategias offline-first)', () => {
  assert.match(V18, /const CACHE_VERSION = 'agrogenomax-pwa-v18-qr-api-network-first';/);
  assert.doesNotMatch(V18, /AGX_PRECACHE|agx-ganaderia-outbox/);
});
