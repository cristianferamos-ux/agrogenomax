// SPRINT-3D11.2: validación/normalización pura del dominio Animal y hash
// canónico de la intención de creación (sin DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreateAnimalBody,
  validateCorregirAnimalBody,
  validateListAnimalesQuery,
  validateAnularAnimalBody,
} from '../animalValidation.js';
import {
  CREATION_INTENT_FIELDS_V1,
  buildCreationIntentCanonical,
  computeCreationIntentHash,
} from '../animalIntentHash.js';
import { CATEGORIA_SEXOS, isCategoriaCompatibleConSexo } from '../categoriaSexoCompat.js';

const HOY = '2026-10-15';
const BASE = Object.freeze({
  clientOperationId: '3FA85F64-5717-4562-B3FC-2C963F66AFA6',
  predioId: '12',
  numeroVisual: '045',
  sexo: 'HEMBRA',
  nacimientoTipo: 'DESCONOCIDA',
  razaTipo: 'DESCONOCIDA',
});

function create(overrides = {}) {
  return validateCreateAnimalBody({ ...BASE, ...overrides }, { hoy: HOY });
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('normaliza textos (trim + espacios colapsados), UUID a minúsculas y ids a string; ausentes -> null', () => {
  const value = create({ numeroVisual: '  A   12 ', nombre: '  La  Negra ', predioId: 12, observaciones: '  línea 1\r\nlínea 2  ' });
  assert.equal(value.clientOperationId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(value.numeroVisual, 'A 12');
  assert.equal(value.nombre, 'La Negra');
  assert.equal(value.predioId, '12');
  assert.equal(value.observaciones, 'línea 1\nlínea 2');
  assert.equal(value.categoriaProductivaId, null);
  assert.equal(value.pesoInicialKg, null);
});

test('identidad: chapeta o nombre; vacío/espacios cuentan como ausente', () => {
  assert.equal(codeOf(() => create({ numeroVisual: '  ', nombre: '' })), 'IDENTIDAD_REQUERIDA');
  assert.equal(create({ numeroVisual: null, nombre: 'Lucero' }).nombre, 'Lucero');
});

test('nacimiento veraz: EXACTA solo fecha; APROXIMADA solo meses (entero 0-300); DESCONOCIDA nada; nunca fecha futura ni < 1990', () => {
  assert.equal(create({ nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-02-29' }).fechaNacimiento, '2024-02-29');
  assert.equal(create({ nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 18 }).edadAproximadaMeses, 18);
  assert.equal(codeOf(() => create({ nacimientoTipo: 'EXACTA', fechaNacimiento: '2023-02-29' })), 'INVALID_NACIMIENTO');
  assert.equal(codeOf(() => create({ nacimientoTipo: 'EXACTA', fechaNacimiento: '2026-10-16' })), 'INVALID_NACIMIENTO');
  assert.equal(codeOf(() => create({ nacimientoTipo: 'EXACTA', fechaNacimiento: '1989-12-31' })), 'INVALID_NACIMIENTO');
  assert.equal(codeOf(() => create({ nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 18.5 })), 'INVALID_NACIMIENTO');
  assert.equal(codeOf(() => create({ nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: '18' })), 'INVALID_NACIMIENTO');
  assert.equal(codeOf(() => create({ nacimientoTipo: 'DESCONOCIDA', edadAproximadaMeses: 18 })), 'INVALID_NACIMIENTO');
});

test('raza: PURA catálogo XOR otro nombre; CRUCE predominante y/o descripción, sin otro nombre; DESCONOCIDA sin datos', () => {
  assert.equal(create({ razaTipo: 'PURA', razaPrincipalId: '3' }).razaPrincipalId, '3');
  assert.equal(create({ razaTipo: 'PURA', razaOtroNombre: ' Charolais ' }).razaOtroNombre, 'Charolais');
  assert.equal(create({ razaTipo: 'CRUCE', cruceDescripcion: 'Mestizo comercial' }).razaPrincipalId, null);
  assert.equal(create({ razaTipo: 'CRUCE', razaPrincipalId: '3' }).cruceDescripcion, null);
  for (const invalid of [
    { razaTipo: 'PURA' },
    { razaTipo: 'PURA', razaPrincipalId: '3', razaOtroNombre: 'Charolais' },
    { razaTipo: 'PURA', razaPrincipalId: '3', cruceDescripcion: 'x' },
    { razaTipo: 'CRUCE' },
    { razaTipo: 'CRUCE', razaOtroNombre: 'Charolais', cruceDescripcion: 'x' },
    { razaTipo: 'DESCONOCIDA', razaOtroNombre: 'Charolais' },
    { razaTipo: 'OTRA' },
  ]) {
    assert.equal(codeOf(() => create(invalid)), 'INVALID_RAZA', JSON.stringify(invalid));
  }
});

test('peso inicial: número > 0, <= 2000, máx. un decimal, siempre con método', () => {
  assert.equal(create({ pesoInicialKg: 280.5, pesoInicialMetodo: 'ESTIMADO' }).pesoInicialKg, 280.5);
  for (const invalid of [
    { pesoInicialKg: 280 },
    { pesoInicialMetodo: 'BASCULA' },
    { pesoInicialKg: '280', pesoInicialMetodo: 'BASCULA' },
    { pesoInicialKg: 0, pesoInicialMetodo: 'BASCULA' },
    { pesoInicialKg: 280.25, pesoInicialMetodo: 'BASCULA' },
    { pesoInicialKg: 280, pesoInicialMetodo: 'CINTA' },
  ]) {
    assert.equal(codeOf(() => create(invalid)), 'INVALID_PESO', JSON.stringify(invalid));
  }
});

test('origen: nacido en el predio sin procedencia ni ingreso; procedencia exige origen; ingreso >= nacimiento', () => {
  assert.equal(codeOf(() => create({ origenTipo: 'NACIDO_EN_PREDIO', fechaIngreso: '2025-01-01' })), 'INVALID_ORIGEN');
  assert.equal(codeOf(() => create({ procedencia: 'Finca X' })), 'INVALID_ORIGEN');
  assert.equal(
    codeOf(() => create({ nacimientoTipo: 'EXACTA', fechaNacimiento: '2025-01-02', origenTipo: 'COMPRADO', fechaIngreso: '2025-01-01' })),
    'INVALID_ORIGEN',
  );
  assert.equal(create({ origenTipo: 'COMPRADO', procedencia: 'Subasta', fechaIngreso: '2025-06-01' }).procedencia, 'Subasta');
});

test('rechaza campos no permitidos (organizacionId, estado, predio del servidor, hash)', () => {
  for (const field of ['organizacionId', 'estado', 'creationIntentHash', 'edadReferenciaFecha', 'animalId']) {
    assert.equal(codeOf(() => create({ [field]: 'x' })), 'FORBIDDEN_FIELDS', field);
  }
});

test('hash v1: formato v1:<sha256>, orden fijo de 18 campos, estable ante normalización equivalente', () => {
  assert.equal(CREATION_INTENT_FIELDS_V1.length, 18);
  const a = computeCreationIntentHash(create({ numeroVisual: '  045 ' }));
  const b = computeCreationIntentHash(create({ numeroVisual: '045', clientOperationId: BASE.clientOperationId.toLowerCase() }));
  assert.match(a, /^v1:[0-9a-f]{64}$/);
  assert.equal(a, b);
});

test('hash v1: el peso inicial y su método forman parte de la intención; clientOperationId no', () => {
  const peso280 = computeCreationIntentHash(create({ pesoInicialKg: 280, pesoInicialMetodo: 'BASCULA' }));
  const peso300 = computeCreationIntentHash(create({ pesoInicialKg: 300, pesoInicialMetodo: 'BASCULA' }));
  const estimado = computeCreationIntentHash(create({ pesoInicialKg: 280, pesoInicialMetodo: 'ESTIMADO' }));
  assert.notEqual(peso280, peso300);
  assert.notEqual(peso280, estimado);
  const otraOperacion = computeCreationIntentHash(create({
    pesoInicialKg: 280, pesoInicialMetodo: 'BASCULA', clientOperationId: '11111111-2222-4333-8444-555555555555',
  }));
  assert.equal(peso280, otraOperacion);
});

test('hash v1: excluye edadReferenciaFecha, actor, timestamps, animalId y estado', () => {
  const canonical = JSON.parse(buildCreationIntentCanonical({ ...create(), edadReferenciaFecha: '2026-10-15', estado: 'ACTIVO' }));
  assert.equal(canonical.length, 18);
  for (const excluded of ['edadReferenciaFecha', 'actorCuentaId', 'createdAt', 'animalId', 'estado', 'clientOperationId']) {
    assert.ok(!CREATION_INTENT_FIELDS_V1.includes(excluded), excluded);
  }
});

test('corregir: grupos completos, fecha esperada ISO obligatoria, sin campos inmutables', () => {
  const { cambios } = validateCorregirAnimalBody({
    fechaActualizacionEsperada: '2026-10-15T12:00:00.123456Z',
    razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre: 'Charolais', cruceDescripcion: null,
  }, { hoy: HOY });
  assert.deepEqual(cambios, { razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre: 'Charolais', cruceDescripcion: null });
  assert.equal(
    codeOf(() => validateCorregirAnimalBody({ fechaActualizacionEsperada: '2026-10-15T12:00:00Z', fechaNacimiento: '2024-01-01' }, { hoy: HOY })),
    'INCOMPLETE_CORRECTION_GROUP',
  );
  assert.equal(codeOf(() => validateCorregirAnimalBody({ fechaActualizacionEsperada: 'ayer', sexo: 'MACHO' }, { hoy: HOY })), 'INVALID_FECHA_ACTUALIZACION');
});

test('anular: motivo normalizado y obligatorio', () => {
  assert.deepEqual(validateAnularAnimalBody({ motivo: '  Registro   duplicado ' }), { motivo: 'Registro duplicado' });
  assert.equal(codeOf(() => validateAnularAnimalBody({ motivo: 'x', extra: 1 })), 'FORBIDDEN_FIELDS');
});

test('listado: defaults (ACTIVO, EN_HATO, 50, 0) y límites', () => {
  assert.deepEqual(validateListAnimalesQuery({}), { predioId: null, estado: 'ACTIVO', estadoOperativo: 'EN_HATO', sexo: null, q: null, limit: 50, offset: 0 });
  assert.equal(validateListAnimalesQuery({ estado: 'TODOS', limit: '200', q: '  lo ' }).q, 'lo');
  assert.equal(codeOf(() => validateListAnimalesQuery({ limit: '201' })), 'INVALID_QUERY');
  assert.equal(codeOf(() => validateListAnimalesQuery({ q: ['a', 'b'] })), 'INVALID_QUERY');
});

test('FASE 2B listado: estadoOperativo EN_HATO|SALIDO|MUERTO|TODOS; inválido -> INVALID_QUERY', () => {
  for (const valor of ['EN_HATO', 'SALIDO', 'MUERTO', 'TODOS']) {
    assert.equal(validateListAnimalesQuery({ estadoOperativo: valor }).estadoOperativo, valor);
  }
  assert.equal(validateListAnimalesQuery({ estadoOperativo: '' }).estadoOperativo, 'EN_HATO');
  for (const valor of ['ACTIVO', 'salido', 'VENDIDO']) {
    assert.equal(codeOf(() => validateListAnimalesQuery({ estadoOperativo: valor })), 'INVALID_QUERY', valor);
  }
});

test('categoría-sexo: hembras/machos según código; ternero_emposte ambos; código desconocido no asignable', () => {
  assert.equal(isCategoriaCompatibleConSexo('vaca_seca', 'HEMBRA'), true);
  assert.equal(isCategoriaCompatibleConSexo('vaca_seca', 'MACHO'), false);
  assert.equal(isCategoriaCompatibleConSexo('novillo_ceba', 'MACHO'), true);
  assert.equal(isCategoriaCompatibleConSexo('ternero_emposte', 'MACHO'), true);
  assert.equal(isCategoriaCompatibleConSexo('ternero_emposte', 'HEMBRA'), true);
  assert.equal(isCategoriaCompatibleConSexo('categoria_futura', 'HEMBRA'), false);
  assert.equal(Object.keys(CATEGORIA_SEXOS).length, 13);
});
