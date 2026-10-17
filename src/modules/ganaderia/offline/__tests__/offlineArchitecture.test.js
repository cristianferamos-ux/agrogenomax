// SPRINT-3D11.3 (R1) -- invariantes de arquitectura del offline-first
// (análisis de texto fuente, convención del repo: sin jsdom).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFLINE_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(OFFLINE_DIR, '..');
const SRC_DIR = path.resolve(GANADERIA_DIR, '..', '..');
const REPO_ROOT = path.resolve(SRC_DIR, '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const code = (...parts) => stripComments(read(path.join(...parts)));
const offlineFiles = fs.readdirSync(OFFLINE_DIR).filter((name) => /\.(js|jsx)$/.test(name));

test('motor, repo, outbox, storage y sesión offline: JS puro (sin React ni DOM), reutilizable en SW/Capacitor', () => {
  for (const name of ['syncEngine.js', 'localRepo.js', 'outbox.js', 'storage.js', 'offlineSession.js', 'operationHandlers.js', 'offlineSchema.js']) {
    const source = code(OFFLINE_DIR, name);
    assert.doesNotMatch(source, /from 'react'|\bwindow\.|\bdocument\.|localStorage|sessionStorage/, name);
  }
});

test('IndexedDB es la base local (nunca localStorage/sessionStorage)', () => {
  for (const name of offlineFiles) assert.doesNotMatch(code(OFFLINE_DIR, name), /localStorage|sessionStorage/, name);
  assert.match(code(OFFLINE_DIR, 'browserOffline.js'), /openIndexedDb\(indexedDB, orgDbName\(organizacionId\)/);
});

test('namespace por organización y ningún secreto en el esquema local', () => {
  const schema = code(OFFLINE_DIR, 'offlineSchema.js');
  assert.match(schema, /export const ORG_DB_PREFIX = 'agx-ganaderia-org-v1-';/);
  for (const store of ['meta', 'animales', 'chapetas', 'predios', 'potreros', 'razas', 'categorias', 'outbox', 'aliases']) {
    assert.match(schema, new RegExp(`\\b${store}: \\{`), store);
  }
  assert.doesNotMatch(schema, /\btoken:|csrf|password|cookie/i);
});

test('motor genérico: manejadores registrables (no exclusivo de QR)', () => {
  const handlers = code(OFFLINE_DIR, 'operationHandlers.js');
  assert.match(handlers, /ANIMAL_CREAR:/);
  assert.match(handlers, /ANIMAL_CREAR_CON_CHAPETA:/);
  assert.match(code(OFFLINE_DIR, 'syncEngine.js'), /const handler = handlerFor\(original\.tipoOperacion\);/);
});

test('el motor nunca hace "last write wins": 409/404/410 -> CONFLICTO conservando el registro local', () => {
  const engine = code(OFFLINE_DIR, 'syncEngine.js');
  assert.match(engine, /if \(\[404, 409, 410\]\.includes\(result\.status\)\) return 'CONFLICTO';/);
  const repo = code(OFFLINE_DIR, 'localRepo.js');
  assert.match(repo, /valorLocal: op\.payload/);
});

test('sesión offline: SOLO sin respuesta del servidor y con perfil vigente; un 5xx sigue siendo fail-closed', () => {
  const bridge = code(GANADERIA_DIR, 'auth', 'offlineSessionBridge.js');
  assert.match(bridge, /return error instanceof TypeError \|\| nav\?\.onLine === false;/);
  const context = code(GANADERIA_DIR, 'auth', 'GanaderiaAuthContext.jsx');
  assert.match(context, /const offlinePayload = isNetworkFailure\(error\) \? await loadOfflineSession\(\) : null;/);
  assert.match(context, /setStatus\(offlinePayload \? deriveStatus\(offlinePayload\) : 'anonymous'\);/);
  assert.match(context, /clearOfflineSession\(sessionRef\.current\?\.organizacionActiva\?\.organizacionId\);/);
  const session = code(OFFLINE_DIR, 'offlineSession.js');
  assert.match(session, /export const OFFLINE_VALIDEZ_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(session, /if \(rolInterno \|\| !organizacionActiva\?\.organizacionId\) return null;/);
});

test('Ganadería: proveedor offline + indicador siempre visible + /ganaderia/sincronizacion', () => {
  const app = code(GANADERIA_DIR, 'GanaderiaApp.jsx');
  assert.match(app, /<GanaderiaOfflineProvider>\s*<GanaderiaShell>\s*<OfflineStatusBar \/>/);
  assert.match(app, /<Route path="sincronizacion" element=\{<OfflineSyncPage \/>\} \/>/);
  const rootApp = read(path.join(SRC_DIR, 'App.jsx'));
  assert.match(rootApp, /<GanaderiaOfflineProvider>\s*<OfflineStatusBar \/>\s*<GanaderiaDashboard \/>/);
  const page = code(OFFLINE_DIR, 'OfflineSyncPage.jsx');
  assert.match(page, /Preparar dispositivo para trabajo offline/);
  for (const dato of ['Última sincronización', 'Animales en el dispositivo', 'Chapetas disponibles', 'Operaciones pendientes']) {
    assert.ok(page.includes(dato), dato);
  }
});

test('sincronización automática: el botón manual es solo respaldo', () => {
  const provider = code(OFFLINE_DIR, 'GanaderiaOfflineProvider.jsx');
  assert.match(provider, /const auto = startAutoSync\(\{ engine, repo \}\);/);
  const auto = code(OFFLINE_DIR, 'autoSync.js');
  for (const disparador of ["'online'", "'visibilitychange'", "'AGX_SYNC_REQUEST'", 'registration.sync.register(BACKGROUND_SYNC_TAG)', "trigger('apertura')", "trigger('reintento')", "trigger('operacion')"]) {
    assert.ok(auto.includes(disparador), disparador);
  }
});

test('páginas del piloto local-first: lista, ficha, registro, catálogos y resolución QR', () => {
  const hato = (name) => code(GANADERIA_DIR, 'hato', name);
  assert.match(hato('HatoListaPage.jsx'), /const animales = await local\.listAnimales\(filtros\);/);
  assert.match(hato('HatoDetallePage.jsx'), /const animalLocal = await local\.getAnimal\(animalId\)/);
  assert.match(hato('HatoDetallePage.jsx'), /const accionesDisponibles = !esLocal && offline\.online;/);
  assert.match(hato('HatoRegistroPage.jsx'), /const \{ localUuid \} = await local\.registrarAnimalLocal\(\{ body, chapetaCodigo: chapeta \}\);/);
  assert.match(hato('HatoRegistroPage.jsx'), /navigate\(`\/ganaderia\/animales\/local:\$\{localUuid\}`, \{ replace: true \}\);/);
  assert.match(hato('useHatoCatalogos.js'), /local\.listRazas\(\)/);
  const resolver = hato('HatoQrResolverPage.jsx');
  assert.match(resolver, /await local\.resolverLocal\(/);
  assert.match(resolver, /setOutcome\(\{ status: 'desconocida_offline' \}\);/);
  assert.match(read(path.join(GANADERIA_DIR, 'hato', 'HatoQrResolverPage.jsx')), /Código no disponible en este dispositivo\. Conéctese para verificarlo\./);
});

test('Service Worker: precache del build, /api nunca cacheado, Background Sync, timeout de navegación', () => {
  const sw = read(path.join(REPO_ROOT, 'public', 'service-worker.js'));
  assert.match(sw, /const PRECACHE_MANIFEST = '\/agx-precache\.json';/);
  assert.match(sw, /const BACKGROUND_SYNC_TAG = 'agx-ganaderia-outbox';/);
  assert.match(sw, /importScripts\('\/agx-offline-sync\.js'\)/);
  // Estrategias offline LIMITADAS a Ganadería (ver serviceWorkerCatastroxRegression.test.js).
  assert.match(sw, /const network = isGanaderiaPath\(requestUrl\.pathname\)\s*\? networkWithTimeout\(request, GANADERIA_NAVIGATION_TIMEOUT_MS\)\s*: fetch\(request\);/);
  assert.match(sw, /return pathname === '\/ganaderia' \|\| pathname\.startsWith\('\/ganaderia\/'\) \|\| pathname\.startsWith\('\/qr\/'\);/);
  const install = sw.match(/self\.addEventListener\('install'[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.doesNotMatch(install, /precacheBuild/, 'la instalación nunca precachea el build');
  const plugin = read(path.join(REPO_ROOT, 'vite.agx-offline.js'));
  assert.match(plugin, /fileName: 'agx-precache\.json'/);
  assert.match(plugin, /entry: 'src\/modules\/ganaderia\/offline\/swSyncEntry\.js'/);
  assert.match(read(path.join(REPO_ROOT, 'vite.config.js')), /plugins: \[react\(\), agxOfflinePlugin\(\)\]/);
  const register = read(path.join(SRC_DIR, 'registerServiceWorker.js'));
  assert.match(register, /return Boolean\(\(isLocalHost && !allowLocal\) \|\| isDev\);/);
});

test('sin dependencias nuevas para offline (IndexedDB nativo, sin librerías de sync)', () => {
  const pkg = JSON.parse(read(path.join(REPO_ROOT, 'package.json')));
  for (const dep of ['idb', 'dexie', 'localforage', 'workbox-window', 'vite-plugin-pwa', 'pouchdb']) {
    assert.equal(pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep], undefined, dep);
  }
});
