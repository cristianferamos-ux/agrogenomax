// FASE 1D.2 -- línea de tiempo del animal: lee las fuentes (repositorio),
// deriva pesajes con el motor canónico (construirHistorialPesajes: misma
// diferencia / días / GMD que la pestaña Pesajes y el PDF) y normaliza con
// el modelo puro. null si el animal no existe o es de otra organización.
import { construirHistorialPesajes } from '../pesajesService.js';
import { leerFuentesTimeline } from './timelineRepository.js';
import { construirTimelineAnimal } from './timelineModelo.js';

export async function obtenerTimelineAnimal(organizacionId, animalId, { limit, leerFuentes = leerFuentesTimeline } = {}) {
  const fuentes = await leerFuentes(organizacionId, animalId);
  if (!fuentes) return null;
  // FASE 5B: `historial` (ACTIVOS + ANULADOS): cada fila da su hecho
  // PESAJE_REGISTRADO (created_at) y, si está ANULADA, además PESAJE_ANULADO
  // (anulado_at, motivo). Derivado de animal_pesajes: sin tabla de eventos ni backfill.
  const { historial } = construirHistorialPesajes({ animalId: String(animalId), pesajes: fuentes.pesajes });
  const timeline = construirTimelineAnimal({ animal: fuentes.animal, pesajes: historial, eventosAnimal: fuentes.eventosAnimal, eventosReproductivos: fuentes.eventosReproductivos, limit });
  return { animalId: String(fuentes.animal.animalId), ...timeline };
}
