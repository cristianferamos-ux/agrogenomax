// FASE 4D -- analítica reproductiva sin base de datos: cada regla aprobada de
// los ciclos M2/M3/M4, M8 y M12, muestra mínima, periodo, M14 y SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONFIGURACION_ANALITICA_REPRODUCCION,
  CONFIGURACION_CALIDAD_REPRODUCCION,
  MENSAJE_VOLUMEN_ANALITICA,
  MUESTRA_MINIMA_ANALITICA,
  agregarMetricas,
  analizarHembra,
  indicador,
  percentil,
  periodoPorDefecto,
  validateAnaliticaQuery,
} from '../reproduccionAnalitica.js';
import { agruparHembras, leerHistorialLimitado, sqlConteoAnalitica, sqlHistorialAnalitica } from '../reproduccionAnaliticaRepository.js';

const HOY = '2026-11-02';
const PERIODO = { desde: '2000-01-01', hasta: HOY, hoy: HOY };
let id = 0;
const ev = (tipoEvento, fechaEvento, extra = {}) => { id += 1; return { eventoId: String(id), tipoEvento, fechaEvento, ...extra }; };
const ia = (f) => ev('INSEMINACION_ARTIFICIAL', f);
const te = (f) => ev('TRANSFERENCIA_EMBRION', f);
const libre = (f) => ev('SERVICIO_MONTA', f, { tipoServicio: 'LIBRE' });
const controlada = (f) => ev('SERVICIO_MONTA', f, { tipoServicio: 'CONTROLADA' });
const diag = (f, r, diasGestacion) => ev('DIAGNOSTICO_PRENEZ', f, { diagnosticoResultado: r, diasGestacion: diasGestacion ?? null });
const parto = (f, partoTipo = 'NORMAL', numeroCrias = 1) => ev('PARTO', f, { partoTipo, numeroCrias });
const aborto = (f, diasGestacion) => ev('ABORTO', f, { diasGestacion: diasGestacion ?? null });
const celo = (f) => ev('CELO_OBSERVADO', f);
const hembra = (eventos, extra = {}) => ({ animalId: '1', estadoOperativo: 'EN_HATO', origenTipo: 'COMPRADO', nacimientoTipo: 'DESCONOCIDA', fechaNacimiento: null, eventos, ...extra });

const analizar = (eventos, extra) => analizarHembra(hembra(eventos, extra), { hoy: HOY });
const resultados = (eventos, extra) => analizar(eventos, extra).intentos.map((i) => i.motivo ? `${i.resultado}:${i.motivo}` : i.resultado);
const gestaciones = (eventos, extra) => analizar(eventos, extra).gestaciones.map((g) => g.resultado);

test('configuración de calidad: valores aprobados, congelada y documentada como no clínica', () => {
  assert.deepEqual({ ...CONFIGURACION_CALIDAD_REPRODUCCION }, {
    mismoIntentoMaxDias: 1,
    retornoServicioMinDias: 17,
    toleranciaConcepcionDias: 21,
    servicioPartoMinDias: 240,
    servicioPartoMaxDias: 310,
    intervaloPartosMinDias: 300,
    intervaloPartosMaxDias: 900,
    partoConcepcionMinDias: 20,
  });
  assert.ok(Object.isFrozen(CONFIGURACION_CALIDAD_REPRODUCCION));
  assert.equal(MUESTRA_MINIMA_ANALITICA, 10);
  const fuente = fs.readFileSync(new URL('../reproduccionAnalitica.js', import.meta.url), 'utf8');
  assert.match(fuente, /no son una regla clínica/);
});

test('periodo: ventana móvil de 12 meses terminada en la fecha de negocio, inclusive', () => {
  assert.deepEqual(periodoPorDefecto('2026-11-02'), { desde: '2025-11-03', hasta: '2026-11-02' });
  assert.deepEqual(periodoPorDefecto('2028-02-29'), { desde: '2027-03-01', hasta: '2028-02-29' });
  assert.deepEqual(periodoPorDefecto('2026-12-31'), { desde: '2026-01-01', hasta: '2026-12-31' });
  assert.deepEqual(validateAnaliticaQuery({}, { hoy: HOY }), { predioId: null, desde: '2025-11-03', hasta: HOY });
});

test('query inválida -> 400 INVALID_QUERY (sin organizacionId del cliente)', () => {
  const casos = [
    { organizacionId: 'x' }, { desde: '2026-02-30' }, { hasta: '2026-13-01' }, { hasta: '2026-11-03' },
    { desde: '2026-10-02', hasta: '2026-10-01' }, { desde: '1989-12-31' }, { predioId: 'abc' }, { desde: ['2026-01-01'] },
  ];
  for (const query of casos) {
    assert.throws(() => validateAnaliticaQuery(query, { hoy: HOY }), (e) => e.status === 400 && e.code === 'INVALID_QUERY', JSON.stringify(query));
  }
});

test('intento: servicios a 0 o 1 día son el mismo intento; se asigna por el primero', () => {
  const r = analizar([ia('2026-01-01'), ia('2026-01-02'), diag('2026-02-15', 'VACIA')]);
  assert.equal(r.intentos.length, 1);
  assert.equal(r.intentos[0].fecha, '2026-01-01');
  assert.equal(r.intentos[0].resultado, 'NO_CONCEPCION');
  assert.equal(r.servicios.length, 2);
  assert.equal(analizar([ia('2026-01-01'), ia('2026-01-01')]).intentos.length, 1);
});

test('intento: una resolución entre dos servicios impide agruparlos', () => {
  const r = analizar([ia('2026-01-01'), diag('2026-01-01', 'VACIA'), ia('2026-01-02')]);
  assert.equal(r.intentos.length, 2);
});

test('retorno: 2-16 días NO_ATRIBUIBLE; 17 días o más NO_CONCEPCION (frontera exacta)', () => {
  assert.deepEqual(resultados([ia('2026-01-01'), ia('2026-01-03')]), ['NO_ATRIBUIBLE:RETORNO_NO_PLAUSIBLE', 'PENDIENTE']);
  assert.deepEqual(resultados([ia('2026-01-01'), ia('2026-01-17')]), ['NO_ATRIBUIBLE:RETORNO_NO_PLAUSIBLE', 'PENDIENTE']);
  assert.deepEqual(resultados([ia('2026-01-01'), ia('2026-01-18')]), ['NO_CONCEPCION', 'PENDIENTE']);
});

test('monta libre: fuera del denominador; un servicio seguido de libre es NO_ATRIBUIBLE', () => {
  assert.deepEqual(resultados([libre('2026-01-01'), diag('2026-03-01', 'PRENADA')]), ['MONTA_LIBRE']);
  assert.deepEqual(resultados([ia('2026-01-01'), libre('2026-01-02'), diag('2026-03-01', 'PRENADA')]), ['NO_ATRIBUIBLE:MONTA_LIBRE_POSTERIOR', 'MONTA_LIBRE']);
  // Con resolución concluyente antes de la libre el intento ya está resuelto.
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-02-15', 'VACIA'), libre('2026-03-01')]), ['NO_CONCEPCION', 'MONTA_LIBRE']);
  // Monta controlada sí es un servicio puntual.
  assert.deepEqual(resultados([controlada('2026-01-01'), diag('2026-03-01', 'PRENADA')]), ['CONCEPCION']);
});

test('diagnóstico con días: ±21 días del servicio; TE se ajusta 7 días', () => {
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-03-01', 'PRENADA', 59)]), ['CONCEPCION']);
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-03-01', 'PRENADA', 38)]), ['CONCEPCION']); // +21
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-03-01', 'PRENADA', 37)]), ['NO_ATRIBUIBLE:CONCEPCION_FUERA_DE_TOLERANCIA']); // +22
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-03-01', 'PRENADA', 90)]), ['NO_ATRIBUIBLE:CONCEPCION_FUERA_DE_TOLERANCIA']);
  // TE 2026-01-08 = concepción de referencia 2026-01-01; a +21 días exactos.
  assert.deepEqual(resultados([te('2026-01-08'), diag('2026-03-01', 'PRENADA', 38)]), ['CONCEPCION']);
  assert.deepEqual(resultados([te('2026-01-08'), diag('2026-03-01', 'PRENADA', 37)]), ['NO_ATRIBUIBLE:CONCEPCION_FUERA_DE_TOLERANCIA']);
});

test('resolución directa: PARTO 240-310 días, ABORTO y eventos no resolutivos', () => {
  assert.deepEqual(resultados([ia('2025-01-01'), parto('2025-08-29')]), ['CONCEPCION']); // 240
  assert.deepEqual(resultados([ia('2025-01-01'), parto('2025-08-28')]), ['NO_ATRIBUIBLE:SERVICIO_PARTO_FUERA_DE_RANGO']); // 239
  assert.deepEqual(resultados([ia('2025-01-01'), parto('2025-11-07')]), ['CONCEPCION']); // 310
  assert.deepEqual(resultados([ia('2025-01-01'), parto('2025-11-08')]), ['NO_ATRIBUIBLE:SERVICIO_PARTO_FUERA_DE_RANGO']); // 311
  assert.deepEqual(resultados([ia('2025-01-01'), aborto('2025-04-01')]), ['CONCEPCION']);
  assert.deepEqual(resultados([ia('2025-01-01'), aborto('2025-11-08')]), ['NO_ATRIBUIBLE:SERVICIO_ABORTO_FUERA_DE_RANGO']);
  assert.deepEqual(resultados([ia('2025-01-01'), aborto('2025-04-01', 40)]), ['NO_ATRIBUIBLE:CONCEPCION_FUERA_DE_TOLERANCIA']);
  assert.deepEqual(resultados([ia('2026-01-01'), celo('2026-01-20'), diag('2026-02-01', 'DUDOSA')]), ['PENDIENTE']);
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-02-01', 'DUDOSA'), diag('2026-03-01', 'PRENADA')]), ['CONCEPCION']);
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-02-01', 'VACIA')]), ['NO_CONCEPCION']);
});

test('una pérdida posterior no quita la concepción en M2', () => {
  assert.deepEqual(resultados([ia('2026-01-01'), diag('2026-02-15', 'PRENADA'), diag('2026-04-01', 'VACIA')]), ['CONCEPCION']);
});

test('M3: primer intento del episodio; INICIO_CICLO_DESCONOCIDO fuera de M3 y dentro de M2', () => {
  const eventos = [ia('2026-01-01'), diag('2026-02-15', 'VACIA'), ia('2026-03-01'), diag('2026-04-15', 'VACIA')];
  const comprada = agregarMetricas([hembra(eventos)], PERIODO).metricas;
  assert.equal(comprada.M2.totalIntentos, 2);
  assert.equal(comprada.M3.nEvaluable, 0);
  assert.equal(comprada.M3.inicioCicloDesconocido, 1);
  assert.equal(comprada.M14.find((g) => g.metrica === 'M2-M4').items.find((i) => i.codigo === 'INICIO_CICLO_DESCONOCIDO').conteo, 1);

  const nacida = agregarMetricas([hembra(eventos, { origenTipo: 'NACIDO_EN_PREDIO' })], PERIODO).metricas;
  assert.equal(nacida.M3.nEvaluable, 1);
  assert.equal(nacida.M3.inicioCicloDesconocido, 0);

  // Comprada con parto registrado: el episodio siguiente sí tiene inicio conocido.
  const conParto = agregarMetricas([hembra([parto('2025-01-01'), ia('2025-04-01'), diag('2025-05-15', 'PRENADA')])], PERIODO).metricas;
  assert.equal(conParto.M3.concepciones, 1);
});

test('M3: el segundo intento no ocupa el lugar de un primero no evaluable', () => {
  const eventos = [parto('2025-01-01'), libre('2025-03-01'), ia('2025-05-01'), diag('2025-06-15', 'PRENADA')];
  const m = agregarMetricas([hembra(eventos)], PERIODO).metricas;
  assert.equal(m.M3.montaLibre, 1);
  assert.equal(m.M3.concepciones, 0);
  assert.equal(m.M2.concepciones, 1);
});

test('M2-M4: conteos cuadran con el total y nada se pierde', () => {
  const hembras = [
    hembra([ia('2026-01-01'), diag('2026-02-15', 'PRENADA')]),
    hembra([ia('2026-01-01'), diag('2026-02-15', 'VACIA')]),
    hembra([libre('2026-01-01')]),
    hembra([ia('2026-01-01'), ia('2026-01-05')]),
    hembra([ia('2026-10-30')]),
  ];
  const { M2, M4 } = agregarMetricas(hembras, PERIODO).metricas;
  assert.equal(M2.totalIntentos, M2.concepciones + M2.noConcepciones + M2.pendientes + M2.noAtribuibles + M2.montaLibre);
  assert.equal(M2.nEvaluable, M2.concepciones + M2.noConcepciones);
  assert.deepEqual([M2.concepciones, M2.noConcepciones, M2.pendientes, M2.noAtribuibles, M2.montaLibre], [1, 1, 2, 1, 1]);
  assert.equal(M2.cobertura, 33.3);
  assert.equal(M4.nEvaluable, M2.nEvaluable);
});

test('n < 10: conteos visibles, indicador "datos insuficientes"; M4 sin concepciones no calculable', () => {
  assert.deepEqual(indicador(9, 50), { estado: 'DATOS_INSUFICIENTES', valor: null });
  assert.deepEqual(indicador(10, 50), { estado: 'OK', valor: 50 });
  assert.deepEqual(indicador(10, null), { estado: 'NO_CALCULABLE', valor: null });

  const vacias = (n) => Array.from({ length: n }, () => hembra([ia('2026-01-01'), diag('2026-02-15', 'VACIA')]));
  const prenadas = (n) => Array.from({ length: n }, () => hembra([ia('2026-01-01'), diag('2026-02-15', 'PRENADA')]));
  const nueve = agregarMetricas([...prenadas(4), ...vacias(5)], PERIODO).metricas;
  assert.equal(nueve.M2.indicador.estado, 'DATOS_INSUFICIENTES');
  assert.equal(nueve.M2.indicador.valor, null);
  assert.equal(nueve.M2.concepciones, 4);
  const diez = agregarMetricas([...prenadas(4), ...vacias(6)], PERIODO).metricas;
  assert.deepEqual(diez.M2.indicador, { estado: 'OK', valor: 40 });
  assert.deepEqual(diez.M4.indicador, { estado: 'OK', valor: 2.5 });
  assert.equal(diez.M2.porTipo.INSEMINACION_ARTIFICIAL.nEvaluable, 10);
  assert.equal(agregarMetricas(vacias(10), PERIODO).metricas.M4.indicador.estado, 'NO_CALCULABLE');
});

test('percentil continuo y estadística oculta con n < 10', () => {
  assert.equal(percentil([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentil([10, 20, 30, 40], 0.25), 17.5);
  assert.equal(percentil([10], 0.75), 10);
  assert.equal(percentil([], 0.5), null);
  const dos = agregarMetricas([hembra([parto('2024-01-01'), parto('2025-01-01')])], PERIODO).metricas.M7;
  assert.deepEqual([dos.n, dos.estado, dos.mediana], [1, 'DATOS_INSUFICIENTES', null]);
});

test('M5: DUDOSA fuera, repeticiones una vez, un servicio intermedio reinicia', () => {
  const m = agregarMetricas([hembra([
    ia('2026-01-01'), diag('2026-02-01', 'PRENADA'), diag('2026-02-20', 'DUDOSA'), diag('2026-03-01', 'PRENADA'), diag('2026-04-01', 'VACIA'),
    ia('2026-05-01'), diag('2026-06-15', 'VACIA'),
  ])], PERIODO).metricas.M5;
  assert.deepEqual([m.positivos, m.negativos, m.dudosas, m.repeticiones, m.n], [1, 2, 1, 1, 3]);
});

test('M7: consecutivos, 300-900 días, atípicos contados', () => {
  const r = analizar([parto('2023-01-01'), parto('2024-01-01'), parto('2024-06-01'), parto('2026-01-01')]);
  assert.deepEqual(r.intervalos.map((i) => [i.dias, i.atipico]), [[365, false], [152, true], [579, false]]);
  assert.equal(analizar([parto('2023-01-01'), parto('2023-10-28')]).intervalos[0].atipico, false); // 300
  assert.equal(analizar([parto('2023-01-01'), parto('2023-10-27')]).intervalos[0].atipico, true); // 299
  assert.equal(analizar([parto('2023-01-01'), parto('2025-06-19')]).intervalos[0].atipico, false); // 900
  assert.equal(analizar([parto('2023-01-01'), parto('2025-06-20')]).intervalos[0].atipico, true); // 901
});

test('M8: concepción por días, por servicio y TE; 20 días de frontera', () => {
  const casos = (e, x) => analizar(e, x).diasAbiertos.casos;
  assert.deepEqual(casos([parto('2025-01-01'), diag('2025-04-15', 'PRENADA', 30)]), [{ fecha: '2025-03-16', resultado: 'VALIDO', dias: 74 }]);
  assert.deepEqual(casos([parto('2025-01-01'), ia('2025-03-01'), diag('2025-04-15', 'PRENADA')]), [{ fecha: '2025-03-01', resultado: 'VALIDO', dias: 59 }]);
  assert.deepEqual(casos([parto('2025-01-01'), te('2025-03-08'), diag('2025-04-15', 'PRENADA')]), [{ fecha: '2025-03-01', resultado: 'VALIDO', dias: 59 }]);
  assert.equal(casos([parto('2025-01-01'), ia('2025-01-21'), diag('2025-03-01', 'PRENADA')])[0].resultado, 'VALIDO'); // 20
  assert.equal(casos([parto('2025-01-01'), ia('2025-01-20'), diag('2025-03-01', 'PRENADA')])[0].resultado, 'ATIPICO'); // 19
});

test('M8: una pérdida prolonga los días abiertos; un ABORTO no cierra la ventana', () => {
  const r = analizar([parto('2025-01-01'), ia('2025-03-01'), diag('2025-04-15', 'PRENADA'), aborto('2025-05-01'), ia('2025-06-01'), diag('2025-07-15', 'PRENADA')]);
  assert.deepEqual(r.diasAbiertos.casos, [{ fecha: '2025-06-01', resultado: 'VALIDO', dias: 151 }]);
  const v = analizar([parto('2025-01-01'), ia('2025-03-01'), diag('2025-04-15', 'PRENADA'), diag('2025-05-15', 'VACIA')]);
  assert.deepEqual(v.diasAbiertos.casos, []);
  assert.ok(v.diasAbiertos.abierta);
});

test('M8: sin PRENADA con parto de cierre usa el último servicio a 240-310 días; casos fuera contados', () => {
  const casos = (e) => analizar(e).diasAbiertos.casos;
  assert.deepEqual(casos([parto('2024-01-01'), ia('2024-03-01'), parto('2024-12-01')])[0], { fecha: '2024-03-01', resultado: 'VALIDO', dias: 60 });
  assert.equal(casos([parto('2024-01-01'), ia('2024-08-01'), parto('2024-12-01')])[0].resultado, 'SIN_BASE');
  assert.equal(casos([parto('2024-01-01'), parto('2024-12-01')])[0].resultado, 'SIN_BASE');
  assert.equal(casos([parto('2024-01-01'), libre('2024-03-01'), parto('2024-12-01')])[0].resultado, 'NO_ATRIBUIBLE');
  assert.equal(casos([parto('2024-01-01'), libre('2024-03-01'), diag('2024-05-01', 'PRENADA')])[0].resultado, 'NO_ATRIBUIBLE');
  assert.equal(casos([parto('2024-01-01'), diag('2024-05-01', 'PRENADA')])[0].resultado, 'SIN_BASE');
  // Con días, la monta libre no impide estimar la concepción.
  assert.equal(casos([parto('2024-01-01'), libre('2024-03-01'), diag('2024-05-01', 'PRENADA', 60)])[0].resultado, 'VALIDO');
  // Concepción a parto de cierre fuera de 240-310 días.
  assert.equal(casos([parto('2024-01-01'), diag('2024-03-15', 'PRENADA', 30), parto('2024-08-01')])[0].resultado, 'ATIPICO');
});

test('M8: abierta hoy solo EN_HATO; cerrada sin desenlace queda censurada, no en el agregado', () => {
  const enHato = analizar([parto('2026-01-01')]);
  assert.deepEqual(enHato.diasAbiertos.abierta, { dias: 305 });
  assert.deepEqual(enHato.diasAbiertos.casos, []);
  const cerrada = analizar([parto('2026-01-01')], { estadoOperativo: 'SALIDO' });
  assert.equal(cerrada.diasAbiertos.abierta, null);
  assert.deepEqual(cerrada.diasAbiertos.casos, [{ fecha: '2026-01-01', resultado: 'CENSURADA_CERRADA' }]);
  const m = agregarMetricas([hembra([parto('2026-01-01')]), hembra([parto('2026-01-01')], { estadoOperativo: 'MUERTO' })], PERIODO).metricas.M8;
  assert.deepEqual([m.n, m.abiertasHoy.n, m.censuradasCerradas], [0, 1, 1]);
});

test('M9: primer servicio tras el parto; libre excluido y contado, sin pasar al siguiente', () => {
  assert.deepEqual(analizar([parto('2025-01-01'), ia('2025-03-02'), ia('2025-05-01')]).partoServicio, [{ fecha: '2025-03-02', dias: 60 }]);
  assert.deepEqual(analizar([parto('2025-01-01'), libre('2025-03-02'), ia('2025-05-01')]).partoServicio, [{ fecha: '2025-03-02', excluido: 'SERVICIO_LIBRE' }]);
  assert.deepEqual(analizar([parto('2025-01-01'), parto('2025-12-01')]).partoServicio, []);
});

test('M10: solo NACIDO_EN_PREDIO con nacimiento EXACTA; nunca infiere en comprados', () => {
  const nacida = { origenTipo: 'NACIDO_EN_PREDIO', nacimientoTipo: 'EXACTA', fechaNacimiento: '2023-01-01' };
  const eventos = [ia('2025-01-01'), parto('2025-10-01')];
  const ok = analizar(eventos, nacida).edades;
  assert.deepEqual(ok.primerServicio, { fecha: '2025-01-01', meses: 24 });
  assert.equal(ok.primerParto.meses, 33);
  assert.equal(analizar(eventos, { ...nacida, origenTipo: 'COMPRADO' }).edades.primerParto.excluido, 'ORIGEN_NO_ELEGIBLE');
  assert.equal(analizar(eventos, { ...nacida, origenTipo: null }).edades.primerServicio.excluido, 'ORIGEN_NO_ELEGIBLE');
  assert.equal(analizar(eventos, { origenTipo: 'NACIDO_EN_PREDIO', nacimientoTipo: 'APROXIMADA', fechaNacimiento: null }).edades.primerServicio.excluido, 'NACIMIENTO_NO_EXACTO');
  assert.equal(analizar([libre('2025-01-01')], nacida).edades.primerServicio.excluido, 'SERVICIO_LIBRE');
});

test('M12: DUDOSA es transparente (secuencias aprobadas)', () => {
  const inicio = () => [ia('2025-01-01'), diag('2025-02-15', 'PRENADA')];
  assert.deepEqual(gestaciones([...inicio(), diag('2025-03-15', 'DUDOSA'), parto('2025-10-10')]), ['TERMINO']);
  assert.deepEqual(gestaciones([...inicio(), diag('2025-03-15', 'DUDOSA'), diag('2025-04-15', 'VACIA')]), ['PERDIDA']);
  assert.deepEqual(gestaciones([...inicio(), diag('2025-03-15', 'DUDOSA'), aborto('2025-04-15')]), ['PERDIDA']);
  assert.deepEqual(gestaciones([...inicio(), diag('2025-03-15', 'DUDOSA'), diag('2025-04-15', 'PRENADA'), parto('2025-10-10')]), ['TERMINO']);
  // DUDOSA no abre gestación.
  assert.deepEqual(gestaciones([ia('2025-01-01'), diag('2025-03-15', 'DUDOSA'), diag('2025-04-15', 'VACIA')]), []);
  const r = analizar([...inicio(), diag('2025-03-15', 'DUDOSA'), parto('2025-10-10')]).gestaciones[0];
  assert.equal(r.conDudosa, true);
});

test('M12: resoluciones, incompatibles, atípicos y en curso', () => {
  const inicio = () => [ia('2025-01-01'), diag('2025-02-15', 'PRENADA')];
  assert.deepEqual(gestaciones([...inicio(), diag('2025-04-01', 'VACIA')]), ['PERDIDA']);
  assert.deepEqual(gestaciones([...inicio(), aborto('2025-04-01')]), ['PERDIDA']);
  assert.deepEqual(gestaciones([...inicio(), parto('2025-10-10')]), ['TERMINO']);
  assert.deepEqual(gestaciones([...inicio(), diag('2025-03-01', 'PRENADA'), parto('2025-10-10')]), ['TERMINO']);
  assert.deepEqual(gestaciones([...inicio(), ia('2025-04-01')]), ['NO_ATRIBUIBLE']);
  assert.deepEqual(gestaciones([...inicio(), celo('2025-04-01')]), ['NO_ATRIBUIBLE']);
  assert.deepEqual(gestaciones([...inicio(), diag('2025-02-15', 'VACIA')]), ['NO_ATRIBUIBLE']); // rectificación
  assert.deepEqual(gestaciones([...inicio(), parto('2025-05-01')]), ['ATIPICO']);
  assert.deepEqual(gestaciones(inicio()), ['EN_CURSO']);
  assert.deepEqual(gestaciones(inicio(), { estadoOperativo: 'MUERTO' }), ['CENSURADA_CERRADA']);
  // Tras una pérdida, un nuevo PRENADA abre otra gestación.
  assert.deepEqual(gestaciones([...inicio(), diag('2025-04-01', 'VACIA'), ia('2025-05-01'), diag('2025-06-15', 'PRENADA')]), ['PERDIDA', 'EN_CURSO']);
});

test('M12: % sobre gestaciones resueltas evaluables; no atribuibles y en curso fuera del denominador', () => {
  const inicio = () => [ia('2025-01-01'), diag('2025-02-15', 'PRENADA')];
  const hembras = [
    ...Array.from({ length: 2 }, () => hembra([...inicio(), aborto('2025-04-01')])),
    ...Array.from({ length: 8 }, () => hembra([...inicio(), parto('2025-10-10')])),
    hembra([...inicio(), ia('2025-04-01')]),
    hembra(inicio()),
  ];
  const m = agregarMetricas(hembras, PERIODO).metricas.M12;
  assert.deepEqual([m.perdidas, m.n, m.noAtribuibles, m.enCurso], [2, 10, 1, 1]);
  assert.deepEqual(m.indicador, { estado: 'OK', valor: 20 });
});

test('M13: intervención y crías declaradas; M6 y M11 no existen', () => {
  const hembras = [hembra([parto('2026-01-01', 'CESAREA', 2)]), hembra([parto('2026-01-01', 'NORMAL')]), hembra([parto('2026-01-01', 'ASISTIDO')])];
  const m = agregarMetricas(hembras, PERIODO).metricas;
  assert.deepEqual([m.M13.partos, m.M13.conIntervencion, m.M13.criasDeclaradas], [3, 2, 4]);
  assert.deepEqual(m.M13.porTipo, { CESAREA: 1, NORMAL: 1, ASISTIDO: 1 });
  assert.equal(m.M6, undefined);
  assert.equal(m.M11, undefined);
});

test('periodo: asigna por la fecha aprobada y clasifica con todo el historial', () => {
  const eventos = [ia('2025-10-01'), diag('2025-11-15', 'PRENADA'), parto('2026-07-01')];
  // Servicio fuera del periodo, parto dentro: M2 no lo cuenta; M13 sí.
  const dentro = agregarMetricas([hembra(eventos)], { desde: '2025-11-03', hasta: HOY, hoy: HOY }).metricas;
  assert.equal(dentro.M2.totalIntentos, 0);
  assert.equal(dentro.M13.partos, 1);
  // Periodo cerrado anterior: el servicio se resuelve con un evento posterior a `hasta`.
  const pasado = agregarMetricas([hembra(eventos)], { desde: '2025-01-01', hasta: '2025-10-31', hoy: HOY }).metricas;
  assert.equal(pasado.M2.concepciones, 1);
  assert.equal(pasado.M13.partos, 0);
});

test('hembras SALIDO y MUERTO cuentan en históricos; ANULADO no se pliega', () => {
  const eventos = [ia('2026-01-01'), diag('2026-02-15', 'PRENADA'), parto('2026-10-10')];
  const m = agregarMetricas([hembra(eventos, { estadoOperativo: 'SALIDO' }), hembra(eventos, { estadoOperativo: 'MUERTO' })], PERIODO);
  assert.equal(m.metricas.M2.concepciones, 2);
  assert.equal(m.metricas.M13.partos, 2);
  assert.deepEqual(m.poblacion, { hembrasConEventos: 2, enHato: 0, salidas: 1, muertas: 1 });
  const anulado = analizar([{ ...ia('2026-01-01'), estadoRegistro: 'ANULADO' }, { ...ia('2026-03-01'), estadoRegistro: 'ACTIVO' }]);
  assert.equal(anulado.servicios.length, 1);
});

test('M14: siempre presente con todos los grupos, también sin datos', () => {
  const { M14 } = agregarMetricas([], PERIODO).metricas;
  assert.deepEqual(M14.map((g) => g.metrica), ['M2-M4', 'M5', 'M7', 'M8', 'M9', 'M10', 'M12', 'General']);
  assert.ok(M14.every((g) => g.items.length && g.items.every((i) => i.conteo === 0)));
});

test('M14: pendientes vencidos desde 35 días y preñez sin servicio', () => {
  const m = agregarMetricas([
    hembra([ia('2026-09-28')]), // 35 días
    hembra([ia('2026-09-29')]), // 34 días
    hembra([ia('2026-01-01')], { estadoOperativo: 'SALIDO' }),
    hembra([diag('2026-05-01', 'PRENADA')]),
    hembra([diag('2026-05-01', 'PRENADA', 40)]),
  ], PERIODO).metricas.M14;
  const conteo = (grupo, codigo) => m.find((g) => g.metrica === grupo).items.find((i) => i.codigo === codigo).conteo;
  assert.equal(conteo('M2-M4', 'PENDIENTE_VENCIDO'), 2);
  assert.equal(conteo('M2-M4', 'PENDIENTE_ANIMAL_CERRADO'), 1);
  assert.equal(conteo('General', 'PRENADA_SIN_SERVICIO'), 2);
  assert.equal(conteo('General', 'PRENADA_SIN_BASE'), 1);
});

test('el plegado no depende del orden de entrada y no muta el historial', () => {
  const eventos = [ia('2026-01-01'), diag('2026-02-15', 'PRENADA')];
  const invertidos = Object.freeze([...eventos].reverse());
  assert.deepEqual(analizar(invertidos).intentos, analizar(eventos).intentos);
});

test('SQL: una lectura, solo ACTIVO, hembras con registro ACTIVO, predio parametrizado, sin legacy', () => {
  const sql = sqlHistorialAnalitica();
  assert.match(sql, /a\.sexo = 'HEMBRA' and a\.estado = 'ACTIVO' and e\.estado_registro = 'ACTIVO'/);
  assert.match(sql, /a\.organizacion_id = e\.organizacion_id/);
  assert.match(sql, /order by a\.animal_id, e\.fecha_evento, e\.evento_id/);
  assert.doesNotMatch(sql, /estado_operativo =/); // SALIDO y MUERTO se incluyen
  assert.doesNotMatch(sql, /organizacion_id = \$/); // tenant por RLS
  assert.doesNotMatch(sql, /\$2/);
  assert.match(sqlHistorialAnalitica({ conPredio: true }), /a\.predio_id = \$2/);
  const repo = fs.readFileSync(new URL('../reproduccionAnaliticaRepository.js', import.meta.url), 'utf8');
  assert.match(repo, /withOrganizacionTransaction/);
  assert.doesNotMatch(repo, /from '\.\.\/\.\.\/db\.js'/);
  assert.doesNotMatch(repo, /insert |update |delete /i);
});

function clienteFalso(total) {
  const consultas = [];
  return {
    consultas,
    query: async (sql, params) => {
      consultas.push({ sql, params });
      return sql.includes('count(*)') ? { rows: [{ total }] } : { rows: [{ animal_id: '1' }] };
    },
  };
}

test('salvaguarda: máximo centralizado y congelado', () => {
  assert.ok(Object.isFrozen(CONFIGURACION_ANALITICA_REPRODUCCION));
  assert.ok(Number.isInteger(CONFIGURACION_ANALITICA_REPRODUCCION.maxEventosProcesables));
  assert.ok(CONFIGURACION_ANALITICA_REPRODUCCION.maxEventosProcesables > 0);
  const repo = fs.readFileSync(new URL('../reproduccionAnaliticaRepository.js', import.meta.url), 'utf8');
  assert.doesNotMatch(repo, /\b\d{4,}\b|\d_\d{3}/); // sin máximo mágico en el repositorio
});

test('salvaguarda: debajo del límite y exactamente en el límite se procesa', async () => {
  for (const total of [99, 100]) {
    const client = clienteFalso(total);
    const rows = await leerHistorialLimitado(client, {}, { hoy: HOY, maxEventos: 100 });
    assert.deepEqual(rows, [{ animal_id: '1' }], String(total));
    assert.equal(client.consultas.length, 2);
    assert.match(client.consultas[0].sql, /count\(\*\)/);
    assert.match(client.consultas[1].sql, /order by a\.animal_id/);
  }
});

test('salvaguarda: límite + 1 no ejecuta la consulta pesada y da un error funcional sin conteos', async () => {
  const client = clienteFalso(101);
  await assert.rejects(leerHistorialLimitado(client, {}, { hoy: HOY, maxEventos: 100 }), (e) => {
    assert.equal(e.code, 'ANALITICA_VOLUMEN_EXCEDIDO');
    assert.equal(e.status, 422);
    assert.equal(e.message, MENSAJE_VOLUMEN_ANALITICA);
    assert.doesNotMatch(e.message, /\d/);
    assert.doesNotMatch(e.message, /select|agx\.|count/i);
    return true;
  });
  assert.equal(client.consultas.length, 1);
  assert.match(client.consultas[0].sql, /count\(\*\)/);
  assert.doesNotMatch(client.consultas[0].sql, /order by/);
});

test('salvaguarda: COUNT e historial comparten población, parámetros y predio', async () => {
  const poblacion = (sql) => sql.slice(sql.indexOf('from agx.reproduccion_eventos')).replace(/\s+order by[\s\S]*$/, '');
  for (const conPredio of [false, true]) {
    assert.equal(poblacion(sqlConteoAnalitica({ conPredio })), poblacion(sqlHistorialAnalitica({ conPredio })));
  }
  assert.match(sqlConteoAnalitica(), /a\.sexo = 'HEMBRA' and a\.estado = 'ACTIVO' and e\.estado_registro = 'ACTIVO'/);
  assert.match(sqlConteoAnalitica(), /a\.organizacion_id = e\.organizacion_id/);
  assert.match(sqlConteoAnalitica(), /e\.fecha_evento <= \$1::date/);
  assert.doesNotMatch(sqlConteoAnalitica(), /organizacion_id = \$/); // tenant por RLS
  assert.match(sqlConteoAnalitica({ conPredio: true }), /a\.predio_id = \$2/);

  const client = clienteFalso(1);
  await leerHistorialLimitado(client, { predioId: '7' }, { hoy: HOY, maxEventos: 100 });
  assert.deepEqual(client.consultas.map((c) => c.params), [[HOY, '7'], [HOY, '7']]);
  assert.ok(client.consultas.every((c) => /a\.predio_id = \$2/.test(c.sql)));

  const sinPredio = clienteFalso(1);
  await leerHistorialLimitado(sinPredio, {}, { hoy: HOY, maxEventos: 100 });
  assert.deepEqual(sinPredio.consultas.map((c) => c.params), [[HOY], [HOY]]);
});

test('agruparHembras: conserva el orden y no expone columnas internas', () => {
  const base = { estado_operativo: 'EN_HATO', origen_tipo: null, nacimiento_tipo: 'DESCONOCIDA', fecha_nacimiento: null, tipo_servicio: null, diagnostico_resultado: null, dias_gestacion: null, parto_tipo: null, numero_crias: null };
  const r = agruparHembras([
    { ...base, animal_id: '1', evento_id: '5', tipo_evento: 'IATF', fecha_evento: '2026-01-01' },
    { ...base, animal_id: '1', evento_id: '6', tipo_evento: 'PARTO', fecha_evento: '2026-10-01' },
    { ...base, animal_id: '2', evento_id: '7', tipo_evento: 'IATF', fecha_evento: '2026-01-01' },
  ]);
  assert.deepEqual(r.map((h) => [h.animalId, h.eventos.length]), [['1', 2], ['2', 1]]);
});
