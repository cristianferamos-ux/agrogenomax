// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas unitarias puras de
// validateRecomendacionPastoreoBody (sin HTTP, sin DB). Cubre: campos
// prohibidos (spoofing de derivados server-side -- §7/§17 del sprint:
// nunca biomasaFrescaKg/materiaSecaPct/utilizacionPct/consumoPctPesoVivo/
// resultados/fichaId/contextoId/categoriaId/organizacionId/predioId/
// potreroId), guardrails de categoriaCodigo/numeroAnimales/pesoPromedioKg,
// y NaN/Infinity/string basura.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecomendacionPastoreoBody } from '../ganaderiaPotreroRecomendacionPastoreo.js';

const BASE = {
  categoriaCodigo: 'novillo_ceba',
  numeroAnimales: 10,
  pesoPromedioKg: 420,
};

test('acepta un body mínimo válido', () => {
  const result = validateRecomendacionPastoreoBody(BASE);
  assert.equal(result.categoriaCodigo, 'novillo_ceba');
  assert.equal(result.numeroAnimales, 10);
  assert.equal(result.pesoPromedioKg, 420);
  assert.equal(result.produccionLecheLDia, null);
  assert.equal(result.terneroAlPie, null);
});

test('acepta campos condicionales opcionales (produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie)', () => {
  const result = validateRecomendacionPastoreoBody({
    ...BASE,
    categoriaCodigo: 'vaca_leche_produccion',
    produccionLecheLDia: 18.5,
    diasEnLeche: 90,
    grasaLechePct: 3.8,
  });
  assert.equal(result.produccionLecheLDia, 18.5);
  assert.equal(result.diasEnLeche, 90);
  assert.equal(result.grasaLechePct, 3.8);

  const result2 = validateRecomendacionPastoreoBody({
    ...BASE,
    categoriaCodigo: 'vaca_cria_con_ternero',
    terneroAlPie: true,
  });
  assert.equal(result2.terneroAlPie, true);
});

test('acepta un body mínimo sin diasEnLeche/produccionLecheLDia/grasaLechePct -- ausencia es null (la obligatoriedad condicional vive en el repositorio, que conoce la categoría)', () => {
  const result = validateRecomendacionPastoreoBody(BASE);
  assert.equal(result.diasEnLeche, null);
  assert.equal(result.grasaLechePct, null);
});

test('RECHAZA campos derivados server-side (§7/§17 del sprint), nunca aceptados del cliente', () => {
  for (const forbiddenKey of [
    'biomasaFrescaKg', 'materiaSecaPct', 'utilizacionPct', 'consumoPctPesoVivo',
    'materiaSecaTotalKg', 'materiaSecaUtilizableKg', 'demandaDiariaLoteKgMs', 'diasOcupacionEstimados',
    'fichaId', 'contextoId', 'categoriaId', 'nivelConfianza', 'motorVersion',
    'organizacionId', 'predioId', 'potreroId', 'areaHa', 'dryMatterSource',
    'dmiModel', 'fcmKgDay', 'predictedDmiKgDay', 'milkKgDayUsed',
  ]) {
    assert.throws(
      () => validateRecomendacionPastoreoBody({ ...BASE, [forbiddenKey]: 1 }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('rechaza categoriaCodigo ausente/con formato inválido', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, categoriaCodigo: undefined }),
    (e) => e.status === 400 && e.code === 'INVALID_CATEGORIA_CODIGO',
  );
  for (const garbage of ['', 'NOVILLO_CEBA', 'novillo ceba', "novillo_ceba'; drop table x;--", 123, null]) {
    assert.throws(
      () => validateRecomendacionPastoreoBody({ ...BASE, categoriaCodigo: garbage }),
      (e) => e.code === 'INVALID_CATEGORIA_CODIGO',
      `categoriaCodigo=${String(garbage)} debía ser rechazado`,
    );
  }
});

test('numeroAnimales: entero >= 1 y <= 100000', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, numeroAnimales: 0 }),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, numeroAnimales: 1.5 }),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, numeroAnimales: 100001 }),
    (e) => e.code === 'NUMERO_ANIMALES_TOO_HIGH',
  );
});

test('pesoPromedioKg: > 0 y <= 2000 kg', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, pesoPromedioKg: 0 }),
    (e) => e.code === 'INVALID_PESO_PROMEDIO',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, pesoPromedioKg: -10 }),
    (e) => e.code === 'INVALID_PESO_PROMEDIO',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, pesoPromedioKg: 2001 }),
    (e) => e.code === 'PESO_PROMEDIO_TOO_HIGH',
  );
  const result = validateRecomendacionPastoreoBody({ ...BASE, pesoPromedioKg: 2000 });
  assert.equal(result.pesoPromedioKg, 2000);
});

test('produccionLecheLDia: entre 0 y 60 (hardening ronda 3 -- tope realista, antes 100 sin justificación), opcional', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, produccionLecheLDia: -1 }),
    (e) => e.code === 'INVALID_PRODUCCION_LECHE',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, produccionLecheLDia: 61 }),
    (e) => e.code === 'INVALID_PRODUCCION_LECHE',
  );
  const result = validateRecomendacionPastoreoBody({ ...BASE, produccionLecheLDia: 0 });
  assert.equal(result.produccionLecheLDia, 0);
  const resultMax = validateRecomendacionPastoreoBody({ ...BASE, produccionLecheLDia: 60 });
  assert.equal(resultMax.produccionLecheLDia, 60);
});

test('diasEnLeche: > 0 y <= 500, opcional (hardening ronda 3 §1/§3 -- input nuevo, exigido por la ecuación NRC 2001)', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, diasEnLeche: 0 }),
    (e) => e.code === 'INVALID_DIAS_EN_LECHE',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, diasEnLeche: -5 }),
    (e) => e.code === 'INVALID_DIAS_EN_LECHE',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, diasEnLeche: 501 }),
    (e) => e.code === 'INVALID_DIAS_EN_LECHE',
  );
  const result = validateRecomendacionPastoreoBody({ ...BASE, diasEnLeche: 500 });
  assert.equal(result.diasEnLeche, 500);
});

test('grasaLechePct: > 0 y <= 10, opcional (hardening ronda 4 §4 -- SIEMPRE opcional, nunca se obliga al productor a conocerla)', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, grasaLechePct: 0 }),
    (e) => e.code === 'INVALID_GRASA_LECHE',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, grasaLechePct: -1 }),
    (e) => e.code === 'INVALID_GRASA_LECHE',
  );
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, grasaLechePct: 10.1 }),
    (e) => e.code === 'INVALID_GRASA_LECHE',
  );
  const result = validateRecomendacionPastoreoBody({ ...BASE, grasaLechePct: 10 });
  assert.equal(result.grasaLechePct, 10);
});

test('terneroAlPie: debe ser booleano si se envía', () => {
  assert.throws(
    () => validateRecomendacionPastoreoBody({ ...BASE, terneroAlPie: 'si' }),
    (e) => e.code === 'INVALID_TERNERO_AL_PIE',
  );
  const result = validateRecomendacionPastoreoBody({ ...BASE, terneroAlPie: false });
  assert.equal(result.terneroAlPie, false);
});

test('nunca acepta NaN/Infinity/string basura', () => {
  for (const garbage of ['abc', NaN, Infinity, -Infinity, null, undefined, '']) {
    assert.throws(
      () => validateRecomendacionPastoreoBody({ ...BASE, pesoPromedioKg: garbage }),
      (e) => e.code === 'INVALID_PESO_PROMEDIO',
      `pesoPromedioKg=${String(garbage)} debía ser rechazado`,
    );
  }
});
