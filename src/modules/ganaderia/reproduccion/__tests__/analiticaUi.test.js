// FASE 4D: analítica reproductiva (UI). Modelo puro + invariantes por fuente
// (no hay jsdom en el repo), como el resto de pruebas de ganadería.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ETIQUETAS_CALIDAD,
  MENSAJE_CARGA_ANALITICA,
  TEXTO_DATOS_INSUFICIENTES,
  estadoAnalitica,
  gruposCalidad,
  queryAnalitica,
  tarjetasMetricas,
  textoIndicador,
  textoPeriodo,
  textoPoblacion,
  textoUmbralesCalidad,
} from '../analiticaModel.js';
import { cargarVigente, crearSecuencia } from '../tableroModel.js';
import { MENSAJE_SIN_CONEXION } from '../../api/errorModel.js';
import {
  CONFIGURACION_CALIDAD_REPRODUCCION,
  MUESTRA_MINIMA_ANALITICA,
  agregarMetricas,
} from '../../../../../server/services/ganaderia/reproduccionAnalitica.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..');
const GAN = path.resolve(DIR, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const leer = (...p) => strip(fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'));
const pagina = leer(DIR, 'ReproduccionAnaliticaPage.jsx');
const modelo = leer(DIR, 'analiticaModel.js');
const app = leer(GAN, 'GanaderiaApp.jsx');
const tablero = leer(DIR, 'ReproduccionTableroPage.jsx');
const api = fs.readFileSync(path.join(GAN, 'hato', 'hatoApi.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(GAN, 'styles', 'ganaderia-hato.css'), 'utf8').replace(/\r\n/g, '\n');

const HOY = '2026-11-02';
const METRICAS = agregarMetricas([], { desde: '2025-11-03', hasta: HOY, hoy: HOY }).metricas;
const buscar = (tarjetas, id) => tarjetas.find((t) => t.id === id);

test('sin datos: cada indicador dice "Datos insuficientes", con conteos en cero', () => {
  const tarjetas = tarjetasMetricas(METRICAS);
  for (const id of ['M2', 'M3', 'M4', 'M5', 'M7', 'M8', 'M9', 'M10-S', 'M10-P', 'M12', 'M13']) {
    assert.equal(buscar(tarjetas, id).valor, TEXTO_DATOS_INSUFICIENTES, id);
  }
  assert.equal(buscar(tarjetas, 'M1').valor, '0'); // conteo, sin mínimo de muestra
});

test('títulos aprobados; M6 y M11 no aparecen', () => {
  const tarjetas = tarjetasMetricas(METRICAS);
  assert.equal(buscar(tarjetas, 'M2').titulo, 'Concepción por servicio evaluable');
  assert.equal(buscar(tarjetas, 'M3').titulo, 'Concepción al primer servicio evaluable');
  assert.equal(buscar(tarjetas, 'M4').titulo, 'Servicios evaluables por concepción');
  assert.equal(buscar(tarjetas, 'M12').titulo, 'Pérdida posterior a preñez confirmada');
  assert.equal(buscar(tarjetas, 'M6'), undefined);
  assert.equal(buscar(tarjetas, 'M11'), undefined);
  assert.doesNotMatch(modelo, /[Tt]asa de aborto|Preñez del hato/);
});

test('M2-M4 muestran siempre concepciones, no concepciones, pendientes, no atribuibles y n evaluable', () => {
  for (const id of ['M2', 'M3', 'M4']) {
    const etiquetas = buscar(tarjetasMetricas(METRICAS), id).datos.map(([label]) => label);
    for (const requerida of ['Concepciones', 'No concepciones', 'Pendientes', 'No atribuibles', 'Monta libre', 'n evaluable']) {
      assert.ok(etiquetas.includes(requerida), `${id}: ${requerida}`);
    }
  }
  const m3 = buscar(tarjetasMetricas(METRICAS), 'M3').datos.map(([label]) => label);
  assert.ok(m3.includes('Inicio desconocido'));
});

test('M12 muestra pérdidas, gestaciones resueltas evaluables y cobertura', () => {
  const m12 = buscar(tarjetasMetricas(METRICAS), 'M12');
  const etiquetas = m12.datos.map(([label]) => label);
  assert.ok(etiquetas.includes('Pérdidas'));
  assert.ok(etiquetas.includes('Gestaciones resueltas evaluables'));
  assert.equal(m12.cobertura, 'Sin casos');
});

test('indicador: nunca presenta un valor con muestra insuficiente; decimales con coma', () => {
  assert.equal(textoIndicador({ estado: 'OK', valor: 42.5 }, ' %'), '42,5 %');
  assert.equal(textoIndicador({ estado: 'OK', valor: 0 }, ' %'), '0 %');
  assert.equal(textoIndicador({ estado: 'DATOS_INSUFICIENTES', valor: 42.5 }, ' %'), TEXTO_DATOS_INSUFICIENTES);
  assert.equal(textoIndicador({ estado: 'NO_CALCULABLE', valor: null }), 'No calculable');
  assert.equal(textoIndicador(undefined), TEXTO_DATOS_INSUFICIENTES);
});

test('M14: todos los códigos del backend tienen etiqueta; un código nuevo no sale crudo ni se oculta', () => {
  const grupos = gruposCalidad(METRICAS);
  assert.equal(grupos.length, METRICAS.M14.length);
  for (const grupo of METRICAS.M14) {
    for (const item of grupo.items) assert.ok(ETIQUETAS_CALIDAD[item.codigo], item.codigo);
  }
  const [nuevo] = gruposCalidad({ M14: [{ metrica: 'X', items: [{ codigo: 'CODIGO_NUEVO', conteo: 3 }] }] });
  assert.equal(nuevo.items[0].etiqueta, 'Otro motivo');
  assert.equal(nuevo.items[0].conteo, 3);
});

test('query: sin vacíos y sin organización del cliente', () => {
  assert.deepEqual(queryAnalitica({}), {});
  assert.deepEqual(queryAnalitica({ predioId: '7', desde: '2026-01-01', hasta: '' }), { predioId: '7', desde: '2026-01-01' });
  assert.doesNotMatch(pagina + modelo, /organizacion/i);
});

test('estado: datos, error funcional y excepción con mensajes seguros', () => {
  const data = { metricas: METRICAS };
  assert.deepEqual(estadoAnalitica({ ok: true, valor: { ok: true, data } }), { status: 'ok', data, mensaje: null });
  const fallo = estadoAnalitica({ ok: true, valor: { ok: false, status: 500, data: { error: 'SELECT secreto' } } });
  assert.equal(fallo.status, 'error');
  assert.doesNotMatch(fallo.mensaje, /SELECT/);
  assert.equal(estadoAnalitica({ ok: true, valor: { ok: true, status: 200, data: {} } }).mensaje, MENSAJE_CARGA_ANALITICA);
  assert.equal(estadoAnalitica({ ok: false, error: new TypeError('Failed to fetch') }).mensaje, MENSAJE_SIN_CONEXION);
});

test('textos: periodo, población y umbrales como calidad de datos, no regla clínica', () => {
  assert.match(textoPeriodo({ desde: '2025-11-03', hasta: HOY }), /ambos inclusive/);
  assert.match(textoPoblacion({ hembrasConEventos: 5, enHato: 3, salidas: 1, muertas: 1 }), /5 hembras.*anulados no cuentan/);
  const umbrales = textoUmbralesCalidad(CONFIGURACION_CALIDAD_REPRODUCCION, MUESTRA_MINIMA_ANALITICA);
  assert.match(umbrales, /17 días/);
  assert.match(umbrales, /no reglas clínicas/);
  assert.equal(textoUmbralesCalidad(null), null);
});

test('response-race: una respuesta vieja, también si falla, no pisa la vigente', async () => {
  const secuencia = crearSecuencia();
  const aplicados = [];
  let resolverVieja;
  let rechazarOtra;
  const vieja = cargarVigente(secuencia, () => new Promise((r) => { resolverVieja = r; }), (x) => aplicados.push(['vieja', x.ok]));
  const otra = cargarVigente(secuencia, () => new Promise((_, rej) => { rechazarOtra = rej; }), (x) => aplicados.push(['otra', x.ok]));
  const nueva = cargarVigente(secuencia, async () => 'ok', (x) => aplicados.push(['nueva', x.ok]));
  assert.equal(await nueva, true);
  resolverVieja('tarde');
  rechazarOtra(new Error('tarde'));
  assert.equal(await vieja, false);
  assert.equal(await otra, false);
  assert.deepEqual(aplicados, [['nueva', true]]);
});

test('página: una secuencia desde el inicio, sin mutaciones, con M14 y reintento', () => {
  assert.match(pagina, /crearSecuencia\(\)/);
  assert.match(pagina, /cargarVigente\(/);
  assert.doesNotMatch(pagina, /setEstado\(await|\.then\(.*setEstado/);
  assert.doesNotMatch(pagina, /postJsonWithCsrf|method:/);
  assert.match(pagina, /gruposCalidad\(data\?\.metricas\)/);
  assert.match(pagina, /Calidad y exclusiones/);
  assert.match(pagina, /Reintentar/);
  assert.match(pagina, /aria-busy/);
  assert.match(pagina, /aria-live="polite"/);
  assert.match(pagina, /Predio actual/);
  assert.match(pagina, /href="#analitica-calidad-titulo"/);
});

test('ruta, enlace desde el tablero y GET con sesión', () => {
  assert.match(app, /path="reproduccion\/analitica" element=\{<ReproduccionAnaliticaPage \/>\}/);
  assert.match(tablero, /to="\/ganaderia\/reproduccion\/analitica"/);
  assert.match(api, /export function getAnaliticaReproductiva[\s\S]{0,300}getJsonWithSession\(`\$\{BASE\}\/reproduccion\/analitica/);
});

test('responsive: sin anchos fijos que desborden; M14 al lado solo en escritorio', () => {
  const bloque = css.slice(css.indexOf('FASE 4D'));
  assert.match(bloque, /minmax\(min\(17rem, 100%\), 1fr\)/);
  assert.match(bloque, /min-height: 44px/);
  assert.match(bloque, /overflow-wrap: anywhere/);
  assert.match(bloque, /@media \(min-width: 1100px\)[\s\S]*minmax\(0, 1fr\) 20rem/);
});
