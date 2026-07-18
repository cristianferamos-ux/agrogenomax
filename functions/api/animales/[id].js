import { corsPreflightResponse, corsRejectedResponse, evaluateStaticCors, findAnimal, json } from '../../_data/agxStatic.js';

export function onRequestGet({ params, request, env }) {
  const decision = evaluateStaticCors({ request, env });
  if (decision.action === 'reject') {
    return corsRejectedResponse(decision);
  }

  const animal = findAnimal(params.id);

  if (!animal) {
    return json({ error: 'Animal no encontrado.' }, { status: 404 }, decision);
  }

  return json(animal, {}, decision);
}

export const onRequestOptions = corsPreflightResponse;
