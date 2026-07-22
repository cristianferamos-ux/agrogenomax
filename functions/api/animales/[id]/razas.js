import { corsPreflightResponse, corsRejectedResponse, evaluateStaticCors, findAnimalRazas, json } from '../../../_data/agxStatic.js';

export function onRequestGet({ params, request, env }) {
  const decision = evaluateStaticCors({ request, env });
  if (decision.action === 'reject') {
    return corsRejectedResponse(decision);
  }

  const razas = findAnimalRazas(params.id);

  if (!razas) {
    return json({ error: 'Animal no encontrado.' }, { status: 404 }, decision);
  }

  return json(razas, {}, decision);
}

export const onRequestOptions = corsPreflightResponse;
