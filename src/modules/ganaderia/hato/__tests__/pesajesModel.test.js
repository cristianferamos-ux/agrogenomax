// FASE 1B: modelo puro de la UI de pesajes (validación del formulario,
// traducción de respuestas del POST, KPIs, historial y puntos de gráfica).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OBSERVACIONES_PESAJE,
  SIN_DATO,
  buildPesajeBody,
  dominioTemporal,
  fechaATiempo,
  formatDiferenciaKg,
  formatDias,
  formatFecha,
  formatGmd,
  formatKg,
  formatMetodo,
  historialParaVista,
  initialPesajeForm,
  kpisDePesajes,
  puntosGmd,
  puntosPeso,
  resultadoRegistro,
  tiempoAFecha,
  validatePesajeForm,
} from '../pesajesModel.js';
import { construirHistorialPesajes } from '../../../../../server/services/ganaderia/pesajesService.js';
import { validateCreatePesajeBody } from '../../../../../server/services/ganaderia/pesajeValidation.js';

const HOY = '2026-10-19';
const DIA = 86400000;
const form = (extra = {}) => ({ ...initialPesajeForm(HOY), pesoKg: '350', ...extra });
const kpi = (resumen, id) => kpisDePesajes(resumen).find((k) => k.id === id);

// Serie con la forma de la respuesta GET de Fase 1A (orden ascendente).
const SERIE = [
  { pesajeId: '1', fecha: '2026-01-10', pesoKg: 240, metodo: 'BASCULA', origen: 'REGISTRO_INICIAL', observaciones: null, diferenciaKg: null, diasDesdeAnterior: null, gmdKgDia: null },
  { pesajeId: '2', fecha: '2026-02-09', pesoKg: 265, metodo: 'BASCULA', origen: 'MANUAL', observaciones: 'Primer control', diferenciaKg: 25, diasDesdeAnterior: 30, gmdKgDia: 0.8333333 },
  { pesajeId: '3', fecha: '2026-04-20', pesoKg: 301.5, metodo: 'ESTIMADO', origen: 'MANUAL', observaciones: null, diferenciaKg: 36.5, diasDesdeAnterior: 70, gmdKgDia: 0.5214286 },
  { pesajeId: '4', fecha: '2026-04-20', pesoKg: 302, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, diferenciaKg: 0.5, diasDesdeAnterior: 0, gmdKgDia: null },
  { pesajeId: '5', fecha: '2026-07-01', pesoKg: 296.4, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, diferenciaKg: -5.6, diasDesdeAnterior: 72, gmdKgDia: -0.0777778 },
];

// --- Formulario ------------------------------------------------------------

test('formulario inicial: fecha de hoy, peso vacío, báscula, sin observaciones', () => {
  assert.deepEqual(initialPesajeForm(HOY), { fecha: HOY, pesoKg: '', metodo: 'BASCULA', observaciones: '' });
});

test('validación: peso válido con 0 o 1 decimal (coma o punto)', () => {
  for (const pesoKg of ['350', '350.5', '350,5', '0.1', '2000']) {
    assert.equal(validatePesajeForm(form({ pesoKg }), { hoy: HOY }).valido, true, pesoKg);
  }
});

test('validación: peso vacío, 0, negativo, no numérico -> error en pesoKg', () => {
  for (const pesoKg of ['', '0', '-5', 'abc', '1e3', ' ']) {
    const r = validatePesajeForm(form({ pesoKg }), { hoy: HOY });
    assert.equal(r.valido, false, pesoKg);
    assert.match(r.errores.pesoKg, /mayor que 0/);
  }
});

test('validación: peso > 2000 kg y más de un decimal', () => {
  assert.match(validatePesajeForm(form({ pesoKg: '2000.1' }), { hoy: HOY }).errores.pesoKg, /2000 kg/);
  assert.match(validatePesajeForm(form({ pesoKg: '350.25' }), { hoy: HOY }).errores.pesoKg, /un decimal/);
});

test('validación: fecha futura, inválida o anterior a 1990', () => {
  assert.match(validatePesajeForm(form({ fecha: '2026-10-20' }), { hoy: HOY }).errores.fecha, /futura/);
  assert.match(validatePesajeForm(form({ fecha: '2026-02-30' }), { hoy: HOY }).errores.fecha, /válida/);
  assert.match(validatePesajeForm(form({ fecha: '' }), { hoy: HOY }).errores.fecha, /válida/);
  assert.match(validatePesajeForm(form({ fecha: '1989-12-31' }), { hoy: HOY }).errores.fecha, /1990/);
  assert.equal(validatePesajeForm(form({ fecha: HOY }), { hoy: HOY }).valido, true);
});

test('validación: método desconocido y observaciones > 500', () => {
  assert.ok(validatePesajeForm(form({ metodo: 'OJO' }), { hoy: HOY }).errores.metodo);
  const largo = 'x'.repeat(MAX_OBSERVACIONES_PESAJE + 1);
  assert.match(validatePesajeForm(form({ observaciones: largo }), { hoy: HOY }).errores.observaciones, /500/);
  assert.equal(validatePesajeForm(form({ observaciones: 'x'.repeat(500) }), { hoy: HOY }).valido, true);
});

test('cuerpo del POST: peso numérico, observaciones recortadas u omitidas, clientOperationId', () => {
  const op = '0d470fc2-0541-4c09-b387-954ed63729cb';
  assert.deepEqual(buildPesajeBody(form({ pesoKg: '350,5', observaciones: '  ok  ' }), op), {
    fecha: HOY, pesoKg: 350.5, metodo: 'BASCULA', observaciones: 'ok', clientOperationId: op,
  });
  const sinObs = buildPesajeBody(form({ observaciones: '   ' }), op);
  assert.equal('observaciones' in sinObs, false);
  assert.equal('organizacionId' in sinObs, false);
});

// --- Respuestas del POST ----------------------------------------------------

test('POST 201 -> CREADO; 200 yaExistia -> YA_EXISTIA (ambos éxito)', () => {
  const creado = resultadoRegistro({ ok: true, status: 201, data: { ok: true, yaExistia: false, pesaje: { pesajeId: '9' } } });
  assert.equal(creado.tipo, 'CREADO');
  assert.equal(creado.exito, true);
  const ya = resultadoRegistro({ ok: true, status: 200, data: { ok: true, yaExistia: true, pesaje: { pesajeId: '9' } } });
  assert.equal(ya.tipo, 'YA_EXISTIA');
  assert.equal(ya.exito, true);
  assert.match(ya.mensaje, /no se duplicó/);
});

test('POST 400 por campo -> CAMPO con el campo correcto', () => {
  const casos = { INVALID_FECHA: 'fecha', INVALID_PESO: 'pesoKg', INVALID_METODO: 'metodo', INVALID_OBSERVACIONES: 'observaciones' };
  for (const [error, campo] of Object.entries(casos)) {
    const r = resultadoRegistro({ ok: false, status: 400, data: { error, message: 'm' } });
    assert.equal(r.tipo, 'CAMPO', error);
    assert.equal(r.campo, campo);
  }
  assert.equal(resultadoRegistro({ ok: false, status: 400, data: { error: 'INVALID_CLIENT_OPERATION_ID' } }).tipo, 'ERROR');
});

test('POST 409 ANIMAL_ANULADO y CLIENT_OPERATION_ID_REUSED', () => {
  assert.equal(resultadoRegistro({ ok: false, status: 409, data: { error: 'ANIMAL_ANULADO' } }).tipo, 'ANULADO');
  assert.equal(resultadoRegistro({ ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } }).tipo, 'OPERACION_REUSADA');
});

test('POST 401/403 -> SESION; 404 -> NO_ENCONTRADO', () => {
  assert.equal(resultadoRegistro({ ok: false, status: 401, data: { error: 'UNAUTHENTICATED' } }).tipo, 'SESION');
  assert.equal(resultadoRegistro({ ok: false, status: 403, data: { error: 'CSRF_REQUIRED' } }).tipo, 'SESION');
  assert.equal(resultadoRegistro({ ok: false, status: 404, data: { error: 'ANIMAL_NOT_FOUND' } }).tipo, 'NO_ENCONTRADO');
});

test('red caída o 5xx -> INCIERTO (reintento seguro); CSRF no disponible -> NO_ENVIADO', () => {
  assert.equal(resultadoRegistro({ ok: false, status: 0, data: { error: 'NETWORK_ERROR' } }).tipo, 'INCIERTO');
  assert.equal(resultadoRegistro({ ok: false, status: 502, data: null }).tipo, 'INCIERTO');
  assert.match(resultadoRegistro({ ok: false, status: 500, data: { error: 'INTERNAL' } }).mensaje, /no se duplicará/);
  assert.equal(resultadoRegistro({ ok: false, status: 0, data: { error: 'CSRF_UNAVAILABLE' } }).tipo, 'NO_ENVIADO');
  assert.equal(resultadoRegistro(undefined).tipo, 'ERROR');
});

test('los mensajes de error no exponen detalles internos', () => {
  const r = resultadoRegistro({ ok: false, status: 500, data: { error: 'INTERNAL', message: 'relation animal_pesajes SELECT ...' } });
  assert.doesNotMatch(r.mensaje, /SELECT|animal_pesajes|stack/i);
});

// --- Formato ---------------------------------------------------------------

test('formato: null -> "Sin dato"; GMD con máximo 2 decimales y signo', () => {
  for (const fn of [formatKg, formatDiferenciaKg, formatGmd, formatDias]) assert.equal(fn(null), SIN_DATO);
  assert.equal(formatFecha(null), SIN_DATO);
  assert.equal(formatGmd(0.8333333), '+0,83 kg/día');
  assert.equal(formatGmd(-0.0777778), '−0,08 kg/día');
  assert.equal(formatGmd(0), '0 kg/día');
  assert.equal(formatGmd(1), '+1 kg/día');
});

test('formato: kg, diferencia con signo, días, fecha y método', () => {
  assert.equal(formatKg(301.5), '301,5 kg');
  assert.equal(formatKg(1250), '1.250 kg');
  assert.equal(formatDiferenciaKg(25), '+25 kg');
  assert.equal(formatDiferenciaKg(-5.6), '−5,6 kg');
  assert.equal(formatDiferenciaKg(0), '0 kg');
  assert.equal(formatDias(1), '1 día');
  assert.equal(formatDias(0), '0 días');
  assert.equal(formatFecha('2026-04-20'), '20/04/2026');
  assert.equal(formatMetodo('BASCULA'), 'Pesado en báscula');
  assert.equal(formatMetodo('ESTIMADO'), 'Estimado');
});

// --- Historial y KPIs ---------------------------------------------------------

test('historial: más reciente primero sin mutar la fuente ascendente', () => {
  const copia = SERIE.map((p) => ({ ...p }));
  assert.deepEqual(historialParaVista(SERIE).map((p) => p.pesajeId), ['5', '4', '3', '2', '1']);
  assert.deepEqual(SERIE, copia);
  assert.deepEqual(historialParaVista(), []);
});

test('KPIs: seis indicadores; resumen vacío o null -> todo "Sin dato"', () => {
  for (const resumen of [null, undefined, { totalPesajes: 0, gananciaAcumulada: null }]) {
    const kpis = kpisDePesajes(resumen);
    assert.deepEqual(kpis.map((k) => k.id), ['ultimo', 'anterior', 'diferencia', 'dias', 'gmd', 'acumulada']);
    for (const k of kpis) assert.equal(k.valor, SIN_DATO, k.id);
  }
});

test('KPIs: un solo pesaje -> último peso; resto "Sin dato"', () => {
  const resumen = { totalPesajes: 1, ultimoPesoKg: 300, fechaUltimoPeso: '2026-09-01', pesoAnteriorKg: null, diferenciaKg: null, diasDesdeAnterior: null, gmdKgDia: null, gananciaAcumulada: null };
  assert.equal(kpi(resumen, 'ultimo').valor, '300 kg');
  assert.equal(kpi(resumen, 'ultimo').detalle, '01/09/2026');
  for (const id of ['anterior', 'diferencia', 'dias', 'gmd', 'acumulada']) assert.equal(kpi(resumen, id).valor, SIN_DATO, id);
});

test('KPIs: GMD positiva, negativa y cero; ganancia acumulada desde el primer peso registrado', () => {
  const base = { ultimoPesoKg: 296.4, fechaUltimoPeso: '2026-07-01', pesoAnteriorKg: 302, diferenciaKg: -5.6, diasDesdeAnterior: 72 };
  assert.equal(kpi({ ...base, gmdKgDia: 0.5214286 }, 'gmd').valor, '+0,52 kg/día');
  assert.equal(kpi({ ...base, gmdKgDia: -0.0777778 }, 'gmd').valor, '−0,08 kg/día');
  assert.equal(kpi({ ...base, gmdKgDia: 0 }, 'gmd').valor, '0 kg/día');
  const acumulada = kpi({ ...base, gananciaAcumulada: { primerPesoRegistradoKg: 240, fechaPrimerPesoRegistrado: '2026-01-10', ultimoPesoKg: 296.4, gananciaKg: 56.4, dias: 172, gmdPromedioKgDia: 0.33 } }, 'acumulada');
  assert.equal(acumulada.valor, '+56,4 kg');
  assert.equal(acumulada.detalle, 'Desde el primer peso registrado (240 kg, 10/01/2026)');
});

test('KPIs y etiquetas nunca hablan de "nacimiento" ni de umbrales de GMD', () => {
  const textos = JSON.stringify(kpisDePesajes({ gmdKgDia: 1.2, gananciaAcumulada: { primerPesoRegistradoKg: 30, fechaPrimerPesoRegistrado: '2026-01-01', gananciaKg: 10 } }));
  assert.doesNotMatch(textos, /nacimiento|nacer/i);
  assert.doesNotMatch(textos, /excelente|aceptable|cr[ií]tico|bajo|alto/i);
});

// --- Gráficas: eje temporal real ------------------------------------------------

test('fechaATiempo / tiempoAFecha: ida y vuelta en UTC sin desfase de zona horaria', () => {
  for (const f of ['2026-01-10', '2026-03-08', '2026-11-01', '2024-02-29']) assert.equal(tiempoAFecha(fechaATiempo(f)), f);
  assert.equal(fechaATiempo('2026-02-30'), null);
});

test('puntos de peso: distancia proporcional a días reales (intervalos desiguales)', () => {
  const puntos = puntosPeso(SERIE);
  assert.equal(puntos.length, 5);
  assert.equal((puntos[1].t - puntos[0].t) / DIA, 30);
  assert.equal((puntos[2].t - puntos[1].t) / DIA, 70);
  assert.equal(puntos[3].t, puntos[2].t, 'mismo día -> mismo instante');
  assert.deepEqual(Object.keys(puntos[0]).sort(), ['fecha', 'metodo', 'pesoKg', 't']);
});

test('puntos de GMD: solo períodos con GMD (sin primer pesaje ni mismo día), negativos incluidos', () => {
  const puntos = puntosGmd(SERIE);
  assert.deepEqual(puntos.map((p) => p.fecha), ['2026-02-09', '2026-04-20', '2026-07-01']);
  assert.ok(puntos.some((p) => p.gmdKgDia < 0));
});

test('gráfica: 0, 1 y varios puntos; dominio temporal', () => {
  assert.deepEqual(puntosPeso([]), []);
  assert.equal(dominioTemporal([]), null);
  const uno = puntosPeso(SERIE.slice(0, 1));
  assert.equal(uno.length, 1);
  assert.deepEqual(dominioTemporal(uno), [uno[0].t - 3 * DIA, uno[0].t + 3 * DIA]);
  assert.deepEqual(puntosGmd(SERIE.slice(0, 1)), []);
  const varios = puntosPeso(SERIE);
  assert.deepEqual(dominioTemporal(varios), [varios[0].t, varios.at(-1).t]);
});

// --- Contrato con el backend real de Fase 1A ----------------------------------

test('contrato: el cuerpo construido pasa la validación real del backend', () => {
  const body = buildPesajeBody(form({ pesoKg: '350,5', metodo: 'ESTIMADO', observaciones: 'cinta' }), '0d470fc2-0541-4c09-b387-954ed63729cb');
  const value = validateCreatePesajeBody(body, { hoy: HOY });
  assert.equal(value.pesoKg, 350.5);
  assert.equal(value.metodo, 'ESTIMADO');
});

test('contrato: KPIs, historial y gráficas sobre la respuesta real de construirHistorialPesajes', () => {
  const filas = [
    { pesajeId: '1', fecha: '2026-01-10', pesoKg: 240, metodo: 'BASCULA', origen: 'REGISTRO_INICIAL', observaciones: null, createdAt: '2026-01-10T12:00:00Z' },
    { pesajeId: '2', fecha: '2026-02-09', pesoKg: 265, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2026-02-09T12:00:00Z' },
    { pesajeId: '3', fecha: '2026-04-20', pesoKg: 301.5, metodo: 'ESTIMADO', origen: 'MANUAL', observaciones: null, createdAt: '2026-04-20T12:00:00Z' },
  ];
  const api = construirHistorialPesajes({ animalId: '3', pesajes: filas });
  assert.equal(kpi(api.resumen, 'ultimo').valor, '301,5 kg');
  assert.equal(kpi(api.resumen, 'diferencia').valor, '+36,5 kg');
  assert.equal(kpi(api.resumen, 'dias').valor, '70 días');
  assert.equal(kpi(api.resumen, 'gmd').valor, '+0,52 kg/día');
  assert.equal(kpi(api.resumen, 'acumulada').valor, '+61,5 kg');
  assert.deepEqual(historialParaVista(api.pesajes).map((p) => p.pesajeId), ['3', '2', '1']);
  assert.equal(puntosPeso(api.pesajes).length, 3);
  assert.equal(puntosGmd(api.pesajes).length, 2);
});
