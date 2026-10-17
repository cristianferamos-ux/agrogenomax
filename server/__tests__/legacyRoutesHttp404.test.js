// SPRINT-3D11.SECURITY-LEGACY: smoke HTTP sobre el server/index.js REAL
// (proceso hijo, APP_ENV=development, entorno limpio sin ninguna URL de
// base de datos). Prueba que las rutas legacy de animales/QR/predios/
// potreros/razas/salud ya no existen -- 404 genérico de notFound, sin
// `exists`/`codigo`/`qr`/`animal` -- y que /api/health y /api/ganaderia/*
// conservan su semántica sin sesión. Nunca toca una base de datos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '..', 'index.js');

let child;
let baseUrl;
let childOutput = '';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  // Entorno mínimo explícito: NUNCA hereda DATABASE_URL/AGX_*_DATABASE_URL
  // ni secretos del entorno del desarrollador o de CI.
  const env = { APP_ENV: 'development', PORT: String(port), PATH: process.env.PATH ?? '' };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;

  child = spawn(process.execPath, [INDEX_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server/index.js no arrancó a tiempo:\n${childOutput}`)), 15000);
    const onData = () => {
      if (childOutput.includes('AgroGenomaX API running on port')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server/index.js terminó (code ${code}) antes de arrancar:\n${childOutput}`));
    });
  });
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
});

async function request(method, urlPath, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${urlPath}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const GENERIC_NOT_FOUND = { error: 'Ruta no encontrada' };

const LEGACY_GET_PATHS = [
  '/api/animales',
  '/api/animales/1',
  '/api/animales/1/razas',
  '/api/qr/AGX-SMOKE-NONEXISTENT-7f3c9a',
  '/api/predios',
  '/api/potreros',
  '/api/razas',
  '/api/animales/1/pesajes',
  '/api/animales/1/pesajes/evolucion',
  '/api/animales/1/vacunaciones',
  '/api/animales/1/tratamientos',
  '/api/animales/1/reproduccion',
  '/api/catalogo-vacunas',
  '/api/tratamientos?animal_id=1',
  '/api/reproduccion?animal_id=1',
];

for (const urlPath of LEGACY_GET_PATHS) {
  test(`GET ${urlPath} -> 404 genérico (router legacy desmontado)`, async () => {
    const { status, json } = await request('GET', urlPath);
    assert.equal(status, 404);
    assert.deepEqual(json, GENERIC_NOT_FOUND);
  });
}

test('GET /api/qr/:codigo no revela existencia: ni exists, ni codigo, ni qr, ni animal', async () => {
  const { status, json } = await request('GET', '/api/qr/AGX-SMOKE-NONEXISTENT-7f3c9a');
  assert.equal(status, 404);
  for (const key of ['exists', 'assigned', 'codigo', 'qr', 'animal']) {
    assert.equal(Object.hasOwn(json, key), false, `la respuesta no debe incluir ${key}`);
  }
});

const LEGACY_MUTATIONS = [
  ['POST', '/api/animales'],
  ['PUT', '/api/animales/1'],
  ['POST', '/api/qr/asociar'],
  ['POST', '/api/qr/importar'],
  ['POST', '/api/predios'],
  ['POST', '/api/potreros'],
  ['POST', '/api/animal-razas'],
  ['POST', '/api/pesajes'],
  ['POST', '/api/vacunaciones'],
  ['POST', '/api/tratamientos'],
  ['POST', '/api/reproduccion'],
];

for (const [method, urlPath] of LEGACY_MUTATIONS) {
  test(`${method} ${urlPath} -> 404 genérico (router legacy desmontado)`, async () => {
    const { status, json } = await request(method, urlPath, {});
    assert.equal(status, 404);
    assert.deepEqual(json, GENERIC_NOT_FOUND);
  });
}

test('GET /api/health/live sigue respondiendo 200', async () => {
  const { status, json } = await request('GET', '/api/health/live');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
});

test('GET /api/health sigue respondiendo 200', async () => {
  const { status } = await request('GET', '/api/health');
  assert.equal(status, 200);
});

test('GET /api/ganaderia/auth/session sin cookie conserva su semántica (200, authenticated:false)', async () => {
  const { status, json } = await request('GET', '/api/ganaderia/auth/session');
  assert.equal(status, 200);
  assert.equal(json.authenticated, false);
});

test('GET /api/ganaderia/predios sin sesión conserva 401 SESSION_REQUIRED', async () => {
  const { status, json } = await request('GET', '/api/ganaderia/predios');
  assert.equal(status, 401);
  assert.equal(json.error, 'SESSION_REQUIRED');
});

test('GET /api/ganaderia/predios/1/potreros sin sesión conserva 401 SESSION_REQUIRED', async () => {
  const { status, json } = await request('GET', '/api/ganaderia/predios/1/potreros');
  assert.equal(status, 401);
  assert.equal(json.error, 'SESSION_REQUIRED');
});

// SPRINT-3D11.3 (R1): el QR nuevo vive bajo /api/ganaderia (sesión
// obligatoria; inventario solo Super Admin), nunca reabre /api/qr legacy.
for (const [method, routePath] of [
  ['GET', '/api/ganaderia/qr/token/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['GET', '/api/ganaderia/qr/codigo/AGX-000003'],
  ['GET', '/api/ganaderia/animales/1/qr'],
  ['POST', '/api/ganaderia/animales/1/qr/asociar'],
  ['GET', '/api/ganaderia/admin/qr/lotes'],
  ['POST', '/api/ganaderia/admin/qr/lotes'],
]) {
  test(`${method} ${routePath} sin sesión -> 401 SESSION_REQUIRED (QR nuevo, no legacy)`, async () => {
    const { status, json } = await request(method, routePath);
    assert.equal(status, 401);
    assert.equal(json.error, 'SESSION_REQUIRED');
  });
}
