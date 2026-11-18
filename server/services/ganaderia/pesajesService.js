// FASE 1A / FASE 5A.1b -- lógica de negocio de pesajes. Las derivaciones
// (diferencia, días, GMD, ganancia acumulada, mismo día, resumen) usan el
// motor de pesajes: la fuente canónica es shared/ganaderia/engine/ (la
// reexporta el frontend) y server/services/ganaderia/engine/ es su COPIA BYTE
// A BYTE, porque el runtime de Railway solo garantiza server/ (ver
// server/__tests__/architecture/noSrcImports.test.js). La paridad la exige
// server/services/__tests__/ganaderiaEngineParidad.test.js: una sola fórmula.
// Nada derivado se persiste. Sin redondeo (solo al presentar).
//
// FASE 5A: todo cálculo productivo usa SOLO pesajes ACTIVOS y la serie diaria
// (último ACTIVO de cada fecha). `pesajes` conserva su semántica histórica
// (lista productiva: solo ACTIVOS); `historial` añade los ANULADOS.
import { calcularGananciaAcumulada, enriquecerHistorialPesajes } from './engine/pesajes.js';
import { anularPesajeIdempotente, listPesajesDeAnimal, registrarPesajeIdempotente } from './pesajesRepository.js';

function presentarPesaje(row) {
  return {
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
  };
}

/**
 * Historial derivado. `pesajes` (ACTIVOS) e `historial` (ACTIVOS + ANULADOS)
 * en orden cronológico ASCENDENTE (fecha, pesajeId), listos para graficar;
 * `resumen` calculado exclusivamente con la serie diaria ACTIVA. La ganancia
 * acumulada parte del PRIMER PESO REGISTRADO activo de la serie (no es peso al
 * nacimiento).
 */
export function construirHistorialPesajes({ animalId, pesajes }) {
  const historial = enriquecerHistorialPesajes(pesajes).map(presentarPesaje);
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

/** null si el animal no existe o es de otra organización. */
export async function obtenerHistorialPesajes(organizacionId, animalId) {
  const data = await listPesajesDeAnimal(organizacionId, animalId);
  return data ? construirHistorialPesajes(data) : null;
}

export function registrarPesaje(organizacionId, animalId, value, { actorCuentaId }) {
  return registrarPesajeIdempotente(organizacionId, animalId, value, { actorCuentaId });
}

/**
 * Anulación auditada. Devuelve el pesaje anulado (con su anulación) y el
 * resumen productivo recalculado desde la MISMA transacción.
 */
export async function anularPesaje(organizacionId, animalId, pesajeId, value, { actorCuentaId }) {
  const { pesajes, yaExistia } = await anularPesajeIdempotente(organizacionId, animalId, pesajeId, value, { actorCuentaId });
  const derivado = construirHistorialPesajes({ animalId: String(animalId), pesajes });
  return {
    yaExistia,
    pesaje: derivado.historial.find((p) => p.pesajeId === String(pesajeId)),
    resumen: derivado.resumen,
  };
}
