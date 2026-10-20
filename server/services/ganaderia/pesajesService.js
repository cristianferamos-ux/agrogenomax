// FASE 1A -- lógica de negocio de pesajes. Las derivaciones (diferencia,
// días, GMD, ganancia acumulada, resumen) usan el motor de pesajes: la fuente
// canónica es shared/ganaderia/engine/ (la reexporta el frontend) y
// server/services/ganaderia/engine/ es su COPIA BYTE A BYTE, porque el runtime
// de Railway solo garantiza server/ (ver
// server/__tests__/architecture/noSrcImports.test.js). La paridad la exige
// server/services/__tests__/ganaderiaEngineParidad.test.js: una sola fórmula.
// Nada derivado se persiste. Sin redondeo (solo al presentar).
import { calcularGananciaAcumulada, enriquecerPesajes } from './engine/pesajes.js';
import { listPesajesDeAnimal, registrarPesajeIdempotente } from './pesajesRepository.js';

function presentarPesaje(row) {
  return {
    pesajeId: row.pesajeId,
    fecha: row.fecha,
    pesoKg: row.pesoKg,
    metodo: row.metodo,
    origen: row.origen,
    observaciones: row.observaciones,
    createdAt: row.createdAt,
    diferenciaKg: row.diferenciaKg,
    diasDesdeAnterior: row.diasDesdeAnterior,
    gmdKgDia: row.gmdKgDia,
  };
}

/**
 * Historial derivado. `pesajes` en orden cronológico ASCENDENTE (fecha,
 * pesajeId), listo para graficar; `resumen` independiente con el último
 * peso. La ganancia acumulada parte del PRIMER PESO REGISTRADO de la serie
 * (no es peso al nacimiento).
 */
export function construirHistorialPesajes({ animalId, pesajes }) {
  const enriquecidos = enriquecerPesajes(pesajes).map(presentarPesaje);
  const ultimo = enriquecidos.at(-1) ?? null;
  const acumulada = calcularGananciaAcumulada(pesajes);
  return {
    animalId,
    orden: 'ASCENDENTE',
    resumen: {
      totalPesajes: enriquecidos.length,
      ultimoPesoKg: ultimo?.pesoKg ?? null,
      fechaUltimoPeso: ultimo?.fecha ?? null,
      metodoUltimoPeso: ultimo?.metodo ?? null,
      pesoAnteriorKg: ultimo && enriquecidos.length > 1 ? enriquecidos.at(-2).pesoKg : null,
      diferenciaKg: ultimo?.diferenciaKg ?? null,
      diasDesdeAnterior: ultimo?.diasDesdeAnterior ?? null,
      gmdKgDia: ultimo?.gmdKgDia ?? null,
      gananciaAcumulada: acumulada
        ? {
            primerPesoRegistradoKg: acumulada.pesoInicialKg,
            fechaPrimerPesoRegistrado: enriquecidos[0].fecha,
            ultimoPesoKg: acumulada.pesoFinalKg,
            gananciaKg: acumulada.gananciaKg,
            dias: acumulada.dias,
            gmdPromedioKgDia: acumulada.gmdPromedioKgDia,
          }
        : null,
    },
    pesajes: enriquecidos,
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
