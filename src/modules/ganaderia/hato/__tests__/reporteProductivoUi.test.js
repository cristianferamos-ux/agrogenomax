// FASE 1C.2: botón "Descargar reporte productivo" de la pestaña Pesajes.
//   - llamada real del cliente (descargarReporteProductivo) con fetch simulado:
//     endpoint correcto, credenciales, nombre de archivo, errores;
//   - mensajes del modelo puro;
//   - invariantes por fuente (no hay jsdom en el repo): botón visible en la
//     cabecera, estado cargando, sin doble descarga, guardado del blob, sin
//     legacy y SIN construir el PDF en el navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { descargarReporteProductivo } from '../hatoApi.js';
import {
  AVISO_REPORTE_SIN_CONEXION,
  TEXTO_BOTON_REPORTE,
  TEXTO_BOTON_REPORTE_CARGANDO,
  mensajeErrorReporte,
} from '../reporteProductivoModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}
const src = (name) => stripComments(fs.readFileSync(path.join(HATO_DIR, name), 'utf8').replace(/\r\n/g, '\n'));
const boton = src('HatoReporteProductivoBoton.jsx');
const panel = src('HatoPesajesPanel.jsx');

async function conFetch(respuesta, fn) {
  const original = globalThis.fetch;
  const llamadas = [];
  globalThis.fetch = async (url, init) => {
    llamadas.push({ url, init });
    if (respuesta instanceof Error) throw respuesta;
    return respuesta;
  };
  try {
    return { resultado: await fn(), llamadas };
  } finally {
    globalThis.fetch = original;
  }
}

test('descarga: GET al endpoint Business correcto con credenciales; blob y nombre del servidor', async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const { resultado, llamadas } = await conFetch(new Response(pdf, {
    status: 200,
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="AgroGenomaX_Reporte_Productivo_AGX-1_2026-10-20.pdf"' },
  }), () => descargarReporteProductivo('12'));
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, '/api/ganaderia/animales/12/reporte-productivo.pdf');
  assert.equal(llamadas[0].init.credentials, 'include');
  assert.equal(llamadas[0].init.method ?? 'GET', 'GET');
  assert.equal(resultado.ok, true);
  assert.equal(resultado.filename, 'AgroGenomaX_Reporte_Productivo_AGX-1_2026-10-20.pdf');
  assert.equal((await resultado.blob.arrayBuffer()).byteLength, 5);
});

test('descarga: el id se codifica en la URL', async () => {
  const { llamadas } = await conFetch(new Response('{}', { status: 400 }), () => descargarReporteProductivo('1/../2'));
  assert.equal(llamadas[0].url, '/api/ganaderia/animales/1%2F..%2F2/reporte-productivo.pdf');
});

test('descarga: errores devuelven { ok:false, status, data }; la red caída lanza', async () => {
  const { resultado } = await conFetch(new Response(JSON.stringify({ error: 'ANIMAL_NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } }), () => descargarReporteProductivo('9'));
  assert.equal(resultado.ok, false);
  assert.equal(resultado.status, 404);
  assert.deepEqual(resultado.data, { error: 'ANIMAL_NOT_FOUND' });
  await assert.rejects(conFetch(new TypeError('Failed to fetch'), () => descargarReporteProductivo('9')));
});

test('mensajes amigables (sin detalles internos)', () => {
  assert.equal(TEXTO_BOTON_REPORTE, 'Descargar reporte productivo');
  assert.equal(TEXTO_BOTON_REPORTE_CARGANDO, 'Generando reporte...');
  assert.equal(AVISO_REPORTE_SIN_CONEXION, 'Descargar el reporte requiere conexión.');
  assert.match(mensajeErrorReporte(null), /conexión/);
  assert.match(mensajeErrorReporte({ status: 401 }), /sesión/);
  assert.match(mensajeErrorReporte({ status: 403 }), /sesión/);
  assert.equal(mensajeErrorReporte({ status: 404 }), 'Este animal no está disponible.');
  const generico = mensajeErrorReporte({ status: 500, data: { error: 'INTERNAL', message: 'select * from agx.animales' } });
  assert.doesNotMatch(generico, /select|agx|INTERNAL/);
});

test('botón visible en la cabecera de la pestaña Pesajes (también anulados y sin pesajes)', () => {
  assert.match(panel, /import HatoReporteProductivoBoton from '\.\/HatoReporteProductivoBoton\.jsx'/);
  assert.match(panel, /<div className="gan-pesajes-cabecera">\s*<h3 id="pesajes-titulo">Pesajes<\/h3>\s*<HatoReporteProductivoBoton animalId=\{animalId\} online=\{online\} \/>/);
  const cabecera = panel.slice(panel.indexOf('gan-pesajes-cabecera'), panel.indexOf('</div>', panel.indexOf('gan-pesajes-cabecera')));
  assert.doesNotMatch(cabecera, /admitePesajes|sinPesajes/, 'no depende del estado del animal ni de tener pesajes');
});

test('botón: cargando, sin doble descarga, deshabilitado sin conexión, error accesible', () => {
  assert.match(boton, /type="button"/);
  assert.match(boton, /\{descargando \? TEXTO_BOTON_REPORTE_CARGANDO : TEXTO_BOTON_REPORTE\}/);
  assert.match(boton, /disabled=\{descargando \|\| !online\}/);
  assert.match(boton, /aria-busy=\{descargando \? 'true' : undefined\}/);
  assert.match(boton, /if \(enCursoRef\.current\) return;/);
  assert.match(boton, /finally \{\s*enCursoRef\.current = false;\s*setDescargando\(false\)/);
  assert.match(boton, /aria-live="polite"/);
  assert.match(boton, /mensajeErrorReporte\(resultado\)/);
  assert.match(boton, /catch \{\s*setError\(mensajeErrorReporte\(null\)\)/);
  assert.equal((boton.match(/descargarReporteProductivo\(/g) ?? []).length, 1, 'una sola llamada por clic');
  assert.doesNotMatch(boton, /setTimeout\([^)]*descargar|retry|reintent/i, 'sin reintento automático');
});

test('descarga: guarda el blob recibido (object URL + atributo download) y lo libera', () => {
  assert.match(boton, /URL\.createObjectURL\(blob\)/);
  assert.match(boton, /enlace\.download = filename;/);
  assert.match(boton, /URL\.revokeObjectURL\(href\)/);
  assert.match(boton, /guardarArchivo\(resultado\.blob, resultado\.filename\)/);
});

test('el PDF NO se construye en el navegador y no se usa legacy', () => {
  const archivos = fs.readdirSync(HATO_DIR).filter((n) => /\.(js|jsx)$/.test(n));
  for (const name of archivos) {
    const code = src(name);
    assert.doesNotMatch(code, /from ['"](jspdf|pdfkit|pdf-lib|html2canvas|html2pdf)/, `${name}: sin librerías PDF en el navegador`);
    assert.doesNotMatch(code, /%PDF|application\/pdf['"]\s*\}/, `${name}: no arma bytes PDF`);
    assert.doesNotMatch(code, /productiveReportPdf|clinicalHistoryPdf|geneticReportPdf|demoPdf|ganaderiaApi/, `${name}: sin generadores ni cliente legacy`);
  }
  const api = src('hatoApi.js');
  assert.match(api, /getFileWithSession\(`\$\{BASE\}\/animales\/\$\{encodeURIComponent\(animalId\)\}\/reporte-productivo\.pdf`\)/);
});
