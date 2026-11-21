// FASE 5A.3c -- modelo PURO (sin React ni red) de la UI offline de pesajes sobre el
// motor 5A.3b (offline/localRepo.js + offline/pesajesLocales.js).
//
// Reglas:
//   * El historial local SOLO se presenta con evidencia de copia completa
//     (repo.leerPesajesLocales().copiaCompleta). Con copia incompleta no se fabrican
//     KPIs, GMD ni gráficas: se informa que requieren conexión.
//   * KPIs, GMD, alertas y gráficas locales usan EXACTAMENTE el armado del servidor
//     (construirHistorialPesajes, misma forma que pesajesService.construirHistorialPesajes)
//     sobre el motor compartido shared/ganaderia/engine/pesajes.js: una sola fórmula. La
//     paridad la exige pesajesOfflineVista.test.js contra la función del servidor.
//   * Una ANULAR pendiente coherente (en curso) deja el pesaje confirmado como está
//     (sigue ACTIVO en el servidor) pero, igual que ultimoPesoLocal, NO participa en los
//     cálculos provisionales locales. Se marca "Anulación pendiente".
//   * Las decisiones de seguridad (cancelación segura, identidad, permisos) las toma el
//     motor; la UI solo las refleja y nunca las amplía.
//   * Nunca se presentan operationId, clientOperationId, UUID internos ni posibleEnServidor.
import { calcularGananciaAcumulada, enriquecerHistorialPesajes } from '../engine/pesajes.js';
import { MENSAJE_ROLE_FORBIDDEN } from '../auth/ganaderiaPermisos.js';
import {
  ETIQUETA_CONFLICTO,
  ETIQUETA_IDENTIDAD,
  ETIQUETA_RECHAZADO,
  MENSAJE_IDENTIDAD_OPERACION,
  MENSAJE_SESION_NO_VERIFICADA,
  mensajeBloqueoPesaje,
} from './pesajesOfflineModel.js';

/** Estados de operación que siguen en curso (se aplicarán tal cual). */
export const ESTADOS_OPERACION_EN_CURSO = Object.freeze(['PENDIENTE', 'SINCRONIZANDO', 'ERROR_REINTENTABLE', 'BLOQUEADA_POR_IDENTIDAD']);

export const ETIQUETA_ANULACION_PENDIENTE = 'Anulación pendiente';
export const TEXTO_ANULACION_PENDIENTE = 'Solicitud de anulación pendiente de sincronizar. Mientras tanto no participa en los cálculos de este dispositivo.';
export const TEXTO_ANULACION_DIFERIDA = 'Anulación solicitada: se enviará cuando el servidor confirme este pesaje.';
export const ADVERTENCIA_CANCELAR_PENDIENTE = 'Este registro aún no fue enviado al servidor y puede retirarse de este dispositivo.';
export const TEXTO_COPIA_LOCAL = 'Sin conexión: mostrando la copia guardada en este dispositivo. Los cálculos incluyen las anulaciones pendientes y se actualizarán al sincronizar.';
export const TEXTO_SIN_COPIA_LOCAL = 'Sin conexión y sin una copia completa de los pesajes en este dispositivo: el historial y los indicadores requieren conexión.';
export const MENSAJE_ANULACION_ENCOLADA = 'Anulación guardada en este dispositivo. Se enviará al servidor al recuperar la conexión.';
export const MENSAJE_PENDIENTE_CANCELADO = 'Registro pendiente retirado de este dispositivo. No se envió al servidor.';

/**
 * Mismo armado que pesajesService.construirHistorialPesajes del servidor (se mantiene
 * idéntico; ver test de paridad). Entrada: filas confirmadas { pesajeId, fecha, pesoKg,
 * metodo, origen, observaciones, createdAt, estadoRegistro, anulacion }.
 */
export function construirHistorialPesajes({ animalId, pesajes }) {
  const historial = enriquecerHistorialPesajes(pesajes).map((row) => ({
    pesajeId: row.pesajeId,
    fecha: row.fecha,
    pesoKg: row.pesoKg,
    metodo: row.metodo,
    origen: row.origen,
    observaciones: row.observaciones,
    createdAt: row.createdAt,
    estadoRegistro: row.estadoRegistro,
    anulacion: row.estadoRegistro === 'ANULADO' ? (row.anulacion ?? null) : null,
    representativoDelDia: row.representativoDelDia,
    pesoAnteriorKg: row.pesoAnteriorKg,
    fechaAnterior: row.fechaAnterior,
    diferenciaKg: row.diferenciaKg,
    diasDesdeAnterior: row.diasDesdeAnterior,
    gmdKgDia: row.gmdKgDia,
    mismoDia: row.mismoDia,
  }));
  const activos = historial.filter((p) => p.estadoRegistro === 'ACTIVO');
  const ultimo = activos.at(-1) ?? null;
  const acumulada = calcularGananciaAcumulada(pesajes);
  return {
    animalId,
    orden: 'ASCENDENTE',
    resumen: {
      totalPesajes: activos.length,
      totalAnulados: historial.length - activos.length,
      ultimoPesoKg: ultimo?.pesoKg ?? null,
      fechaUltimoPeso: ultimo?.fecha ?? null,
      metodoUltimoPeso: ultimo?.metodo ?? null,
      pesoAnteriorKg: ultimo?.pesoAnteriorKg ?? null,
      fechaPesoAnterior: ultimo?.fechaAnterior ?? null,
      diferenciaKg: ultimo?.diferenciaKg ?? null,
      diasDesdeAnterior: ultimo?.diasDesdeAnterior ?? null,
      gmdKgDia: ultimo?.gmdKgDia ?? null,
      mismoDia: ultimo?.mismoDia ?? null,
      gananciaAcumulada: acumulada
        ? {
            primerPesoRegistradoKg: acumulada.pesoInicialKg,
            fechaPrimerPesoRegistrado: acumulada.fechaInicial,
            ultimoPesoKg: acumulada.pesoFinalKg,
            gananciaKg: acumulada.gananciaKg,
            dias: acumulada.dias,
            gmdPromedioKgDia: acumulada.gmdPromedioKgDia,
          }
        : null,
    },
    pesajes: activos,
    historial,
  };
}

/** ANULAR en curso por pesajeId resuelto (una diferida sin resolver no marca ninguna fila confirmada). */
export function anulacionesEnCursoPorPesaje(anulaciones = []) {
  const mapa = new Map();
  for (const a of anulaciones) {
    if (a?.pesajeId && ESTADOS_OPERACION_EN_CURSO.includes(a.estado)) mapa.set(String(a.pesajeId), a);
  }
  return mapa;
}

/** ANULAR (de cualquier estado) por pesajeId resuelto: impide ofrecer otra. */
export function anulacionesPorPesaje(anulaciones = []) {
  const mapa = new Map();
  for (const a of anulaciones) if (a?.pesajeId) mapa.set(String(a.pesajeId), a);
  return mapa;
}

/**
 * Datos de la ficha desde la copia local (misma forma que GET /pesajes) o null si la
 * copia no está completa. Las filas con ANULAR en curso conservan su estado confirmado
 * (ACTIVO) en el historial, marcadas con `anulacionPendiente`, y quedan fuera de los
 * cálculos provisionales (como en ultimoPesoLocal).
 */
export function vistaLocalPesajes({ animalId, copiaCompleta, confirmados = [], anulaciones = [] }) {
  if (!copiaCompleta) return null;
  const enCurso = anulacionesEnCursoPorPesaje(anulaciones);
  const entrada = confirmados.map((p) => (enCurso.has(String(p.pesajeId)) && p.estadoRegistro !== 'ANULADO'
    ? { ...p, estadoRegistro: 'ANULADO', anulacion: null }
    : p));
  const datos = construirHistorialPesajes({ animalId: String(animalId), pesajes: entrada });
  const historial = datos.historial.map((fila) => (enCurso.has(String(fila.pesajeId))
    ? { ...fila, estadoRegistro: 'ACTIVO', anulacion: null }
    : fila));
  return { ...datos, historial, origen: 'LOCAL', provisional: enCurso.size > 0 };
}

/** Historial (del servidor o local) con la marca de ANULAR pendiente de cada fila. */
export function marcarAnulacionesPendientes(historial = [], anulaciones = []) {
  const todas = anulacionesPorPesaje(anulaciones);
  if (todas.size === 0) return historial;
  return historial.map((fila) => {
    const a = todas.get(String(fila.pesajeId));
    return a && fila.estadoRegistro !== 'ANULADO' ? { ...fila, anulacionPendiente: a } : fila;
  });
}

/**
 * Estado visible de una PESAJE_ANULAR pendiente: { etiqueta, detalle, bloqueado }.
 * Nunca muestra códigos internos como único mensaje.
 */
export function estadoAnulacionPendiente(a) {
  switch (a?.estado) {
    case 'CONFLICTO':
      return { etiqueta: ETIQUETA_CONFLICTO, detalle: `La anulación no se aplicó: ${mensajeBloqueoPesaje(a.ultimoError?.codigo)}`, bloqueado: true };
    case 'RECHAZADO':
      return { etiqueta: ETIQUETA_RECHAZADO, detalle: `La anulación no se aplicó: ${mensajeBloqueoPesaje(a.ultimoError?.codigo)}`, bloqueado: true };
    case 'BLOQUEADA_POR_IDENTIDAD':
      return {
        etiqueta: ETIQUETA_IDENTIDAD,
        detalle: a.ultimoError?.codigo === 'SESION_NO_VERIFICABLE' ? MENSAJE_SESION_NO_VERIFICADA : MENSAJE_IDENTIDAD_OPERACION,
        bloqueado: true,
      };
    case 'SINCRONIZANDO':
      return { etiqueta: ETIQUETA_ANULACION_PENDIENTE, detalle: 'Enviando la anulación al servidor...', bloqueado: false };
    default:
      return {
        etiqueta: ETIQUETA_ANULACION_PENDIENTE,
        detalle: a?.pesajeId ? TEXTO_ANULACION_PENDIENTE : TEXTO_ANULACION_DIFERIDA,
        bloqueado: false,
      };
  }
}

/**
 * Acciones sobre un CREATE pendiente. El motor ya decidió `cancelableSeguro`
 * (v2, posibleEnServidor === false, no SINCRONIZANDO); aquí solo se exige además que
 * sea de la cuenta actual y que el rol pueda registrar pesajes.
 *   cancelar        "Cancelar registro pendiente" (nunca "Anular")
 *   anularDiferida  CREATE incierto (posibleEnServidor o legacy): owner/admin pueden
 *                   pedir su anulación, que espera a que el servidor lo confirme.
 */
export function accionesPesajePendiente(pendiente, { cuentaId = null, puedeRegistrar = false, puedeAnular = false, anulaciones = [] } = {}) {
  const enCurso = ESTADOS_OPERACION_EN_CURSO.includes(pendiente?.estado) && pendiente?.estado !== 'BLOQUEADA_POR_IDENTIDAD';
  const propio = Boolean(cuentaId) && pendiente?.cuentaOrigenId === cuentaId;
  const cancelar = Boolean(pendiente?.cancelableSeguro && puedeRegistrar && propio);
  const yaSolicitada = anulaciones.some((a) => a.refClientOperationId && a.refClientOperationId === pendiente?.clientOperationId);
  const incierto = Boolean(pendiente?.legacy || pendiente?.posibleEnServidor);
  const anularDiferida = Boolean(puedeAnular && !cancelar && incierto && enCurso && !yaSolicitada && pendiente?.estado !== 'SINCRONIZANDO');
  return { cancelar, anularDiferida, anulacionSolicitada: yaSolicitada };
}

/**
 * "Último peso" de la ficha. Con conexión manda la ficha del servidor. Sin conexión, el
 * resultado de repo.ultimoPesoLocal() del MISMO animal: LOCAL (copia completa; excluye
 * anulaciones pendientes) o ANIMAL (respaldo: copia de la ficha del último sync).
 * -> { ultimoPeso, nota }
 */
export function presentarUltimoPesoFicha({ animal, pesoLocal, online }) {
  const delServidor = animal?.ultimoPeso ?? null;
  if (online || !pesoLocal || String(pesoLocal.animalId) !== String(animal?.animalId)) return { ultimoPeso: delServidor, nota: null };
  if (pesoLocal.fuente !== 'LOCAL') {
    return { ultimoPeso: delServidor, nota: 'Último dato sincronizado: este dispositivo no tiene la copia completa de pesajes.' };
  }
  const excluidos = pesoLocal.excluidosPorAnulacion?.length ?? 0;
  return {
    ultimoPeso: pesoLocal.ultimoPeso,
    nota: excluidos > 0 ? 'Provisional: excluye pesajes con anulación pendiente de sincronizar.' : 'Según la copia de este dispositivo.',
  };
}

const MENSAJES_ACCION = Object.freeze({
  ROLE_FORBIDDEN: MENSAJE_ROLE_FORBIDDEN,
  PESAJE_YA_ANULADO: 'Este pesaje ya está anulado.',
  OPERACION_ADMINISTRATIVA_PENDIENTE: 'Este pesaje ya tiene una anulación pendiente en este dispositivo.',
  CLIENT_OPERATION_ID_REUSED: 'Esta solicitud ya se registró con otros datos. Vuelve a intentarlo.',
  INVALID_MOTIVO: 'Escribe el motivo de la anulación (máximo 500 caracteres).',
  PESAJE_ENVIO_INCIERTO: 'Este registro pudo haber llegado al servidor: se conserva hasta confirmarlo.',
  PESAJE_CANCELABLE_LOCALMENTE: 'Este registro nunca salió del dispositivo: retíralo con "Cancelar registro pendiente".',
  PESAJE_PENDIENTE_EN_CURSO: 'Se está enviando al servidor: espera a que termine.',
  PESAJE_PENDIENTE_NO_ENCONTRADO: 'Este registro ya no está pendiente. Actualizamos la vista.',
  PESAJE_NOT_FOUND: 'Este pesaje no pertenece a este animal.',
  PESAJE_REQUIERE_ANIMAL_SINCRONIZADO: 'Este animal aún no está sincronizado.',
  BLOQUEADA_POR_IDENTIDAD: 'Esta operación la registró otra cuenta: solo esa cuenta puede modificarla.',
});

/** Mensaje de un error del motor al encolar / cancelar (sin códigos internos). */
export function mensajeAccionOffline(error) {
  return MENSAJES_ACCION[error?.code] ?? 'No se pudo guardar el cambio en este dispositivo. Intenta nuevamente.';
}
