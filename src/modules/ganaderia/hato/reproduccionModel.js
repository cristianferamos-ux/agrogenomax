// FASE 4B -- modelo PURO de la pestaña "Reproducción" de la ficha (sin React
// ni red). Consume el contrato de la Fase 4A tal cual:
//   GET  /api/ganaderia/animales/:id/reproduccion           historial + estado
//   POST .../reproduccion/eventos                           registrar (operación)
//   POST .../reproduccion/eventos/:eventoId/anular          anular (administración)
//   POST .../reproduccion/eventos/:eventoId/corregir        corregir (administración)
//
// El estado reproductivo, la gestación estimada y la fecha probable de parto
// los DERIVA el servidor (reproduccionEstado.js): aquí solo se presentan,
// nunca se recalculan. Los catálogos y los campos por tipo replican
// server/services/ganaderia/reproduccionValidation.js (un campo de otro tipo
// -> 400 FORBIDDEN_FIELDS), por eso el body solo lleva los campos del tipo y
// nunca campos vacíos. Los errores pasan por el modelo de la Fase 3C.
import { MENSAJE_ROLE_FORBIDDEN } from '../auth/ganaderiaAuthedRequest.js';
import { MENSAJE_SIN_CONEXION, conCodigoSeguimiento, mensajeError } from '../api/errorModel.js';
import { formatFecha } from './pesajesModel.js';
import { MENSAJE_CSRF, MENSAJE_SESION_EXPIRADA, crearControlOperacion } from './cierreModel.js';

export { crearControlOperacion };

export const MAX_OBSERVACIONES_REPRODUCCION = 500;
export const MAX_MOTIVO_ANULACION = 500;
export const MAX_DIAS_GESTACION = 300;
export const MAX_NUMERO_CRIAS = 4;

// ---------------------------------------------------------------------------
// Catálogos (reproduccionValidation.js) -> texto
// ---------------------------------------------------------------------------

export const TIPOS_EVENTO_REPRODUCTIVO = Object.freeze([
  'CELO_OBSERVADO',
  'SERVICIO_MONTA',
  'INSEMINACION_ARTIFICIAL',
  'IATF',
  'TRANSFERENCIA_EMBRION',
  'DIAGNOSTICO_PRENEZ',
  'ABORTO',
  'PARTO',
]);

export const ETIQUETAS_TIPO_EVENTO = Object.freeze({
  CELO_OBSERVADO: 'Celo observado',
  SERVICIO_MONTA: 'Servicio por monta',
  INSEMINACION_ARTIFICIAL: 'Inseminación artificial',
  IATF: 'IATF',
  TRANSFERENCIA_EMBRION: 'Transferencia de embrión',
  DIAGNOSTICO_PRENEZ: 'Diagnóstico de preñez',
  ABORTO: 'Aborto',
  PARTO: 'Parto',
});

// Estado DERIVADO por el servidor: solo se nombra, sin interpretación clínica.
export const ETIQUETAS_ESTADO_REPRODUCTIVO = Object.freeze({
  SIN_ESTADO: 'Sin estado',
  CICLANDO: 'Ciclando',
  SERVIDA: 'Servida',
  PRENADA: 'Preñada',
  VACIA: 'Vacía',
  POSPARTO: 'Posparto',
  NO_APLICA: 'No aplica',
});

const DESCRIPCION_ESTADO = Object.freeze({
  SIN_ESTADO: 'Sin eventos reproductivos activos.',
  NO_APLICA: 'Los eventos reproductivos se registran sobre hembras.',
});

const opciones = (pares) => Object.freeze(pares.map(([value, label]) => Object.freeze({ value, label })));

export const OPCIONES = Object.freeze({
  intensidadCelo: opciones([['BAJA', 'Baja'], ['MEDIA', 'Media'], ['ALTA', 'Alta']]),
  metodoDeteccion: opciones([
    ['VISUAL', 'Visual'], ['PARCHE_DETECTOR', 'Parche detector'], ['PODOMETRO', 'Podómetro'],
    ['TORO_CELADOR', 'Toro celador'], ['OTRO', 'Otro'],
  ]),
  tipoServicio: opciones([['CONTROLADA', 'Controlada'], ['LIBRE', 'Libre']]),
  embrionConservacion: opciones([['FRESCO', 'Fresco'], ['CONGELADO', 'Congelado']]),
  diagnosticoResultado: opciones([['PRENADA', 'Preñada'], ['VACIA', 'Vacía'], ['DUDOSA', 'Dudosa']]),
  diagnosticoMetodo: opciones([['PALPACION', 'Palpación'], ['ECOGRAFIA', 'Ecografía'], ['OTRO', 'Otro']]),
  partoTipo: opciones([['NORMAL', 'Normal'], ['ASISTIDO', 'Asistido'], ['CESAREA', 'Cesárea'], ['OTRO', 'Otro']]),
});

export function etiquetaOpcion(campo, valor) {
  return OPCIONES[campo]?.find((o) => o.value === valor)?.label ?? null;
}

// ---------------------------------------------------------------------------
// Campos del formulario por tipo (contrato 4A)
// ---------------------------------------------------------------------------

// kind: select (OPCIONES[campo]) | texto (max) | entero (min/max) | toro.
// toroAnimalId / toroExterno se editan juntos en el control "toro".
export const CAMPOS = Object.freeze({
  intensidadCelo: { kind: 'select', label: 'Intensidad' },
  metodoDeteccion: { kind: 'select', label: 'Método de detección' },
  tipoServicio: { kind: 'select', label: 'Tipo de servicio', required: true },
  toroAnimalId: { kind: 'toro', label: 'Toro del hato' },
  toroExterno: { kind: 'texto', label: 'Toro externo', max: 120 },
  semenCodigo: { kind: 'texto', label: 'Código de semen', max: 80 },
  protocoloIatf: { kind: 'texto', label: 'Protocolo IATF', max: 120 },
  tecnico: { kind: 'texto', label: 'Técnico', max: 120 },
  embrionCodigo: { kind: 'texto', label: 'Código del embrión', max: 80 },
  embrionRaza: { kind: 'texto', label: 'Raza / cruce', max: 120 },
  embrionDonadora: { kind: 'texto', label: 'Donadora', max: 120 },
  embrionEstadio: { kind: 'texto', label: 'Estadio', max: 40 },
  embrionCalidad: { kind: 'texto', label: 'Calidad', max: 40 },
  embrionConservacion: { kind: 'select', label: 'Conservación', required: true },
  diagnosticoResultado: { kind: 'select', label: 'Resultado', required: true },
  diagnosticoMetodo: { kind: 'select', label: 'Método', required: true },
  diasGestacion: { kind: 'entero', label: 'Días de gestación', min: 1, max: MAX_DIAS_GESTACION },
  abortoCausa: { kind: 'texto', label: 'Causa', max: 200 },
  partoTipo: { kind: 'select', label: 'Tipo de parto', required: true },
  numeroCrias: { kind: 'entero', label: 'Número de crías', min: 1, max: MAX_NUMERO_CRIAS, required: true },
});

// Orden de presentación = orden del formulario. En TE, toroExterno es la
// genética / padre del embrión (no hay toro del hato).
export const CAMPOS_POR_TIPO = Object.freeze({
  CELO_OBSERVADO: Object.freeze(['intensidadCelo', 'metodoDeteccion']),
  SERVICIO_MONTA: Object.freeze(['tipoServicio', 'toroAnimalId', 'toroExterno']),
  INSEMINACION_ARTIFICIAL: Object.freeze(['toroAnimalId', 'toroExterno', 'semenCodigo', 'tecnico']),
  IATF: Object.freeze(['protocoloIatf', 'toroAnimalId', 'toroExterno', 'semenCodigo', 'tecnico']),
  TRANSFERENCIA_EMBRION: Object.freeze([
    'embrionCodigo', 'embrionRaza', 'embrionDonadora', 'toroExterno',
    'embrionEstadio', 'embrionCalidad', 'embrionConservacion', 'tecnico',
  ]),
  DIAGNOSTICO_PRENEZ: Object.freeze(['diagnosticoResultado', 'diagnosticoMetodo', 'diasGestacion', 'tecnico']),
  ABORTO: Object.freeze(['diasGestacion', 'abortoCausa']),
  PARTO: Object.freeze(['partoTipo', 'numeroCrias']),
});

const ETIQUETA_CAMPO_POR_TIPO = Object.freeze({
  TRANSFERENCIA_EMBRION: Object.freeze({ toroExterno: 'Genética / padre' }),
  SERVICIO_MONTA: Object.freeze({ toroExterno: 'Toro externo' }),
  INSEMINACION_ARTIFICIAL: Object.freeze({ toroExterno: 'Toro / pajilla externa' }),
  IATF: Object.freeze({ toroExterno: 'Toro / pajilla externa' }),
});

export function etiquetaCampo(tipoEvento, campo) {
  return ETIQUETA_CAMPO_POR_TIPO[tipoEvento]?.[campo] ?? CAMPOS[campo]?.label ?? campo;
}

const TODOS_LOS_CAMPOS = Object.freeze(Object.keys(CAMPOS));

/** Formulario vacío (todo texto: los <input> trabajan con strings). */
export function formInicialEvento(tipoEvento = '', hoy = '') {
  const form = { tipoEvento, fechaEvento: hoy, horaEvento: '', observaciones: '' };
  for (const campo of TODOS_LOS_CAMPOS) form[campo] = '';
  if (tipoEvento === 'PARTO') form.numeroCrias = '1';
  return form;
}

/** Corrección: formulario PRECARGADO con el evento original (de su `detalle`). */
export function formDesdeEvento(evento) {
  const form = formInicialEvento(evento?.tipoEvento ?? '');
  form.fechaEvento = evento?.fechaEvento ?? '';
  form.horaEvento = evento?.horaEvento ?? '';
  form.observaciones = evento?.observaciones ?? '';
  const detalle = evento?.detalle && typeof evento.detalle === 'object' ? evento.detalle : {};
  for (const campo of TODOS_LOS_CAMPOS) {
    if (detalle[campo] !== undefined && detalle[campo] !== null) form[campo] = String(detalle[campo]);
  }
  return form;
}

/** Cambio de tipo: conserva fecha, hora y observaciones; limpia el resto. */
export function cambiarTipoForm(form, tipoEvento) {
  const nuevo = formInicialEvento(tipoEvento, form?.fechaEvento ?? '');
  nuevo.horaEvento = form?.horaEvento ?? '';
  nuevo.observaciones = form?.observaciones ?? '';
  return nuevo;
}

function limpio(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function camposVisibles(form) {
  const propios = CAMPOS_POR_TIPO[form?.tipoEvento] ?? [];
  // diasGestacion en un diagnóstico solo aplica a PRENADA (400 si no).
  if (form?.tipoEvento === 'DIAGNOSTICO_PRENEZ' && form.diagnosticoResultado !== 'PRENADA') {
    return propios.filter((c) => c !== 'diasGestacion');
  }
  return propios;
}

export { camposVisibles as camposDelFormulario };

/**
 * Validación local mínima (el servidor es la autoridad): devuelve
 * { campo: mensaje } (vacío si es válido).
 */
export function validarEvento(form, { hoy } = {}) {
  const errores = {};
  if (!TIPOS_EVENTO_REPRODUCTIVO.includes(form?.tipoEvento)) {
    errores.tipoEvento = 'Selecciona el tipo de evento.';
    return errores;
  }
  const fecha = limpio(form.fechaEvento);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) errores.fechaEvento = 'Indica la fecha del evento.';
  else if (hoy && fecha > hoy) errores.fechaEvento = 'La fecha no puede ser futura.';
  const hora = limpio(form.horaEvento);
  if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) errores.horaEvento = 'Usa el formato HH:MM.';
  if (limpio(form.observaciones).length > MAX_OBSERVACIONES_REPRODUCCION) {
    errores.observaciones = `Máximo ${MAX_OBSERVACIONES_REPRODUCCION} caracteres.`;
  }
  for (const campo of camposVisibles(form)) {
    const def = CAMPOS[campo];
    const valor = limpio(form[campo]);
    if (!valor) {
      if (def.required) errores[campo] = 'Este dato es obligatorio.';
      continue;
    }
    if (def.kind === 'select' && !OPCIONES[campo].some((o) => o.value === valor)) errores[campo] = 'Selecciona una opción válida.';
    if (def.kind === 'texto' && valor.length > def.max) errores[campo] = `Máximo ${def.max} caracteres.`;
    if (def.kind === 'entero') {
      const n = Number(valor);
      if (!/^\d+$/.test(valor) || n < def.min || n > def.max) errores[campo] = `Debe ser un número entero entre ${def.min} y ${def.max}.`;
    }
    if (def.kind === 'toro' && !/^[1-9]\d{0,17}$/.test(valor)) errores[campo] = 'Selecciona un toro válido.';
  }
  return errores;
}

/**
 * Evento -> body del contrato 4A: SOLO los campos del tipo y nunca vacíos
 * (null/'' no se envían). Enteros como número; toroAnimalId como texto (id).
 */
export function buildEventoBody(form) {
  const body = { tipoEvento: form.tipoEvento, fechaEvento: limpio(form.fechaEvento) };
  const hora = limpio(form.horaEvento);
  if (hora) body.horaEvento = hora;
  for (const campo of camposVisibles(form)) {
    const valor = limpio(form[campo]);
    if (!valor) continue;
    body[campo] = CAMPOS[campo].kind === 'entero' ? Number(valor) : valor;
  }
  const observaciones = limpio(String(form.observaciones ?? '').replace(/\r\n?/g, '\n'));
  if (observaciones) body.observaciones = observaciones;
  return body;
}

export function buildCrearBody(form, clientOperationId) {
  return { ...buildEventoBody(form), clientOperationId };
}

export function buildAnularBody(motivo, clientOperationId) {
  return { motivo: limpio(motivo), clientOperationId };
}

export function buildCorregirBody(form, motivo, clientOperationId) {
  return { motivo: limpio(motivo), clientOperationId, evento: buildEventoBody(form) };
}

export function validarMotivo(motivo) {
  const valor = limpio(motivo);
  if (!valor) return 'Indica el motivo.';
  if (valor.length > MAX_MOTIVO_ANULACION) return `Máximo ${MAX_MOTIVO_ANULACION} caracteres.`;
  return null;
}

// Firma de la INTENCIÓN (acción + evento + datos): un clientOperationId nuevo
// por cada acción y cada cambio de datos; nunca compartido entre crear,
// anular y corregir.
export function firmaOperacion(accion, { eventoId = null, form = null, motivo = '' } = {}) {
  return JSON.stringify([accion, eventoId, form ? buildEventoBody(form) : null, limpio(motivo)]);
}

export const ACCIONES_OPERACION = Object.freeze(['crear', 'anular', 'corregir']);

/**
 * clientOperationId de las tres acciones (un control por acción; nunca
 * comparten UUID). Vive mientras el panel esté montado (sin persistir):
 *   idPara(accion, firma)        misma intención -> mismo id (reintento,
 *                                doble clic, o cerrar y reabrir tras un
 *                                resultado INCIERTO); datos distintos -> id nuevo;
 *   resolver(accion, resultado)  descarta SOLO tras un resultado definitivo
 *                                (éxito o rechazo); un incierto lo conserva.
 * Cerrar o cancelar el formulario NUNCA descarta: el POST pudo haberse
 * guardado y un id nuevo para la misma intención podría duplicarlo.
 */
export function crearOperacionesReproduccion(generarId) {
  const controles = Object.fromEntries(ACCIONES_OPERACION.map((accion) => [accion, crearControlOperacion(generarId)]));
  return {
    idPara(accion, firma) {
      return controles[accion].revisar(firma);
    },
    resolver(accion, resultado) {
      if (resultado?.descartarOperacion) controles[accion].descartar();
    },
    idActual(accion) {
      return controles[accion].id;
    },
  };
}

// ---------------------------------------------------------------------------
// RBAC + disponibilidad (solo UX: el backend es la autoridad)
// ---------------------------------------------------------------------------

export const MENSAJE_REPRODUCCION_OFFLINE = 'Sin conexión. Registrar, anular o corregir eventos reproductivos requiere conexión.';
export const MENSAJE_REGISTRO_SIN_CONEXION = 'Sin conexión: los cambios se guardarán en este dispositivo y se enviarán al recuperar la señal.';

/**
 * Acciones visibles en la pestaña:
 *   registrar  operación (owner/admin/operador) + hembra ACTIVA EN_HATO
 *   administrar  owner/admin (anular / corregir) + registro ACTIVO
 *   habilitado  con conexión
 *   registrarHabilitado, administrarHabilitado  con conexión, o sin ella si el
 *                dispositivo ya descargó el historial reproductivo (registroLocal):
 *                anular y corregir van al outbox (FASE 4E.2B)
 */
export function accionesReproduccion({ animal, sexo, puedeRegistrar, puedeAdministrar, online, registroLocal = false }) {
  const hembra = (sexo ?? animal?.sexo) === 'HEMBRA';
  const activo = animal?.estado === 'ACTIVO';
  const enHato = (animal?.estadoOperativo ?? 'EN_HATO') === 'EN_HATO';
  let aviso = null;
  if (!online) aviso = registroLocal ? MENSAJE_REGISTRO_SIN_CONEXION : MENSAJE_REPRODUCCION_OFFLINE;
  return {
    registrar: Boolean(puedeRegistrar && hembra && activo && enHato),
    administrar: Boolean(puedeAdministrar && hembra && activo),
    habilitado: Boolean(online),
    registrarHabilitado: Boolean(online || registroLocal),
    administrarHabilitado: Boolean(online || registroLocal),
    aviso,
  };
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

/** "dd/mm/yyyy" o "dd/mm/yyyy · HH:MM". */
export function fechaHoraEvento(evento) {
  const fecha = formatFecha(evento?.fechaEvento);
  return evento?.horaEvento ? `${fecha} · ${evento.horaEvento}` : fecha;
}

/** Referencia legible a un toro del hato (mapa id -> identidad); nunca una consulta por fila. */
export function referenciaToro(toroAnimalId, toros) {
  if (!toroAnimalId) return null;
  const nombre = toros?.get?.(String(toroAnimalId));
  return nombre ? nombre : `Animal #${toroAnimalId}`;
}

// Machos de la organización: UNA consulta (listado existente, sexo=MACHO)
// resuelve todas las referencias del historial y llena el selector; nunca
// una consulta por fila. Sin listado (o fuera del límite) -> "Animal #id".
export const LIMITE_TOROS = 200;

/** Respuesta de GET /animales?sexo=MACHO -> { mapa: Map(id -> identidad), opciones activas }. */
export function torosDesdeListado(result, identidad) {
  const lista = result?.ok && Array.isArray(result.data?.animales) ? result.data.animales : [];
  const mapa = new Map();
  const opciones = [];
  for (const a of lista) {
    if (a?.sexo !== 'MACHO' || !a.animalId) continue;
    const nombre = identidad(a);
    mapa.set(String(a.animalId), nombre);
    if (a.estado === 'ACTIVO') opciones.push({ value: String(a.animalId), label: nombre });
  }
  return { mapa, opciones };
}

/** ¿Hace falta resolver toros? (algún evento con toroAnimalId o un formulario que lo admite). */
export function necesitaToros(eventos, tipoFormulario = null) {
  if (tipoFormulario && CAMPOS_POR_TIPO[tipoFormulario]?.includes('toroAnimalId')) return true;
  return (Array.isArray(eventos) ? eventos : []).some((e) => e?.detalle?.toroAnimalId);
}

/** Líneas [etiqueta, valor] del detalle del evento, en el orden del formulario. */
export function detalleEvento(evento, { toros } = {}) {
  const detalle = evento?.detalle && typeof evento.detalle === 'object' ? evento.detalle : {};
  const filas = [];
  for (const campo of CAMPOS_POR_TIPO[evento?.tipoEvento] ?? []) {
    const valor = detalle[campo];
    if (valor === undefined || valor === null || valor === '') continue;
    const def = CAMPOS[campo];
    let texto;
    if (def.kind === 'select') texto = etiquetaOpcion(campo, valor) ?? 'Sin dato';
    else if (def.kind === 'toro') texto = referenciaToro(valor, toros);
    else texto = String(valor);
    filas.push([etiquetaCampo(evento.tipoEvento, campo), texto]);
  }
  return filas;
}

/** Historial cronológico (fecha, luego id) -- el servidor ya lo entrega ASCENDENTE. */
export function ordenarHistorial(eventos) {
  return [...(Array.isArray(eventos) ? eventos : [])].sort((a, b) => {
    if (a.fechaEvento !== b.fechaEvento) return a.fechaEvento < b.fechaEvento ? -1 : 1;
    return Number(a.eventoId) - Number(b.eventoId);
  });
}

/** Relación de corrección legible: { corrige, corregidoPor } (ids) o nulls. */
export function relacionCorreccion(evento) {
  return {
    corrige: evento?.corrigeEventoId ? `Corrige el evento #${evento.corrigeEventoId}` : null,
    corregidoPor: evento?.corregidoPorEventoId ? `Corregido por el evento #${evento.corregidoPorEventoId}` : null,
  };
}

function refTexto(ref) {
  if (!ref) return 'Sin registro';
  return `${ETIQUETAS_TIPO_EVENTO[ref.tipoEvento] ?? 'Evento'} · ${formatFecha(ref.fechaEvento)}`;
}

/**
 * Resumen del estado derivado por el servidor -> { estado, etiqueta,
 * descripcion, desde, filas: [[etiqueta, valor]], gestacion } SIN recalcular
 * fechas: la gestación y la fecha probable de parto vienen del backend.
 */
export function resumenEstado(estado) {
  const codigo = estado?.estado && ETIQUETAS_ESTADO_REPRODUCTIVO[estado.estado] ? estado.estado : 'SIN_ESTADO';
  const resumen = {
    estado: codigo,
    etiqueta: ETIQUETAS_ESTADO_REPRODUCTIVO[codigo],
    descripcion: DESCRIPCION_ESTADO[codigo] ?? null,
    desde: estado?.desde ? formatFecha(estado.desde) : null,
    filas: [],
    gestacion: null,
  };
  if (codigo === 'NO_APLICA') return resumen;
  resumen.filas.push(['Último servicio', refTexto(estado?.ultimoServicio)]);
  const diag = estado?.ultimoDiagnostico;
  if (diag) {
    const resultado = etiquetaOpcion('diagnosticoResultado', diag.resultado) ?? 'Sin dato';
    const dias = diag.diasGestacion ? ` · ${diag.diasGestacion} días` : '';
    resumen.filas.push(['Último diagnóstico', `${resultado} · ${formatFecha(diag.fechaEvento)}${dias}`]);
  } else {
    resumen.filas.push(['Último diagnóstico', 'Sin registro']);
  }
  const parto = estado?.ultimoParto;
  resumen.filas.push(['Último parto', parto
    ? `${formatFecha(parto.fechaEvento)}${parto.numeroCrias ? ` · ${parto.numeroCrias} ${parto.numeroCrias === 1 ? 'cría' : 'crías'}` : ''}`
    : 'Sin registro']);
  const g = estado?.gestacion;
  if (codigo === 'PRENADA' && g) {
    const gestacion = [];
    if (typeof g.diasEstimados === 'number') gestacion.push(['Gestación estimada', `${g.diasEstimados} días`]);
    if (g.fechaConcepcionEstimada) gestacion.push(['Concepción estimada', formatFecha(g.fechaConcepcionEstimada)]);
    if (g.fechaProbableParto) gestacion.push(['Fecha probable de parto', formatFecha(g.fechaProbableParto)]);
    if (g.base) gestacion.push(['Calculada desde', g.base === 'DIAGNOSTICO' ? 'Días del diagnóstico' : 'Fecha del servicio']);
    resumen.gestacion = gestacion;
  }
  return resumen;
}

// ---------------------------------------------------------------------------
// Carga (GET) y resultados de escritura (Fase 3C)
// ---------------------------------------------------------------------------

export const TEXTO_CARGANDO_REPRODUCCION = 'Cargando reproducción…';
export const TEXTO_SIN_EVENTOS = 'No hay eventos reproductivos registrados.';
export const MENSAJE_CARGA_REPRODUCCION = 'No fue posible cargar la información reproductiva.';

/** Resultado del GET -> estado de la pestaña. */
export function estadoCarga(result) {
  if (result?.ok && Array.isArray(result.data?.eventos)) {
    return {
      status: 'ok',
      sexo: result.data.sexo ?? null,
      estado: result.data.estado ?? null,
      eventos: ordenarHistorial(result.data.eventos),
      mensaje: null,
    };
  }
  if (result?.status === 404) return { status: 'not_found', sexo: null, estado: null, eventos: [], mensaje: 'Este animal no está disponible.' };
  return { status: 'error', sexo: null, estado: null, eventos: [], mensaje: mensajeError(result, null, { fallback: MENSAJE_CARGA_REPRODUCCION }) };
}

// Mensajes funcionales por código (4xx). Nunca el `message` del servidor.
export const MENSAJES_ERROR_REPRODUCCION = Object.freeze({
  SEXO_INCOMPATIBLE: 'Los eventos reproductivos solo se registran en hembras.',
  ANIMAL_ANULADO: 'Este registro está anulado y no admite eventos reproductivos.',
  ANIMAL_YA_SALIDO: 'Este animal ya salió del hato y no admite nuevos eventos reproductivos.',
  ANIMAL_YA_MUERTO: 'Este animal está registrado como muerto y no admite nuevos eventos reproductivos.',
  FECHA_ANTERIOR_A_HISTORIAL: 'La fecha es anterior al último evento reproductivo. Un registro retroactivo se hace corrigiendo el evento correspondiente.',
  EVENTO_NO_PERMITIDO_POR_ESTADO: 'Este evento no es compatible con el estado reproductivo actual de la hembra.',
  EVENTO_YA_ANULADO: 'Este evento ya fue anulado o corregido.',
  EVENTO_NOT_FOUND: 'Este evento ya no está disponible. Actualiza el historial.',
  IDENTIDAD_NO_COINCIDE: 'La sesión cambió en este dispositivo: esta operación no se envió. Recarga la página.',
  CLIENT_OPERATION_ID_REUSED: 'Esta operación ya se había usado con otros datos. Revisa el historial y vuelve a intentarlo.',
  INVALID_TORO: 'El toro indicado no es válido: debe ser un macho activo del hato.',
  INVALID_FECHA: 'Revisa la fecha: no puede ser futura ni anterior al nacimiento del animal.',
  INVALID_HORA: 'Revisa la hora: usa el formato HH:MM y no puede ser futura.',
  INVALID_MOTIVO: 'Indica un motivo válido.',
  ANIMAL_NOT_FOUND: 'Este animal no está disponible.',
  ROLE_FORBIDDEN: MENSAJE_ROLE_FORBIDDEN,
});

// Código de validación -> campo del formulario (para marcarlo).
const CAMPO_POR_ERROR = Object.freeze({
  INVALID_FECHA: 'fechaEvento',
  FECHA_ANTERIOR_A_HISTORIAL: 'fechaEvento',
  INVALID_HORA: 'horaEvento',
  INVALID_TORO: 'toroAnimalId',
  INVALID_OBSERVACIONES: 'observaciones',
  INVALID_MOTIVO: 'motivo',
  INVALID_DIAS_GESTACION: 'diasGestacion',
});

// Cambios en el servidor que dejan la vista desactualizada: recargar.
const RECARGAR = new Set([
  'ANIMAL_ANULADO', 'ANIMAL_YA_SALIDO', 'ANIMAL_YA_MUERTO', 'FECHA_ANTERIOR_A_HISTORIAL',
  'EVENTO_NO_PERMITIDO_POR_ESTADO', 'EVENTO_YA_ANULADO', 'EVENTO_NOT_FOUND', 'SEXO_INCOMPATIBLE',
]);

export const MENSAJE_INCIERTO = 'No pudimos confirmar si la operación se guardó. Puedes reintentar: no se duplicará.';

const EXITO = Object.freeze({
  crear: 'Evento reproductivo registrado.',
  anular: 'Evento anulado. Se conserva en el historial.',
  corregir: 'Corrección registrada. El evento original queda anulado en el historial.',
});

/**
 * Respuesta de un POST (crear | anular | corregir) -> { exito, tipo, mensaje,
 * campo?, descartarOperacion, recargar }:
 *   exito                         201 o 200 yaExistia (reintento idempotente)
 *   INCIERTO (red, 5xx)           conserva el clientOperationId (reintento seguro)
 *   resto                         mensaje funcional; descarta la operación
 */
export function resultadoOperacion(accion, result) {
  if (result?.ok && result.data?.evento) {
    const mensaje = result.data.yaExistia ? 'Esta operación ya estaba guardada (no se duplicó).' : EXITO[accion];
    return { exito: true, tipo: result.data.yaExistia ? 'YA_EXISTIA' : 'OK', mensaje, descartarOperacion: true, recargar: true };
  }
  const base = { exito: false, descartarOperacion: true, recargar: false };
  const code = typeof result?.data?.error === 'string' ? result.data.error : null;
  // El POST nunca salió (sin token CSRF): reintentar a mano es seguro.
  if (result?.failure === 'REQUEST_NOT_SENT' || code === 'CSRF_UNAVAILABLE') {
    return { ...base, tipo: 'NO_ENVIADO', descartarOperacion: false, mensaje: MENSAJE_SIN_CONEXION };
  }
  if (!result || result.status === 0 || result.failure === 'NETWORK_ERROR' || code === 'NETWORK_ERROR' || result.status >= 500) {
    return { ...base, tipo: 'INCIERTO', descartarOperacion: false, mensaje: conCodigoSeguimiento(MENSAJE_INCIERTO, result?.correlationId) };
  }
  if (result.failure === 'SESSION_EXPIRED' || result.status === 401) {
    return { ...base, tipo: 'SESION', descartarOperacion: false, mensaje: MENSAJE_SESION_EXPIRADA };
  }
  if (result.failure === 'CSRF_REJECTED') {
    return { ...base, tipo: 'CSRF', descartarOperacion: false, mensaje: MENSAJE_CSRF };
  }
  const mensaje = mensajeError(result, MENSAJES_ERROR_REPRODUCCION);
  return {
    ...base,
    tipo: result.status === 403 ? 'PERMISOS' : 'RECHAZADO',
    codigo: code,
    campo: result.status === 400 || code === 'FECHA_ANTERIOR_A_HISTORIAL' ? CAMPO_POR_ERROR[code] ?? null : null,
    recargar: RECARGAR.has(code),
    mensaje,
  };
}
