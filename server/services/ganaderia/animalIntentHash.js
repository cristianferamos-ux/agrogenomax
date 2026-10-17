// SPRINT-3D11.2: hash canónico versionado de la intención de CREACIÓN de
// un animal (agx.animales.creation_intent_hash, inmutable). Es la ÚNICA
// fuente del protocolo de reintento de POST /api/ganaderia/animales --
// nunca animal_eventos.metadata_json.
//
// Entrada: el valor YA normalizado por validateCreateAnimalBody
// (animalValidation.js) -- textos con trim/espacios colapsados, '' -> null,
// ids como string decimal, números como number. El orden de campos es fijo
// (v1); cambiarlo o agregar campos exige una versión nueva (v2), nunca
// reinterpretar v1. Excluye deliberadamente edadReferenciaFecha (la fija el
// servidor con la fecha del día), actor, timestamps, animalId y estado.
import crypto from 'crypto';

export const CREATION_INTENT_HASH_VERSION = 'v1';

export const CREATION_INTENT_FIELDS_V1 = Object.freeze([
  'predioId',
  'numeroVisual',
  'nombre',
  'sexo',
  'nacimientoTipo',
  'fechaNacimiento',
  'edadAproximadaMeses',
  'razaTipo',
  'razaPrincipalId',
  'razaOtroNombre',
  'cruceDescripcion',
  'categoriaProductivaId',
  'origenTipo',
  'procedencia',
  'fechaIngreso',
  'observaciones',
  'pesoInicialKg',
  'pesoInicialMetodo',
]);

export function buildCreationIntentCanonical(value) {
  return JSON.stringify(CREATION_INTENT_FIELDS_V1.map((field) => {
    const fieldValue = value[field];
    return fieldValue === undefined ? null : fieldValue;
  }));
}

export function computeCreationIntentHash(value) {
  const digest = crypto.createHash('sha256').update(buildCreationIntentCanonical(value), 'utf8').digest('hex');
  return `${CREATION_INTENT_HASH_VERSION}:${digest}`;
}
