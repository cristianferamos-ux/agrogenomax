// SPRINT-3D9.1: pruebas unitarias puras de validateIniciarBody/
// validateCancelarBody (sin HTTP, sin DB). Cubre: campos prohibidos
// (nunca fechas ni derivados server-side), motivo obligatorio no vacío
// al cancelar.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIniciarBody,
  validateCancelarBody,
  validateAnularBody,
  validateCorregirBody,
  validateEvaluarReingresoBody,
} from '../ganaderiaPotreroCicloPastoreo.js';

test('iniciar: body vacío es válido -- el cliente NUNCA está obligado a aportar nada', () => {
  const result = validateIniciarBody({});
  assert.deepEqual(result, { numeroAnimales: undefined, pesoPromedioKg: undefined, categoriaCodigo: undefined });
});

test('iniciar: acepta el ajuste opcional del lote real', () => {
  const result = validateIniciarBody({ numeroAnimales: 9, pesoPromedioKg: 405, categoriaCodigo: 'novillo_ceba' });
  assert.deepEqual(result, { numeroAnimales: 9, pesoPromedioKg: 405, categoriaCodigo: 'novillo_ceba' });
});

test('iniciar: RECHAZA fechaIngresoReal/fechaInicioPastoreo -- el cliente NUNCA aporta una fecha', () => {
  for (const forbidden of ['fechaIngresoReal', 'fechaInicioPastoreo', 'fechaSalidaReal', 'organizacionId', 'cicloId', 'estado']) {
    assert.throws(
      () => validateIniciarBody({ [forbidden]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbidden}`,
    );
  }
});

test('iniciar: tipos incorrectos son rechazados', () => {
  assert.throws(() => validateIniciarBody({ numeroAnimales: '9' }), (e) => e.code === 'INVALID_NUMERO_ANIMALES_REAL');
  assert.throws(() => validateIniciarBody({ pesoPromedioKg: '405' }), (e) => e.code === 'INVALID_PESO_PROMEDIO_REAL');
  assert.throws(() => validateIniciarBody({ categoriaCodigo: 123 }), (e) => e.code === 'INVALID_CATEGORIA_CODIGO');
});

test('cancelar: motivo obligatorio -- vacío/espacios/ausente son rechazados', () => {
  for (const motivoInvalido of [undefined, null, '', '   ']) {
    assert.throws(
      () => validateCancelarBody({ motivo: motivoInvalido }),
      (e) => e.status === 400 && e.code === 'INVALID_MOTIVO_CANCELACION',
    );
  }
});

test('cancelar: acepta un motivo no vacío', () => {
  const result = validateCancelarBody({ motivo: 'lote trasladado por error' });
  assert.deepEqual(result, { motivo: 'lote trasladado por error' });
});

test('cancelar: RECHAZA campos derivados server-side', () => {
  for (const forbidden of ['fechaSalidaReal', 'estado', 'organizacionId']) {
    assert.throws(
      () => validateCancelarBody({ motivo: 'x', [forbidden]: 'y' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
    );
  }
});

// ---------------------------------------------------------------------
// SPRINT-3D9.2: anular -- mismo criterio de motivo obligatorio que cancelar.
// ---------------------------------------------------------------------

test('anular: motivo obligatorio -- vacío/espacios/ausente son rechazados', () => {
  for (const motivoInvalido of [undefined, null, '', '   ']) {
    assert.throws(
      () => validateAnularBody({ motivo: motivoInvalido }),
      (e) => e.status === 400 && e.code === 'INVALID_MOTIVO_ANULACION',
    );
  }
});

test('anular: acepta un motivo no vacío', () => {
  const result = validateAnularBody({ motivo: 'registro duplicado por error' });
  assert.deepEqual(result, { motivo: 'registro duplicado por error' });
});

test('anular: RECHAZA campos derivados server-side', () => {
  for (const forbidden of ['estado', 'fechaSalidaReal', 'organizacionId']) {
    assert.throws(
      () => validateAnularBody({ motivo: 'x', [forbidden]: 'y' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
    );
  }
});

// ---------------------------------------------------------------------
// SPRINT-3D9.2: corregir -- motivo obligatorio + al menos un campo,
// tipos correctos, nunca campos derivados server-side (organizacionId,
// estado, etc.).
// ---------------------------------------------------------------------

test('corregir: motivo obligatorio', () => {
  assert.throws(
    () => validateCorregirBody({ numeroAnimales: 30 }),
    (e) => e.status === 400 && e.code === 'INVALID_MOTIVO_CORRECCION',
  );
});

test('corregir: exige al menos un campo a corregir', () => {
  assert.throws(
    () => validateCorregirBody({ motivo: 'x' }),
    (e) => e.status === 400 && e.code === 'SIN_CAMBIOS_SOLICITADOS',
  );
});

test('corregir: acepta un subconjunto cualquiera de los cinco campos corregibles', () => {
  const result = validateCorregirBody({ motivo: 'peso mal capturado', pesoPromedioKg: 410 });
  assert.deepEqual(result, {
    fechaIngresoReal: undefined, fechaSalidaReal: undefined, categoriaCodigo: undefined,
    numeroAnimales: undefined, pesoPromedioKg: 410, motivo: 'peso mal capturado',
  });
});

test('corregir: tipos incorrectos son rechazados', () => {
  assert.throws(() => validateCorregirBody({ motivo: 'x', fechaIngresoReal: 123 }), (e) => e.code === 'INVALID_FECHA_INGRESO_REAL');
  assert.throws(() => validateCorregirBody({ motivo: 'x', fechaSalidaReal: 123 }), (e) => e.code === 'INVALID_FECHA_SALIDA_REAL');
  assert.throws(() => validateCorregirBody({ motivo: 'x', categoriaCodigo: 1 }), (e) => e.code === 'INVALID_CATEGORIA_CODIGO');
  assert.throws(() => validateCorregirBody({ motivo: 'x', numeroAnimales: '30' }), (e) => e.code === 'INVALID_NUMERO_ANIMALES_REAL');
  assert.throws(() => validateCorregirBody({ motivo: 'x', pesoPromedioKg: '410' }), (e) => e.code === 'INVALID_PESO_PROMEDIO_REAL');
});

test('corregir: RECHAZA campos derivados server-side', () => {
  for (const forbidden of ['organizacionId', 'estado', 'cicloId', 'predioId']) {
    assert.throws(
      () => validateCorregirBody({ motivo: 'x', numeroAnimales: 10, [forbidden]: 'y' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
    );
  }
});

// ---------------------------------------------------------------------
// SPRINT-3D9.2: evaluar reingreso -- fichaId + resultado obligatorios,
// observación obligatoria SOLO para NO_APTO (APTO puede omitirla).
// ---------------------------------------------------------------------

test('evaluar reingreso: fichaId obligatorio', () => {
  assert.throws(
    () => validateEvaluarReingresoBody({ resultado: 'APTO' }),
    (e) => e.status === 400 && e.code === 'INVALID_FICHA_ID',
  );
});

test('evaluar reingreso: resultado debe ser APTO o NO_APTO, ningún otro valor', () => {
  assert.throws(
    () => validateEvaluarReingresoBody({ fichaId: '5', resultado: 'QUIZAS' }),
    (e) => e.code === 'INVALID_RESULTADO_EVALUACION',
  );
});

test('evaluar reingreso: NO_APTO exige observación no vacía', () => {
  for (const observacionInvalida of [undefined, '', '   ']) {
    assert.throws(
      () => validateEvaluarReingresoBody({ fichaId: '5', resultado: 'NO_APTO', observacion: observacionInvalida }),
      (e) => e.code === 'INVALID_OBSERVACION_EVALUACION',
    );
  }
});

test('evaluar reingreso: APTO puede omitir observación', () => {
  const result = validateEvaluarReingresoBody({ fichaId: '5', resultado: 'APTO' });
  assert.deepEqual(result, { fichaId: '5', resultado: 'APTO', observacion: undefined });
});

test('evaluar reingreso: RECHAZA campos derivados server-side', () => {
  for (const forbidden of ['organizacionId', 'descansoId', 'cicloOrigenId']) {
    assert.throws(
      () => validateEvaluarReingresoBody({ fichaId: '5', resultado: 'APTO', [forbidden]: 'y' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
    );
  }
});
