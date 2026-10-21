// FASE 1C.2: contenido del reporte productivo individual (modelo PURO), con
// el historial derivado REAL (construirHistorialPesajes, motor canónico) y un
// instante de generación inyectado. No depende de bytes PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirHistorialPesajes } from '../ganaderia/pesajesService.js';
import {
  ALERTAS_ANULADO,
  NOTA_UMBRALES,
  SIN_ALERTAS,
  SIN_DATO,
  SIN_PESAJES,
  construirReporteProductivo,
  formatDiferenciaKg,
  formatGmd,
  nombreArchivoReporte,
  parteArchivo,
  textoPdf,
} from '../ganaderia/reporteProductivo/reporteProductivoModelo.js';

const AHORA = new Date('2026-10-21T02:00:00Z'); // 20/10/2026 21:00 en Bogotá (UTC ya es 21)
let seq = 0;
const p = (fecha, pesoKg, extra = {}) => ({ pesajeId: String(++seq), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: `${fecha}T12:00:00Z`, ...extra });
const animal = (extra = {}) => ({
  animalId: '7', predioNombre: 'Finca QA', numeroVisual: 'AGX-000007', nombre: 'Lucero', sexo: 'HEMBRA',
  razaTipo: 'PURA', razaPrincipalNombre: 'Brahman', razaOtroNombre: null, cruceDescripcion: null,
  categoriaProductivaNombre: 'Novilla de levante', estado: 'ACTIVO', estadoMotivo: null,
  fechaCreacion: new Date('2026-01-11T03:00:00Z'), // 10/01/2026 22:00 en Bogotá
  ...extra,
});
const reporte = (filas, a = animal(), ahora = AHORA) => construirReporteProductivo({
  animal: a, historial: construirHistorialPesajes({ animalId: a.animalId, pesajes: filas }), ahora,
});
const valor = (lista, etiqueta) => lista.find((x) => x.etiqueta === etiqueta)?.valor;

test('encabezado: título, subtítulo y fecha/hora de generación en America/Bogota', () => {
  const r = reporte([]);
  assert.equal(r.titulo, 'Reporte productivo individual');
  assert.equal(r.subtitulo, 'AgroGenomaX — Ganadería Inteligente');
  assert.deepEqual({ fecha: r.generado.fecha, hora: r.generado.hora, zona: r.generado.zonaHoraria }, { fecha: '2026-10-20', hora: '21:00', zona: 'America/Bogota' });
  assert.equal(r.generado.texto, 'Generado el 20/10/2026 a las 21:00 (hora de Colombia)');
});

test('identificación: solo campos existentes; fecha de registro en fecha de negocio', () => {
  const completa = reporte([]).identificacion.map((x) => `${x.etiqueta}=${x.valor}`);
  assert.deepEqual(completa, [
    'Número de identificación=AGX-000007', 'Nombre=Lucero', 'Sexo=Hembra', 'Estado=Activo',
    'Categoría productiva=Novilla de levante', 'Raza=Brahman', 'Predio=Finca QA', 'Fecha de registro=10/01/2026',
  ]);
  const minima = reporte([], animal({ nombre: null, categoriaProductivaNombre: null, predioNombre: null, razaTipo: 'DESCONOCIDA', razaPrincipalNombre: null }));
  const etiquetas = minima.identificacion.map((x) => x.etiqueta);
  assert.deepEqual(etiquetas, ['Número de identificación', 'Sexo', 'Estado', 'Raza', 'Fecha de registro']);
  assert.equal(valor(minima.identificacion, 'Raza'), 'No conocida');
  assert.ok(!minima.identificacion.some((x) => x.valor === SIN_DATO), 'no se rellena con "Sin dato" en masa');
  assert.equal(valor(reporte([], animal({ razaTipo: 'CRUCE', cruceDescripcion: 'Brahman x Holstein' })).identificacion, 'Raza'), 'Cruce: Brahman x Holstein');
});

test('animal anulado: estado y motivo; alertas no evaluadas', () => {
  const r = reporte([p('2026-03-01', 290)], animal({ estado: 'ANULADO', estadoMotivo: 'Registro duplicado' }));
  assert.equal(valor(r.identificacion, 'Estado'), 'Anulado');
  assert.equal(valor(r.identificacion, 'Motivo de anulación'), 'Registro duplicado');
  assert.equal(r.animal.anulado, true);
  assert.deepEqual(r.alertas.lista, []);
  assert.equal(r.alertas.vacio, ALERTAS_ANULADO);
});

test('0 pesajes: resumen "Sin dato", sin gráficas, historial vacío, alerta INFO', () => {
  const r = reporte([]);
  assert.equal(valor(r.resumen, 'Pesajes registrados'), '0');
  for (const e of ['Último peso', 'Fecha del último peso', 'Peso anterior', 'Diferencia', 'Días entre los últimos pesajes', 'GMD (ganancia media diaria)', 'Primer peso registrado', 'Ganancia acumulada']) {
    assert.equal(valor(r.resumen, e), SIN_DATO, e);
  }
  assert.equal(r.graficaPeso, null);
  assert.equal(r.gmd, null);
  assert.deepEqual(r.historial.filas, []);
  assert.equal(r.historial.vacio, SIN_PESAJES);
  assert.deepEqual(r.alertas.lista.map((a) => `${a.etiqueta}: ${a.mensaje}`), ['INFO: Este animal aún no tiene pesajes registrados.']);
});

test('1 pesaje: último peso y primer peso registrado; sin tendencia ni GMD', () => {
  const r = reporte([p('2026-10-19', 350, { observaciones: 'QA FASE1A PESAJE' })]);
  assert.equal(valor(r.resumen, 'Último peso'), '350 kg (báscula)');
  assert.equal(valor(r.resumen, 'Fecha del último peso'), '19/10/2026');
  assert.equal(valor(r.resumen, 'Primer peso registrado'), '350 kg (19/10/2026)');
  assert.equal(valor(r.resumen, 'Ganancia acumulada'), SIN_DATO);
  assert.equal(valor(r.resumen, 'GMD (ganancia media diaria)'), SIN_DATO);
  assert.equal(r.graficaPeso.puntos.length, 1);
  assert.equal(r.graficaPeso.conLinea, false, 'un punto no inventa tendencia');
  assert.equal(r.gmd, null);
  assert.deepEqual(r.historial.filas, [['19/10/2026', '350', 'Báscula', '—', '—', '—', 'QA FASE1A PESAJE']]);
});

test('2 pesajes (QA producción): +5 kg en 1 día, GMD +5 kg/día; sin alertas', () => {
  const r = reporte([p('2026-10-19', 350), p('2026-10-20', 355)]);
  assert.equal(valor(r.resumen, 'Último peso'), '355 kg (báscula)');
  assert.equal(valor(r.resumen, 'Peso anterior'), '350 kg');
  assert.equal(valor(r.resumen, 'Diferencia'), '+5 kg');
  assert.equal(valor(r.resumen, 'Días entre los últimos pesajes'), '1 día');
  assert.equal(valor(r.resumen, 'GMD (ganancia media diaria)'), '+5 kg/día');
  assert.equal(valor(r.resumen, 'Ganancia acumulada'), '+5 kg en 1 día');
  assert.equal(r.graficaPeso.conLinea, true);
  assert.deepEqual(r.gmd.filas, [['19/10/2026', '20/10/2026', '1', '+5', '+5']]);
  assert.deepEqual(r.alertas.lista, []);
  assert.equal(r.alertas.vacio, SIN_ALERTAS);
});

test('historial en orden cronológico ASCENDENTE con unidades en las columnas', () => {
  const r = reporte([p('2026-02-09', 265), p('2026-01-10', 240), p('2026-04-20', 301.5, { metodo: 'ESTIMADO' })]);
  assert.equal(r.historial.orden, 'ASCENDENTE');
  assert.deepEqual(r.historial.columnas, ['Fecha', 'Peso (kg)', 'Método', 'Diferencia (kg)', 'Días', 'GMD (kg/día)', 'Observaciones']);
  assert.deepEqual(r.historial.filas.map((f) => f[0]), ['10/01/2026', '09/02/2026', '20/04/2026']);
  assert.deepEqual(r.historial.filas[2], ['20/04/2026', '301,5', 'Estimado', '+36,5', '70', '+0,52', '—']);
});

test('GMD positiva, negativa y nula el mismo día (sin inventar valor)', () => {
  const r = reporte([p('2026-06-01', 320), p('2026-07-01', 330), p('2026-08-06', 300), p('2026-08-06', 301)]);
  assert.deepEqual(r.gmd.filas, [
    ['01/06/2026', '01/07/2026', '30', '+10', '+0,33'],
    ['01/07/2026', '06/08/2026', '36', '-30', '-0,83'],
  ], 'el período de 0 días no tiene GMD');
  assert.equal(r.historial.filas[3][5], '—', 'GMD del mismo día: sin dato');
  assert.equal(valor(r.resumen, 'GMD (ganancia media diaria)'), SIN_DATO);
  assert.equal(valor(r.resumen, 'Días entre los últimos pesajes'), '0 días');
  assert.equal(r.gmd.conLinea, true);
});

test('gráfica de peso: eje X en días calendario reales (proporcional)', () => {
  const r = reporte([p('2026-01-10', 240), p('2026-02-09', 265), p('2026-04-20', 301.5)]);
  const dias = r.graficaPeso.puntos.map((x) => x.dia);
  assert.equal(dias[1] - dias[0], 30);
  assert.equal(dias[2] - dias[1], 70);
});

test('alertas: mismas reglas que la UI con fecha de referencia de negocio (Bogotá)', () => {
  // UTC ya es 21/10 (61 días -> URGENTE); en Bogotá es 20/10: 60 días -> ATENCIÓN.
  const r = reporte([p('2026-08-21', 300)]);
  assert.deepEqual(r.alertas.lista.map((a) => [a.etiqueta, a.mensaje, a.detalle]), [
    ['ATENCIÓN', 'Han pasado 60 días desde el último pesaje.', 'Último pesaje: 21/08/2026. Fecha de referencia: 20/10/2026.'],
  ]);
  const urgente = reporte([p('2026-07-20', 320), p('2026-08-06', 300)]);
  assert.deepEqual(urgente.alertas.lista.map((a) => a.etiqueta), ['URGENTE', 'ATENCIÓN']);
  assert.equal(urgente.alertas.lista[1].mensaje, 'Se registró una pérdida de 20 kg desde el pesaje anterior.');
  assert.equal(urgente.alertas.lista[1].detalle, 'De 320 kg a 300 kg en 17 días; GMD -1,18 kg/día.');
  assert.equal(r.alertas.nota, NOTA_UMBRALES);
  assert.match(NOTA_UMBRALES, /provisionales y no constituyen recomendación veterinaria/);
});

test('nunca "peso al nacimiento" ni umbrales productivos de GMD', () => {
  const texto = JSON.stringify(reporte([p('2026-01-10', 240), p('2026-02-09', 230), p('2026-04-20', 301.5)]));
  assert.doesNotMatch(texto, /nacimiento|al nacer/i);
  assert.doesNotMatch(texto, /excelente|bueno|malo|cr[ií]tico/i);
});

test('formatos: signo ASCII, GMD con máximo 2 decimales, es-CO', () => {
  assert.equal(formatDiferenciaKg(-5.6), '-5,6 kg');
  assert.equal(formatDiferenciaKg(1250.25), '+1.250,3 kg');
  assert.equal(formatGmd(-0.0777778), '-0,08 kg/día');
  assert.equal(formatGmd(0), '0 kg/día');
  assert.equal(formatGmd(null), SIN_DATO);
});

test('texto apto para WinAnsi: sin signo menos Unicode ni emojis', () => {
  assert.equal(textoPdf('−5 kg'), '-5 kg');
  assert.equal(textoPdf('Sequía 🌵 dura'), 'Sequía ? dura');
  assert.equal(textoPdf('línea 1\nlínea 2'), 'línea 1 línea 2');
  assert.equal(textoPdf('Ñandú — “ok” • €'), 'Ñandú — “ok” • €');
  const r = reporte([p('2026-10-19', 350, { observaciones: 'Báscula 🐄 nueva' })]);
  assert.equal(r.historial.filas[0][6], 'Báscula ? nueva');
});

test('nombre de archivo seguro: AgroGenomaX_Reporte_Productivo_<código>_<fecha Bogotá>.pdf', () => {
  assert.equal(reporte([]).nombreArchivo, 'AgroGenomaX_Reporte_Productivo_AGX-000007_2026-10-20.pdf');
  assert.equal(nombreArchivoReporte({ animalId: '9', numeroVisual: 'AGX/2025 #46 ñandú' }, '2026-10-20'), 'AgroGenomaX_Reporte_Productivo_AGX-2025-46-nandu_2026-10-20.pdf');
  assert.equal(nombreArchivoReporte({ animalId: '9', numeroVisual: null, nombre: 'Lucero "la" ../../x' }, '2026-10-20'), 'AgroGenomaX_Reporte_Productivo_Lucero-la-x_2026-10-20.pdf');
  assert.equal(nombreArchivoReporte({ animalId: '9', numeroVisual: '///', nombre: '' }, '2026-10-20'), 'AgroGenomaX_Reporte_Productivo_animal-9_2026-10-20.pdf');
  assert.match(parteArchivo('x'.repeat(90)), /^x{40}$/);
  for (const n of [reporte([]).nombreArchivo, nombreArchivoReporte({ animalId: '1', numeroVisual: '"\r\n;=' }, '2026-10-20')]) {
    assert.match(n, /^[A-Za-z0-9_.-]+$/, 'sin comillas, CR/LF ni separadores: seguro en Content-Disposition');
  }
});

test('modelo puro: requiere animal e historial; sin estado del reloj si se inyecta `ahora`', () => {
  assert.throws(() => construirReporteProductivo({ animal: null, historial: {} }), TypeError);
  const a = reporte([p('2026-10-19', 350)]);
  const b = reporte([p('2026-10-19', 350)]);
  assert.deepEqual({ ...a, historial: null }, { ...b, historial: null });
});
