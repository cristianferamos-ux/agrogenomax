// Identidad canónica de predio y ambigüedad de búsqueda por punto (Bloque
// 3/4/5): funciones puras, sin red ni base de datos -- resolveCanonicalPredioId
// e isAmbiguousPointMatch son las mismas que usan las tres vías de búsqueda
// (código, coordenadas manuales, "mi ubicación actual" -- las dos últimas
// son la misma llamada POST /lookup, ver auditoría).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAmbiguousPointMatch, resolveCanonicalPredioId } from '../catastrox.js';

test('resolveCanonicalPredioId: con código predial, usa el código normalizado (nunca coordenadas/GPS)', () => {
  assert.equal(
    resolveCanonicalPredioId({ codigoPredial: '18150000300 0000130054000000000'.replace(/\s/g, ''), source: 'legacy', terrenoId: 999 }),
    '181500003000000130054000000000',
  );
});

test('resolveCanonicalPredioId: código con espacios/guiones se normaliza igual que en el resto del módulo', () => {
  const withNoise = '1815-0000300-0000130054000000000';
  const clean = resolveCanonicalPredioId({ codigoPredial: withNoise, source: 'code', terrenoId: null });
  assert.equal(clean, '181500003000000130054000000000');
});

test('resolveCanonicalPredioId: código y coordenadas del mismo predio producen la misma identidad', () => {
  const byCode = resolveCanonicalPredioId({ codigoPredial: '181500003000000130054000000000', source: 'code', terrenoId: null });
  const byPoint = resolveCanonicalPredioId({ codigoPredial: '181500003000000130054000000000', source: 'legacy', terrenoId: 42 });
  assert.equal(byCode, byPoint, 'la identidad depende del código, nunca de la fuente/terrenoId cuando el código existe');
});

test('resolveCanonicalPredioId: sin código predial, usa el respaldo fuente:version:terrenoId', () => {
  const id = resolveCanonicalPredioId({ codigoPredial: null, source: 'clean', terrenoId: 'fid-777' });
  assert.match(id, /^clean:v.+:fid-777$/);
});

test('resolveCanonicalPredioId: el respaldo nunca incluye latitud/longitud', () => {
  const id = resolveCanonicalPredioId({ codigoPredial: null, source: 'legacy', terrenoId: 5 });
  assert.doesNotMatch(id, /\d+\.\d{4,}/, 'no debe parecer una coordenada de alta precisión');
});

test('isAmbiguousPointMatch: dos filas con la misma prioridad y código distinto -> ambiguo', () => {
  const first = { priority_tier: 0, codigo_predial: 'A' };
  const second = { priority_tier: 0, codigo_predial: 'B' };
  assert.equal(isAmbiguousPointMatch(first, second), true);
});

test('isAmbiguousPointMatch: primera fila cubre (tier 0), segunda solo intersecta (tier 1) -> NO ambiguo (desempate correcto ya existente)', () => {
  const first = { priority_tier: 0, codigo_predial: 'A' };
  const second = { priority_tier: 1, codigo_predial: 'B' };
  assert.equal(isAmbiguousPointMatch(first, second), false);
});

test('isAmbiguousPointMatch: misma prioridad + mismo código + mismo geometry_fingerprint (duplicado físico real del mismo predio) -> NO ambiguo', () => {
  const first = { priority_tier: 0, codigo_predial: 'A', geometry_fingerprint: 'abc123' };
  const second = { priority_tier: 0, codigo_predial: 'A', geometry_fingerprint: 'abc123' };
  assert.equal(isAmbiguousPointMatch(first, second), false);
});

test('isAmbiguousPointMatch: misma prioridad + mismo código + geometry_fingerprint distinto -> ambiguo (mismo código, geometría real distinta)', () => {
  const first = { priority_tier: 0, codigo_predial: 'A', geometry_fingerprint: 'abc123' };
  const second = { priority_tier: 0, codigo_predial: 'A', geometry_fingerprint: 'def456' };
  assert.equal(isAmbiguousPointMatch(first, second), true);
});

test('isAmbiguousPointMatch: misma prioridad + mismo código + geometry_fingerprint ausente en ambas filas -> ambiguo (fail-closed, no comparable)', () => {
  const first = { priority_tier: 0, codigo_predial: 'A' };
  const second = { priority_tier: 0, codigo_predial: 'A' };
  assert.equal(isAmbiguousPointMatch(first, second), true);
});

test('isAmbiguousPointMatch: misma prioridad + mismo código + geometry_fingerprint ausente solo en una fila -> ambiguo (fail-closed)', () => {
  const first = { priority_tier: 0, codigo_predial: 'A', geometry_fingerprint: 'abc123' };
  const second = { priority_tier: 0, codigo_predial: 'A' };
  assert.equal(isAmbiguousPointMatch(first, second), true);
});

test('isAmbiguousPointMatch: sin segunda fila (predio único) -> nunca ambiguo', () => {
  assert.equal(isAmbiguousPointMatch({ priority_tier: 0, codigo_predial: 'A' }, undefined), false);
  assert.equal(isAmbiguousPointMatch({ priority_tier: 0, codigo_predial: 'A' }, null), false);
});

test('isAmbiguousPointMatch: sin primera fila -> nunca ambiguo (nada que comparar)', () => {
  assert.equal(isAmbiguousPointMatch(null, { priority_tier: 0, codigo_predial: 'A' }), false);
});
