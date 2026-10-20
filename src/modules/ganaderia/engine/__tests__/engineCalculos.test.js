// FASE 0 -- motor ganadero: fechas calendario, edad Business, pesajes/GMD,
// categoría oficial y genética. Entradas fijas (sin reloj) -> 0 flaky.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  aFechaISO,
  diasEntre,
  esFechaISOValida,
  mesesDecimalesEntre,
  mesesYDiasEntre,
  sumarDias,
  sumarMeses,
} from '../fechas.js';
import { calcularEdadAnimal, datosNacimiento, formatearEdad } from '../edad.js';
import {
  calcularGMD,
  calcularGananciaAcumulada,
  calcularTendenciaGMD,
  clasificarAntiguedadPesaje,
  enriquecerPesajes,
  ordenarPesajes,
} from '../pesajes.js';
import { resolverCategoriaProductiva, sexoAnimal } from '../categoria.js';
import {
  esPuro,
  formatComposicionRacial,
  formatPercent,
  porcentajePrincipal,
  razaPrincipal,
  validarComposicionRacial,
} from '../genetica.js';

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

describe('FECHAS calendario (sin zona horaria)', () => {
  test('valida fechas reales; rechaza imposibles', () => {
    assert.equal(esFechaISOValida('2024-02-29'), true);
    assert.equal(esFechaISOValida('2023-02-29'), false);
    assert.equal(esFechaISOValida('2025-13-01'), false);
    assert.equal(esFechaISOValida('2025-04-31'), false);
    assert.equal(aFechaISO('2025-03-10T23:59:59.000Z'), '2025-03-10');
    assert.equal(aFechaISO('basura'), null);
    assert.equal(aFechaISO(null), null);
    assert.equal(aFechaISO(new Date(2025, 0, 5, 23, 30)), '2025-01-05');
  });

  test('días entre fechas: fin de mes, febrero, bisiesto, cambio de año', () => {
    assert.equal(diasEntre('2025-01-31', '2025-02-01'), 1);
    assert.equal(diasEntre('2025-02-28', '2025-03-01'), 1);
    assert.equal(diasEntre('2024-02-28', '2024-03-01'), 2);
    assert.equal(diasEntre('2024-12-31', '2025-01-01'), 1);
    assert.equal(diasEntre('2024-01-01', '2025-01-01'), 366);
    assert.equal(diasEntre('2025-03-10', '2025-03-01'), -9);
    assert.equal(diasEntre('2025-03-10', 'x'), null);
    // Cambio de horario (no existe en Colombia, pero el cálculo no depende de la zona).
    assert.equal(diasEntre('2025-03-08', '2025-03-10'), 2);
  });

  test('sumar días y meses (acota al fin de mes)', () => {
    assert.equal(sumarDias('2024-12-31', 1), '2025-01-01');
    assert.equal(sumarDias('2024-03-01', -1), '2024-02-29');
    assert.equal(sumarMeses('2025-01-31', 1), '2025-02-28');
    assert.equal(sumarMeses('2024-01-31', 1), '2024-02-29');
    assert.equal(sumarMeses('2024-11-30', 3), '2025-02-28');
    assert.equal(sumarMeses('2025-03-15', -14), '2024-01-15');
  });

  test('meses y días de calendario', () => {
    assert.deepEqual(mesesYDiasEntre('2024-01-31', '2024-02-29'), { meses: 1, dias: 0 });
    assert.deepEqual(mesesYDiasEntre('2024-01-31', '2024-02-28'), { meses: 0, dias: 28 });
    assert.deepEqual(mesesYDiasEntre('2023-12-15', '2024-03-20'), { meses: 3, dias: 5 });
    assert.equal(mesesYDiasEntre('2024-03-20', '2024-03-19'), null);
    close(mesesDecimalesEntre('2025-01-01', '2025-01-16'), 15 / 31);
    assert.equal(mesesDecimalesEntre('2020-02-29', '2025-02-28'), 60);
  });
});

describe('EDAD según modelo Business', () => {
  test('EXACTA: 6, 60 y 84 meses desde fecha_nacimiento', () => {
    const base = { nacimientoTipo: 'EXACTA', fechaNacimiento: '2018-06-15' };
    assert.equal(calcularEdadAnimal(base, '2018-12-15').mesesCompletos, 6);
    assert.equal(calcularEdadAnimal(base, '2023-06-15').mesesCompletos, 60);
    const e84 = calcularEdadAnimal(base, '2025-06-15');
    assert.equal(e84.meses, 84);
    assert.equal(e84.mesesCompletos, 84);
    assert.equal(e84.diasTotales, diasEntre('2018-06-15', '2025-06-15'));
    assert.equal(formatearEdad(e84), '7 años');
  });

  test('EXACTA: año bisiesto (29-feb) y fecha objetivo anterior al nacimiento', () => {
    const bisiesto = { nacimiento_tipo: 'EXACTA', fecha_nacimiento: '2020-02-29' };
    assert.equal(calcularEdadAnimal(bisiesto, '2021-02-28').mesesCompletos, 12);
    assert.equal(calcularEdadAnimal(bisiesto, '2021-03-01').mesesCompletos, 12);
    assert.equal(calcularEdadAnimal(bisiesto, '2020-02-28').meses, null);
  });

  test('APROXIMADA: se proyecta desde edad_referencia_fecha, no desde "hoy"', () => {
    const animal = { nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 24, edadReferenciaFecha: '2024-01-10' };
    assert.equal(calcularEdadAnimal(animal, '2024-01-10').meses, 24);
    assert.equal(calcularEdadAnimal(animal, '2025-01-10').meses, 36);
    close(calcularEdadAnimal(animal, '2024-04-10').meses, 27);
    // Fecha objetivo anterior a la referencia: retrocede.
    assert.equal(calcularEdadAnimal(animal, '2023-01-10').meses, 12);
    // Más atrás que el nacimiento estimado: desconocida.
    assert.equal(calcularEdadAnimal(animal, '2021-01-10').meses, null);
    assert.equal(formatearEdad(calcularEdadAnimal(animal, '2025-01-10')), '≈ 3 años');
    // La misma declaración da edades distintas en fechas distintas (no depende del reloj).
    assert.notEqual(calcularEdadAnimal(animal, '2026-01-10').meses, calcularEdadAnimal(animal, '2024-01-10').meses);
  });

  test('APROXIMADA: 84 meses se mantienen como 84 meses', () => {
    const animal = { nacimiento_tipo: 'APROXIMADA', edad_aproximada_meses: 84, edad_referencia_fecha: '2025-06-01' };
    assert.equal(calcularEdadAnimal(animal, '2025-06-01').meses, 84);
  });

  test('DESCONOCIDA (o datos incompletos): edad null, nunca inventada', () => {
    assert.equal(calcularEdadAnimal({ nacimientoTipo: 'DESCONOCIDA' }, '2025-01-01').meses, null);
    assert.equal(calcularEdadAnimal({ nacimientoTipo: 'EXACTA' }, '2025-01-01').meses, null);
    assert.equal(calcularEdadAnimal({ nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 10 }, '2025-01-01').meses, null);
    assert.equal(calcularEdadAnimal({}, '2025-01-01').tipo, 'DESCONOCIDA');
    assert.equal(calcularEdadAnimal({ fechaNacimiento: '2024-01-01' }, null).meses, null);
    assert.equal(formatearEdad(calcularEdadAnimal({}, '2025-01-01')), 'Edad desconocida');
  });

  test('tipo inferido solo si falta nacimiento_tipo (compatibilidad de forma)', () => {
    assert.equal(datosNacimiento({ fechaNacimiento: '2024-01-01' }).tipo, 'EXACTA');
    assert.equal(datosNacimiento({ edadAproximadaMeses: 5, edadReferenciaFecha: '2024-01-01' }).tipo, 'APROXIMADA');
    assert.equal(datosNacimiento({}).tipo, 'DESCONOCIDA');
  });

  test('edad en días para recién nacidos', () => {
    const animal = { nacimientoTipo: 'EXACTA', fechaNacimiento: '2025-01-01' };
    assert.equal(formatearEdad(calcularEdadAnimal(animal, '2025-01-11')), '10 días');
    assert.equal(formatearEdad(calcularEdadAnimal(animal, '2025-02-06')), '1 mes y 5 días');
  });
});

describe('PESAJES y GMD', () => {
  test('GMD positiva, negativa, cero; sin anterior / mismo día -> null', () => {
    close(calcularGMD(330, 300, 30), 1);
    close(calcularGMD(290, 300, 20), -0.5);
    assert.equal(calcularGMD(300, 300, 15), 0);
    assert.equal(calcularGMD(300, null, 10), null);
    assert.equal(calcularGMD(300, 290, 0), null);
    assert.equal(calcularGMD(300, 290, -3), null);
  });

  test('enriquecimiento: diferencia, días calendario exactos y GMD sin redondeo', () => {
    const filas = enriquecerPesajes([
      { pesajeId: 3, fecha: '2025-03-01', pesoKg: 262.5 },
      { pesajeId: 1, fecha: '2025-01-31', pesoKg: 240 },
      { pesajeId: 2, fecha: '2025-02-28', pesoKg: 250.1 },
    ]);
    assert.deepEqual(filas.map((f) => f.fecha), ['2025-01-31', '2025-02-28', '2025-03-01']);
    assert.equal(filas[0].pesoAnteriorKg, null);
    assert.equal(filas[0].gmdKgDia, null);
    assert.equal(filas[1].diasDesdeAnterior, 28);
    close(filas[1].diferenciaKg, 10.1);
    close(filas[1].gmdKgDia, 10.1 / 28);
    assert.equal(filas[2].diasDesdeAnterior, 1);
    close(filas[2].gmdKgDia, 12.4);
  });

  test('mismo día: orden por pesajeId y GMD null', () => {
    const filas = enriquecerPesajes([
      { pesaje_id: 8, fecha_pesaje: '2025-05-05', peso_kg: '310' },
      { pesaje_id: 7, fecha_pesaje: '2025-05-05', peso_kg: '305' },
    ]);
    assert.deepEqual(filas.map((f) => f.pesoKg), [305, 310]);
    assert.equal(filas[1].diasDesdeAnterior, 0);
    assert.equal(filas[1].gmdKgDia, null);
    assert.equal(filas[1].diferenciaKg, 5);
  });

  test('primer pesaje (REGISTRO_INICIAL) NO es nacimiento: sin edad ni categoría inventadas', () => {
    const [primero] = enriquecerPesajes([
      { pesajeId: 1, fecha: '2025-06-01', pesoKg: 350, origen: 'REGISTRO_INICIAL', observaciones: 'peso al nacimiento' },
    ]);
    assert.equal(primero.pesoKg, 350);
    assert.equal(primero.gmdKgDia, null);
    for (const campo of ['es_peso_nacimiento', 'edad_meses_en_pesaje', 'edad_texto_en_pesaje', 'categoria_evaluada', 'fechaNacimiento']) {
      assert.equal(campo in primero, false, campo);
    }
  });

  test('filas inválidas se descartan (sin fecha, sin peso, peso <= 0)', () => {
    assert.equal(ordenarPesajes([{ fecha: '2025-01-01' }, { pesoKg: 10 }, { fecha: '2025-01-01', pesoKg: 0 }, { fecha: '2025-02-30', pesoKg: 5 }]).length, 0);
  });

  test('ganancia acumulada entre primer y último pesaje', () => {
    const r = calcularGananciaAcumulada([
      { fecha: '2025-01-01', pesoKg: 200 },
      { fecha: '2025-04-11', pesoKg: 260 },
      { fecha: '2025-02-01', pesoKg: 215 },
    ]);
    assert.deepEqual({ ...r, gmdPromedioKgDia: undefined }, { pesoInicialKg: 200, pesoFinalKg: 260, gananciaKg: 60, dias: 100, gmdPromedioKgDia: undefined });
    close(r.gmdPromedioKgDia, 0.6);
    assert.equal(calcularGananciaAcumulada([{ fecha: '2025-01-01', pesoKg: 200 }]), null);
  });

  test('tendencia (heurística ±5 %): mejorando, estable, empeorando, sin datos', () => {
    const conGmd = (...g) => g.map((gmdKgDia) => ({ gmdKgDia }));
    assert.equal(calcularTendenciaGMD(conGmd(0.8, 0.9)).tendencia, 'MEJORANDO');
    assert.equal(calcularTendenciaGMD(conGmd(0.8, 0.82)).tendencia, 'ESTABLE');
    assert.equal(calcularTendenciaGMD(conGmd(0.8, 0.6)).tendencia, 'EMPEORANDO');
    assert.equal(calcularTendenciaGMD(conGmd(0, 0.04)).tendencia, 'ESTABLE');
    assert.equal(calcularTendenciaGMD(conGmd(0.8)).tendencia, 'SIN_DATOS');
    assert.equal(calcularTendenciaGMD(conGmd(0.5, 0.6), { toleranciaRelativa: 0.5 }).tendencia, 'ESTABLE');
  });

  test('antigüedad del último pesaje parametrizable (provisional 30/60)', () => {
    assert.deepEqual(clasificarAntiguedadPesaje('2025-01-01', '2025-01-31'), { estado: 'ACTUALIZADO', dias: 30 });
    assert.equal(clasificarAntiguedadPesaje('2025-01-01', '2025-03-02').estado, 'RECOMENDADO');
    assert.equal(clasificarAntiguedadPesaje('2025-01-01', '2025-03-03').estado, 'ATRASADO');
    assert.equal(clasificarAntiguedadPesaje(null, '2025-03-03').estado, 'SIN_FECHA');
    assert.equal(clasificarAntiguedadPesaje('2025-01-01', '2025-01-20', { diasRecomendado: 7, diasAtrasado: 14 }).estado, 'ATRASADO');
  });
});

describe('CATEGORÍA productiva oficial', () => {
  const catalogo = [
    { categoriaId: '4', codigo: 'vaca_lactancia', nombre: 'Vacas en lactancia', grupoProductivo: 'LECHE' },
    { categoria_id: 9, codigo: 'novillo_ceba', nombre: 'Novillos de ceba', grupo_productivo: 'CEBA' },
  ];

  test('usa la categoría oficial del catálogo por categoria_productiva_id', () => {
    assert.deepEqual(resolverCategoriaProductiva({ categoriaProductivaId: 4 }, catalogo), {
      categoriaId: '4', codigo: 'vaca_lactancia', nombre: 'Vacas en lactancia', grupoProductivo: 'LECHE',
    });
    assert.equal(resolverCategoriaProductiva({ categoria_productiva_id: '9' }, catalogo).codigo, 'novillo_ceba');
  });

  test('sin catálogo usa los datos oficiales serializados por la API', () => {
    assert.deepEqual(
      resolverCategoriaProductiva({ categoriaProductivaId: '4', categoriaProductivaCodigo: 'vaca_lactancia', categoriaProductivaNombre: 'Vacas en lactancia' }),
      { categoriaId: '4', codigo: 'vaca_lactancia', nombre: 'Vacas en lactancia', grupoProductivo: null },
    );
  });

  test('desconocida: sin id o id inexistente -> null; nunca infiere por edad, sexo ni texto', () => {
    assert.equal(resolverCategoriaProductiva({}, catalogo), null);
    assert.equal(resolverCategoriaProductiva({ categoriaProductivaId: 77 }, catalogo), null);
    assert.equal(
      resolverCategoriaProductiva({ sexo: 'HEMBRA', fechaNacimiento: '2015-01-01', categoria: 'vaca lactante gestante', proposito: 'Leche' }, catalogo),
      null,
    );
  });

  test('sexo Business sin alias de texto libre', () => {
    assert.equal(sexoAnimal({ sexo: 'HEMBRA' }), 'HEMBRA');
    assert.equal(sexoAnimal({ sexo: 'hembra' }), null);
    assert.equal(sexoAnimal({}), null);
  });
});

describe('GENÉTICA (composición racial)', () => {
  test('pureza: 100 % puro; 99,5 % puro; < 99,5 % no; varias razas no', () => {
    assert.equal(esPuro([{ porcentaje: 100 }]), true);
    assert.equal(esPuro([{ porcentaje: 99.5 }]), true);
    assert.equal(esPuro([{ porcentaje: 99.49 }]), false);
    assert.equal(esPuro([{ porcentaje: 100 }, { porcentaje: 0 }]), false);
    assert.equal(esPuro([{ porcentaje: '100' }]), true);
  });

  test('nulos e inválidos no rompen y no son puros', () => {
    for (const valor of [null, undefined, [], [{}], [{ porcentaje: null }], [{ porcentaje: 'abc' }], [{ porcentaje: 150 }], 'x']) {
      assert.equal(esPuro(valor), false, JSON.stringify(valor));
    }
    assert.equal(razaPrincipal(null), null);
    assert.equal(porcentajePrincipal([{ porcentaje: 'abc' }]), null);
    assert.equal(formatPercent(null), '--');
    assert.equal(formatComposicionRacial(null), 'Sin composicion racial registrada');
  });

  test('raza principal y composiciones', () => {
    const f1 = [{ nombre_raza: 'Holstein', porcentaje: 50 }, { nombre_raza: 'Gyr', porcentaje: 50 }];
    assert.equal(razaPrincipal(f1).nombre_raza, 'Holstein');
    const tres = [{ nombre_raza: 'A', porcentaje: 37.5 }, { nombre_raza: 'B', porcentaje: 62.5 }];
    assert.equal(porcentajePrincipal(tres), 62.5);
    assert.equal(formatComposicionRacial(tres), 'A 37,5% / B 62,5%');
  });

  test('validación: suma 100 (± 0,01), rangos y valores inválidos', () => {
    assert.deepEqual(validarComposicionRacial([{ porcentaje: 62.5 }, { porcentaje: 37.5 }]), { valida: true, suma: 100, errores: [] });
    assert.equal(validarComposicionRacial([{ porcentaje: 33.33 }, { porcentaje: 33.33 }, { porcentaje: 33.34 }]).valida, true);
    assert.deepEqual(validarComposicionRacial([{ porcentaje: 60 }, { porcentaje: 30 }]).errores, ['SUMA_DISTINTA_DE_100']);
    assert.deepEqual(validarComposicionRacial([{ porcentaje: 120 }, { porcentaje: -20 }]).errores, ['PORCENTAJE_FUERA_DE_RANGO:0', 'PORCENTAJE_FUERA_DE_RANGO:1']);
    assert.deepEqual(validarComposicionRacial([{ porcentaje: null }]).errores, ['PORCENTAJE_INVALIDO:0']);
    assert.deepEqual(validarComposicionRacial([]).errores, ['SIN_COMPOSICION']);
    assert.equal(validarComposicionRacial(null).valida, false);
  });
});
