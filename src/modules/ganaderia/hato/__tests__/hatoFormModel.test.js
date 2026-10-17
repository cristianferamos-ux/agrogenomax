// SPRINT-3D11.2: modelo puro del formulario de animales -- cuerpo veraz de
// la API (nacimiento, raza con "otra raza conocida", peso), validación
// local, presentación (≈ para estimados) y paridad sexo-categoría con el
// servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_ANIMAL_FORM,
  buildCorreccionBody,
  buildCreateAnimalBody,
  categoriaSigueValida,
  formFromAnimal,
  formatEdad,
  formatPeso,
  formatRaza,
  messageForError,
  newClientOperationId,
  validateAnimalForm,
} from '../hatoFormModel.js';
import { CATEGORIA_SEXOS as FRONT_MAP, categoriasParaSexo } from '../categoriaSexo.js';
import { CATEGORIA_SEXOS as SERVER_MAP } from '../../../../../server/services/ganaderia/categoriaSexoCompat.js';
import { validateCreateAnimalBody } from '../../../../../server/services/ganaderia/animalValidation.js';

const OP = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function form(overrides = {}) {
  return { ...INITIAL_ANIMAL_FORM, predioId: '12', sexo: 'HEMBRA', numeroVisual: ' 045 ', ...overrides };
}

test('cuerpo mínimo de creación: predio, sexo, chapeta; nacimiento y raza DESCONOCIDA; sin peso', () => {
  const body = buildCreateAnimalBody(form(), OP);
  assert.equal(body.clientOperationId, OP);
  assert.equal(body.numeroVisual, '045');
  assert.equal(body.nacimientoTipo, 'DESCONOCIDA');
  assert.equal(body.razaTipo, 'DESCONOCIDA');
  assert.equal(body.pesoInicialKg, null);
  assert.equal(body.pesoInicialMetodo, null);
});

test('"Otra raza conocida" -> PURA + razaOtroNombre (nunca DESCONOCIDA)', () => {
  const body = buildCreateAnimalBody(form({ razaModo: 'OTRA', razaOtroNombre: 'Charolais', razaPrincipalId: '3' }), OP);
  assert.deepEqual(
    [body.razaTipo, body.razaPrincipalId, body.razaOtroNombre, body.cruceDescripcion],
    ['PURA', null, 'Charolais', null],
  );
});

test('raza de catálogo, cruce con/sin predominante y "No sé"', () => {
  assert.equal(buildCreateAnimalBody(form({ razaModo: 'CATALOGO', razaPrincipalId: '3' }), OP).razaPrincipalId, '3');
  const cruce = buildCreateAnimalBody(form({ razaModo: 'CRUCE', cruceDescripcion: 'Mestizo comercial' }), OP);
  assert.deepEqual([cruce.razaTipo, cruce.razaPrincipalId, cruce.cruceDescripcion], ['CRUCE', null, 'Mestizo comercial']);
  const noSe = buildCreateAnimalBody(form({ razaModo: 'DESCONOCIDA', razaPrincipalId: '3', razaOtroNombre: 'x' }), OP);
  assert.deepEqual([noSe.razaTipo, noSe.razaPrincipalId, noSe.razaOtroNombre], ['DESCONOCIDA', null, null]);
});

test('nacimiento veraz: edad aproximada envía solo meses -- nunca una fecha fabricada', () => {
  const body = buildCreateAnimalBody(form({ nacimientoModo: 'APROXIMADA', edadAproximadaMeses: '18', fechaNacimiento: '2024-01-01' }), OP);
  assert.equal(body.edadAproximadaMeses, 18);
  assert.equal(body.fechaNacimiento, null);
  const exacta = buildCreateAnimalBody(form({ nacimientoModo: 'EXACTA', fechaNacimiento: '2024-01-01', edadAproximadaMeses: '18' }), OP);
  assert.equal(exacta.edadAproximadaMeses, null);
});

test('nacido en el predio limpia procedencia y fecha de ingreso', () => {
  const body = buildCreateAnimalBody(form({ origenTipo: 'NACIDO_EN_PREDIO', procedencia: 'Finca X', fechaIngreso: '2025-01-01' }), OP);
  assert.equal(body.procedencia, null);
  assert.equal(body.fechaIngreso, null);
});

test('los cuerpos del frontend pasan la validación real del servidor', () => {
  const casos = [
    form(),
    form({ razaModo: 'OTRA', razaOtroNombre: 'Charolais' }),
    form({ razaModo: 'CRUCE', cruceDescripcion: 'Angus × Brahman', razaPrincipalId: '4' }),
    form({ nacimientoModo: 'APROXIMADA', edadAproximadaMeses: '18', pesoInicialKg: '280,5', pesoInicialMetodo: 'ESTIMADO' }),
    form({ origenTipo: 'COMPRADO', procedencia: 'Subasta', fechaIngreso: '2025-06-01' }),
  ];
  for (const caso of casos) {
    assert.doesNotThrow(() => validateCreateAnimalBody(buildCreateAnimalBody(caso, OP), { hoy: '2026-10-15' }));
  }
});

test('validación local: obligatorios, identidad, raza y peso con método', () => {
  assert.match(validateAnimalForm(form({ predioId: '' })), /predio/);
  assert.match(validateAnimalForm(form({ sexo: '' })), /hembra o macho/);
  assert.match(validateAnimalForm(form({ numeroVisual: ' ', nombre: '' })), /chapeta o el nombre/);
  assert.match(validateAnimalForm(form({ razaModo: 'OTRA' })), /nombre de la raza/);
  assert.match(validateAnimalForm(form({ razaModo: 'CRUCE' })), /cruce/);
  assert.match(validateAnimalForm(form({ pesoInicialKg: '280' })), /cómo obtuvo/);
  assert.match(validateAnimalForm(form({ pesoInicialKg: '280.25', pesoInicialMetodo: 'BASCULA' })), /un decimal/);
  assert.equal(validateAnimalForm(form({ pesoInicialKg: '280', pesoInicialMetodo: 'BASCULA' })), null);
  assert.equal(validateAnimalForm(form({ predioId: '' }), { requirePredio: false }), null);
});

test('presentación: peso estimado con ≈, raza/cruce legibles, edad aproximada con ≈', () => {
  assert.equal(formatPeso({ pesoKg: 280, metodo: 'ESTIMADO' }), '≈ 280 kg');
  assert.equal(formatPeso({ pesoKg: 280, metodo: 'BASCULA' }), '280 kg');
  assert.equal(formatPeso(null), 'Sin peso registrado');
  assert.equal(formatRaza({ razaTipo: 'PURA', razaPrincipalNombre: 'Brahman' }), 'Brahman');
  assert.equal(formatRaza({ razaTipo: 'PURA', razaOtroNombre: 'Charolais' }), 'Charolais');
  assert.equal(formatRaza({ razaTipo: 'CRUCE', cruceDescripcion: 'Angus × Brahman' }), 'Cruce · Angus × Brahman');
  assert.equal(formatRaza({ razaTipo: 'DESCONOCIDA' }), 'Raza no conocida');
  assert.equal(
    formatEdad({ nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 18, edadReferenciaFecha: '2026-07-15' }, '2026-10-15'),
    '≈ 21 meses',
  );
  assert.equal(formatEdad({ nacimientoTipo: 'EXACTA', fechaNacimiento: '2025-04-15' }, '2026-10-15'), '18 meses');
  assert.equal(formatEdad({ nacimientoTipo: 'DESCONOCIDA' }), 'Edad no conocida');
});

test('corrección: formulario desde el animal y cuerpo con fechaActualizacionEsperada, sin predio ni peso', () => {
  const animal = {
    predioId: '12', numeroVisual: '045', nombre: null, sexo: 'MACHO', nacimientoTipo: 'APROXIMADA', fechaNacimiento: null,
    edadAproximadaMeses: 18, razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre: 'Charolais', cruceDescripcion: null,
    categoriaProductivaId: null, origenTipo: null, procedencia: null, fechaIngreso: null, observaciones: null,
  };
  const editForm = formFromAnimal(animal);
  assert.equal(editForm.razaModo, 'OTRA');
  const body = buildCorreccionBody(editForm, '2026-10-15T12:00:00.123456Z');
  assert.equal(body.fechaActualizacionEsperada, '2026-10-15T12:00:00.123456Z');
  for (const forbidden of ['predioId', 'pesoInicialKg', 'pesoInicialMetodo', 'clientOperationId', 'estado']) {
    assert.equal(Object.hasOwn(body, forbidden), false, forbidden);
  }
  assert.equal(body.razaOtroNombre, 'Charolais');
});

test('categorías: filtro por sexo y limpieza al cambiar a un sexo incompatible', () => {
  const categorias = [
    { categoriaId: '1', codigo: 'vaca_seca' },
    { categoriaId: '2', codigo: 'novillo_ceba' },
    { categoriaId: '3', codigo: 'ternero_emposte' },
  ];
  assert.deepEqual(categoriasParaSexo(categorias, 'HEMBRA').map((c) => c.codigo), ['vaca_seca', 'ternero_emposte']);
  assert.deepEqual(categoriasParaSexo(categorias, 'MACHO').map((c) => c.codigo), ['novillo_ceba', 'ternero_emposte']);
  assert.equal(categoriaSigueValida(categorias, '1', 'MACHO'), false);
  assert.equal(categoriaSigueValida(categorias, '3', 'MACHO'), true);
});

test('paridad sexo-categoría frontend == servidor', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(FRONT_MAP).map(([k, v]) => [k, [...v]])),
    Object.fromEntries(Object.entries(SERVER_MAP).map(([k, v]) => [k, [...v]])),
  );
});

test('errores conocidos tienen copy de productor; desconocidos -> mensaje genérico', () => {
  assert.match(messageForError('ANIMAL_NUMERO_VISUAL_DUPLICADO'), /chapeta/);
  assert.match(messageForError('CODIGO_RARO'), /No fue posible/);
});

test('newClientOperationId usa crypto.randomUUID y falla cerrado sin él', () => {
  assert.match(newClientOperationId(), /^[0-9a-f-]{36}$/);
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(newClientOperationId(), null);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
  }
});
