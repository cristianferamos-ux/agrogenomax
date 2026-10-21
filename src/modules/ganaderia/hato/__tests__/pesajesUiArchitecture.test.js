// FASE 1B: invariantes de la UI de pesajes en la ficha del animal (no hay
// jsdom/testing-library en el repo: se verifican por fuente, como el resto de
// pruebas de arquitectura de hato/).
//   - solo API Business de Fase 1A vía hatoApi (nunca legacy);
//   - pestañas Resumen | Pesajes accesibles;
//   - clientOperationId oculto, estable por intención, sin reintento automático;
//   - sin doble envío; refresco tras guardar sin recargar la página;
//   - gráfica Recharts en diferido con eje X temporal real;
//   - sin "nacimiento", sin umbrales de GMD; Demo, CatastroX y DB intactos.
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

const src = (name) => stripComments(read(path.join(HATO_DIR, name)));
const PESAJES_FILES = [
  'HatoPesajesPanel.jsx', 'HatoPesajeForm.jsx', 'HatoPesajesHistorial.jsx', 'HatoPesajesKpis.jsx', 'HatoPesajesGrafica.jsx', 'pesajesModel.js',
];
const panel = src('HatoPesajesPanel.jsx');
const formulario = src('HatoPesajeForm.jsx');
const historial = src('HatoPesajesHistorial.jsx');
const kpis = src('HatoPesajesKpis.jsx');
const grafica = src('HatoPesajesGrafica.jsx');
const modelo = src('pesajesModel.js');
const api = src('hatoApi.js');
const detalle = src('HatoDetallePage.jsx');
const css = read(path.join(GANADERIA_DIR, 'styles', 'ganaderia-hato.css'));

test('existen los componentes y el modelo de pesajes', () => {
  for (const name of PESAJES_FILES) assert.ok(fs.existsSync(path.join(HATO_DIR, name)), `falta hato/${name}`);
});

test('pesajes: solo la API Business de Fase 1A vía hatoApi; nunca legacy ni fetch directo', () => {
  assert.match(api, /export function listPesajes\(animalId\) \{\s*return getJsonWithSession\(`\$\{BASE\}\/animales\/\$\{encodeURIComponent\(animalId\)\}\/pesajes`\)/);
  assert.match(api, /export function registrarPesaje\(animalId, body\) \{\s*return postJsonWithCsrf\(`\$\{BASE\}\/animales\/\$\{encodeURIComponent\(animalId\)\}\/pesajes`, body\)/);
  for (const name of PESAJES_FILES) {
    const code = src(name);
    assert.doesNotMatch(code, /ganaderiaApi|\/api\/pesajes|\/api\/animales/, name);
    assert.doesNotMatch(code, /from ['"]\.\.\/(animales|qr|pages|catastrox)\//, name);
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|axios/, `${name} no hace red directa`);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB/, `${name} no persiste en el navegador`);
  }
  assert.match(panel, /import \{ listPesajes, registrarPesaje \} from '\.\/hatoApi\.js'/);
});

test('pesajes: organizacionId nunca sale del frontend (lo resuelve la sesión)', () => {
  for (const name of PESAJES_FILES) assert.doesNotMatch(src(name), /organizacion_?id/i, name);
});

test('ficha: pestañas Resumen | Pesajes accesibles (tablist, aria-selected, aria-controls, teclado)', () => {
  assert.match(detalle, /import HatoPesajesPanel from '\.\/HatoPesajesPanel\.jsx'/);
  assert.match(detalle, /\{ id: 'resumen', label: 'Resumen' \}/);
  assert.match(detalle, /\{ id: 'pesajes', label: 'Pesajes' \}/);
  assert.match(detalle, /role="tablist"/);
  assert.match(detalle, /role="tab"/);
  assert.match(detalle, /aria-selected=/);
  assert.match(detalle, /aria-controls=\{`ficha-panel-\$\{/);
  assert.match(detalle, /role="tabpanel"/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.match(detalle, new RegExp(`\\b${key}:`));
  assert.match(detalle, /useState\('resumen'\)/);
});

test('ficha: tras registrar un pesaje refresca la ficha en silencio (sin recargar la página)', () => {
  assert.match(detalle, /onPesajeRegistrado=\{\(\) => load\(\{ silencioso: true \}\)\}/);
  assert.match(detalle, /animalActivo=\{[^}]*'ACTIVO'/);
  for (const name of [...PESAJES_FILES, 'HatoDetallePage.jsx']) {
    assert.doesNotMatch(src(name), /location\.reload|window\.location\s*=/, name);
  }
});

test('panel: clientOperationId oculto, estable por intención, renovado solo tras éxito o reuso', () => {
  assert.match(panel, /const operationIdRef = useRef\(newClientOperationId\(\)\)/);
  assert.match(panel, /buildPesajeBody\(form, operationIdRef\.current\)/);
  const renovaciones = panel.match(/operationIdRef\.current = newClientOperationId\(\)/g) ?? [];
  assert.equal(renovaciones.length, 3, 'inicial-si-falta, tras éxito y tras CLIENT_OPERATION_ID_REUSED');
  assert.match(panel, /if \(resultado\.exito\) \{\s*operationIdRef\.current = newClientOperationId\(\)/);
  assert.match(panel, /resultado\.tipo === 'OPERACION_REUSADA'\) \{\s*operationIdRef\.current = newClientOperationId\(\)/);
  assert.doesNotMatch(formulario, /clientOperationId|operationId/, 'el formulario no muestra el id');
});

test('panel: sin doble envío ni reintento automático del POST', () => {
  assert.match(panel, /if \(savingRef\.current\) return;/);
  assert.match(panel, /savingRef\.current = true;\s*setSaving\(true\)/);
  assert.match(panel, /finally \{\s*savingRef\.current = false;\s*setSaving\(false\)/);
  assert.equal((panel.match(/registrarPesaje\(/g) ?? []).length, 1, 'un único POST por envío');
  assert.doesNotMatch(panel, /setTimeout|setInterval|retry/i);
  assert.match(formulario, /disabled=\{saving\}/);
  assert.match(formulario, /'Guardando pesaje\.\.\.'/);
});

test('panel: refresca historial y KPIs tras guardar; valida antes de enviar', () => {
  assert.match(panel, /setMensaje\(\{ type: 'success', text: resultado\.mensaje \}\);\s*await cargar\(\);\s*onPesajeRegistrado\?\.\(\)/);
  assert.match(panel, /validatePesajeForm\(form, \{ hoy: fechaNegocio \}\)/);
  assert.ok(panel.indexOf('validatePesajeForm(') < panel.indexOf('registrarPesaje('), 'validación antes del POST');
  assert.match(panel, /setForm\(initialPesajeForm\(fechaNegocio\)\)/);
});

test('panel: estado vacío, anulado, sin conexión y error de carga', () => {
  assert.match(panel, /No hay pesajes registrados\./);
  assert.match(panel, /Registrar primer pesaje/);
  assert.match(panel, /getElementById\('pesaje-peso'\)\?\.focus\(\)/);
  assert.match(panel, /Este animal está anulado y no admite nuevos pesajes\./);
  assert.match(panel, /const admitePesajes = animalActivo && !anuladoEnServidor/);
  assert.match(panel, /\{admitePesajes && online \? \(\s*<HatoPesajeForm/);
  assert.match(panel, /\{pesajes\.length \? <HatoPesajesHistorial/, 'historial visible también si está anulado');
  assert.match(panel, /Reintentar/);
  assert.match(panel, /aria-live="polite"/);
});

test('formulario: labels reales, errores asociados por aria, límites del backend', () => {
  for (const campo of ['fecha', 'peso', 'metodo', 'observaciones']) assert.match(formulario, new RegExp(`htmlFor="pesaje-${campo}"`));
  for (const campo of ['fecha', 'pesoKg', 'metodo', 'observaciones']) {
    assert.match(formulario, new RegExp(`aria-describedby=\\{describedBy\\('${campo}'\\)\\}`));
    assert.match(formulario, new RegExp(`campoError\\('pesaje-${campo}-error'`));
  }
  assert.match(formulario, /aria-invalid=/);
  assert.match(formulario, /role="alert"/);
  assert.match(formulario, /max=\{hoy\}/);
  assert.match(formulario, /inputMode="decimal"/);
  assert.match(formulario, /step="0\.1"/);
  assert.match(formulario, /maxLength=\{MAX_OBSERVACIONES_PESAJE\}/);
  assert.match(modelo, /MAX_PESO_KG = 2000/);
  assert.match(modelo, /MAX_OBSERVACIONES_PESAJE = 500/);
});

test('historial y KPIs: tabla con encabezados, etiquetas móviles y lista de definiciones', () => {
  assert.match(historial, /historialParaVista\(pesajes\)/);
  assert.match(historial, /<caption>Historial de pesajes \(más reciente primero\)<\/caption>/);
  assert.equal((historial.match(/<th scope="col">/g) ?? []).length, 7);
  assert.equal((historial.match(/data-label="/g) ?? []).length, 7);
  assert.match(kpis, /<dl className="gan-pesajes-kpis" aria-label="Indicadores de peso">/);
});

test('gráfica: Recharts en diferido, eje X temporal real, tooltip, alternativa accesible', () => {
  assert.match(panel, /const HatoPesajesGrafica = lazy\(\(\) => import\('\.\/HatoPesajesGrafica\.jsx'\)\)/);
  assert.match(panel, /<Suspense/);
  for (const name of PESAJES_FILES.filter((n) => n !== 'HatoPesajesGrafica.jsx')) {
    assert.doesNotMatch(src(name), /from 'recharts'/, `${name} no debe cargar recharts en el bundle principal`);
  }
  assert.match(grafica, /from 'recharts'/);
  assert.match(grafica, /<ResponsiveContainer width="100%"/);
  const ejes = grafica.match(/<XAxis [^>]*>/g) ?? [];
  assert.ok(ejes.length >= 1);
  for (const eje of ejes) {
    assert.match(eje, /dataKey="t"/);
    assert.match(eje, /type="number"/);
    assert.match(eje, /scale="time"/);
  }
  assert.doesNotMatch(grafica, /type="category"|dataKey="fecha"/, 'nunca eje categórico por fecha');
  assert.match(grafica, /<Tooltip content=\{<TooltipPeso \/>\}/);
  assert.match(grafica, /formatMetodo\(p\.metodo\)/);
  assert.match(grafica, /role="img" aria-label=/);
  assert.match(grafica, /isAnimationActive=\{false\}/);
});

test('gráfica de GMD: solo si hay períodos con GMD; referencia en 0; sin umbrales', () => {
  assert.match(grafica, /\{gmd\.length \? \(/);
  assert.match(grafica, /<ReferenceLine y=\{0\}/);
  assert.equal((grafica.match(/<ReferenceLine/g) ?? []).length, 1, 'una única línea de referencia (cero)');
  for (const name of PESAJES_FILES) {
    assert.doesNotMatch(src(name), /Excelente|Aceptable|Cr[ií]tico|umbral|threshold/i, name);
  }
});

test('ningún texto de pesajes habla de "nacimiento"', () => {
  for (const name of PESAJES_FILES) assert.doesNotMatch(src(name), /nacimiento|al nacer/i, name);
});

test('CSS móvil: pestañas propias (no la regla legacy), grids que encogen, tabla como tarjetas, inputs ≥ 16px', () => {
  assert.match(detalle, /className="gan-hato-tabs"/);
  assert.doesNotMatch(detalle, /gan-ficha-tabs/);
  assert.match(css, /\.gan-pesajes > \*,\n\.gan-pesajes-graficas \{\n  min-width: 0;/);
  assert.match(css, /content: attr\(data-label\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /font-size: 1rem/);
});

test('Demo, legacy, CatastroX y DB no reciben código de pesajes de Fase 1B', () => {
  const demo = read(path.join(GANADERIA_DIR, 'pages', 'GanaderiaDemo.jsx'));
  assert.doesNotMatch(demo, /HatoPesajes|pesajesModel/);
  const catastroxDir = path.join(REPO_ROOT, 'src', 'modules', 'catastrox');
  const pendientes = [catastroxDir];
  while (pendientes.length) {
    const dir = pendientes.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pendientes.push(full);
      else if (/\.(js|jsx|mjs)$/.test(entry.name)) assert.doesNotMatch(read(full), /HatoPesajes|pesajesModel/, full);
    }
  }
  for (const name of PESAJES_FILES) assert.doesNotMatch(src(name), /server\/db|DATABASE_URL|catastrox/i, name);
});
