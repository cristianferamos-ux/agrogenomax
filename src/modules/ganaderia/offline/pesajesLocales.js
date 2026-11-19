// FASE 5A.3b -- lógica PURA de los pesajes locales (sin storage, React ni red):
// contrato del store `pesajes`, fusión sin retroceso, conciliación EXACTA de
// PESAJE_CREAR / PESAJE_ANULAR con filas de GET /api/ganaderia/sync/pesajes y
// derivación del último peso local. La usan localRepo (escrituras) y, en 5A.3c, la UI.
//
// Conciliación (nunca "se parece"):
//   CREATE  confirmado solo si una fila trae clientOperationId === op.clientOperationId,
//           animalId === op.payload.animalId y un pesajeId válido. Ni fecha, ni peso,
//           ni "mismo animal" bastan.
//   ANULAR  confirmado solo si la fila del pesaje esperado cumple TODO:
//           anulacionClientOperationId === op.clientOperationId, pesajeId y animalId
//           esperados, estadoRegistro ANULADO y motivo idéntico (normalizado). Una
//           anulación hecha por OTRA operación nunca cierra esta pendiente.
//
// Último peso local: ACTIVOS confirmados, menos los que tienen una ANULAR pendiente
// coherente, orden fecha desc y pesajeId desc (mismo orden que el `lateral` de
// animalesRepository). Con la copia local incompleta -> animal.ultimoPeso (respaldo
// conservador: un dato parcial nunca se presenta como certeza).
import { OUTBOX_ESTADOS, PESAJE_ANULAR, PESAJE_CREAR, normalizarMotivo } from './outbox.js';

export const ESTADO_PESAJE = Object.freeze({ ACTIVO: 'ACTIVO', ANULADO: 'ANULADO' });
/** Mismo límite que el servidor (pesajeValidation.js, CHECK de 0028). */
export const MAX_MOTIVO_ANULACION_PESAJE = 500;

/** Estados en los que una operación de pesaje sigue "en curso" (se aplicará tal cual). */
export const ESTADOS_PESAJE_EN_CURSO = Object.freeze([
  OUTBOX_ESTADOS.PENDIENTE,
  OUTBOX_ESTADOS.SINCRONIZANDO,
  OUTBOX_ESTADOS.ERROR_REINTENTABLE,
  OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD,
]);

const ID_SERVIDOR = /^[1-9]\d{0,18}$/;
export const esIdPesajeValido = (valor) => ID_SERVIDOR.test(String(valor ?? ''));
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function errorPull() {
  return Object.assign(new Error('Respuesta de sincronización no válida.'), { code: 'PULL_PESAJES_INVALIDO' });
}

/**
 * Fila de /sync/pesajes -> registro del store. Solo los campos del contrato: nunca
 * actor, anulado_por ni nada ajeno. Una fila incompleta invalida la página entera.
 */
export function proyectarPesajeSync(fila, organizacionId) {
  if (!fila || !esIdPesajeValido(fila.pesajeId) || !esIdPesajeValido(fila.animalId)) throw errorPull();
  if (fila.organizacionId !== organizacionId) {
    throw Object.assign(new Error('Los datos recibidos son de otra organización.'), { code: 'ORGANIZACION_DISTINTA' });
  }
  const estadoRegistro = fila.estadoRegistro === ESTADO_PESAJE.ANULADO ? ESTADO_PESAJE.ANULADO : ESTADO_PESAJE.ACTIVO;
  if (fila.estadoRegistro !== undefined && fila.estadoRegistro !== estadoRegistro) throw errorPull();
  return {
    pesajeId: String(fila.pesajeId),
    animalId: String(fila.animalId),
    organizacionId,
    fecha: fila.fecha,
    pesoKg: Number(fila.pesoKg),
    metodo: fila.metodo ?? null,
    origen: fila.origen ?? null,
    observaciones: fila.observaciones ?? null,
    createdAt: fila.createdAt ?? null,
    estadoRegistro,
    anulacion: estadoRegistro === ESTADO_PESAJE.ANULADO && fila.anulacion
      ? { anuladoEn: fila.anulacion.anuladoEn ?? null, motivo: fila.anulacion.motivo ?? null }
      : null,
    clientOperationId: fila.clientOperationId ?? null,
    anulacionClientOperationId: fila.anulacionClientOperationId ?? null,
  };
}

/**
 * Upsert sin retroceso: ANULADO es terminal. Un dato viejo ACTIVO (solape, página
 * repetida, respuesta tardía) nunca devuelve a ACTIVO un pesaje ya ANULADO. La
 * evidencia de conciliación ya conocida tampoco se pierde.
 */
export function fusionarPesaje(existente, entrante) {
  if (!existente) return entrante;
  if (existente.estadoRegistro === ESTADO_PESAJE.ANULADO && entrante.estadoRegistro !== ESTADO_PESAJE.ANULADO) return existente;
  return {
    ...existente,
    ...entrante,
    anulacion: entrante.anulacion ?? (entrante.estadoRegistro === ESTADO_PESAJE.ANULADO ? existente.anulacion ?? null : null),
    clientOperationId: entrante.clientOperationId ?? existente.clientOperationId ?? null,
    anulacionClientOperationId: entrante.anulacionClientOperationId ?? existente.anulacionClientOperationId ?? null,
  };
}

/** Respuesta de POST .../pesajes (vista pública) -> registro del store, con la evidencia del CREATE. */
export function pesajeConfirmadoDeCreate(op, pesaje, organizacionId) {
  if (!pesaje || !esIdPesajeValido(pesaje.pesajeId)) return null;
  return proyectarPesajeSync({
    ...pesaje,
    animalId: op.payload.animalId,
    organizacionId,
    clientOperationId: op.clientOperationId,
    anulacionClientOperationId: pesaje.anulacionClientOperationId ?? null,
  }, organizacionId);
}

/** ¿Esta fila confirma EXACTAMENTE este CREATE? */
export function filaConfirmaCreate(op, fila) {
  return op?.tipoOperacion === PESAJE_CREAR
    && Boolean(op.clientOperationId)
    && fila?.clientOperationId === op.clientOperationId
    && String(fila.animalId) === String(op.payload?.animalId)
    && esIdPesajeValido(fila.pesajeId);
}

/** pesajeId objetivo de una ANULAR: el del payload o, si es diferida, el del CREATE confirmado. */
export function pesajeIdObjetivo(op, pesajesConocidos) {
  if (op?.tipoOperacion !== PESAJE_ANULAR) return null;
  if (esIdPesajeValido(op.payload?.pesajeId)) return String(op.payload.pesajeId);
  const ref = op.payload?.pesajeRef?.clientOperationId;
  if (!ref) return null;
  const candidatos = pesajesConocidos.filter((p) => p.clientOperationId === ref && String(p.animalId) === String(op.payload.animalId));
  // Más de una fila con el mismo clientOperationId no puede ocurrir (UNIQUE en el servidor): sin certeza, no se resuelve.
  return candidatos.length === 1 ? candidatos[0].pesajeId : null;
}

/** ¿Esta fila confirma EXACTAMENTE esta ANULAR (todas las condiciones)? */
export function filaConfirmaAnular(op, fila, pesajeIdEsperado) {
  return op?.tipoOperacion === PESAJE_ANULAR
    && esIdPesajeValido(pesajeIdEsperado)
    && Boolean(op.clientOperationId)
    && fila?.anulacionClientOperationId === op.clientOperationId
    && String(fila.pesajeId) === String(pesajeIdEsperado)
    && String(fila.animalId) === String(op.payload?.animalId)
    && fila.estadoRegistro === ESTADO_PESAJE.ANULADO
    && normalizarMotivo(fila.anulacion?.motivo) === normalizarMotivo(op.payload?.motivo)
    && normalizarMotivo(op.payload?.motivo) !== '';
}

/** Comparador determinista: fecha desc y, en la misma fecha, pesajeId desc (BigInt: sin pérdida de precisión). */
export function compararPesajesRecientePrimero(a, b) {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
  const ia = BigInt(a.pesajeId);
  const ib = BigInt(b.pesajeId);
  if (ia === ib) return 0;
  return ia < ib ? 1 : -1;
}

/** ANULAR en curso (no en conflicto ni rechazada) del animal, por pesajeId resuelto. */
export function anulacionesPendientesCoherentes(operaciones, pesajesConocidos, animalId) {
  const ids = new Set();
  for (const op of operaciones) {
    if (op?.tipoOperacion !== PESAJE_ANULAR || String(op.payload?.animalId) !== String(animalId)) continue;
    if (!ESTADOS_PESAJE_EN_CURSO.includes(op.estado)) continue;
    const pesajeId = pesajeIdObjetivo(op, pesajesConocidos);
    if (pesajeId) ids.add(pesajeId);
  }
  return ids;
}

const pesoValido = (p) => FECHA.test(String(p?.fecha ?? '')) && Number.isFinite(Number(p?.pesoKg)) && Number(p.pesoKg) > 0 && esIdPesajeValido(p.pesajeId);

/**
 * Último peso local de un animal.
 *   pesajes        filas del store `pesajes` de ese animal
 *   operaciones    outbox (se filtra por animal)
 *   animal         copia local (respaldo animal.ultimoPeso)
 *   copiaCompleta  el store terminó un recorrido conciliado (meta.pesajesListaAt)
 *   incluirPendientes  agrega CREATE pendientes, aparte y marcados, sin mezclarlos
 * -> { ultimoPeso: { pesoKg, fecha, metodo, pesajeId } | null, fuente: 'LOCAL' | 'ANIMAL',
 *      completo, excluidosPorAnulacion: pesajeId[], pendientes? }
 */
export function derivarUltimoPesoLocal({ pesajes = [], operaciones = [], animal = null, copiaCompleta = false, incluirPendientes = false } = {}) {
  const animalId = animal?.animalId != null ? String(animal.animalId) : (pesajes[0]?.animalId ?? null);
  const pendientes = incluirPendientes
    ? operaciones
      .filter((op) => op?.tipoOperacion === PESAJE_CREAR && String(op.payload?.animalId) === String(animalId) && ESTADOS_PESAJE_EN_CURSO.includes(op.estado))
      .map((op) => ({ pendiente: true, localOperationId: op.operationId, clientOperationId: op.clientOperationId, fecha: op.payload.fecha, pesoKg: Number(op.payload.pesoKg), metodo: op.payload.metodo ?? null, estado: op.estado }))
    : undefined;
  const conPendientes = (resultado) => (incluirPendientes ? { ...resultado, pendientes } : resultado);

  if (!copiaCompleta) {
    const respaldo = animal?.ultimoPeso ?? null;
    return conPendientes({ ultimoPeso: respaldo ? { ...respaldo, pesajeId: respaldo.pesajeId ?? null } : null, fuente: 'ANIMAL', completo: false, excluidosPorAnulacion: [] });
  }
  const anulando = anulacionesPendientesCoherentes(operaciones, pesajes, animalId);
  const vigentes = pesajes
    .filter((p) => String(p.animalId) === String(animalId) && p.estadoRegistro !== ESTADO_PESAJE.ANULADO && pesoValido(p));
  const candidatos = vigentes.filter((p) => !anulando.has(p.pesajeId)).sort(compararPesajesRecientePrimero);
  const ultimo = candidatos[0] ?? null;
  return conPendientes({
    ultimoPeso: ultimo ? { pesoKg: Number(ultimo.pesoKg), fecha: ultimo.fecha, metodo: ultimo.metodo ?? null, pesajeId: ultimo.pesajeId } : null,
    fuente: 'LOCAL',
    completo: true,
    excluidosPorAnulacion: vigentes.filter((p) => anulando.has(p.pesajeId)).map((p) => p.pesajeId).sort(),
  });
}
