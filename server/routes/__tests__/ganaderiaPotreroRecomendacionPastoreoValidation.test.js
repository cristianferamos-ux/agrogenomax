// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas unitarias puras de
// validateRecomendacionPastoreoBody (sin HTTP, sin DB). Cubre: campos
// prohibidos (spoofing de derivados server-side -- §7/§17 del sprint:
// nunca biomasaFrescaKg/materiaSecaPct/utilizacionPct/consumoPctPesoVivo/
// resultados/fichaId/contextoId/categoriaId/organizacionId/predioId/
// potreroId), guardrails de categoriaCodigo/numeroAnimales/pesoPromedioKg,
// y NaN/Infinity/string basura.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRecomendacionPastoreoBody,
  validateCargaAutomaticaBody,
  validateCargaAutomaticaEscenarioBody,
} from '../ganaderiaPotreroRecomendacionPastoreo.js';

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

// -----------------------------------------------------------------------
// SPRINT-3D10.4 FASE 3 §0/§1/§23 -- validateCargaAutomaticaBody/
// validateCargaAutomaticaEscenarioBody: whitelist estricta del motor
// automático. numeroAnimales (input manual) y TODO campo server-side
// (ficha/pastura/MSU/DI/resultado/provenance) deben ser rechazados --
// aquí numeroAnimales JAMÁS es input, ni siquiera en el endpoint manual
// que ya lo permite -- el automático nunca lo acepta.
// -----------------------------------------------------------------------

const BASE_AUTO = {
  categoriaCodigo: 'novillo_ceba',
  pesoPromedioKg: 420,
  fechaIngresoPrevista: '2026-09-10',
};

test('validateCargaAutomaticaBody acepta un body mínimo válido', () => {
  const result = validateCargaAutomaticaBody(BASE_AUTO);
  assert.equal(result.categoriaCodigo, 'novillo_ceba');
  assert.equal(result.pesoPromedioKg, 420);
  assert.equal(result.fechaIngresoPrevista, '2026-09-10');
  assert.equal(result.produccionLecheLDia, null);
});

test('validateCargaAutomaticaBody RECHAZA numeroAnimales -- en el motor automático SIEMPRE es output, nunca input (§1)', () => {
  assert.throws(
    () => validateCargaAutomaticaBody({ ...BASE_AUTO, numeroAnimales: 10 }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('validateCargaAutomaticaBody RECHAZA todos los campos resueltos server-side (§0 del sprint)', () => {
  for (const forbiddenKey of [
    'fichaId', 'fechaAforo', 'tipoPastura', 'generoPastura', 'generoDominante',
    'occupationPolicy', 'policyVersion', 'MSU', 'materiaSecaTotalKg', 'materiaSecaUtilizableKg',
    'materiaSecaPctAplicada', 'utilizacionPctAplicada', 'DI', 'demandaIndividualKgMsDia',
    'numeroAnimalesRecomendado', 'diasPermanenciaRecomendada', 'fechaSalidaEstimada',
    'consumoOperativoKg', 'remanenteOperativoKg', 'margenForrajeKg', 'diasMaximosSoportadosExactos',
    'motivoDuracion', 'confidence', 'provenance', 'organizacionId', 'predioId', 'potreroId',
  ]) {
    assert.throws(
      () => validateCargaAutomaticaBody({ ...BASE_AUTO, [forbiddenKey]: 1 }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('validateCargaAutomaticaBody exige fechaIngresoPrevista con formato YYYY-MM-DD y fecha de calendario real', () => {
  for (const invalida of ['10-09-2026', '2026/09/10', '2026-02-30', '', null, undefined, 20260910]) {
    assert.throws(
      () => validateCargaAutomaticaBody({ ...BASE_AUTO, fechaIngresoPrevista: invalida }),
      (e) => e.code === 'INVALID_FECHA_INGRESO_PREVISTA',
      `fechaIngresoPrevista=${String(invalida)} debía ser rechazada`,
    );
  }
});

test('validateCargaAutomaticaBody reutiliza las mismas validaciones de categoría/peso/leche/ternero del endpoint manual', () => {
  assert.throws(() => validateCargaAutomaticaBody({ ...BASE_AUTO, categoriaCodigo: 'NO VALIDO' }), (e) => e.code === 'INVALID_CATEGORIA_CODIGO');
  assert.throws(() => validateCargaAutomaticaBody({ ...BASE_AUTO, pesoPromedioKg: -1 }), (e) => e.code === 'INVALID_PESO_PROMEDIO');
  const conLeche = validateCargaAutomaticaBody({ ...BASE_AUTO, categoriaCodigo: 'vaca_leche_produccion', produccionLecheLDia: 18, diasEnLeche: 90, grasaLechePct: 3.8 });
  assert.equal(conLeche.grasaLechePct, 3.8);
});

test('validateCargaAutomaticaEscenarioBody exige numeroAnimalesUsuario (entero >= 1)', () => {
  assert.throws(
    () => validateCargaAutomaticaEscenarioBody(BASE_AUTO),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES_USUARIO',
  );
  assert.throws(
    () => validateCargaAutomaticaEscenarioBody({ ...BASE_AUTO, numeroAnimalesUsuario: 0 }),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES_USUARIO',
  );
  assert.throws(
    () => validateCargaAutomaticaEscenarioBody({ ...BASE_AUTO, numeroAnimalesUsuario: 1.5 }),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES_USUARIO',
  );
  const result = validateCargaAutomaticaEscenarioBody({ ...BASE_AUTO, numeroAnimalesUsuario: 15 });
  assert.equal(result.numeroAnimalesUsuario, 15);
});

test('validateCargaAutomaticaEscenarioBody RECHAZA los mismos campos server-side prohibidos que preview/guardar', () => {
  assert.throws(
    () => validateCargaAutomaticaEscenarioBody({ ...BASE_AUTO, numeroAnimalesUsuario: 15, fichaId: 1 }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
});
