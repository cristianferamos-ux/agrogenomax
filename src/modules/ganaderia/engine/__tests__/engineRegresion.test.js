// FASE 0 -- regresión de los bugs de la auditoría del motor ganadero,
// arquitectura del motor (funciones puras, Demo aislada) y smoke de la Demo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { calcularEdadAnimal } from '../edad.js';
import { enriquecerPesajes } from '../pesajes.js';
import { resolverCategoriaProductiva } from '../categoria.js';
import { resumenSanitario, sanitaryGeneralStatus } from '../sanidad.js';
import { calcularPromedioLeche } from '../produccionLeche.js';
import { getFechaNacimientoEstimadaPorEdad, obtenerEdadMeses } from '../demo/edadDemo.js';
import { enrichRows, getFechaNacimientoProductiva, isBirthWeightRow } from '../demo/pesajesDemo.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const BUSINESS = ['fechas', 'edad', 'pesajes', 'categoria', 'sanidad', 'produccionLeche', 'genetica', 'index'];
// FASE 1A: fechas y pesajes viven en shared/ (compartidos con el backend);
// src/.../engine/{fechas,pesajes}.js solo los reexportan.
const CANONICO = { fechas: '../../../../../shared/ganaderia/engine/fechas.js', pesajes: '../../../../../shared/ganaderia/engine/pesajes.js' };
const fuente = (nombre) => CANONICO[nombre] ?? `../${nombre}.js`;
const DEMO = ['edadDemo', 'categoriaDemo', 'pesajesDemo'];

describe('REGRESIÓN', () => {
  test('BUG-01: 84 meses nunca se interpretan como 84 días', () => {
    assert.equal(obtenerEdadMeses({ edad_meses: 84 }), 84);
    assert.equal(obtenerEdadMeses({ edad: 84 }), 84);
    assert.equal(obtenerEdadMeses({ edad_meses: '61' }), 61);
    assert.equal(getFechaNacimientoEstimadaPorEdad({ edad_meses: 84 }, '2025-06-15'), '2018-06-15');
    assert.equal(getFechaNacimientoEstimadaPorEdad({ edad_meses: 6 }, '2025-06-15'), '2024-12-15');
    const aprox = { nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 84, edadReferenciaFecha: '2025-01-01' };
    assert.equal(calcularEdadAnimal(aprox, '2025-01-01').meses, 84);
  });

  test('BUG-02: el primer pesaje no se convierte en peso/fecha de nacimiento ni en "lactante"', () => {
    const pesajes = [
      { pesaje_id: 1, fecha_pesaje: '2025-01-10', peso_kg: 380, observaciones: 'Peso inicial al nacimiento (texto engañoso)' },
      { pesaje_id: 2, fecha_pesaje: '2025-02-09', peso_kg: 395 },
    ];
    // Business: sin campos de nacimiento/edad/categoría.
    const business = enriquecerPesajes(pesajes);
    assert.equal(business[0].gmdKgDia, null);
    assert.equal('es_peso_nacimiento' in business[0], false);
    // Demo/legacy: ni regex de observaciones ni "primera fila".
    const animalAdulto = { sexo: 'Hembra', fecha_nacimiento: '2020-03-01' };
    assert.equal(isBirthWeightRow(pesajes[0]), false);
    assert.equal(getFechaNacimientoProductiva({ sexo: 'Hembra' }, pesajes), '');
    assert.equal(getFechaNacimientoProductiva(animalAdulto, pesajes), '2020-03-01');
    const demo = enrichRows(pesajes, null, null, animalAdulto);
    assert.equal(demo[0].es_peso_nacimiento, false);
    assert.notEqual(demo[0].edad_texto_en_pesaje, '----');
    assert.doesNotMatch(demo[0].categoria_evaluada, /lactante/i);
    assert.equal(demo[0].categoria_evaluada, 'Vaca adulta');
    // El dato EXPLÍCITO sigue funcionando (lo usa la Demo).
    const explicito = enrichRows([{ ...pesajes[0], es_peso_nacimiento: true }, pesajes[1]], null, null, { sexo: 'Macho' });
    assert.equal(explicito[0].es_peso_nacimiento, true);
    assert.equal(explicito[0].categoria_evaluada, 'Ternero lactante');
  });

  test('BUG-03: vacuna antigua vencida + refuerzo vigente NO marca el animal como vencido', () => {
    const r = resumenSanitario([
      { catalogoVacunaId: 1, fechaAplicacion: '2024-01-01', proximaAplicacion: '2024-07-01' },
      { catalogoVacunaId: 1, fechaAplicacion: '2024-07-02', proximaAplicacion: '2025-07-02' },
    ], '2025-03-01');
    assert.equal(r.vencidas, 0);
    assert.equal(r.estadoGeneral, 'VIGENTE');
    assert.equal(sanitaryGeneralStatus(r).label, 'Excelente');
  });

  test('BUG-04: el promedio de leche usa 7 días calendario, no 7 registros', () => {
    const registros = [
      ...['2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05'].map((fecha) => ({ fecha, litros_dia: 30 })),
      { fecha: '2025-06-14', litros_dia: 10 },
      { fecha: '2025-06-15', litros_dia: 12 },
    ];
    // Los "últimos 7 registros" darían (5*30 + 10 + 12) / 7 = 24.57; los últimos 7 días solo tienen 2 días.
    assert.equal(calcularPromedioLeche(registros, 7), 11);
  });

  test('BUG-05: la categoría productiva no depende de regex sobre texto libre', () => {
    const catalogo = [{ categoriaId: '3', codigo: 'novilla_levante', nombre: 'Novillas de levante' }];
    const animal = { categoriaProductivaId: '3', categoria: 'Vaca gestante lactante', proposito: 'Leche', estado_reproductivo: 'gestante', sexo: 'HEMBRA' };
    assert.equal(resolverCategoriaProductiva(animal, catalogo).codigo, 'novilla_levante');
    const src = stripComments(read('../categoria.js'));
    assert.doesNotMatch(src, /\.test\(|RegExp|toLowerCase|prop[oó]sito/);
  });
});

describe('ARQUITECTURA del motor', () => {
  test('src/engine/{fechas,pesajes}.js son solo reexportaciones de shared/', () => {
    for (const nombre of ['fechas', 'pesajes']) {
      assert.equal(stripComments(read(`../${nombre}.js`)).trim(), `export * from '../../../../shared/ganaderia/engine/${nombre}.js';`);
    }
  });

  for (const nombre of [...BUSINESS, ...DEMO]) {
    const rel = DEMO.includes(nombre) ? `../demo/${nombre}.js` : fuente(nombre);
    test(`${rel}: puro (sin React, window, document, fetch, storage)`, () => {
      const src = stripComments(read(rel));
      assert.doesNotMatch(src, /\bwindow\b|\bdocument\b|\bfetch\(|localStorage|sessionStorage|from 'react'|import\.meta\.env|XMLHttpRequest/);
    });
  }

  test('el reloj solo se lee en fechas.fechaHoyLocal (inyectable)', () => {
    for (const nombre of BUSINESS) {
      const src = stripComments(read(fuente(nombre)));
      if (nombre === 'fechas') {
        assert.equal((src.match(/new Date\(\)/g) || []).length, 1);
      } else {
        assert.doesNotMatch(src, /new Date\(\)|Date\.now\(/, nombre);
      }
    }
  });

  test('el motor Business no importa la compatibilidad Demo/legacy', () => {
    for (const nombre of BUSINESS) assert.doesNotMatch(read(fuente(nombre)), /from '\.\/demo\//, nombre);
  });

  test('los módulos Demo están etiquetados DEMO / LEGACY', () => {
    for (const nombre of DEMO) assert.match(read(`../demo/${nombre}.js`), /^\/\/ DEMO \/ LEGACY -- NO es regla Business\./, nombre);
  });

  test('el código activo (hato/) no usa la compatibilidad Demo', () => {
    const dir = new URL('../../hato/', import.meta.url);
    for (const file of fs.readdirSync(dir).filter((f) => /\.(js|jsx)$/.test(f))) {
      assert.doesNotMatch(fs.readFileSync(new URL(file, dir), 'utf8'), /engine\/demo\//, file);
    }
  });
});

describe('DEMO sigue funcionando con el motor saneado', () => {
  test('carga de datos Demo: pesajes, sanidad y leche', async () => {
    const { loadDemoData } = await import('../../data/ganaderiaDemoData.js');
    const { coronado, esperanza } = loadDemoData().casos;
    assert.equal(coronado.pesajes.length, 6);
    assert.equal(coronado.pesajes[0].es_peso_nacimiento, true);
    assert.ok(coronado.pesajes.slice(1).every((p) => Number.isFinite(p.ganancia_diaria_kg)));
    assert.match(esperanza.estadoSanitario, /^Excelente/);
    assert.equal(esperanza.produccionLeche.caida.hayCaida, true);
    assert.ok(esperanza.produccionLeche.dias_en_leche >= 140 && esperanza.produccionLeche.dias_en_leche <= 160);
    assert.equal(esperanza.reproduccion.diasEnLeche, esperanza.produccionLeche.dias_en_leche);
    assert.equal(esperanza.produccionLeche.promedio_semanal, Math.round(esperanza.produccionLeche.promedio_semanal * 10) / 10);
  });
});
