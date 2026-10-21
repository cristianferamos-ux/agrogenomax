// FASE 1C.2: invariantes de arquitectura del reporte productivo PDF.
//   - solo Business (animalesRepository + pesajesService); nunca legacy
//     (server/db.js, DATABASE_URL), vistas (v_pesajes_evolucion), Demo ni
//     Supabase;
//   - organización EXCLUSIVAMENTE desde la sesión (req.ganaderiaAuth);
//   - montado en server/index.js antes del router de animales;
//   - pdfkit en el servidor (sin strings %PDF manuales) y alertas con la
//     copia del engine canónico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ARCHIVOS = [
  'services/ganaderia/reporteProductivo/reporteProductivoModelo.js',
  'services/ganaderia/reporteProductivo/reporteProductivoPdf.js',
  'services/ganaderia/reporteProductivo/reporteProductivoService.js',
  'routes/ganaderiaAnimalReporte.js',
];

test('solo fuentes Business: sin legacy, vistas, Demo ni Supabase', () => {
  for (const rel of ARCHIVOS) {
    const code = strip(read(rel));
    assert.doesNotMatch(code, /from ['"][^'"]*\/db\.js['"]|DATABASE_URL|v_pesajes|vista|supabase|demo|ganaderiaApi/i, rel);
    assert.doesNotMatch(code, /\bselect\b[\s\S]{0,80}\bfrom\b/i, `${rel}: sin SQL propio (usa repositorios Business)`);
  }
  const service = strip(read(ARCHIVOS[2]));
  assert.match(service, /from '\.\.\/animalesRepository\.js'/);
  assert.match(service, /from '\.\.\/pesajesService\.js'/);
});

test('organización solo desde la sesión; nunca de query/body/headers', () => {
  const ruta = strip(read(ARCHIVOS[3]));
  assert.match(ruta, /router\.use\(createRequireGanaderiaSession\(\{ appEnv \}\)\)/);
  assert.match(ruta, /req\.ganaderiaAuth\.organizacionId/);
  assert.doesNotMatch(ruta, /req\.(query|body|headers)\b[^\n]*organizaci/i);
  assert.doesNotMatch(ruta, /router\.(post|put|patch|delete)\(/, 'solo lectura');
});

test('montaje en server/index.js antes del router de animales', () => {
  const index = read('index.js');
  const reporte = index.indexOf("'/api/ganaderia/animales/:animalId/reporte-productivo.pdf'");
  const animales = index.indexOf("'/api/ganaderia/animales',");
  assert.ok(reporte > 0, 'ruta montada');
  assert.ok(animales < 0 || reporte < animales, 'antes del router de animales');
});

test('PDF con pdfkit en servidor (sin %PDF manual) y alertas del engine compartido', () => {
  const pdf = strip(read(ARCHIVOS[1]));
  assert.match(pdf, /import PDFDocument from 'pdfkit'/);
  assert.doesNotMatch(pdf, /%PDF/);
  const modelo = strip(read(ARCHIVOS[0]));
  assert.match(modelo, /from '\.\.\/engine\/alertasPesajes\.js'/);
  assert.match(modelo, /resolveFechaHoraNegocio|resolveFechaHoyNegocio/);
  assert.doesNotMatch(modelo, /new Date\(\)\.(getHours|getDate|getFullYear)|toLocaleDateString\(/, 'sin zona horaria implícita del servidor');
});

test('ningún archivo del reporte importa fuera de server/', () => {
  for (const rel of ARCHIVOS) {
    const imports = [...read(rel).matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((s) => s.startsWith('.'));
    for (const spec of imports) {
      const destino = path.resolve(path.dirname(path.join(SERVER, rel)), spec);
      assert.ok(destino.startsWith(SERVER + path.sep), `${rel} importa ${spec} fuera de server/`);
    }
  }
});
