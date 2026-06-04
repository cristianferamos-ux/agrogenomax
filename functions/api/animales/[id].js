import { findAnimal, json } from '../../_data/agxStatic.js';

export function onRequestGet({ params }) {
  const animal = findAnimal(params.id);

  if (!animal) {
    return json({ error: 'Animal no encontrado.' }, { status: 404 });
  }

  return json(animal);
}
