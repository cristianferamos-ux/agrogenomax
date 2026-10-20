// FASE 0 -- motor ganadero: sanidad (estado por vacuna con la última
// aplicación) y producción de leche (días calendario, consolidación por día,
// caída, días en leche). Fecha objetivo SIEMPRE explícita -> 0 flaky.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  claveVacuna,
  estadoAplicacion,
  resumenSanitario,
  sanitaryGeneralStatus,
  ultimasAplicacionesPorVacuna,
  vaccinationStatus,
  daysUntil,
} from '../sanidad.js';
import {
  calcularDiasEnLeche,
  calcularEtapaLactancia,
  calcularPromedioLeche,
  calcularProduccionAcumulada,
  calcularResumenLechero,
  calcularVariacionLeche,
  consolidarLechePorDia,
  detectarCaidaProduccion,
  litrosDeRegistro,
  obtenerEstadoProduccionLeche,
} from '../produccionLeche.js';
import { sumarDias } from '../fechas.js';

const HOY = '2025-06-15';
const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

describe('SANIDAD: estado por aplicación', () => {
  test('vigente, próxima (<= 30 días), vencida, sin programación', () => {
    assert.deepEqual(estadoAplicacion({ proximaAplicacion: '2025-08-01' }, HOY), { estado: 'VIGENTE', diasRestantes: 47 });
    assert.deepEqual(estadoAplicacion({ proxima_aplicacion: '2025-07-15' }, HOY), { estado: 'PROXIMA', diasRestantes: 30 });
    assert.deepEqual(estadoAplicacion({ fecha_proxima: '2025-06-15' }, HOY), { estado: 'PROXIMA', diasRestantes: 0 });
    assert.deepEqual(estadoAplicacion({ fecha_proxima: '2025-06-14' }, HOY), { estado: 'VENCIDA', diasRestantes: -1 });
    assert.deepEqual(estadoAplicacion({}, HOY), { estado: 'SIN_PROGRAMACION', diasRestantes: null });
    assert.equal(estadoAplicacion({ proximaAplicacion: '2025-07-01' }, HOY, { diasAviso: 7 }).estado, 'VIGENTE');
  });

  test('etiquetas de presentación con fecha inyectada', () => {
    assert.equal(vaccinationStatus({ proxima_aplicacion: '2025-06-10' }, HOY), 'Vencida');
    assert.equal(vaccinationStatus({ proxima_aplicacion: '2025-06-20' }, HOY), 'Próxima a vencer');
    assert.equal(daysUntil('2025-06-20T05:00:00.000Z', HOY), 5);
  });
});

describe('SANIDAD: estado por vacuna (última aplicación)', () => {
  const aftosaVieja = { catalogoVacunaId: 1, vacuna: 'Aftosa', fechaAplicacion: '2024-06-01', proximaAplicacion: '2024-12-01' };
  const aftosaRefuerzo = { catalogoVacunaId: 1, vacuna: 'Aftosa', fechaAplicacion: '2024-12-02', proximaAplicacion: '2025-12-02' };

  test('refuerzo vigente reemplaza la dosis histórica vencida', () => {
    const r = resumenSanitario([aftosaVieja, aftosaRefuerzo], HOY);
    assert.equal(r.totalVacunas, 1);
    assert.equal(r.vencidas, 0);
    assert.equal(r.vigentes, 1);
    assert.equal(r.estadoGeneral, 'VIGENTE');
    assert.equal(r.porVacuna[0].aplicacion, aftosaRefuerzo);
    // El orden de llegada no importa.
    assert.equal(resumenSanitario([aftosaRefuerzo, aftosaVieja], HOY).estadoGeneral, 'VIGENTE');
  });

  test('varias vacunas: el estado general es el peor (VENCIDA > PROXIMA > VIGENTE)', () => {
    const brucela = { catalogo_vacuna_id: 2, fecha_aplicacion: '2025-01-01', proxima_aplicacion: '2025-06-01' };
    const carbon = { vacuna: 'Carbón', fecha_aplicacion: '2025-05-01', proxima_aplicacion: '2025-07-01' };
    const r = resumenSanitario([aftosaRefuerzo, brucela, carbon], HOY);
    assert.deepEqual([r.vigentes, r.proximas, r.vencidas], [1, 1, 1]);
    assert.equal(r.estadoGeneral, 'VENCIDA');
    assert.equal(resumenSanitario([aftosaRefuerzo, carbon], HOY).estadoGeneral, 'PROXIMA');
  });

  test('una sin próxima fecha NO degrada a las vigentes', () => {
    const sinFecha = { vacuna: 'Rabia', fechaAplicacion: '2025-02-01' };
    const r = resumenSanitario([aftosaRefuerzo, sinFecha], HOY);
    assert.equal(r.sinProgramacion, 1);
    assert.equal(r.estadoGeneral, 'VIGENTE');
    assert.equal(sanitaryGeneralStatus(r).label, 'Excelente');
  });

  test('todas vigentes, una vencida, solo sin programación, ninguna vacunación', () => {
    assert.equal(resumenSanitario([aftosaRefuerzo], HOY).estadoGeneral, 'VIGENTE');
    assert.equal(resumenSanitario([{ vacuna: 'X', proxima_aplicacion: '2025-01-01' }], HOY).estadoGeneral, 'VENCIDA');
    assert.equal(resumenSanitario([{ vacuna: 'X' }], HOY).estadoGeneral, 'SIN_PROGRAMACION');
    const vacio = resumenSanitario([], HOY);
    assert.equal(vacio.estadoGeneral, 'SIN_REGISTROS');
    assert.equal(vacio.totalVacunas, 0);
    assert.equal(sanitaryGeneralStatus(vacio).label, 'Sin programación');
  });

  test('agrupación: catálogo > nombre normalizado > aplicación individual', () => {
    assert.equal(claveVacuna({ catalogoVacunaId: 5, vacuna: 'X' }), 'catalogo:5');
    assert.equal(claveVacuna({ vacuna: '  Aftosa   Bivalente ' }), 'nombre:aftosa bivalente');
    assert.notEqual(claveVacuna({}, 0), claveVacuna({}, 1));
    assert.equal(ultimasAplicacionesPorVacuna([{ vacuna: 'A' }, { vacuna: 'a' }, { vacuna: 'B' }]).length, 2);
  });

  test('a igual fecha de aplicación gana la registrada después', () => {
    const a = { vacuna: 'A', fechaAplicacion: '2025-01-01', proximaAplicacion: '2025-02-01' };
    const b = { vacuna: 'A', fechaAplicacion: '2025-01-01', proximaAplicacion: '2026-01-01' };
    assert.equal(ultimasAplicacionesPorVacuna([a, b])[0].aplicacion, b);
  });
});

function serie(fechaFinal, litros) {
  // litros[i] = litros del día (fechaFinal - (n-1-i)); null = día sin registro.
  return litros
    .map((l, i) => (l === null ? null : { fecha: sumarDias(fechaFinal, -(litros.length - 1 - i)), litros_dia: l }))
    .filter(Boolean);
}

describe('LECHE: consolidación y promedios por días calendario', () => {
  test('dos ordeños el mismo día se suman antes de promediar; AM + PM soportado', () => {
    const registros = [
      { fecha: '2025-06-14', litros_dia: 8 },
      { fecha: '2025-06-14', litros_dia: 7 },
      { fecha: '2025-06-15', litros_am: 9, litros_pm: 7.5 },
    ];
    assert.deepEqual(consolidarLechePorDia(registros), [
      { fecha: '2025-06-14', litros: 15, registros: 2 },
      { fecha: '2025-06-15', litros: 16.5, registros: 1 },
    ]);
    close(calcularPromedioLeche(registros, 7), 15.75);
    assert.equal(litrosDeRegistro({ litros_am: 9 }), 9);
    assert.equal(litrosDeRegistro({}), null);
  });

  test('promedio 7 días calendario con días sin datos (no "últimos 7 registros")', () => {
    // 20 días con 10 L, luego 3 días sin registro, luego 2 días de 20 L.
    const registros = [...serie('2025-06-10', Array(20).fill(10)), ...serie('2025-06-15', [null, null, null, 20, 20])];
    // Ventana 2025-06-09..15: días con registro 06-09 y 06-10 (10 L) y 06-14, 06-15 (20 L).
    close(calcularPromedioLeche(registros, 7), 15);
    // Ventana explícita.
    close(calcularPromedioLeche(registros, 7, { fechaReferencia: '2025-06-10' }), 10);
    close(calcularPromedioLeche(registros), (20 * 10 + 40) / 22);
    assert.equal(calcularPromedioLeche([], 7), null);
    assert.equal(calcularProduccionAcumulada(registros), 240);
  });
});

describe('LECHE: caída de producción (heurística 15 % / 25 %)', () => {
  const base15 = Array(15).fill(20);
  const conReciente = (...recientes) => serie(HOY, [...base15, ...recientes]);

  test('producción estable: sin caída', () => {
    const r = detectarCaidaProduccion(conReciente(20, 19.8, 20.2));
    assert.equal(r.hayCaida, false);
    assert.equal(r.datosSuficientes, true);
    close(r.variacionPorcentaje, 0);
  });

  test('caída 10 %: no alerta', () => {
    const r = detectarCaidaProduccion(conReciente(18, 18, 18));
    assert.equal(r.hayCaida, false);
    close(r.variacionPorcentaje, 10);
  });

  test('caída 15 %: alerta (Atención)', () => {
    const r = detectarCaidaProduccion(conReciente(17, 17, 17));
    assert.equal(r.hayCaida, true);
    close(r.variacionPorcentaje, 15);
    assert.equal(obtenerEstadoProduccionLeche({ caida: r }).label, 'Atención');
  });

  test('caída 25 %: Crítico', () => {
    const r = detectarCaidaProduccion(conReciente(15, 15, 15));
    close(r.variacionPorcentaje, 25);
    assert.equal(obtenerEstadoProduccionLeche({ caida: r }).label, 'Crítico');
  });

  test('recuperación (subida): variación negativa, sin alerta', () => {
    const r = detectarCaidaProduccion(conReciente(22, 22, 22));
    assert.equal(r.hayCaida, false);
    close(r.variacionPorcentaje, -10);
    assert.equal(obtenerEstadoProduccionLeche({ caida: r }).label, 'Estable');
  });

  test('datos insuficientes: sin alerta y marcado', () => {
    const pocos = serie(HOY, [20, 15]);
    const r = detectarCaidaProduccion(pocos);
    assert.deepEqual(r, { hayCaida: false, variacionPorcentaje: null, datosSuficientes: false });
    assert.equal(calcularVariacionLeche(pocos), null);
  });

  test('ventanas explícitas: base de 15 días inmediatamente anterior (no superpuesta)', () => {
    const v = calcularVariacionLeche(conReciente(17, 17, 17));
    assert.equal(v.ventanaRecienteDias, 3);
    assert.equal(v.ventanaBaseDias, 15);
    assert.equal(v.diasConRegistroReciente, 3);
    assert.equal(v.diasConRegistroBase, 15);
  });
});

describe('LECHE: días en leche y resumen', () => {
  test('días en leche desde la fecha de parto; sin parto -> null', () => {
    assert.equal(calcularDiasEnLeche('2025-01-15', HOY), 151);
    assert.equal(calcularDiasEnLeche(null, HOY), null);
    assert.equal(calcularDiasEnLeche('2025-07-01', HOY), null);
    assert.equal(calcularEtapaLactancia(99), 'Temprana');
    assert.equal(calcularEtapaLactancia(100), 'Media');
    assert.equal(calcularEtapaLactancia(201), 'Tardía');
    assert.equal(calcularEtapaLactancia(null), 'Sin datos');
  });

  test('resumen: DEL desde parto (nunca un campo fijo) y sin redondeo prematuro', () => {
    const registros = serie(HOY, [...Array(15).fill(20), 17, 17, 16]);
    const r = calcularResumenLechero({ registrosLeche: registros, fechaParto: '2025-03-17' });
    assert.equal(r.fecha_referencia, HOY);
    assert.equal(r.dias_en_leche, 90);
    assert.equal(r.etapa_lactancia, 'Temprana');
    assert.equal(r.litros_hoy, 16);
    close(r.promedio_semanal, (20 * 4 + 17 + 17 + 16) / 7);
    assert.equal(r.caida.hayCaida, true);
    const sinParto = calcularResumenLechero({ registrosLeche: registros, fechaParto: null });
    assert.equal(sinParto.dias_en_leche, null);
    assert.equal(sinParto.etapa_lactancia, 'Sin datos');
    // Un campo fijo de días en leche se ignora.
    assert.equal(calcularResumenLechero({ registrosLeche: registros, animal: { dias_en_leche: 150 } }).dias_en_leche, null);
  });
});
