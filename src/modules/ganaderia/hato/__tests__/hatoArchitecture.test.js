// SPRINT-3D11.2: invariantes de arquitectura del módulo nuevo de animales
// (hato/) y de la contención legacy (3D11.SECURITY-LEGACY):
//   - el frontend nuevo solo habla con /api/ganaderia/*;
//   - nunca importa api/ganaderiaApi.js ni páginas legacy de animales/QR;
//   - clientOperationId solo con crypto.randomUUID, estable por intención,
//     sin storage, sin reintento automático del POST;
//   - el backend no vuelve a montar routers legacy;
//   - la Demo no recibe código del módulo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');
const REPO_ROOT = path.resolve(GANADERIA_DIR, '..', '..', '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const hatoFiles = fs.readdirSync(HATO_DIR).filter((name) => /\.(js|jsx)$/.test(name));
const hatoSources = Object.fromEntries(hatoFiles.map((name) => [name, stripComments(read(path.join(HATO_DIR, name)))]));
const registroCode = hatoSources['HatoRegistroPage.jsx'];
const apiCode = hatoSources['hatoApi.js'];
const modelCode = hatoSources['hatoFormModel.js'];
const indexCode = stripComments(read(path.join(REPO_ROOT, 'server', 'index.js')));
const ganaderiaAppCode = stripComments(read(path.join(GANADERIA_DIR, 'GanaderiaApp.jsx')));
const sidebarCode = stripComments(read(path.join(GANADERIA_DIR, 'components', 'GanaderiaSidebar.jsx')));
const demoSource = read(path.join(GANADERIA_DIR, 'pages', 'GanaderiaDemo.jsx'));

test('hato/ contiene las 3 páginas, el cliente y el modelo esperados', () => {
  for (const name of ['HatoListaPage.jsx', 'HatoRegistroPage.jsx', 'HatoDetallePage.jsx', 'hatoApi.js', 'hatoFormModel.js']) {
    assert.ok(hatoFiles.includes(name), `falta hato/${name}`);
  }
});

test('ningún archivo de hato/ importa el cliente legacy ni páginas legacy de animales/QR', () => {
  for (const [name, code] of Object.entries(hatoSources)) {
    assert.doesNotMatch(code, /ganaderiaApi/, `${name} no debe usar api/ganaderiaApi.js`);
    assert.doesNotMatch(code, /from ['"]\.\.\/(animales|qr)\//, `${name} no debe importar animales/ o qr/ legacy`);
    assert.doesNotMatch(code, /AnimalesListPage|AnimalFichaBasica|QrEntryPage|lookupQr/, name);
  }
});

test('hato/ solo llama a /api/ganaderia/* (nunca /api/animales, /api/qr, /api/razas, /api/pesajes...)', () => {
  for (const [name, code] of Object.entries(hatoSources)) {
    for (const legacy of ['/api/animales', '/api/qr', '/api/razas', '/api/pesajes', '/api/vacunaciones', '/api/tratamientos', '/api/reproduccion', '/api/predios', '/api/potreros']) {
      assert.ok(!code.includes(`'${legacy}`) && !code.includes(`\`${legacy}`), `${name} no debe llamar ${legacy}`);
    }
    assert.doesNotMatch(code, /\bfetch\(/, `${name}: las llamadas pasan por ganaderiaAuthedRequest`);
  }
  assert.match(apiCode, /const BASE = '\/api\/ganaderia';/);
  for (const endpoint of ['/animales', '/catalogo-razas', '/categorias-productivas', '/predios']) {
    assert.ok(apiCode.includes(`\${BASE}${endpoint}`), `hatoApi.js debe usar \${BASE}${endpoint}`);
  }
  assert.match(apiCode, /from '\.\.\/auth\/ganaderiaAuthedRequest\.js'/);
});

test('clientOperationId: solo crypto.randomUUID, sin Math.random/Date.now ni storage', () => {
  assert.match(modelCode, /globalThis\.crypto\?\.randomUUID\?\.\(\) \?\? null/);
  for (const [name, code] of Object.entries(hatoSources)) {
    assert.doesNotMatch(code, /Math\.random|localStorage|sessionStorage/, name);
  }
  assert.doesNotMatch(modelCode, /newClientOperationId[\s\S]{0,200}Date\.now/);
});

test('registro: UUID estable por intención -- se genera al abrir y en "Registrar otro"; se descarta al éxito/cancelar; nunca en el submit', () => {
  assert.match(registroCode, /const operationIdRef = useRef\(newClientOperationId\(\)\);/);
  const submit = registroCode.match(/async function handleSubmit[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
  assert.ok(submit, 'handleSubmit debe existir');
  assert.doesNotMatch(submit, /newClientOperationId\(/, 'el submit nunca genera un UUID nuevo');
  assert.match(submit, /if \(!operationIdRef\.current\) \{[\s\S]*?OPERATION_UNAVAILABLE_MESSAGE[\s\S]*?return;/);
  const registrarOtro = registroCode.match(/function registrarOtro\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(registrarOtro, /operationIdRef\.current = newClientOperationId\(\);/);
  assert.match(submit, /if \(ok && data\?\.animal\) \{[\s\S]*?operationIdRef\.current = null;/);
  const cancelar = registroCode.match(/function cancelar\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(cancelar, /operationIdRef\.current = null;/);
});

test('registro: sin reintento automático del POST -- una sola llamada a createAnimal, sin bucles ni timers', () => {
  assert.equal((registroCode.match(/createAnimal\(/g) || []).length, 1);
  assert.doesNotMatch(registroCode, /setTimeout|setInterval|while\s*\(|for\s*\(/);
  assert.match(registroCode, /NETWORK_UNCERTAIN_MESSAGE/);
});

test('registro: chapeta duplicada se informa en el campo; CLIENT_OPERATION_ID_REUSED bloquea y exige una intención nueva', () => {
  assert.match(registroCode, /ANIMAL_NUMERO_VISUAL_DUPLICADO'\) \{\s*setFieldError/);
  assert.match(registroCode, /CLIENT_OPERATION_ID_REUSED'\) \{[\s\S]*?setOperationReused\(true\)/);
});

test('registro/lista/detalle: el estado de carga siempre se libera (finally / estados terminales)', () => {
  assert.match(registroCode, /finally \{\s*setSaving\(false\);\s*\}/);
  assert.match(hatoSources['HatoDetallePage.jsx'], /finally \{\s*setSaving\(false\);\s*\}/);
  assert.match(hatoSources['HatoListaPage.jsx'], /setState\(\{ status: 'error', animales: \[\], total: 0 \}\)/);
  assert.match(hatoSources['useHatoCatalogos.js'], /status: 'error'/);
});

test('UI veraz: "Otra raza conocida" nunca se mapea a DESCONOCIDA; sin enums técnicos visibles', () => {
  assert.match(modelCode, /form\.razaModo === 'OTRA'\) \{\s*raza = \{ razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre:/);
  assert.match(modelCode, /\{ value: 'OTRA', label: 'Otra raza conocida' \}/);
  const fieldsCode = hatoSources['HatoAnimalFields.jsx'];
  for (const visibleEnum of ['>EXACTA<', '>APROXIMADA<', '>DESCONOCIDA<', '>BASCULA<', '>ESTIMADO<', '>PURA<', '>CRUCE<']) {
    assert.ok(!fieldsCode.includes(visibleEnum), `no debe mostrar ${visibleEnum}`);
  }
  assert.match(fieldsCode, /¿Conoce la edad del animal\?/);
  assert.match(fieldsCode, /¿Cómo obtuvo este peso\?/);
});

test('rutas: /ganaderia/animales, /animales/nuevo y /animales/:animalId montan el módulo nuevo; legacy redirige', () => {
  assert.match(ganaderiaAppCode, /<Route path="animales" element=\{<HatoListaPage \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="animales\/nuevo" element=\{<HatoRegistroPage \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="animales\/:animalId" element=\{<HatoDetallePage \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="animal\/\*" element=\{<Navigate to="\/ganaderia\/animales" replace \/>\} \/>/);
  assert.match(ganaderiaAppCode, /<Route path="escanear-qr" element=\{<Navigate to="\/ganaderia\/animales" replace \/>\} \/>/);
});

test('sidebar: "Mis animales" y "Registrar animal" apuntan al módulo nuevo', () => {
  assert.match(sidebarCode, /\{ label: 'Mis animales', icon: Beef, to: '\/ganaderia\/animales' \}/);
  assert.match(sidebarCode, /\{ label: 'Registrar animal', icon: ClipboardList, to: '\/ganaderia\/animales\/nuevo' \}/);
});

test('backend: 3D11.2 monta solo /api/ganaderia/animales y /api/ganaderia/catalogo-razas; ningún router legacy', () => {
  assert.ok(indexCode.includes("'/api/ganaderia/animales'"));
  assert.ok(indexCode.includes("'/api/ganaderia/catalogo-razas'"));
  for (const legacy of ['/api/animales', '/api/qr', '/api/razas', '/api/predios', '/api/potreros']) {
    assert.doesNotMatch(indexCode, new RegExp(`app\\.use\\(\\s*['"]${legacy.replace(/\//g, '\\/')}['"]`), legacy);
  }
  assert.doesNotMatch(indexCode, /from '\.\/routes\/(animales|qr|razas|pesajes|vacunaciones|tratamientos|reproduccion|predios|potreros)\.js'/);
});

test('Demo: GanaderiaDemo.jsx no usa el módulo hato ni la API real', () => {
  assert.doesNotMatch(demoSource, /hato\/|hatoApi|HatoListaPage|\/api\/ganaderia\/animales/);
});
