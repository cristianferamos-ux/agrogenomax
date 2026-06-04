import { findAnimalRazas, json } from '../../../_data/agxStatic.js';

export function onRequestGet({ params }) {
  const razas = findAnimalRazas(params.id);

  if (!razas) {
    return json({ error: 'Animal no encontrado.' }, { status: 404 });
  }

  return json(razas);
}
