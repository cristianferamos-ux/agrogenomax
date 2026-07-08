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

// Taxonomia cerrada de proposito productivo. Un mismo sexo/edad puede requerir
// modulos distintos segun para que existe el animal en el hato (ver diseno
// "Logica ganadera por sexo, proposito y produccion de leche").
export const PROPOSITOS_MACHO = [
  'Padrón/Reproductor',
  'Calentador',
  'Levante',
  'Carne/Ceba',
  'Reserva genética',
  'Descarte',
  'Otro',
];

export const PROPOSITOS_HEMBRA = [
  'Donadora',
  'Receptora',
  'Leche',
  'Carne',
  'Cría',
  'Doble propósito',
  'Reemplazo',
  'Descarte',
  'Otro',
];

export function getPropositosPorSexo(sexo) {
  const sexoNormalizado = normalizeSex(sexo);
  if (sexoNormalizado === 'macho') return PROPOSITOS_MACHO;
  if (sexoNormalizado === 'hembra') return PROPOSITOS_HEMBRA;
  return [];
}

function propositoDe(animal) {
  return valueOf(animal, ['proposito_productivo', 'proposito', 'propósito']);
}

// Solo hembra con proposito Leche o Doble proposito. Un macho nunca debe
// mostrar produccion de leche, sin importar su categoria por edad/sexo.
export function aplicaProduccionLeche(animal) {
  const sexo = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  return sexo === 'hembra' && ['Leche', 'Doble propósito'].includes(propositoDe(animal));
}

// Comercializacion directa del animal (no de sus crias). Carne/Ceba y Descarte
// son los casos sin ambiguedad; "Carne" (hembra) y "Doble propósito" comercializan
// principalmente a traves de las crias, por lo que quedan fuera de este gate simple.
export function aplicaComercializacion(animal) {
  return ['Carne/Ceba', 'Descarte'].includes(propositoDe(animal));
}

const SIN_REPRODUCCION_MACHO = ['Levante', 'Carne/Ceba', 'Reserva genética', 'Descarte', 'Otro'];
const SIN_REPRODUCCION_HEMBRA = ['Cría', 'Otro'];

export function aplicaReproduccion(animal) {
  const sexo = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  const proposito = propositoDe(animal);
  if (sexo === 'macho') return !SIN_REPRODUCCION_MACHO.includes(proposito);
  if (sexo === 'hembra') return !SIN_REPRODUCCION_HEMBRA.includes(proposito);
  return false;
}

const GENETICA_PROTAGONISTA = ['Padrón/Reproductor', 'Reserva genética', 'Donadora'];

// Genetica como modulo PRINCIPAL (no solo presente). Aplica a los propositos
// donde la composicion racial/pedigri es el dato que sostiene la decision.
export function aplicaGeneticaComoModuloPrincipal(animal) {
  return GENETICA_PROTAGONISTA.includes(propositoDe(animal));
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
