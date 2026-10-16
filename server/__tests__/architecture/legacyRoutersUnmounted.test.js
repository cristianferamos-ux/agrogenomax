// SPRINT-3D11.SECURITY-LEGACY: los routers de negocio legacy (server/routes/
// {animales,qr,razas,pesajes,vacunaciones,tratamientos,reproduccion,predios,
// potreros}.js, sobre el Postgres legacy de server/db.js, sin tenant ni RLS)
// quedan DESMONTADOS de server/index.js. Esta prueba lee el fuente (mismo
// patrón que liveness/gracefulShutdown) y falla si alguno vuelve a
// importarse o montarse, o si desaparece algún montaje vigente de
// /api/ganaderia/*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(SERVER_ROOT, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const indexCode = indexSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LEGACY_ROUTE_FILES = [
  'animales',
  'qr',
  'razas',
  'pesajes',
  'vacunaciones',
  'tratamientos',
  'reproduccion',
  'predios',
  'potreros',
];

const LEGACY_FACTORIES = [
  'createAnimalesRouter',
  'createQrRouter',
  'createRazasRouter',
  'createPesajesRouter',
  'createVacunacionesRouter',
  'createTratamientosRouter',
  'createReproduccionRouter',
  'createPrediosRouter',
  'createPotrerosRouter',
];

const LEGACY_MOUNT_PATHS = ['/api/animales', '/api/qr', '/api/razas', '/api/predios', '/api/potreros'];

test('server/index.js no importa ningún router legacy de server/routes/', () => {
  for (const name of LEGACY_ROUTE_FILES) {
    assert.doesNotMatch(
      indexCode,
      new RegExp(`from\\s+['"]\\./routes/${name}\\.js['"]`),
      `server/index.js no debe importar ./routes/${name}.js`,
    );
  }
});

test('server/index.js no referencia ninguna fábrica de router legacy', () => {
  for (const factory of LEGACY_FACTORIES) {
    assert.doesNotMatch(indexCode, new RegExp(`\\b${factory}\\b`), `${factory} no debe aparecer en server/index.js`);
  }
});

test('server/index.js no monta ninguna ruta legacy (/api/animales, /api/qr, /api/razas, /api/predios, /api/potreros)', () => {
  for (const mountPath of LEGACY_MOUNT_PATHS) {
    assert.doesNotMatch(
      indexCode,
      new RegExp(`app\\.use\\(\\s*['"]${mountPath.replace(/\//g, '\\/')}['"]`),
      `${mountPath} no debe montarse`,
    );
  }
});

test('server/index.js no monta routers de negocio sobre /api a secas (pesajes/vacunaciones/tratamientos/reproduccion/razas legacy)', () => {
  assert.doesNotMatch(indexCode, /app\.use\(\s*['"]\/api['"]\s*,/);
});

test('server/index.js conserva los montajes vigentes de /api/ganaderia/* y health', () => {
  for (const mountPath of [
    '/api/ganaderia/auth',
    '/api/ganaderia/admin',
    '/api/ganaderia/predios',
    '/api/ganaderia/predios/:predioId/potreros',
    '/api/ganaderia/predios/:predioId/potreros/:potreroId/ciclos-pastoreo',
    '/api/ganaderia/catalogo-pasturas',
    '/api/ganaderia/categorias-productivas',
    '/api/health',
  ]) {
    assert.ok(indexCode.includes(`'${mountPath}'`), `debe seguir montado ${mountPath}`);
  }
  assert.match(indexCode, /app\.get\('\/api\/health\/live'/);
});

test('los archivos fuente legacy se conservan (desmontados, no borrados)', () => {
  for (const name of LEGACY_ROUTE_FILES) {
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'routes', `${name}.js`)), `server/routes/${name}.js debe seguir existiendo`);
  }
});

test('notFound y errorHandler siguen siendo los últimos middlewares', () => {
  const notFoundIndex = indexCode.indexOf('app.use(notFound)');
  const errorHandlerIndex = indexCode.indexOf('app.use(errorHandler)');
  assert.ok(notFoundIndex > -1 && errorHandlerIndex > notFoundIndex);
  const lastRouteMount = indexCode.lastIndexOf("app.use(\n  '/api/");
  assert.ok(lastRouteMount < notFoundIndex);
});
