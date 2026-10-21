// FASE 1C.1: invariantes del bloque "Alertas" de la pestaña Pesajes (por
// fuente, como el resto de pruebas de arquitectura de hato/: no hay jsdom).
//   - alertas DERIVADAS en cada render, con la fecha de negocio `hoy`;
//   - sin persistencia, sin red propia, sin backend nuevo ni tablas;
//   - severidad en texto (no solo color), estados INFO/ATENCION/URGENTE/vacío;
//   - umbrales centralizados, no en componentes; sin legacy; CatastroX intacto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ETIQUETAS_SEVERIDAD, construirAlertasPesajes } from '../pesajesAlertas.js';

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
const componente = src('HatoPesajesAlertas.jsx');
// FASE 1C.2: la fuente canónica de las reglas pasó a shared/ (la comparte el
// reporte PDF del backend); hato/pesajesAlertas.js solo la reexporta.
const MODELO_CANONICO = path.join(REPO_ROOT, 'shared', 'ganaderia', 'engine', 'alertasPesajes.js');
const modelo = stripComments(read(MODELO_CANONICO));
const panel = src('HatoPesajesPanel.jsx');
const css = read(path.join(GANADERIA_DIR, 'styles', 'ganaderia-hato.css'));
const ARCHIVOS = ['HatoPesajesAlertas.jsx', 'pesajesAlertas.js'];

test('16. UI sin alertas: "No hay alertas de pesaje activas."', () => {
  assert.match(componente, /alertas\.length \? \(/);
  assert.match(componente, /No hay alertas de pesaje activas\./);
});

test('17-19. UI con INFO, ATENCIÓN y URGENTE: severidad textual, mensaje y dato de origen', () => {
  assert.match(componente, /\{ETIQUETAS_SEVERIDAD\[alerta\.severidad\]\}/);
  assert.match(componente, /\{alerta\.mensaje\}/);
  assert.match(componente, /detalleAlerta\(alerta\)/);
  assert.match(componente, /data-severidad=\{alerta\.severidad\}/);
  assert.deepEqual({ ...ETIQUETAS_SEVERIDAD }, { URGENTE: 'URGENTE', ATENCION: 'ATENCIÓN', INFO: 'INFO' });
  for (const sev of ['URGENTE', 'ATENCION', 'INFO']) {
    assert.match(css, new RegExp(`\\.gan-pesajes-alerta\\[data-severidad="${sev}"\\]`), `estilo ${sev}`);
  }
  // Los tres estados se producen con datos reales del modelo.
  const ref = '2026-10-20';
  assert.equal(construirAlertasPesajes({ pesajes: [], fechaReferencia: ref })[0].severidad, 'INFO');
  const p = (fecha, pesoKg) => ({ fecha, pesoKg });
  assert.equal(construirAlertasPesajes({ pesajes: [p('2026-09-05', 300)], fechaReferencia: ref })[0].severidad, 'ATENCION');
  assert.equal(construirAlertasPesajes({ pesajes: [p('2026-08-06', 300)], fechaReferencia: ref })[0].severidad, 'URGENTE');
});

test('20. accesibilidad: sección con encabezado propio, lista semántica, sin role=alert intrusivo', () => {
  assert.match(componente, /<section className="gan-pesajes-alertas" aria-labelledby="pesajes-alertas-titulo">/);
  assert.match(componente, /<h4 id="pesajes-alertas-titulo">Alertas<\/h4>/);
  assert.match(componente, /<ul>/);
  assert.match(componente, /<li key=\{alerta\.codigo\}/);
  assert.doesNotMatch(componente, /role="alert"|aria-live/, 'derivadas en cada carga: no deben anunciarse como urgencia');
  assert.match(css, /border-left-width: 4px;/, 'refuerzo visual además del texto');
});

test('21. responsive: el bloque no fija anchos y parte palabras largas', () => {
  const bloque = css.slice(css.indexOf('.gan-pesajes-alertas {'), css.indexOf('.gan-pesaje-form-grid {'));
  assert.doesNotMatch(bloque, /^\s*(min-|max-)?width:\s*\d+px/m);
  assert.match(bloque, /overflow-wrap: anywhere;/);
  assert.match(css, /\.gan-pesajes > \*,\n\.gan-pesajes-graficas \{\n  min-width: 0;/);
});

test('cosmético: caption del historial como bloque en tarjetas móviles', () => {
  const movil = css.slice(css.indexOf('@media (max-width: 640px) {\n  .gan-pesajes-kpis'));
  assert.match(movil, /\.gan-pesajes-historial caption \{\n    display: block;\n    width: 100%;\n  \}/);
});

test('panel: alertas derivadas en render con fecha de negocio (America/Bogota); solo animales activos', () => {
  assert.match(panel, /import HatoPesajesAlertas from '\.\/HatoPesajesAlertas\.jsx'/);
  assert.match(panel, /import \{ construirAlertasPesajes \} from '\.\/pesajesAlertas\.js'/);
  assert.match(panel, /\{admitePesajes \? \(\s*<HatoPesajesAlertas\s*alertas=\{construirAlertasPesajes\(\{ pesajes, resumen: state\.data\.resumen, fechaReferencia: fechaNegocio \}\)\}/);
  // Fecha de NEGOCIO (America/Bogota), no la fecha local del navegador.
  assert.match(panel, /import \{ fechaHoyNegocio \} from '\.\.\/engine\/fechaNegocio\.js'/);
  assert.match(panel, /const fechaNegocio = fechaHoyNegocio\(\);/);
  assert.doesNotMatch(panel, /fechaReferencia: hoy\b/);
  assert.doesNotMatch(panel, /useState\([^)]*alerta/i, 'las alertas no son estado: se derivan');
});

test('umbrales centralizados en el modelo; nunca en componentes', () => {
  assert.match(modelo, /diasAtencion: 30,\n  diasUrgente: 60,/);
  assert.match(read(MODELO_CANONICO), /UMBRALES PROVISIONALES CONFIGURABLES/);
  assert.match(read(MODELO_CANONICO), /No son una recomendación veterinaria/);
  assert.match(src('pesajesAlertas.js'), /^\s*export \* from '\.\.\/engine\/alertasPesajes\.js';\s*$/, 'hato/ solo reexporta la fuente canónica');
  for (const name of ['HatoPesajesAlertas.jsx', 'HatoPesajesPanel.jsx']) {
    assert.doesNotMatch(src(name), /diasAtencion|diasUrgente|\b(30|60)\b/, `${name} no fija umbrales`);
  }
  assert.match(modelo, /from '\.\/pesajes\.js'/, 'reutiliza clasificarAntiguedadPesaje del engine canónico');
});

test('modelo puro: sin React, sin red, sin reloj', () => {
  assert.doesNotMatch(modelo, /from 'react'|<[A-Z]\w*|fetch\(|XMLHttpRequest|Date\.now|new Date\(/);
});

test('22. sin legacy', () => {
  for (const name of ARCHIVOS) {
    const code = src(name);
    assert.doesNotMatch(code, /ganaderiaApi|\/api\/(animales|pesajes|alertas)/, name);
    assert.doesNotMatch(code, /from ['"]\.\.\/(animales|qr|pages|catastrox)\//, name);
    assert.doesNotMatch(code, /engine\/demo|pesajesDemo|Excelente|Aceptable|Cr[ií]tico/, name);
  }
});

test('23. sin persistencia: ni almacenamiento del navegador ni API de alertas', () => {
  for (const name of [...ARCHIVOS, 'hatoApi.js', 'HatoPesajesPanel.jsx']) {
    const code = src(name);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB/, name);
    assert.doesNotMatch(code, /\/api\/[^'"`]*alert|registrarAlerta|guardarAlerta|postJsonWithCsrf\([^)]*alert/i, name);
  }
});

function listar(dir, filtro) {
  const out = [];
  const pendientes = [dir];
  while (pendientes.length) {
    const actual = pendientes.pop();
    for (const entry of fs.readdirSync(actual, { withFileTypes: true })) {
      const full = path.join(actual, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') pendientes.push(full);
      } else if (filtro.test(entry.name)) out.push(full);
    }
  }
  return out;
}

test('24. backend/DB sin alertas persistidas: ni tabla, ni migración, ni ruta de alertas de pesaje', () => {
  for (const file of listar(path.join(REPO_ROOT, 'db', 'agx-business'), /\.sql$/)) {
    assert.doesNotMatch(read(file), /create\s+table[^;(]*alerta/i, file);
  }
  for (const file of listar(path.join(REPO_ROOT, 'server', 'routes'), /\.js$/).filter((f) => !f.includes('__tests__'))) {
    assert.doesNotMatch(stripComments(read(file)), /['"`]\/[^'"`]*alertas?[^'"`]*['"`]/i, file);
  }
  for (const name of ARCHIVOS) assert.doesNotMatch(src(name), /server\/|shared\/|db\//, `${name} no importa backend`);
});

test('25. CatastroX, QR, offline y Demo no reciben las alertas de pesaje', () => {
  const patron = /HatoPesajesAlertas|pesajesAlertas|construirAlertasPesajes/;
  const dirs = ['catastrox', 'ganaderia/qr', 'ganaderia/offline', 'ganaderia/animales'].map((d) => path.join(REPO_ROOT, 'src', 'modules', ...d.split('/')));
  for (const dir of dirs) {
    for (const file of listar(dir, /\.(js|jsx|mjs)$/)) assert.doesNotMatch(read(file), patron, file);
  }
  assert.doesNotMatch(read(path.join(GANADERIA_DIR, 'pages', 'GanaderiaDemo.jsx')), patron);
});
