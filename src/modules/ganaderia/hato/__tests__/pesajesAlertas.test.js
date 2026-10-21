// FASE 1C.1: alertas DERIVADAS de pesajes (modelo puro, fechas explícitas).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODIGOS_ALERTA,
  CONFIGURACION_ALERTAS_PESAJE,
  ETIQUETAS_SEVERIDAD,
  SEVERIDADES_ALERTA,
  construirAlertasPesajes,
  detalleAlerta,
  resolverConfiguracionAlertas,
} from '../pesajesAlertas.js';
import { construirHistorialPesajes } from '../../../../../server/services/ganaderia/pesajesService.js';
import { sumarDias } from '../../engine/fechas.js';

const REF = '2026-10-20';
const fila = (pesajeId, fecha, pesoKg) => ({ pesajeId: String(pesajeId), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: `${fecha}T12:00:00Z` });
// Respuesta real del backend (misma derivación que la API de Fase 1A).
const api = (...filas) => construirHistorialPesajes({ animalId: '1', pesajes: filas });
const alertas = (respuesta, extra = {}) => construirAlertasPesajes({ pesajes: respuesta.pesajes, resumen: respuesta.resumen, fechaReferencia: REF, ...extra });
const codigos = (lista) => lista.map((a) => `${a.severidad}:${a.codigo}`);
const haceDias = (n) => sumarDias(REF, -n);

test('configuración: umbrales provisionales 30/60 centralizados e inmutables', () => {
  assert.deepEqual({ ...CONFIGURACION_ALERTAS_PESAJE }, { diasAtencion: 30, diasUrgente: 60 });
  assert.ok(Object.isFrozen(CONFIGURACION_ALERTAS_PESAJE));
  assert.deepEqual([...SEVERIDADES_ALERTA], ['URGENTE', 'ATENCION', 'INFO']);
  assert.equal(ETIQUETAS_SEVERIDAD.ATENCION, 'ATENCIÓN');
});

test('1. sin pesajes -> una única alerta INFO', () => {
  const r = alertas(api());
  assert.deepEqual(r, [{
    codigo: CODIGOS_ALERTA.SIN_PESAJES,
    severidad: 'INFO',
    mensaje: 'Este animal aún no tiene pesajes registrados.',
    datos: { totalPesajes: 0 },
  }]);
  assert.doesNotMatch(JSON.stringify(r), /cr[ií]tic/i);
});

test('2. último pesaje hoy -> sin alertas', () => {
  assert.deepEqual(alertas(api(fila(1, REF, 300))), []);
});

test('3. 30 días -> sin alerta', () => {
  assert.deepEqual(alertas(api(fila(1, haceDias(30), 300))), []);
});

test('4. 31 días -> ATENCION con días, fecha y umbrales en datos', () => {
  const [a, ...resto] = alertas(api(fila(1, haceDias(31), 300)));
  assert.equal(resto.length, 0);
  assert.equal(a.codigo, CODIGOS_ALERTA.ATRASADO);
  assert.equal(a.severidad, 'ATENCION');
  assert.equal(a.mensaje, 'Han pasado 31 días desde el último pesaje.');
  assert.deepEqual(a.datos, { diasDesdeUltimoPesaje: 31, fechaUltimoPesaje: haceDias(31), fechaReferencia: REF, diasAtencion: 30, diasUrgente: 60 });
});

test('5. 60 días -> ATENCION', () => {
  assert.deepEqual(codigos(alertas(api(fila(1, haceDias(60), 300)))), ['ATENCION:PESAJE_ATRASADO']);
});

test('6. 61 días -> URGENTE', () => {
  const [a] = alertas(api(fila(1, haceDias(61), 300)));
  assert.equal(a.severidad, 'URGENTE');
  assert.equal(a.mensaje, 'Han pasado 61 días desde el último pesaje.');
});

test('7. GMD positiva -> sin alerta de pérdida', () => {
  assert.deepEqual(alertas(api(fila(1, haceDias(10), 300), fila(2, REF, 310))), []);
});

test('8. GMD cero -> sin alerta por defecto', () => {
  const r = api(fila(1, haceDias(10), 300), fila(2, REF, 300));
  assert.equal(r.resumen.gmdKgDia, 0);
  assert.deepEqual(alertas(r), []);
});

test('9. GMD negativa -> ATENCION con la pérdida en kg y los datos de origen', () => {
  const [a, ...resto] = alertas(api(fila(1, haceDias(10), 308), fila(2, REF, 300)));
  assert.equal(resto.length, 0);
  assert.equal(a.codigo, CODIGOS_ALERTA.PERDIDA_PESO);
  assert.equal(a.severidad, 'ATENCION');
  assert.equal(a.mensaje, 'Se registró una pérdida de 8 kg desde el pesaje anterior.');
  assert.deepEqual(a.datos, { pesoAnteriorKg: 308, ultimoPesoKg: 300, diferenciaKg: -8, diasDesdeAnterior: 10, gmdKgDia: -0.8 });
  assert.equal(detalleAlerta(a), 'De 308 kg a 300 kg en 10 días · GMD −0,8 kg/día');
});

test('9b. pérdida decimal formateada es-CO', () => {
  const [a] = alertas(api(fila(1, haceDias(72), 302), fila(2, REF, 296.4)));
  assert.equal(a.mensaje, 'Se registró una pérdida de 5,6 kg desde el pesaje anterior.');
});

test('10. mismo día (GMD null) -> no inventa pérdida', () => {
  const r = api(fila(1, REF, 310), fila(2, REF, 300));
  assert.equal(r.resumen.gmdKgDia, null);
  assert.equal(r.resumen.diasDesdeAnterior, 0);
  assert.deepEqual(alertas(r), []);
});

test('11 y 12. varias alertas: se muestran todas, ordenadas URGENTE > ATENCION', () => {
  const r = alertas(api(fila(1, haceDias(100), 320), fila(2, haceDias(75), 300)));
  assert.deepEqual(codigos(r), ['URGENTE:PESAJE_ATRASADO', 'ATENCION:PERDIDA_DE_PESO']);
  assert.equal(r[0].mensaje, 'Han pasado 75 días desde el último pesaje.');
  assert.equal(r[1].mensaje, 'Se registró una pérdida de 20 kg desde el pesaje anterior.');
  const r2 = alertas(api(fila(1, haceDias(50), 320), fila(2, haceDias(45), 300)));
  assert.deepEqual(codigos(r2), ['ATENCION:PESAJE_ATRASADO', 'ATENCION:PERDIDA_DE_PESO'], 'empate: orden estable');
});

test('13. fecha de referencia determinística: mismo input -> mismo output; no lee el reloj', () => {
  const r = api(fila(1, '2026-01-01', 300));
  const realNow = Date.now;
  try {
    Date.now = () => { throw new Error('no debe leer el reloj'); };
    const a = construirAlertasPesajes({ pesajes: r.pesajes, resumen: r.resumen, fechaReferencia: '2026-01-31' });
    const b = construirAlertasPesajes({ pesajes: r.pesajes, resumen: r.resumen, fechaReferencia: '2026-03-02' });
    assert.deepEqual(a, []);
    assert.equal(b[0].severidad, 'ATENCION');
    assert.equal(b[0].datos.diasDesdeUltimoPesaje, 60);
    assert.deepEqual(construirAlertasPesajes({ pesajes: r.pesajes, resumen: r.resumen, fechaReferencia: '2026-03-02' }), b);
  } finally {
    Date.now = realNow;
  }
});

test('13b. la fecha de referencia cruza meses/años bisiestos sin desfase horario', () => {
  const r = api(fila(1, '2024-02-28', 300));
  assert.equal(construirAlertasPesajes({ pesajes: r.pesajes, resumen: r.resumen, fechaReferencia: '2024-03-30' })[0].datos.diasDesdeUltimoPesaje, 31);
});

test('14. configuración personalizada', () => {
  const r = api(fila(1, haceDias(20), 300));
  assert.deepEqual(alertas(r, { configuracion: { diasAtencion: 14, diasUrgente: 21 } }).map((a) => a.severidad), ['ATENCION']);
  assert.deepEqual(alertas(r, { configuracion: { diasAtencion: 7, diasUrgente: 14 } }).map((a) => a.severidad), ['URGENTE']);
  assert.deepEqual(alertas(r, { configuracion: { diasUrgente: 90 } }), [], 'parcial: combina con los provisionales');
  const uno = alertas(api(fila(1, haceDias(1), 300)), { configuracion: { diasAtencion: 0, diasUrgente: 0 } });
  assert.equal(uno[0].mensaje, 'Ha pasado 1 día desde el último pesaje.');
  for (const mala of [{ diasAtencion: 60, diasUrgente: 30 }, { diasAtencion: -1 }, { diasUrgente: 1.5 }, { diasAtencion: '30' }]) {
    assert.throws(() => resolverConfiguracionAlertas(mala), RangeError, JSON.stringify(mala));
  }
});

test('15. nulls y entradas parciales no rompen', () => {
  assert.deepEqual(construirAlertasPesajes({ fechaReferencia: REF }).map((a) => a.codigo), [CODIGOS_ALERTA.SIN_PESAJES]);
  assert.deepEqual(construirAlertasPesajes({ pesajes: null, resumen: null, fechaReferencia: REF }).map((a) => a.severidad), ['INFO']);
  const r = api(fila(1, haceDias(90), 300));
  assert.deepEqual(construirAlertasPesajes({ pesajes: r.pesajes, resumen: r.resumen, fechaReferencia: null }), [], 'sin referencia: no inventa días');
  assert.deepEqual(construirAlertasPesajes({ pesajes: r.pesajes, resumen: r.resumen, fechaReferencia: '2026-02-30' }), []);
  // Solo historial (sin resumen) y solo resumen (sin historial).
  const p = api(fila(1, haceDias(80), 308), fila(2, haceDias(70), 300));
  assert.deepEqual(codigos(construirAlertasPesajes({ pesajes: p.pesajes, fechaReferencia: REF })), ['URGENTE:PESAJE_ATRASADO', 'ATENCION:PERDIDA_DE_PESO']);
  assert.deepEqual(codigos(construirAlertasPesajes({ resumen: p.resumen, fechaReferencia: REF })), ['URGENTE:PESAJE_ATRASADO', 'ATENCION:PERDIDA_DE_PESO']);
  // Un solo pesaje: sin anterior -> nunca pérdida.
  assert.deepEqual(alertas(api(fila(1, REF, 300))), []);
  // Último pesaje posterior a la referencia (zona horaria): sin alerta.
  assert.deepEqual(alertas(api(fila(1, sumarDias(REF, 1), 300))), []);
});

test('objetos estables: solo {codigo, severidad, mensaje, datos}; sin umbrales productivos', () => {
  const r = alertas(api(fila(1, haceDias(100), 320), fila(2, haceDias(75), 300)));
  for (const a of r) assert.deepEqual(Object.keys(a), ['codigo', 'severidad', 'mensaje', 'datos']);
  assert.doesNotMatch(JSON.stringify(r), /excelente|bueno|malo|cr[ií]tico|nacimiento/i);
});

test('detalle: dato que origina la alerta de atraso; INFO sin detalle', () => {
  const [a] = alertas(api(fila(1, haceDias(45), 300)));
  assert.equal(detalleAlerta(a), `Último pesaje: 05/09/2026 · Referencia: 20/10/2026`);
  assert.equal(detalleAlerta(alertas(api())[0]), null);
});
