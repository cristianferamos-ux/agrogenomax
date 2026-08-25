// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §2: pruebas puras del selector
// jerárquico -- sin red, sin DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GRUPOS_PRODUCTIVOS, buildGruposConCategorias } from '../categoriaProductivaSelector.js';

test('define exactamente los 6 grupos de primer nivel del sprint (§2)', () => {
  assert.deepEqual(GRUPOS_PRODUCTIVOS.map((g) => g.grupo), ['cria', 'levante', 'ceba', 'leche', 'reproduccion', 'otro']);
});

test('"vaca_seca" aparece en cría Y leche sin duplicarse como categoría distinta (§2)', () => {
  const cria = GRUPOS_PRODUCTIVOS.find((g) => g.grupo === 'cria');
  const leche = GRUPOS_PRODUCTIVOS.find((g) => g.grupo === 'leche');
  assert.ok(cria.codigos.includes('vaca_seca'));
  assert.ok(leche.codigos.includes('vaca_seca'));
});

test('"toro_reproductor" aparece en cría Y reproducción sin duplicarse (§2)', () => {
  const cria = GRUPOS_PRODUCTIVOS.find((g) => g.grupo === 'cria');
  const reproduccion = GRUPOS_PRODUCTIVOS.find((g) => g.grupo === 'reproduccion');
  assert.ok(cria.codigos.includes('toro_reproductor'));
  assert.ok(reproduccion.codigos.includes('toro_reproductor'));
});

test('"otro" no tiene codigos de catálogo -- se muestra como "próximamente" (§19)', () => {
  const otro = GRUPOS_PRODUCTIVOS.find((g) => g.grupo === 'otro');
  assert.equal(otro.codigos, undefined);
  assert.deepEqual(otro.comingSoon, ['Lote mixto', 'Otro']);
});

const CATEGORIAS_FIXTURE = [
  { codigo: 'vaca_seca', nombre: 'Vacas secas' },
  { codigo: 'novillo_ceba', nombre: 'Novillos de ceba' },
  { codigo: 'toro_reproductor', nombre: 'Toros reproductores' },
];

test('buildGruposConCategorias resuelve cada codigo contra el catálogo real, en el orden definido', () => {
  const grupos = buildGruposConCategorias(CATEGORIAS_FIXTURE);
  const cria = grupos.find((g) => g.grupo === 'cria');
  assert.deepEqual(cria.categorias.map((c) => c.codigo), ['vaca_seca', 'toro_reproductor']);
});

test('buildGruposConCategorias omite codigos que no resuelven contra el catálogo (sin romper)', () => {
  const grupos = buildGruposConCategorias([]);
  for (const grupo of grupos) {
    if (grupo.grupo !== 'otro') assert.deepEqual(grupo.categorias, []);
  }
});

test('buildGruposConCategorias preserva comingSoon del grupo "otro"', () => {
  const grupos = buildGruposConCategorias(CATEGORIAS_FIXTURE);
  const otro = grupos.find((g) => g.grupo === 'otro');
  assert.deepEqual(otro.comingSoon, ['Lote mixto', 'Otro']);
  assert.deepEqual(otro.categorias, []);
});
