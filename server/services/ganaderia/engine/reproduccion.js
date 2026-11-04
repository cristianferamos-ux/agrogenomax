// ARCHIVO DERIVADO — NO EDITAR DIRECTAMENTE.
// Fuente canónica:
// shared/ganaderia/engine/reproduccion.js
//
// FASE 4A / FASE 4E.1 -- fuente CANÓNICA compartida de las reglas
// reproductivas y ÚNICA editable: el frontend la reexporta
// (src/modules/ganaderia/engine/) y el backend usa un archivo DERIVADO
// (server/services/ganaderia/engine/: cabecera + este contenido, paridad exigida
// por ganaderiaEngineParidad.test.js). Un cambio de reglas se hace aquí primero
// y luego se regenera la copia. El servidor es la autoridad final.
//
// Estado reproductivo DERIVADO (modelo PURO: sin base de datos,
// sin reloj). Nunca se persiste: se pliega el historial de eventos ACTIVO en
// orden (fechaEvento, eventoId). Anular un evento = dejar de plegarlo; el
// estado se recalcula desde el historial válido.
//
// Máquina de estados mínima (hembra):
//   SIN_ESTADO  sin eventos activos.
//   CICLANDO    CELO_OBSERVADO.
//   SERVIDA     SERVICIO_MONTA | INSEMINACION_ARTIFICIAL | IATF | TRANSFERENCIA_EMBRION.
//   PRENADA     DIAGNOSTICO_PRENEZ resultado PRENADA.
//   VACIA       DIAGNOSTICO_PRENEZ resultado VACIA | ABORTO.
//   POSPARTO    PARTO.
//   DIAGNOSTICO_PRENEZ DUDOSA no cambia el estado (queda como último diagnóstico).
//   NO_APLICA   el animal es MACHO (no recibe eventos reproductivos).
//
// El plegado es TOTAL (nunca rechaza): una corrección administrativa puede
// dejar un historial "atípico" y el estado sigue siendo el del último evento
// que transiciona. Las reglas de registro (reglaRegistro) solo se aplican al
// REGISTRAR un evento operativo nuevo, contra el estado actual.

export const ESTADOS_REPRODUCTIVOS = Object.freeze({
  SIN_ESTADO: 'SIN_ESTADO',
  CICLANDO: 'CICLANDO',
  SERVIDA: 'SERVIDA',
  PRENADA: 'PRENADA',
  VACIA: 'VACIA',
  POSPARTO: 'POSPARTO',
  NO_APLICA: 'NO_APLICA',
});

export const TIPOS_SERVICIO = Object.freeze(['SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF', 'TRANSFERENCIA_EMBRION']);

// Gestación bovina de referencia (días) para la fecha probable de parto, y
// edad del embrión al transferirlo (TE en día ~7 del desarrollo). Son
// ESTIMACIONES de referencia, no un dato del animal.
export const GESTACION_REFERENCIA_DIAS = 283;
export const EDAD_EMBRION_TRANSFERENCIA_DIAS = 7;

const DIA_MS = 86_400_000;

function aDia(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function sumarDias(fecha, dias) {
  return new Date(aDia(fecha) + dias * DIA_MS).toISOString().slice(0, 10);
}

export function diasEntre(desde, hasta) {
  return Math.round((aDia(hasta) - aDia(desde)) / DIA_MS);
}

export function compararEventos(a, b) {
  if (a.fechaEvento !== b.fechaEvento) return a.fechaEvento < b.fechaEvento ? -1 : 1;
  return Number(a.eventoId) - Number(b.eventoId);
}

function transicion(estado, evento) {
  switch (evento.tipoEvento) {
    case 'CELO_OBSERVADO':
      return ESTADOS_REPRODUCTIVOS.CICLANDO;
    case 'DIAGNOSTICO_PRENEZ':
      if (evento.diagnosticoResultado === 'PRENADA') return ESTADOS_REPRODUCTIVOS.PRENADA;
      if (evento.diagnosticoResultado === 'VACIA') return ESTADOS_REPRODUCTIVOS.VACIA;
      return estado;
    case 'ABORTO':
      return ESTADOS_REPRODUCTIVOS.VACIA;
    case 'PARTO':
      return ESTADOS_REPRODUCTIVOS.POSPARTO;
    default:
      return TIPOS_SERVICIO.includes(evento.tipoEvento) ? ESTADOS_REPRODUCTIVOS.SERVIDA : estado;
  }
}

const ref = (e) => ({ eventoId: e.eventoId, tipoEvento: e.tipoEvento, fechaEvento: e.fechaEvento });

/**
 * @param {object} p
 * @param {string} p.sexo     'HEMBRA' | 'MACHO'
 * @param {Array}  p.eventos  eventos serializados (se ignoran los ANULADO)
 * @param {string} [p.hoy]    fecha de negocio para los días de gestación
 */
export function derivarEstadoReproductivo({ sexo, eventos = [], hoy = null }) {
  const activos = eventos.filter((e) => e.estadoRegistro === 'ACTIVO').sort(compararEventos);
  if (sexo !== 'HEMBRA') {
    return {
      estado: ESTADOS_REPRODUCTIVOS.NO_APLICA, desde: null, eventoEstado: null, ultimoEvento: null,
      ultimoServicio: null, ultimoDiagnostico: null, ultimoParto: null, gestacion: null, eventosActivos: activos.length,
    };
  }

  let estado = ESTADOS_REPRODUCTIVOS.SIN_ESTADO;
  let eventoEstado = null;
  let ultimoServicio = null;
  let servicioDelCiclo = null; // último servicio posterior al último parto/aborto
  let ultimoDiagnostico = null;
  let ultimoParto = null;
  let diagnosticoPrenez = null; // diagnóstico que dejó PRENADA

  for (const e of activos) {
    // `desde` = evento que hizo ENTRAR al estado actual (un segundo servicio o
    // un diagnóstico DUDOSA no lo mueven).
    const nuevo = transicion(estado, e);
    if (nuevo !== estado) eventoEstado = e;
    estado = nuevo;
    if (TIPOS_SERVICIO.includes(e.tipoEvento)) {
      ultimoServicio = e;
      servicioDelCiclo = e;
    }
    if (e.tipoEvento === 'DIAGNOSTICO_PRENEZ') {
      ultimoDiagnostico = e;
      if (e.diagnosticoResultado === 'PRENADA') diagnosticoPrenez = e;
    }
    if (e.tipoEvento === 'PARTO') ultimoParto = e;
    if (e.tipoEvento === 'PARTO' || e.tipoEvento === 'ABORTO') {
      servicioDelCiclo = null;
      diagnosticoPrenez = null;
    }
  }

  let gestacion = null;
  if (estado === ESTADOS_REPRODUCTIVOS.PRENADA && diagnosticoPrenez) {
    let concepcion = null;
    let base = null;
    if (diagnosticoPrenez.diasGestacion) {
      concepcion = sumarDias(diagnosticoPrenez.fechaEvento, -diagnosticoPrenez.diasGestacion);
      base = 'DIAGNOSTICO';
    } else if (servicioDelCiclo && servicioDelCiclo.fechaEvento <= diagnosticoPrenez.fechaEvento) {
      const ajuste = servicioDelCiclo.tipoEvento === 'TRANSFERENCIA_EMBRION' ? EDAD_EMBRION_TRANSFERENCIA_DIAS : 0;
      concepcion = sumarDias(servicioDelCiclo.fechaEvento, -ajuste);
      base = 'SERVICIO';
    }
    if (concepcion) {
      gestacion = {
        base,
        fechaConcepcionEstimada: concepcion,
        diasEstimados: hoy ? diasEntre(concepcion, hoy) : null,
        fechaProbableParto: sumarDias(concepcion, GESTACION_REFERENCIA_DIAS),
      };
    }
  }

  const ultimo = activos.at(-1) ?? null;
  return {
    estado,
    desde: eventoEstado?.fechaEvento ?? null,
    eventoEstado: eventoEstado ? ref(eventoEstado) : null,
    ultimoEvento: ultimo ? ref(ultimo) : null,
    ultimoServicio: ultimoServicio ? ref(ultimoServicio) : null,
    ultimoDiagnostico: ultimoDiagnostico
      ? { ...ref(ultimoDiagnostico), resultado: ultimoDiagnostico.diagnosticoResultado, diasGestacion: ultimoDiagnostico.diasGestacion ?? null }
      : null,
    ultimoParto: ultimoParto ? { ...ref(ultimoParto), numeroCrias: ultimoParto.numeroCrias ?? null } : null,
    gestacion,
    eventosActivos: activos.length,
  };
}

/**
 * Regla de REGISTRO operativo (no de corrección) contra el estado actual.
 * null si el evento es admisible; si no, { code, message } (409).
 *   PRENADA: no admite celo ni servicios (registrar antes diagnóstico VACIA o aborto).
 *   VACIA / POSPARTO: no admiten parto ni aborto sin un servicio o diagnóstico
 *   de preñez posterior (sin historial -- SIN_ESTADO -- se admiten: monta libre
 *   sin registros previos).
 */
export function reglaRegistro(estado, tipoEvento) {
  if (estado === ESTADOS_REPRODUCTIVOS.PRENADA && (tipoEvento === 'CELO_OBSERVADO' || TIPOS_SERVICIO.includes(tipoEvento))) {
    return { code: 'EVENTO_NO_PERMITIDO_POR_ESTADO', message: 'La hembra está preñada: registre primero un diagnóstico VACIA o un aborto.' };
  }
  if ((estado === ESTADOS_REPRODUCTIVOS.VACIA || estado === ESTADOS_REPRODUCTIVOS.POSPARTO)
    && (tipoEvento === 'PARTO' || tipoEvento === 'ABORTO')) {
    return {
      code: 'EVENTO_NO_PERMITIDO_POR_ESTADO',
      message: `La hembra está ${estado === 'VACIA' ? 'vacía' : 'en posparto'}: un parto o aborto exige un servicio o diagnóstico de preñez posterior.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// FASE 4E.1 -- evaluación LOCAL de un registro sin red (orienta; nunca confirma)
// ---------------------------------------------------------------------------

// Un evento pendiente no tiene eventoId: para plegarlo se le da uno virtual,
// siempre posterior a cualquier id real. Nunca sale de esta evaluación.
const BASE_ID_VIRTUAL = 2 ** 52;
const esIdVirtual = (eventoId) => Number(eventoId) >= BASE_ID_VIRTUAL;

/**
 * Evalúa `evento` con las MISMAS comprobaciones que el servidor al registrar,
 * sobre los eventos confirmados de la copia local más los pendientes del mismo
 * animal (en orden de envío). Distingue la causa del conflicto:
 *   bloqueo      lo causa un pendiente local: es determinista.
 *   advertencia  solo lo causa la copia confirmada, que puede estar
 *                desactualizada: se permite encolar y el servidor decide.
 * El resultado nunca debe mostrarse como estado clínico confirmado.
 *
 * @param {object} p
 * @param {string} p.sexo         'HEMBRA' | 'MACHO'
 * @param {Array}  p.confirmados  eventos serializados del servidor
 * @param {Array}  p.pendientes   eventos pendientes, en orden de envío
 * @param {object} p.evento       evento a evaluar (tipoEvento, fechaEvento, ...)
 * @returns {{ bloqueo: ?{code, message}, advertencia: ?{code, message} }}
 */
export function evaluarRegistroLocal({ sexo, confirmados = [], pendientes = [], evento }) {
  const virtuales = pendientes.map((e, indice) => ({ ...e, eventoId: String(BASE_ID_VIRTUAL + indice), estadoRegistro: 'ACTIVO' }));
  const actual = derivarEstadoReproductivo({ sexo, eventos: [...confirmados, ...virtuales] });
  const hallazgos = [];
  const ultimo = actual.ultimoEvento;
  if (ultimo && evento.fechaEvento < ultimo.fechaEvento) {
    hallazgos.push({
      local: esIdVirtual(ultimo.eventoId),
      code: 'FECHA_ANTERIOR_A_HISTORIAL',
      message: `La fecha no puede ser anterior al último evento reproductivo (${ultimo.fechaEvento}).`,
    });
  }
  const regla = reglaRegistro(actual.estado, evento.tipoEvento);
  if (regla) hallazgos.push({ local: esIdVirtual(actual.eventoEstado?.eventoId), ...regla });

  const publico = (hallazgo) => (hallazgo ? { code: hallazgo.code, message: hallazgo.message } : null);
  return {
    bloqueo: publico(hallazgos.find((h) => h.local)),
    advertencia: publico(hallazgos.find((h) => !h.local)),
  };
}

/**
 * Primer pendiente que un conflicto determinista deja inválido al evaluar la
 * cadena en orden, cada uno contra los anteriores. null si no hay ninguno.
 */
export function primerBloqueoEnCadena({ sexo, confirmados = [], pendientes = [] }) {
  for (let indice = 0; indice < pendientes.length; indice += 1) {
    const { bloqueo } = evaluarRegistroLocal({ sexo, confirmados, pendientes: pendientes.slice(0, indice), evento: pendientes[indice] });
    if (bloqueo) return { indice, bloqueo };
  }
  return null;
}

// FASE 4E.1 -- intención canónica de un evento, para conciliar una operación
// pendiente con el evento que devuelve el pull. Mismos campos que el intent_hash
// (CAMPOS_EVENTO de reproduccionValidation.js, exigido por ganaderiaEngineParidad)
// y misma normalización que aplica el servidor antes de calcularlo. Nada generado
// por el servidor entra en la comparación.
export const CAMPOS_INTENCION_REPRODUCTIVA = Object.freeze([
  'tipoEvento', 'fechaEvento', 'horaEvento',
  'intensidadCelo', 'metodoDeteccion',
  'tipoServicio', 'toroAnimalId', 'toroExterno',
  'semenCodigo', 'protocoloIatf', 'tecnico',
  'embrionCodigo', 'embrionRaza', 'embrionDonadora', 'embrionEstadio', 'embrionCalidad', 'embrionConservacion',
  'diagnosticoResultado', 'diagnosticoMetodo', 'diasGestacion',
  'abortoCausa',
  'partoTipo', 'numeroCrias',
  'observaciones',
]);

const TEXTOS_DE_UNA_LINEA = new Set([
  'toroExterno', 'semenCodigo', 'protocoloIatf', 'tecnico',
  'embrionCodigo', 'embrionRaza', 'embrionDonadora', 'embrionEstadio', 'embrionCalidad',
  'abortoCausa',
]);

function normalizarCampoIntencion(campo, valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (campo === 'toroAnimalId') return String(valor);
  if (typeof valor !== 'string') return valor;
  if (campo === 'observaciones') return valor.replace(/\r\n?/g, '\n').trim() || null;
  if (TEXTOS_DE_UNA_LINEA.has(campo)) return valor.replace(/\s+/g, ' ').trim() || null;
  return valor;
}

/** Forma canónica de un cuerpo de registro o de un evento del servidor (`detalle` incluido). */
export function intencionReproductiva(evento) {
  const plano = { ...evento, ...evento?.detalle };
  return JSON.stringify(CAMPOS_INTENCION_REPRODUCTIVA.map((campo) => normalizarCampoIntencion(campo, plano[campo])));
}

export function intencionCoincide(a, b) {
  return intencionReproductiva(a) === intencionReproductiva(b);
}
