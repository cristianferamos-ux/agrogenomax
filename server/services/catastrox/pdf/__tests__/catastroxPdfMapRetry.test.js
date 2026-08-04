// CATX-DELIVERY-OBSERVABILITY-001 (requisito 7): pruebas del reintento
// automático con backoff para fallos transitorios de teselas Esri --
// deterministas, sin red real (mocks inyectados + sleepImpl controlado).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTileBufferWithRetry,
  fetchSatelliteMosaic,
  MapRenderError,
  DEFAULT_TILE_RETRY_BASE_DELAY_MS,
} from '../catastroxPdfMap.js';

function noopSleep() {
  return Promise.resolve();
}

test('CATX-DELIVERY-OBSERVABILITY-001: un fallo transitorio se reintenta y termina en éxito sin propagar el error', async () => {
  let calls = 0;
  async function flakyFetch() {
    calls += 1;
    if (calls <= 2) {
      throw new MapRenderError('fallo transitorio simulado'); // transient=true por defecto
    }
    return Buffer.from('ok');
  }

  const buffer = await fetchTileBufferWithRetry('https://example.test/tile', {
    fetchTile: flakyFetch,
    sleepImpl: noopSleep,
  });

  assert.equal(buffer.toString(), 'ok');
  assert.equal(calls, 3, 'se esperaban 3 intentos totales (1 inicial + 2 reintentos) antes de tener éxito');
});

test('CATX-DELIVERY-OBSERVABILITY-001: máximo 2 reintentos por tesela -- si sigue fallando, propaga MAP_RENDER_FAILED tras el 3er intento', async () => {
  let calls = 0;
  async function alwaysFailingFetch() {
    calls += 1;
    throw new MapRenderError('fallo transitorio persistente');
  }

  await assert.rejects(
    () => fetchTileBufferWithRetry('https://example.test/tile', { fetchTile: alwaysFailingFetch, sleepImpl: noopSleep }),
    (error) => {
      assert.equal(error.code, 'MAP_RENDER_FAILED');
      return true;
    },
  );
  assert.equal(calls, 3, 'nunca debe superar 1 intento inicial + 2 reintentos = 3 llamadas');
});

test('CATX-DELIVERY-OBSERVABILITY-001: un error NO transitorio (4xx, dato/validación) nunca se reintenta', async () => {
  let calls = 0;
  async function clientErrorFetch() {
    calls += 1;
    throw new MapRenderError('tesela fuera de rango (400)', { httpStatus: 400, transient: false });
  }

  await assert.rejects(
    () => fetchTileBufferWithRetry('https://example.test/tile', { fetchTile: clientErrorFetch, sleepImpl: noopSleep }),
  );
  assert.equal(calls, 1, 'un error de datos/validación (4xx) debe fallar en el primer intento, sin reintentar');
});

test('CATX-DELIVERY-OBSERVABILITY-001: la espera entre reintentos es incremental (backoff corto, no fijo)', async () => {
  const delays = [];
  async function sleepSpy(ms) {
    delays.push(ms);
  }
  let calls = 0;
  async function flakyFetch() {
    calls += 1;
    if (calls <= 2) throw new MapRenderError('transitorio');
    return Buffer.from('ok');
  }

  // Se usa la MISMA constante que el código de producción (nunca un número
  // mágico aparte) -- así esta prueba no puede quedar desincronizada del
  // valor real (150ms/300ms) si DEFAULT_TILE_RETRY_BASE_DELAY_MS cambia.
  await fetchTileBufferWithRetry('https://example.test/tile', {
    fetchTile: flakyFetch,
    sleepImpl: sleepSpy,
    retryBaseDelayMs: DEFAULT_TILE_RETRY_BASE_DELAY_MS,
  });

  assert.deepEqual(
    delays,
    [DEFAULT_TILE_RETRY_BASE_DELAY_MS, DEFAULT_TILE_RETRY_BASE_DELAY_MS * 2],
    'la espera debe crecer de forma incremental entre reintentos (150ms, luego 300ms), no ser constante',
  );
});

test('CATX-DELIVERY-OBSERVABILITY-001: fetchSatelliteMosaic aplica el reintento de forma independiente por cada tesela', async () => {
  const callsPerUrl = new Map();
  async function flakyMosaicFetch(url) {
    const count = (callsPerUrl.get(url) || 0) + 1;
    callsPerUrl.set(url, count);
    // Cada tesela falla exactamente 1 vez antes de tener éxito -- si el
    // reintento fuera compartido/global en vez de por tesela, alguna
    // tesela terminaría sin suficiente presupuesto propio.
    if (count === 1) throw new MapRenderError('transitorio por tesela');
    return Buffer.from('tile-ok');
  }

  const mapState = { zoom: 18, scale: 2 ** 18, centerWorldX: 100, centerWorldY: 100 };
  const tiles = await fetchSatelliteMosaic(mapState, 256, 256, { fetchTile: flakyMosaicFetch, retryBaseDelayMs: 0 });

  assert.ok(tiles.length > 0);
  tiles.forEach((tile) => assert.equal(tile.buffer.toString(), 'tile-ok'));
  callsPerUrl.forEach((count) => assert.equal(count, 2, 'cada tesela individual debe haber usado exactamente 1 reintento propio'));
});
