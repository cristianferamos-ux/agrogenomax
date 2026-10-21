// FASE 1D.2: invariantes de arquitectura de la línea de tiempo derivada.
//   - sin tabla/migración nueva; solo SELECT (no escribe);
//   - fuentes canónicas: animal_eventos + animal_pesajes (+ animal);
//     agx.qr_chapeta_eventos NO se lee (deduplicación);
//   - sin legacy (server/db.js, DATABASE_URL), Demo ni vistas;
//   - derivaciones de pesajes con el motor canónico;
//   - organización solo desde la sesión; montaje antes del router de animales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(SERVER, '..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ARCHIVOS = [
  'services/ganaderia/timeline/timelineModelo.js',
  'services/ganaderia/timeline/timelineRepository.js',
  'services/ganaderia/timeline/timelineService.js',
  'routes/ganaderiaAnimalTimeline.js',
];

test('sin tabla ni migración de timeline', () => {
  const migraciones = fs.readdirSync(path.join(REPO, 'db', 'agx-business', 'migrations'));
  assert.ok(!migraciones.some((m) => /timeline/i.test(m)));
  for (const m of migraciones.filter((x) => x.endsWith('.sql'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'db', 'agx-business', 'migrations', m), 'utf8'), /create\s+table[^;(]*timeline/i, m);
  }
});

test('solo lectura: ningún INSERT/UPDATE/DELETE en el código de la línea de tiempo', () => {
  for (const rel of ARCHIVOS) assert.doesNotMatch(strip(read(rel)), /\b(insert\s+into|update\s+agx|delete\s+from)\b/i, rel);
  const ruta = strip(read(ARCHIVOS[3]));
  assert.doesNotMatch(ruta, /router\.(post|put|patch|delete)\(/);
});

test('fuentes canónicas: animal_eventos + animal_pesajes; qr_chapeta_eventos excluida', () => {
  const repo = strip(read(ARCHIVOS[1]));
  assert.match(repo, /from agx\.animal_eventos/);
  assert.match(repo, /listPesajesEnTx\(client, animalId\)/);
  assert.match(repo, /fetchAnimal\(client, animalId\)/);
  assert.doesNotMatch(repo, /qr_chapeta_eventos|qr_chapeta_tokens|token_hash|qr_lote/);
  assert.match(repo, /withOrganizacionTransaction\(organizacionId/);
  const service = strip(read(ARCHIVOS[2]));
  assert.match(service, /construirHistorialPesajes\(/, 'mismo motor de GMD que Pesajes y el PDF');
});

test('sin legacy, Demo, vistas ni pdf', () => {
  for (const rel of ARCHIVOS) {
    assert.doesNotMatch(strip(read(rel)), /from ['"][^'"]*\/db\.js['"]|DATABASE_URL|v_pesajes|supabase|demo|pdfkit|reporteProductivo/i, rel);
  }
});

test('modelo puro: sin base de datos, sin reloj, sin JSX', () => {
  const modelo = strip(read(ARCHIVOS[0]));
  assert.doesNotMatch(modelo, /Date\.now|new Date\(\)|agxBusinessPool|client\.query|from 'react'/);
});

test('organización solo desde la sesión; montado antes del router de animales', () => {
  const ruta = strip(read(ARCHIVOS[3]));
  assert.match(ruta, /router\.use\(createRequireGanaderiaSession\(\{ appEnv \}\)\)/);
  assert.match(ruta, /req\.ganaderiaAuth\.organizacionId/);
  assert.doesNotMatch(ruta, /req\.(body|headers)\b[^\n]*organizaci/i);
  const index = read('index.js');
  const t = index.indexOf("'/api/ganaderia/animales/:animalId/timeline'");
  const a = index.indexOf("'/api/ganaderia/animales',");
  assert.ok(t > 0 && (a < 0 || t < a));
});

test('el reporte PDF NO depende de la línea de tiempo', () => {
  for (const rel of ['services/ganaderia/reporteProductivo/reporteProductivoService.js', 'services/ganaderia/reporteProductivo/reporteProductivoModelo.js']) {
    assert.doesNotMatch(read(rel), /timeline/i, rel);
  }
});
