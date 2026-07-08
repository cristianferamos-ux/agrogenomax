// Motor comun de categoria animal para Ganaderia Inteligente.
// Extraido fielmente de AnimalPesajesTab.jsx (version mas completa y contextual).
// Una sola fuente de verdad para que ficha, pesajes, genetica y demo coincidan.

import {
  valueOf,
  todayISO,
  getFechaNacimientoRealAnimal,
  getFechaNacimientoEstimadaPorEdad,
  calcularEdadEnFecha,
  obtenerEdadMeses,
} from './edad.js';

export function normalizeSex(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['m', 'macho', 'male', 'masculino'].includes(text)) return 'macho';
  if (['h', 'hembra', 'female', 'femenino'].includes(text)) return 'hembra';
  return '';
}

export function categoriaCebaPorSexo(sexo) {
  if (sexo === 'hembra') return 'Novilla de Ceba';
  if (sexo === 'macho') return 'Novillo de Ceba';
  return 'Animal en Ceba';
}

export function categoriaNacimientoPorSexo(animal) {
  const sexo = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  if (sexo === 'hembra') return 'Ternera lactante';
  if (sexo === 'macho') return 'Ternero lactante';
  return 'Cría lactante';
}

// Taxonomia base por edad/sexo (sin contexto productivo). Usada como fallback final
// tanto por clasificarCategoriaPorEdadSexo como por la ficha basica del animal.
export function categoriaBasePorEdadSexo(ageMonths, sexo) {
  if (!Number.isFinite(ageMonths)) return 'Categoría no determinada';

  if (sexo === 'hembra') {
    if (ageMonths < 8) return 'Ternera lactante';
    if (ageMonths < 12) return 'Ternera desteta';
    if (ageMonths < 24) return 'Novilla de levante';
    if (ageMonths < 36) return 'Novilla de desarrollo';
    return 'Vaca adulta';
  }

  if (sexo === 'macho') {
    if (ageMonths < 8) return 'Ternero lactante';
    if (ageMonths < 12) return 'Ternero desteto';
    if (ageMonths < 24) return 'Novillo de levante';
    if (ageMonths < 36) return categoriaCebaPorSexo(sexo);
    return 'Toro adulto';
  }

  if (ageMonths < 8) return 'Cría lactante';
  if (ageMonths < 12) return 'Destete';
  if (ageMonths < 24) return 'Levante';
  if (ageMonths < 36) return 'Desarrollo';
  return 'Adulto productivo';
}

// Categoria contextual (usada por pesajes): sensible a fecha de evaluacion (pesaje historico
// vs. hoy), a si es el primer pesaje (nacimiento) y a contexto productivo opcional
// (gestante/lactante/receptora/reproductor/ceba) leido de campos ya existentes del animal.
export function clasificarCategoriaPorEdadSexo(animal, fechaPesaje = todayISO(), esPrimerPesaje = false, fechaNacimientoFallback = '') {
  if (esPrimerPesaje) return categoriaNacimientoPorSexo(animal);

  const sexo = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  const birth = getFechaNacimientoRealAnimal(animal) || fechaNacimientoFallback || getFechaNacimientoEstimadaPorEdad(animal);
  const age = calcularEdadEnFecha(birth, fechaPesaje);
  const ageMonths = age?.edadMesesDecimal;
  const context = String(
    valueOf(animal, ['proposito', 'propósito', 'categoria', 'categoria_productiva', 'category', 'uso_productivo', 'estado_reproductivo']) || '',
  ).toLowerCase();

  if (sexo === 'hembra' && Number.isFinite(ageMonths)) {
    if (/(gestante)/i.test(context) && ageMonths >= 18) return 'Vaca gestante';
    if (/(lactante)/i.test(context) && ageMonths >= 18) return 'Vaca lactante';
    if (/(receptora|vientre|donadora|reproducci[oó]n)/i.test(context) && ageMonths >= 18) return 'Vientre / receptora';
  }

  if (sexo === 'macho' && Number.isFinite(ageMonths)) {
    if (/(reproductor|toro)/i.test(context) && ageMonths >= 24) return 'Toro reproductor';
    if (/(ceba|engorde)/i.test(context) && ageMonths >= 12) return categoriaCebaPorSexo(sexo);
  }

  return categoriaBasePorEdadSexo(ageMonths, sexo);
}

// Categoria contextual evaluada en la fecha de hoy.
export function clasificarCategoriaActual(animal) {
  return clasificarCategoriaPorEdadSexo(animal, todayISO(), false);
}

// Variante productiva (no sensible a fecha historica, usa edad simple en meses).
// Presente en el archivo original pero sin ningun punto de uso activo hoy; se
// extrae igual por completitud y porque el pedido la incluye explicitamente.
export function clasificarCategoriaProductiva(animal) {
  const ageMonths = obtenerEdadMeses(animal);
  const sexo = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  const context = String(
    valueOf(animal, ['proposito', 'propósito', 'categoria', 'categoria_productiva', 'category', 'uso_productivo']) || '',
  ).toLowerCase();

  if (/(receptora|vientre|donadora|reproducci[oó]n)/i.test(context)) return 'Vientre / receptora';
  if (sexo === 'macho' && /(reproductor|toro)/i.test(context)) return 'Toro reproductor';
  if (/(ceba|engorde)/i.test(context)) return categoriaCebaPorSexo(sexo);

  if (!Number.isFinite(ageMonths)) return 'Categoría no determinada';

  if (sexo === 'hembra') {
    if (ageMonths <= 6) return 'Ternera lactante';
    if (ageMonths <= 12) return 'Ternera desteta / levante inicial';
    if (ageMonths <= 24) return 'Novilla de levante / desarrollo';
    if (ageMonths <= 36) return 'Novilla de vientre / desarrollo final';
    return 'Vaca / vientre adulto';
  }

  if (sexo === 'macho') {
    if (ageMonths <= 6) return 'Ternero lactante';
    if (ageMonths <= 12) return 'Ternero desteto / levante inicial';
    if (ageMonths <= 24) return 'Novillo de levante / desarrollo';
    if (ageMonths <= 36) return categoriaCebaPorSexo(sexo);
    return 'Toro / macho adulto';
  }

  if (ageMonths <= 6) return 'Cría lactante';
  if (ageMonths <= 12) return 'Levante inicial';
  if (ageMonths <= 24) return 'Levante / desarrollo';
  if (ageMonths <= 36) return 'Desarrollo final';
  return 'Adulto productivo';
}
