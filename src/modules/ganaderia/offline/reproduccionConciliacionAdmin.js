// FASE 4E.2B -- reconciliación determinista de ANULAR y CORREGIR con el pull. Puro:
// recibe los eventos conocidos (página recibida sobre la copia local) y decide solo
// con identidad exacta de la operación. Nunca por motivo parecido, fecha o estado.
//
//   CONFIRMADA     el servidor aplicó exactamente esta operación
//   CONFLICTO      el id exacto aparece con otros datos: no se sobrescribe nada
//   SIN_EVIDENCIA  aún no se puede decir: la operación sigue incierta y su reintento
//                  (mismo id) lo resuelve el servidor
import { normalizarMotivo } from './outbox.js';
import { intencionCoincide } from '../engine/reproduccion.js';

export const CONCILIACION = Object.freeze({
  CONFIRMADA: 'CONFIRMADA',
  CONFLICTO: 'CONFLICTO',
  SIN_EVIDENCIA: 'SIN_EVIDENCIA',
});

const { CONFIRMADA, CONFLICTO, SIN_EVIDENCIA } = CONCILIACION;

/**
 * ANULAR confirmada solo con anulacionClientOperationId, eventoId, animalId y
 * estadoRegistro exactos. Un evento anulado por otra operación no es evidencia: esta
 * sale y el servidor responde EVENTO_YA_ANULADO. El mismo id en una creación o en una
 * corrección no es esta operación.
 */
export function conciliarAnular(op, eventos) {
  const id = op.clientOperationId;
  const anulados = eventos.filter((evento) => evento.anulacionClientOperationId === id);
  const creados = eventos.filter((evento) => evento.clientOperationId === id);
  if (!anulados.length && !creados.length) return SIN_EVIDENCIA;
  if (creados.length || anulados.length > 1) return CONFLICTO;
  const [evento] = anulados;
  const exacto = evento.eventoId === op.payload.eventoId
    && evento.animalId === op.payload.animalId
    && evento.estadoRegistro === 'ANULADO'
    && !evento.corregidoPorEventoId;
  return exacto ? CONFIRMADA : CONFLICTO;
}

/**
 * CORREGIR ejecutada solo si existe el corrector con su clientOperationId, el
 * corrigeEventoId, el animal y la intención exactos, y el original quedó enlazado:
 * ANULADO por este id, apuntando a este corrector y con este motivo (el motivo se
 * guarda en el original, no en el corrector). Que el corrector esté ANULADO después
 * no invalida nada: la corrección ocurrió.
 *
 * Corrector y original se escriben en la misma transacción, pero pueden llegar en
 * páginas distintas: si falta una parte se espera, sin concluir nada.
 */
export function conciliarCorregir(op, eventos) {
  const id = op.clientOperationId;
  const { animalId, eventoId, motivo, evento: intencion } = op.payload;
  const correctores = eventos.filter((evento) => evento.clientOperationId === id);
  const anulados = eventos.filter((evento) => evento.anulacionClientOperationId === id);
  if (!correctores.length && !anulados.length) return SIN_EVIDENCIA;
  if (correctores.length > 1 || anulados.length > 1) return CONFLICTO;

  const [corrector] = correctores;
  const [anulado] = anulados;
  if (corrector && (corrector.corrigeEventoId !== eventoId || corrector.animalId !== animalId || !intencionCoincide(intencion, corrector))) return CONFLICTO;
  if (anulado && (anulado.eventoId !== eventoId || anulado.animalId !== animalId || anulado.estadoRegistro !== 'ANULADO' || normalizarMotivo(anulado.anulacion?.motivo) !== normalizarMotivo(motivo))) return CONFLICTO;

  if (!corrector || !anulado) {
    // El original figura anulado por otra operación: esta corrección no pudo aplicarse.
    // Sin el campo (copia anterior a 4E.2A) no hay evidencia, solo se espera.
    const original = eventos.find((evento) => evento.eventoId === eventoId);
    const anuladoPorOtra = original?.estadoRegistro === 'ANULADO'
      && original.anulacionClientOperationId !== undefined
      && original.anulacionClientOperationId !== id;
    return corrector && anuladoPorOtra ? CONFLICTO : SIN_EVIDENCIA;
  }
  return anulado.corregidoPorEventoId === corrector.eventoId ? CONFIRMADA : CONFLICTO;
}
