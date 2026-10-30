// FASE 2B -- modelo PURO del cierre operativo del animal (salida / muerte)
// en la UI (sin React, sin red, sin leer el reloj). Lo usan la ficha
// (HatoDetallePage), el formulario de cierre (HatoCierreAnimal), la pestaña
// Pesajes, la sección QR y el listado.
//
// Dos ejes que NUNCA se confunden:
//   Estado del registro  animal.estado          ACTIVO | ANULADO
//   Situación del animal animal.estadoOperativo EN_HATO | SALIDO | MUERTO
// ACTIVO no implica EN_HATO. Sin estadoOperativo (copia offline anterior a
// 0025) la situación es EN_HATO (fallback).
//
// El backend manda: estas validaciones solo evitan viajes inútiles; los
// límites reales (nacimiento, ingreso, último pesaje, fecha de negocio) los
// vuelve a aplicar el servidor con el animal bloqueado.
//
// Deuda documentada: el PDF del reporte productivo (servidor) todavía no
// incorpora la situación del animal ni el cierre.
import { MENSAJE_ROLE_FORBIDDEN } from '../auth/ganaderiaAuthedRequest.js';
import { CAPACIDADES, canCerrarAnimal } from '../auth/ganaderiaPermisos.js';
import { formatFecha } from './pesajesModel.js';

export const SITUACIONES = Object.freeze({ EN_HATO: 'EN_HATO', SALIDO: 'SALIDO', MUERTO: 'MUERTO' });
export const ETIQUETAS_SITUACION = Object.freeze({ EN_HATO: 'En hato', SALIDO: 'Salido', MUERTO: 'Muerto' });
export const ETIQUETAS_ESTADO_REGISTRO = Object.freeze({ ACTIVO: 'Activo', ANULADO: 'Anulado' });

/** Situación con fallback EN_HATO (cache offline sin el campo). */
export function situacionDe(animal) {
  const valor = animal?.estadoOperativo;
  return Object.hasOwn(SITUACIONES, valor ?? '') ? valor : SITUACIONES.EN_HATO;
}

export function animalCerrado(animal) {
  return situacionDe(animal) !== SITUACIONES.EN_HATO;
}

// ---------------------------------------------------------------------------
// Filtros del listado
// ---------------------------------------------------------------------------

export const FILTROS_SITUACION = Object.freeze([
  { value: 'EN_HATO', label: 'En hato' },
  { value: 'SALIDO', label: 'Salidos' },
  { value: 'MUERTO', label: 'Muertos' },
  { value: 'TODOS', label: 'Todos' },
]);
export const FILTROS_ESTADO_REGISTRO = Object.freeze([
  { value: 'ACTIVO', label: 'Activos' },
  { value: 'ANULADO', label: 'Anulados' },
  { value: 'TODOS', label: 'Todos' },
]);
export const FILTROS_LISTADO_DEFAULT = Object.freeze({ estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });

// ---------------------------------------------------------------------------
// Catálogos (= CHECK de 0025 / cierreValidation.js)
// ---------------------------------------------------------------------------

export const MOTIVOS_SALIDA = Object.freeze([
  { value: 'VENTA', label: 'Venta' },
  { value: 'TRASLADO', label: 'Traslado' },
  { value: 'DONACION', label: 'Donación' },
  { value: 'INTERCAMBIO', label: 'Intercambio' },
  { value: 'DEVOLUCION', label: 'Devolución' },
  { value: 'OTRA', label: 'Otra' },
]);
export const CAUSAS_MUERTE = Object.freeze([
  { value: 'MUERTE_NATURAL', label: 'Muerte natural' },
  { value: 'ENFERMEDAD', label: 'Enfermedad' },
  { value: 'ACCIDENTE', label: 'Accidente' },
  { value: 'SACRIFICIO', label: 'Sacrificio' },
  { value: 'DEPREDACION', label: 'Depredación' },
  { value: 'DESCONOCIDA', label: 'Desconocida' },
  { value: 'OTRA', label: 'Otra' },
]);

export const MAX_OBSERVACIONES_CIERRE = 500;

export const CIERRE_CONFIG = Object.freeze({
  SALIDA: Object.freeze({
    tipo: 'SALIDA',
    situacion: 'SALIDO',
    titulo: 'Registrar salida',
    campoFecha: 'fechaSalida',
    campoCausa: 'motivoSalida',
    etiquetaFecha: 'Fecha de salida',
    etiquetaCausa: 'Motivo de salida',
    opciones: MOTIVOS_SALIDA,
    errorCausa: 'Selecciona un motivo.',
    textoConfirmar: 'Confirmar salida',
    textoEnviando: 'Registrando salida...',
    exito: 'Salida registrada. El animal ya no está en el hato.',
  }),
  MUERTE: Object.freeze({
    tipo: 'MUERTE',
    situacion: 'MUERTO',
    titulo: 'Registrar muerte',
    campoFecha: 'fechaMuerte',
    campoCausa: 'causaMuerte',
    etiquetaFecha: 'Fecha de muerte',
    etiquetaCausa: 'Causa de muerte',
    opciones: CAUSAS_MUERTE,
    errorCausa: 'Selecciona una causa.',
    textoConfirmar: 'Confirmar muerte',
    textoEnviando: 'Registrando muerte...',
    exito: 'Muerte registrada.',
  }),
});

export function etiquetaCausaCierre(tipo, codigo) {
  return CIERRE_CONFIG[tipo]?.opciones.find((o) => o.value === codigo)?.label ?? null;
}

// ---------------------------------------------------------------------------
// Visibilidad de acciones
// ---------------------------------------------------------------------------

// FASE 3A: misma fuente que la matriz central de capacidades.
export const ROLES_CIERRE = CAPACIDADES.cerrarAnimal;
export const MENSAJE_CIERRE_OFFLINE = 'Registrar salida o muerte requiere conexión.';

/**
 * Botones "Registrar salida" / "Registrar muerte":
 *   visibles   solo si registro ACTIVO + EN_HATO + rol owner|admin + animal
 *              ya confirmado por el servidor;
 *   habilitados solo con conexión (offline: deshabilitados + aviso).
 */
export function accionesCierre({ animal, rol, online, esLocal = false }) {
  const visible = Boolean(animal) && !esLocal && animal.estado === 'ACTIVO'
    && situacionDe(animal) === SITUACIONES.EN_HATO && canCerrarAnimal(rol);
  if (!visible) return { visible: false, habilitado: false, aviso: null };
  return online ? { visible: true, habilitado: true, aviso: null } : { visible: true, habilitado: false, aviso: MENSAJE_CIERRE_OFFLINE };
}

// ---------------------------------------------------------------------------
// Confirmación (alertdialog)
// ---------------------------------------------------------------------------

export function textoAlertaCierre(tipo, { tieneQrActiva = false } = {}) {
  if (tipo === 'MUERTE') {
    return 'Esta acción registrará al animal como muerto. No podrán registrarse nuevos pesajes ni asignarse nuevas chapetas QR. La chapeta actual quedará fuera de operación y el historial se conservará. Esta acción no puede revertirse en esta versión.';
  }
  return tieneQrActiva
    ? 'Esta acción registrará que el animal salió del hato y dejará su chapeta QR fuera de operación. El historial del animal se conservará. Esta acción no puede revertirse en esta versión.'
    : 'Esta acción registrará que el animal salió del hato. El historial del animal se conservará. Esta acción no puede revertirse en esta versión.';
}

// ---------------------------------------------------------------------------
// Formulario y validación
// ---------------------------------------------------------------------------

export const ERRORES_CIERRE = Object.freeze({
  FECHA_REQUERIDA: 'Indica la fecha.',
  FECHA_FUTURA: 'La fecha no puede ser futura.',
  ANTES_NACIMIENTO: 'La fecha no puede ser anterior a la fecha de nacimiento.',
  ANTES_INGRESO: 'La fecha no puede ser anterior a la fecha de ingreso.',
  ANTES_PESAJE: 'La fecha no puede ser anterior al último pesaje registrado.',
  OBSERVACIONES_LARGAS: 'Las observaciones admiten máximo 500 caracteres.',
});

export function formInicialCierre(hoy) {
  return { fecha: hoy, causa: '', observaciones: '' };
}

function normalizarObservaciones(texto) {
  return String(texto ?? '').replace(/\r\n?/g, '\n').trim();
}

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * { valido, errores: { fecha?, causa?, observaciones? } }. `hoy` = fecha de
 * NEGOCIO (America/Bogota), nunca la del dispositivo.
 */
export function validarCierre(tipo, form, { hoy, animal }) {
  const config = CIERRE_CONFIG[tipo];
  const errores = {};
  const fecha = String(form?.fecha ?? '');
  if (!FECHA_ISO.test(fecha)) errores.fecha = ERRORES_CIERRE.FECHA_REQUERIDA;
  else if (hoy && fecha > hoy) errores.fecha = ERRORES_CIERRE.FECHA_FUTURA;
  else if (animal?.fechaNacimiento && fecha < animal.fechaNacimiento) errores.fecha = ERRORES_CIERRE.ANTES_NACIMIENTO;
  else if (animal?.fechaIngreso && fecha < animal.fechaIngreso) errores.fecha = ERRORES_CIERRE.ANTES_INGRESO;
  else if (animal?.ultimoPeso?.fecha && fecha < animal.ultimoPeso.fecha) errores.fecha = ERRORES_CIERRE.ANTES_PESAJE;
  if (!config.opciones.some((o) => o.value === form?.causa)) errores.causa = config.errorCausa;
  if (normalizarObservaciones(form?.observaciones).length > MAX_OBSERVACIONES_CIERRE) {
    errores.observaciones = ERRORES_CIERRE.OBSERVACIONES_LARGAS;
  }
  return { valido: Object.keys(errores).length === 0, errores };
}

/** Body del POST. Para OTRA se usan las observaciones (sin campo extra). */
export function buildCierreBody(tipo, form, clientOperationId) {
  const config = CIERRE_CONFIG[tipo];
  const body = { [config.campoFecha]: form.fecha, [config.campoCausa]: form.causa, clientOperationId };
  const observaciones = normalizarObservaciones(form.observaciones);
  if (observaciones) body.observaciones = observaciones;
  return body;
}

/** Firma de los DATOS de la intención (cambia si el usuario edita algo). */
export function firmaCierre(tipo, form) {
  return JSON.stringify([tipo, form?.fecha ?? '', form?.causa ?? '', normalizarObservaciones(form?.observaciones)]);
}

// ---------------------------------------------------------------------------
// Idempotencia (clientOperationId)
// ---------------------------------------------------------------------------

/**
 * Un clientOperationId por INTENCIÓN de cierre:
 *   revisar(firma)   genera uno si no hay (o si los datos cambiaron);
 *                    lo CONSERVA en reintentos, timeout, 5xx o incierto;
 *   descartar()      tras éxito confirmado (incluido 200 yaExistia),
 *                    cancelación o cambio de datos: el próximo será nuevo.
 */
export function crearControlOperacion(generarId) {
  let actual = null;
  return {
    revisar(firma) {
      if (!actual || actual.firma !== firma) {
        const id = generarId();
        actual = id ? { id, firma } : null;
      }
      return actual?.id ?? null;
    },
    descartar() {
      actual = null;
    },
    get id() {
      return actual?.id ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Resultado del POST
// ---------------------------------------------------------------------------

const CAMPO_POR_ERROR = Object.freeze({
  INVALID_FECHA: 'fecha',
  INVALID_MOTIVO_SALIDA: 'causa',
  INVALID_CAUSA_MUERTE: 'causa',
  INVALID_OBSERVACIONES: 'observaciones',
});

export const MENSAJE_CIERRE_INCIERTO = 'No pudimos confirmar si el registro se guardó. Puedes reintentar: no se duplicará.';
export const MENSAJE_SESION_EXPIRADA = 'Tu sesión expiró. Vuelve a iniciar sesión para continuar.';
export const MENSAJE_CSRF = 'No pudimos validar la solicitud. Recarga la página e inténtalo de nuevo.';

/**
 * Respuesta de POST .../salida | .../muerte -> { tipo, mensaje, exito, campo?,
 * descartarOperacion, recargarFicha }:
 *   CREADO | YA_EXISTIA      éxito (200 yaExistia=true también lo es)
 *   INCIERTO | NO_ENVIADO    se conserva el clientOperationId (reintento seguro)
 *   PERMISOS (403 ROLE_FORBIDDEN) | SESION (401) | CSRF (403 CSRF)
 *   YA_CERRADO | ANULADO     la ficha cambió en el servidor: recargar
 *   OPERACION_REUSADA        nueva intención
 *   CAMPO                    error de validación del servidor en un campo
 */
export function resultadoCierre(tipo, result) {
  const code = result?.data?.error ?? null;
  const config = CIERRE_CONFIG[tipo];
  if (result?.ok && result.data?.animal) {
    return result.data.yaExistia
      ? { tipo: 'YA_EXISTIA', exito: true, descartarOperacion: true, recargarFicha: true, mensaje: 'Este registro ya estaba guardado (no se duplicó).' }
      : { tipo: 'CREADO', exito: true, descartarOperacion: true, recargarFicha: true, mensaje: config.exito };
  }
  const base = { exito: false, descartarOperacion: false, recargarFicha: false };
  if (code === 'NETWORK_ERROR' || result?.status >= 500 || !result) {
    return { ...base, tipo: 'INCIERTO', mensaje: MENSAJE_CIERRE_INCIERTO };
  }
  if (code === 'CSRF_UNAVAILABLE' || result?.failure === 'REQUEST_NOT_SENT') {
    return { ...base, tipo: 'NO_ENVIADO', mensaje: 'No pudimos enviar el registro. Revisa tu conexión e inténtalo de nuevo.' };
  }
  if (result?.failure === 'ROLE_FORBIDDEN' || code === 'ROLE_FORBIDDEN') {
    return { ...base, tipo: 'PERMISOS', mensaje: MENSAJE_ROLE_FORBIDDEN };
  }
  if (result?.failure === 'CSRF_REJECTED') return { ...base, tipo: 'CSRF', mensaje: MENSAJE_CSRF };
  if (result?.failure === 'SESSION_EXPIRED' || result?.status === 401 || code === 'SESSION_EXPIRED') {
    return { ...base, tipo: 'SESION', mensaje: MENSAJE_SESION_EXPIRADA };
  }
  if (code === 'ANIMAL_YA_SALIDO' || code === 'ANIMAL_YA_MUERTO') {
    return {
      ...base,
      tipo: 'YA_CERRADO',
      descartarOperacion: true,
      recargarFicha: true,
      mensaje: code === 'ANIMAL_YA_SALIDO' ? 'Este animal ya salió del hato.' : 'Este animal ya está registrado como muerto.',
    };
  }
  if (code === 'ANIMAL_ANULADO') {
    return { ...base, tipo: 'ANULADO', descartarOperacion: true, recargarFicha: true, mensaje: 'Este registro está anulado y no admite salida ni muerte.' };
  }
  if (code === 'CLIENT_OPERATION_ID_REUSED') {
    return { ...base, tipo: 'OPERACION_REUSADA', descartarOperacion: true, mensaje: 'Esta operación ya se había usado con otros datos. Revisa la ficha y vuelve a intentarlo.' };
  }
  if (result?.status === 400 && CAMPO_POR_ERROR[code]) {
    return { ...base, tipo: 'CAMPO', campo: CAMPO_POR_ERROR[code], mensaje: 'Revisa este dato: el servidor no lo aceptó.' };
  }
  if (result?.status === 404) return { ...base, tipo: 'NO_ENCONTRADO', mensaje: 'Este animal no está disponible.' };
  return { ...base, tipo: 'ERROR', mensaje: 'No fue posible registrar en este momento. Intenta nuevamente.' };
}

// ---------------------------------------------------------------------------
// Presentación: Situación (Resumen), Pesajes y QR
// ---------------------------------------------------------------------------

/** Bloque "Situación" del Resumen: { titulo, filas: [[etiqueta, valor]] }. */
export function bloqueSituacion(animal) {
  const situacion = situacionDe(animal);
  if (situacion === SITUACIONES.EN_HATO) return { situacion, titulo: 'En hato', filas: [] };
  const cierre = animal?.cierre ?? {};
  const tipo = situacion === SITUACIONES.SALIDO ? 'SALIDA' : 'MUERTE';
  const filas = [
    ['Fecha', formatFecha(cierre.fecha)],
    [tipo === 'SALIDA' ? 'Motivo' : 'Causa', etiquetaCausaCierre(tipo, cierre.causa) ?? 'Sin dato'],
  ];
  if (cierre.observaciones) filas.push(['Observaciones', cierre.observaciones]);
  return { situacion, titulo: ETIQUETAS_SITUACION[situacion], filas };
}

export const MENSAJES_PESAJES_CERRADO = Object.freeze({
  SALIDO: 'Este animal salió del hato y no admite nuevos pesajes.',
  MUERTO: 'Este animal está registrado como muerto y no admite nuevos pesajes.',
});
export const TEXTO_SIN_ALERTAS_CERRADO = 'Sin alertas: el animal ya no está en el hato.';

export function mensajePesajesCerrado(estadoOperativo) {
  return MENSAJES_PESAJES_CERRADO[estadoOperativo] ?? null;
}

// cierreRepository.js (QR_REVOCACION): motivo con el que se revoca la
// chapeta al cerrar el animal.
const MOTIVO_QR_POR_SITUACION = Object.freeze({ SALIDO: 'Animal salió del hato', MUERTO: 'Animal muerto' });
export const MENSAJE_QR_HISTORICA = 'Esta chapeta está vinculada históricamente a este animal y no puede reasignarse.';

/** Chapeta histórica de un animal cerrado: la revocada por el cierre o, si no, la más reciente. */
export function chapetaHistoricaDeCierre(historial, estadoOperativo) {
  const lista = Array.isArray(historial) ? historial.filter((c) => c.estado !== 'ASIGNADO_ANIMAL') : [];
  if (!lista.length) return null;
  const motivo = MOTIVO_QR_POR_SITUACION[estadoOperativo];
  return lista.find((c) => c.motivo === motivo) ?? lista[0];
}
