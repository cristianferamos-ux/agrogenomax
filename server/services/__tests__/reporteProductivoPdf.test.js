// FASE 1C.2: PDF del reporte productivo (pdfkit). Sin snapshots binarios:
// se valida la estructura y se EXTRAE el texto (PDF sin compresión: cada
// operador TJ trae el texto en hex WinAnsi), sin OCR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { construirHistorialPesajes } from '../ganaderia/pesajesService.js';
import { ALERTAS_ANULADO, NOTA_UMBRALES, construirReporteProductivo } from '../ganaderia/reporteProductivo/reporteProductivoModelo.js';
import { LOGO_PATH, escalaTemporal, generarPdfReporteProductivo } from '../ganaderia/reporteProductivo/reporteProductivoPdf.js';

const AHORA = new Date('2026-10-21T02:00:00Z');
let seq = 0;
const p = (fecha, pesoKg, extra = {}) => ({ pesajeId: String(++seq), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: `${fecha}T12:00:00Z`, ...extra });
const animal = (extra = {}) => ({
  animalId: '7', predioNombre: 'Finca QA', numeroVisual: 'AGX-000007', nombre: 'Lucero', sexo: 'HEMBRA',
  razaTipo: 'PURA', razaPrincipalNombre: 'Brahman', categoriaProductivaNombre: 'Novilla de levante',
  estado: 'ACTIVO', estadoMotivo: null, fechaCreacion: new Date('2026-01-10T15:00:00Z'), ...extra,
});
const modelo = (filas, a = animal()) => construirReporteProductivo({ animal: a, historial: construirHistorialPesajes({ animalId: a.animalId, pesajes: filas }), ahora: AHORA });
const pdf = (m, opciones = {}) => generarPdfReporteProductivo(m, { ahora: AHORA, compress: false, ...opciones });

const WINANSI = new TextDecoder('windows-1252');

/** Texto por página, en el orden de /Kids: solo los streams /Contents de cada página. */
function textoPorPagina(buffer) {
  const s = buffer.toString('latin1');
  const objeto = (n) => {
    const i = s.indexOf(`\n${n} 0 obj`);
    return s.slice(i, s.indexOf('endobj', i));
  };
  const kids = s.match(/\/Type \/Pages[\s\S]*?\/Kids \[([^\]]*)\]/)[1].match(/\d+ 0 R/g).map((r) => r.split(' ')[0]);
  return kids.map((k) => {
    const contenido = objeto(objeto(k).match(/\/Contents (\d+) 0 R/)[1]);
    const stream = contenido.slice(contenido.indexOf('stream') + 6, contenido.lastIndexOf('endstream'));
    return [...stream.matchAll(/\[(.*?)\] TJ/g)]
      .map((m) => [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => WINANSI.decode(Buffer.from(h[1], 'hex'))).join(''))
      .join('\n');
  });
}
const paginas = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

function muchos(n) {
  const filas = [];
  let peso = 180;
  const d0 = Date.UTC(2025, 0, 5);
  for (let i = 0; i < n; i++) {
    peso += i % 7 === 3 ? -4.5 : 3.2;
    const fecha = new Date(d0 + (i * 9 + (i % 4) * 5) * 86400000).toISOString().slice(0, 10);
    filas.push(p(fecha, Number(peso.toFixed(1)), { observaciones: i % 5 === 0 ? `Control ${i}: condición corporal y suplementación con sal mineralizada en potrero ${i % 3 + 1}.` : null }));
  }
  return filas;
}

test('PDF válido: cabecera %PDF, fin %%EOF, tamaño razonable, metadatos', async () => {
  const b = await pdf(modelo([p('2026-10-19', 350), p('2026-10-20', 355)]));
  assert.equal(b.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(b.subarray(-8).toString('latin1'), /%%EOF\s*$/);
  assert.ok(b.length > 60_000, `con logo debe superar 60 KB (fue ${b.length})`);
  const s = b.toString('latin1');
  assert.match(s, /\/Title \d+ 0 R/);
  assert.match(s, /\/Author \d+ 0 R/);
  assert.match(s, /\/CreationDate \d+ 0 R/);
  assert.match(s, /\/MediaBox \[0 0 612 792\]/, 'tamaño CARTA');
});

test('secciones y contenido principal en el texto del PDF', async () => {
  const texto = textoPorPagina(await pdf(modelo([p('2026-10-19', 350, { observaciones: 'QA FASE1A PESAJE' }), p('2026-10-20', 355)]))).join('\n');
  for (const t of [
    'Reporte productivo individual', 'AgroGenomaX — Ganadería Inteligente', 'Generado el 20/10/2026 a las 21:00 (hora de Colombia)',
    'IDENTIFICACIÓN', 'RESUMEN PRODUCTIVO', 'HISTORIAL DE PESAJES (ORDEN CRONOLÓGICO)', 'EVOLUCIÓN DE PESO', 'GMD POR PERÍODO', 'ALERTAS ACTIVAS',
    'AGX-000007', 'Lucero', 'Hembra', 'Novilla de levante', 'Brahman', 'Finca QA', '10/01/2026',
    'PRIMER PESO REGISTRADO', '350 kg (19/10/2026)', '+5 kg', '+5 kg/día', 'QA FASE1A PESAJE',
    'Peso (kg)', 'Diferencia (kg)', 'GMD (kg/día)', 'No hay alertas de pesaje activas.', `Nota: ${NOTA_UMBRALES}`,
  ]) {
    assert.ok(texto.includes(t), `falta en el PDF: ${t}`);
  }
  assert.doesNotMatch(texto, /nacimiento|al nacer/i);
  assert.doesNotMatch(texto, /excelente|bueno|malo|cr[ií]tico/i);
});

test('0 pesajes: una página, "No hay pesajes registrados." y alerta INFO', async () => {
  const b = await pdf(modelo([]));
  assert.equal(paginas(b), 1);
  const texto = textoPorPagina(b).join('\n');
  assert.ok(texto.includes('No hay pesajes registrados.'));
  assert.ok(texto.includes('INFO'));
  assert.ok(texto.includes('Este animal aún no tiene pesajes registrados.'));
  assert.ok(!texto.includes('GMD POR PERÍODO'), 'sin períodos calculables no hay sección GMD');
});

test('1 pesaje: sin tendencia inventada ni sección GMD', async () => {
  const texto = textoPorPagina(await pdf(modelo([p('2026-10-19', 350)]))).join('\n');
  assert.ok(texto.includes('Un solo pesaje: no hay tendencia que mostrar.'));
  assert.ok(!texto.includes('GMD POR PERÍODO'));
});

test('GMD negativa y período del mismo día', async () => {
  const texto = textoPorPagina(await pdf(modelo([p('2026-06-01', 320), p('2026-07-01', 330), p('2026-08-06', 300), p('2026-08-06', 301)]))).join('\n');
  assert.ok(texto.includes('-0,83'));
  assert.ok(texto.includes('-30'));
  assert.ok(texto.includes('URGENTE'));
  assert.ok(texto.includes('Han pasado 75 días desde el último pesaje.'));
});

test('animal anulado: el reporte se genera y lo indica', async () => {
  const texto = textoPorPagina(await pdf(modelo([p('2026-03-01', 290)], animal({ estado: 'ANULADO', estadoMotivo: 'Registro duplicado' })))).join('\n');
  assert.ok(texto.includes('Anulado'));
  assert.ok(texto.includes('Registro duplicado'));
  assert.ok(texto.includes(ALERTAS_ANULADO));
});

test('muchos pesajes: paginación con encabezado de tabla repetido, encabezado y pie en todas las páginas', async () => {
  const filas = muchos(46);
  const b = await pdf(modelo(filas));
  const n = paginas(b);
  assert.ok(n >= 3, `esperaba varias páginas, hubo ${n}`);
  const porPagina = textoPorPagina(b);
  assert.equal(porPagina.length, n);
  porPagina.forEach((t, i) => {
    assert.ok(t.includes(`Página ${i + 1} de ${n}`), `pie de la página ${i + 1}`);
    assert.ok(t.includes('Reporte productivo individual'), `encabezado de la página ${i + 1}`);
  });
  const conEncabezadoTabla = porPagina.filter((t) => t.includes('Peso (kg)')).length;
  assert.ok(conEncabezadoTabla >= 2, 'la tabla de historial repite su encabezado al paginar');
  const todo = porPagina.join('\n');
  for (const f of filas) {
    const [y, m, d] = f.fecha.split('-');
    assert.ok(todo.includes(`${d}/${m}/${y}`), `fila ${f.fecha} presente`);
  }
});

test('el logo se incrusta una sola vez aunque haya varias páginas', async () => {
  const b = await pdf(modelo(muchos(46)));
  assert.equal((b.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length, 1);
  assert.ok(fs.existsSync(LOGO_PATH), 'asset de marca en server/assets/branding');
});

test('sin logo disponible el reporte sigue siendo válido', async () => {
  const b = await pdf(modelo([]), { logoPath: '/no/existe.jpeg' });
  assert.equal(b.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal((b.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length, 0);
});

test('determinístico: mismo modelo e instante -> mismos bytes', async () => {
  const m = modelo([p('2026-10-19', 350), p('2026-10-20', 355)]);
  const a = await pdf(m);
  const b = await pdf(m);
  assert.ok(a.equals(b));
});

test('eje X temporal proporcional a los días reales', () => {
  const X = escalaTemporal([0, 30, 100], 0, 1000);
  assert.equal(X(0), 0);
  assert.equal(X(30), 300);
  assert.equal(X(100), 1000);
  const uno = escalaTemporal([50], 0, 600);
  assert.equal(uno(50), 300, 'un único día queda centrado (±3 días)');
});

test('compresión activada por defecto (producción)', async () => {
  const b = await generarPdfReporteProductivo(modelo([p('2026-10-19', 350)]), { ahora: AHORA });
  assert.match(b.toString('latin1'), /\/Filter \/FlateDecode/);
});
