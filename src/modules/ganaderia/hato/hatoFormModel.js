// SPRINT-3D11.2: modelo PURO (sin React ni red) del registro manual de
// animales -- estado del formulario, cuerpo de la API, validación local,
// textos para el productor y ciclo de vida del clientOperationId. Los
// enums técnicos (EXACTA, PURA, BASCULA...) nunca se muestran tal cual.
import { CATEGORIA_SEXOS } from './categoriaSexo.js';

export const NACIMIENTO_MODOS = Object.freeze([
  { value: 'EXACTA', label: 'Sé la fecha de nacimiento' },
  { value: 'APROXIMADA', label: 'Sé aproximadamente cuántos meses tiene' },
  { value: 'DESCONOCIDA', label: 'No la conozco' },
]);

// "Otra raza conocida" es PURA + razaOtroNombre -- nunca DESCONOCIDA.
export const RAZA_MODOS = Object.freeze([
  { value: 'CATALOGO', label: 'Raza conocida' },
  { value: 'OTRA', label: 'Otra raza conocida' },
  { value: 'CRUCE', label: 'Cruce' },
  { value: 'DESCONOCIDA', label: 'No sé' },
]);

export const PESO_METODOS = Object.freeze([
  { value: 'BASCULA', label: 'Pesado en báscula' },
  { value: 'ESTIMADO', label: 'Estimado' },
]);

export const ORIGENES = Object.freeze([
  { value: 'NACIDO_EN_PREDIO', label: 'Nacido en el predio' },
  { value: 'COMPRADO', label: 'Comprado' },
  { value: 'RECIBIDO', label: 'Recibido' },
  { value: 'OTRO', label: 'Otro' },
]);

export const SEXOS = Object.freeze([
  { value: 'HEMBRA', label: 'Hembra' },
  { value: 'MACHO', label: 'Macho' },
]);

export const TIPO_PRODUCTIVO_LABELS = Object.freeze({
  carne: 'Carne',
  leche: 'Leche',
  doble_proposito: 'Doble propósito',
});

export const INITIAL_ANIMAL_FORM = Object.freeze({
  predioId: '',
  numeroVisual: '',
  nombre: '',
  sexo: '',
  nacimientoModo: 'DESCONOCIDA',
  fechaNacimiento: '',
  edadAproximadaMeses: '',
  razaModo: 'DESCONOCIDA',
  razaPrincipalId: '',
  razaOtroNombre: '',
  cruceDescripcion: '',
  categoriaProductivaId: '',
  pesoInicialKg: '',
  pesoInicialMetodo: '',
  origenTipo: '',
  procedencia: '',
  fechaIngreso: '',
  observaciones: '',
});

// UUID de una intención de registro. Solo crypto.randomUUID (contexto
// seguro) -- sin fallback casero: null significa "sin operación segura" y
// el formulario no envía nada (fail-closed).
export function newClientOperationId() {
  return globalThis.crypto?.randomUUID?.() ?? null;
}

function textOrNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function idOrNull(value) {
  return value === '' || value === null || value === undefined ? null : String(value);
}

/**
 * Campos declarados del animal (compartidos por crear y corregir), con la
 * semántica veraz de nacimiento/raza/origen. Nunca incluye predio, peso ni
 * clientOperationId.
 */
export function buildAnimalFields(form) {
  const nacimiento = {
    nacimientoTipo: form.nacimientoModo,
    fechaNacimiento: form.nacimientoModo === 'EXACTA' ? textOrNull(form.fechaNacimiento) : null,
    edadAproximadaMeses: form.nacimientoModo === 'APROXIMADA' && textOrNull(form.edadAproximadaMeses) !== null
      ? Number(form.edadAproximadaMeses)
      : null,
  };

  let raza;
  if (form.razaModo === 'CATALOGO') {
    raza = { razaTipo: 'PURA', razaPrincipalId: idOrNull(form.razaPrincipalId), razaOtroNombre: null, cruceDescripcion: null };
  } else if (form.razaModo === 'OTRA') {
    raza = { razaTipo: 'PURA', razaPrincipalId: null, razaOtroNombre: textOrNull(form.razaOtroNombre), cruceDescripcion: null };
  } else if (form.razaModo === 'CRUCE') {
    raza = {
      razaTipo: 'CRUCE',
      razaPrincipalId: idOrNull(form.razaPrincipalId),
      razaOtroNombre: null,
      cruceDescripcion: textOrNull(form.cruceDescripcion),
    };
  } else {
    raza = { razaTipo: 'DESCONOCIDA', razaPrincipalId: null, razaOtroNombre: null, cruceDescripcion: null };
  }

  const origenTipo = form.origenTipo || null;
  const nacidoEnPredio = origenTipo === 'NACIDO_EN_PREDIO';
  return {
    numeroVisual: textOrNull(form.numeroVisual),
    nombre: textOrNull(form.nombre),
    sexo: form.sexo,
    ...nacimiento,
    ...raza,
    categoriaProductivaId: idOrNull(form.categoriaProductivaId),
    origenTipo,
    procedencia: origenTipo && !nacidoEnPredio ? textOrNull(form.procedencia) : null,
    fechaIngreso: origenTipo && !nacidoEnPredio ? textOrNull(form.fechaIngreso) : null,
    observaciones: textOrNull(form.observaciones),
  };
}

export function buildCreateAnimalBody(form, clientOperationId) {
  const peso = textOrNull(form.pesoInicialKg);
  return {
    clientOperationId,
    predioId: idOrNull(form.predioId),
    ...buildAnimalFields(form),
    pesoInicialKg: peso === null ? null : Number(peso.replace(',', '.')),
    pesoInicialMetodo: peso === null ? null : form.pesoInicialMetodo || null,
  };
}

export function buildCorreccionBody(form, fechaActualizacionEsperada) {
  return { fechaActualizacionEsperada, ...buildAnimalFields(form) };
}

/** Primer problema del formulario en lenguaje del productor, o null. */
export function validateAnimalForm(form, { requirePredio = true, requirePeso = true } = {}) {
  if (requirePredio && !form.predioId) return 'Selecciona el predio.';
  if (!form.sexo) return 'Indica si es hembra o macho.';
  if (!textOrNull(form.numeroVisual) && !textOrNull(form.nombre)) {
    return 'Escribe al menos el número de chapeta o el nombre del animal.';
  }
  if (form.nacimientoModo === 'EXACTA' && !textOrNull(form.fechaNacimiento)) return 'Indica la fecha de nacimiento.';
  if (form.nacimientoModo === 'APROXIMADA') {
    const meses = Number(form.edadAproximadaMeses);
    if (!textOrNull(form.edadAproximadaMeses) || !Number.isInteger(meses) || meses < 0 || meses > 300) {
      return 'Indica la edad aproximada en meses (número entero entre 0 y 300).';
    }
  }
  if (form.razaModo === 'CATALOGO' && !form.razaPrincipalId) return 'Selecciona la raza.';
  if (form.razaModo === 'OTRA' && !textOrNull(form.razaOtroNombre)) return 'Escribe el nombre de la raza.';
  if (form.razaModo === 'CRUCE' && !form.razaPrincipalId && !textOrNull(form.cruceDescripcion)) {
    return 'Describe el cruce o indica la raza predominante.';
  }
  if (requirePeso && textOrNull(form.pesoInicialKg)) {
    const peso = Number(String(form.pesoInicialKg).trim().replace(',', '.'));
    if (!Number.isFinite(peso) || peso <= 0 || peso > 2000 || Math.round(peso * 10) / 10 !== peso) {
      return 'El peso debe estar entre 0 y 2000 kg, con máximo un decimal.';
    }
    if (!form.pesoInicialMetodo) return 'Indica cómo obtuvo el peso.';
  }
  return null;
}

/** Estado del formulario a partir de un animal de la API (para corregir). */
export function formFromAnimal(animal) {
  let razaModo = 'DESCONOCIDA';
  if (animal.razaTipo === 'PURA') razaModo = animal.razaOtroNombre ? 'OTRA' : 'CATALOGO';
  else if (animal.razaTipo === 'CRUCE') razaModo = 'CRUCE';
  return {
    ...INITIAL_ANIMAL_FORM,
    predioId: animal.predioId ?? '',
    numeroVisual: animal.numeroVisual ?? '',
    nombre: animal.nombre ?? '',
    sexo: animal.sexo ?? '',
    nacimientoModo: animal.nacimientoTipo ?? 'DESCONOCIDA',
    fechaNacimiento: animal.fechaNacimiento ?? '',
    edadAproximadaMeses: animal.edadAproximadaMeses === null || animal.edadAproximadaMeses === undefined
      ? ''
      : String(animal.edadAproximadaMeses),
    razaModo,
    razaPrincipalId: animal.razaPrincipalId ?? '',
    razaOtroNombre: animal.razaOtroNombre ?? '',
    cruceDescripcion: animal.cruceDescripcion ?? '',
    categoriaProductivaId: animal.categoriaProductivaId ?? '',
    origenTipo: animal.origenTipo ?? '',
    procedencia: animal.procedencia ?? '',
    fechaIngreso: animal.fechaIngreso ?? '',
    observaciones: animal.observaciones ?? '',
  };
}

/** Al cambiar el sexo, una categoría incompatible se limpia. */
export function categoriaSigueValida(categorias, categoriaProductivaId, sexo) {
  if (!categoriaProductivaId) return true;
  const categoria = (categorias || []).find((c) => c.categoriaId === categoriaProductivaId);
  return Boolean(categoria && CATEGORIA_SEXOS[categoria.codigo]?.includes(sexo));
}

// ---------------------------------------------------------------------
// Presentación (lenguaje del productor, sin ids técnicos)
// ---------------------------------------------------------------------

export function formatIdentidad(animal) {
  if (animal.numeroVisual && animal.nombre) return `${animal.numeroVisual} · ${animal.nombre}`;
  return animal.numeroVisual || animal.nombre || 'Animal sin identificar';
}

export function formatSexo(sexo) {
  return SEXOS.find((s) => s.value === sexo)?.label ?? '—';
}

export function formatRaza(animal) {
  if (animal.razaTipo === 'PURA') return animal.razaPrincipalNombre || animal.razaOtroNombre || '—';
  if (animal.razaTipo === 'CRUCE') {
    const detalle = animal.cruceDescripcion || animal.razaPrincipalNombre;
    return detalle ? `Cruce · ${detalle}` : 'Cruce';
  }
  return 'Raza no conocida';
}

// Un peso estimado nunca se presenta como pesado: "≈ 280 kg".
export function formatPeso(ultimoPeso) {
  if (!ultimoPeso) return 'Sin peso registrado';
  const valor = Number(ultimoPeso.pesoKg).toLocaleString('es-CO', { maximumFractionDigits: 1 });
  return ultimoPeso.metodo === 'ESTIMADO' ? `≈ ${valor} kg` : `${valor} kg`;
}

function mesesEntre(desdeIso, hastaIso) {
  const [y1, m1, d1] = desdeIso.split('-').map(Number);
  const [y2, m2, d2] = hastaIso.split('-').map(Number);
  let meses = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) meses -= 1;
  return Math.max(0, meses);
}

function formatMeses(meses) {
  if (meses < 24) return `${meses} ${meses === 1 ? 'mes' : 'meses'}`;
  const anios = Math.floor(meses / 12);
  return `${anios} años`;
}

export function fechaHoyLocal(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Edad para mostrar. APROXIMADA = meses declarados + meses transcurridos
 * desde la declaración, siempre con "≈" -- nunca se fabrica una fecha de
 * nacimiento.
 */
export function formatEdad(animal, hoy = fechaHoyLocal()) {
  if (animal.nacimientoTipo === 'EXACTA' && animal.fechaNacimiento) {
    return formatMeses(mesesEntre(animal.fechaNacimiento, hoy));
  }
  if (animal.nacimientoTipo === 'APROXIMADA' && animal.edadAproximadaMeses !== null && animal.edadAproximadaMeses !== undefined) {
    const transcurridos = animal.edadReferenciaFecha ? mesesEntre(animal.edadReferenciaFecha, hoy) : 0;
    return `≈ ${formatMeses(animal.edadAproximadaMeses + transcurridos)}`;
  }
  return 'Edad no conocida';
}

export function formatOrigen(origenTipo) {
  return ORIGENES.find((o) => o.value === origenTipo)?.label ?? 'No indicado';
}

const ERROR_MESSAGES = Object.freeze({
  ANIMAL_NUMERO_VISUAL_DUPLICADO: 'Ya hay un animal activo con este número de chapeta.',
  CLIENT_OPERATION_ID_REUSED: 'Este intento ya registró un animal con otros datos. Revisa tu lista de animales antes de continuar.',
  PREDIO_ARCHIVADO: 'El predio está archivado: no admite nuevos animales.',
  PREDIO_NOT_FOUND: 'El predio seleccionado no está disponible.',
  ANIMAL_NOT_FOUND: 'Este animal no está disponible.',
  ANIMAL_ANULADO: 'Este registro está anulado y no admite cambios.',
  ANIMAL_MODIFICADO: 'El animal fue modificado mientras lo editabas. Recargamos sus datos: revisa y vuelve a guardar.',
  CATEGORIA_INCOMPATIBLE_SEXO: 'La categoría no corresponde al sexo del animal.',
  INVALID_RAZA: 'Revisa la raza seleccionada.',
  INVALID_CATEGORIA: 'Revisa la categoría seleccionada.',
  INVALID_NACIMIENTO: 'Revisa los datos de nacimiento o edad.',
  INVALID_PESO: 'Revisa el peso y cómo lo obtuviste.',
  INVALID_ORIGEN: 'Revisa el origen del animal.',
  IDENTIDAD_REQUERIDA: 'Escribe al menos el número de chapeta o el nombre del animal.',
});

export const GENERIC_ERROR_MESSAGE = 'No fue posible completar la acción en este momento. Intenta nuevamente.';
export const NETWORK_UNCERTAIN_MESSAGE = 'No pudimos confirmar si el animal se guardó. Puedes reintentar: no se duplicará.';
export const OPERATION_UNAVAILABLE_MESSAGE = 'No pudimos iniciar una operación segura para registrar el animal. Recarga la página e inténtalo nuevamente.';

export function messageForError(code) {
  return ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE;
}
