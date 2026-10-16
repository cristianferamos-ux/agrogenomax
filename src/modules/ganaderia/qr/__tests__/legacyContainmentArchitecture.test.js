// SPRINT-3D11.SECURITY-LEGACY: el frontend ya no navega hacia los flujos
// legacy de animales/QR/potreros (backend desmontado) y la ruta pública
// /qr/:codigo es una página estática que no consulta ninguna API. La Demo
// de Ganadería queda fuera de este cambio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GANADERIA_DIR = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.resolve(GANADERIA_DIR, '..', '..');
const REPO_ROOT = path.resolve(SRC_DIR, '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

// App.jsx se lee sin stripComments: rutas como "/catastrox/*" contienen '/*'.
const appCode = read(path.join(SRC_DIR, 'App.jsx'));
const qrPageCode = stripComments(read(path.join(GANADERIA_DIR, 'qr', 'QrNoDisponiblePage.jsx')));
const ganaderiaAppCode = stripComments(read(path.join(GANADERIA_DIR, 'GanaderiaApp.jsx')));
const sidebarCode = stripComments(read(path.join(GANADERIA_DIR, 'components', 'GanaderiaSidebar.jsx')));
const dashboardCode = stripComments(read(path.join(GANADERIA_DIR, 'pages', 'GanaderiaDashboard.jsx')));
const demoSource = read(path.join(GANADERIA_DIR, 'pages', 'GanaderiaDemo.jsx'));

const DEAD_LEGACY_LINKS = [
  '/ganaderia/potreros',
  '/ganaderia/escanear-qr',
  '/ganaderia/animales/listado',
  '/ganaderia/animal/',
  '?modulo=',
];

// ---------------------------------------------------------------------
// Ruta pública /qr/:codigo
// ---------------------------------------------------------------------

test('App.jsx: /qr/:codigo renderiza QrNoDisponiblePage (ya no GanaderiaApp)', () => {
  const qrRoute = appCode.match(/<Route path="\/qr\/:codigo"[^\n]*\/>/)?.[0] ?? '';
  assert.match(qrRoute, /element=\{<QrNoDisponiblePage \/>\}/);
  assert.doesNotMatch(qrRoute, /GanaderiaApp|RequireGanaderiaAuth/);
  assert.match(appCode, /import QrNoDisponiblePage from '\.\/modules\/ganaderia\/qr\/QrNoDisponiblePage\.jsx';/);
});

test('QrNoDisponiblePage.jsx: estática -- sin fetch, sin API, sin leer el código de la URL', () => {
  for (const forbidden of [/fetch\(/, /ganaderiaApi/, /ganaderiaAuthedRequest/, /\/api\//, /useParams/, /useEffect/, /lookupQr/, /codigo/]) {
    assert.doesNotMatch(qrPageCode, forbidden);
  }
  assert.match(qrPageCode, /Este código QR ya no está disponible\./);
});

test('QrNoDisponiblePage.jsx: no importa ningún módulo legacy de QR/animales', () => {
  const imports = [...qrPageCode.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['react-router-dom']);
  assert.match(qrPageCode, /import '\.\.\/styles\/ganaderia-login\.css';/);
});

// ---------------------------------------------------------------------
// Navegación autenticada
// ---------------------------------------------------------------------

test('GanaderiaApp.jsx: no importa ni monta páginas legacy de animales/QR/potreros', () => {
  for (const legacy of [
    'QrEntryPage',
    'AnimalesListPage',
    'AnimalFichaBasica',
    'AnimalPesajesTab',
    'AnimalVacunacionesTab',
    'AnimalTratamientosTab',
    'AnimalReproduccionTab',
    'AnimalGeneticaTab',
    'PotrerosPage',
    'ganaderiaApi',
  ]) {
    assert.doesNotMatch(ganaderiaAppCode, new RegExp(`\\b${legacy}\\b`), `GanaderiaApp.jsx no debe referenciar ${legacy}`);
  }
  assert.doesNotMatch(ganaderiaAppCode, /isPublicQr|\/qr\//);
});

test('GanaderiaApp.jsx: las rutas legacy redirigen (nunca vuelven a montar las páginas)', () => {
  assert.match(ganaderiaAppCode, /<Route path="potreros" element=\{<Navigate to="\/ganaderia\/predios" replace \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="animales\/\*" element=\{<Navigate to="\/ganaderia\/animales" replace \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="escanear-qr" element=\{<Navigate to="\/ganaderia\/animales" replace \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="animal\/\*" element=\{<Navigate to="\/ganaderia\/animales" replace \/>\} \/>/);
  // SPRINT-3D11.2: /ganaderia/animales ya no es un placeholder: monta el
  // módulo nuevo (hato/), nunca una página legacy.
  assert.match(ganaderiaAppCode, /<Route path="animales" element=\{<HatoListaPage \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="predios" element=\{<PrediosPage \/>\} \/>/);
});

test('GanaderiaSidebar.jsx y GanaderiaDashboard.jsx: sin enlaces a flujos legacy muertos', () => {
  for (const [name, code] of [['GanaderiaSidebar.jsx', sidebarCode], ['GanaderiaDashboard.jsx', dashboardCode]]) {
    for (const link of DEAD_LEGACY_LINKS) {
      assert.ok(!code.includes(link), `${name} no debe enlazar ${link}`);
    }
  }
});

test('GanaderiaSidebar.jsx: sin entradas legacy de animales/QR/potreros; "Mis animales" va a /ganaderia/animales', () => {
  const navItems = sidebarCode.match(/const navItems = \[[\s\S]*?\];/)?.[0] ?? '';
  assert.ok(navItems);
  for (const label of [
    'Registro de Potreros',
    'Registro de Animales',
    'Escanear QR',
    'Ficha Animal',
    'Pesajes',
    'Vacunaciones',
    'Tratamientos',
    'Reproducción',
    'Genética',
  ]) {
    assert.ok(!navItems.includes(`'${label}'`), `el sidebar no debe incluir ${label}`);
  }
  assert.match(navItems, /\{ label: 'Mis animales', icon: Beef, to: '\/ganaderia\/animales' \}/);
});

test('GanaderiaDashboard.jsx: sin tarjetas legacy ni promesa de QR', () => {
  for (const label of ['Escanear QR', 'Ficha Animal', 'Registro de Animales', 'Módulos por animal seleccionado']) {
    assert.ok(!dashboardCode.includes(label), `el dashboard no debe incluir ${label}`);
  }
  assert.doesNotMatch(dashboardCode, /\bQR\b/);
});

// ---------------------------------------------------------------------
// Ganadería Demo
// ---------------------------------------------------------------------

test('Demo: /ganaderia/demo sigue montada sobre GanaderiaDemo, sin guard', () => {
  assert.match(appCode, /<Route path="\/ganaderia\/demo" element=\{<GanaderiaDemo \/>\} \/>/);
});

test('Demo: GanaderiaDemo.jsx no recibe código de contención ni APIs reales', () => {
  for (const forbidden of [/SECURITY-LEGACY/, /QrNoDisponiblePage/, /ganaderiaApi/, /ganaderiaAuthedRequest/]) {
    assert.doesNotMatch(demoSource, forbidden);
  }
});

test('Demo: los Functions estáticos de Cloudflare siguen presentes (fuera de alcance)', () => {
  for (const file of ['functions/api/animales/[id].js', 'functions/api/qr/[codigo].js', 'functions/_data/agxStatic.js']) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${file} debe seguir existiendo`);
  }
});
