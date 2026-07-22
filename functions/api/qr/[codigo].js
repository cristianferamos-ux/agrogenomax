import { corsPreflightResponse, corsRejectedResponse, evaluateStaticCors, findQr, json } from '../../_data/agxStatic.js';

export function onRequestGet({ params, request, env }) {
  const decision = evaluateStaticCors({ request, env });
  if (decision.action === 'reject') {
    return corsRejectedResponse(decision);
  }

  const result = findQr(params.codigo);

  if (!result) {
    return json({ exists: false, codigo: params.codigo }, { status: 404 }, decision);
  }

  return json(result, {}, decision);
}

export const onRequestOptions = corsPreflightResponse;
