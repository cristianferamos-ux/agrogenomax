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
  const { pesajes } = construirHistorialPesajes({ animalId: String(animalId), pesajes: fuentes.pesajes });
  const timeline = construirTimelineAnimal({ animal: fuentes.animal, pesajes, eventosAnimal: fuentes.eventosAnimal, limit });
  return { animalId: String(fuentes.animal.animalId), ...timeline };
}
