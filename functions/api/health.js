import { corsPreflightResponse, corsRejectedResponse, evaluateStaticCors, json } from '../_data/agxStatic.js';

export function onRequestGet({ request, env } = {}) {
  const decision = evaluateStaticCors({ request, env });
  if (decision.action === 'reject') {
    return corsRejectedResponse(decision);
  }

  return json({ ok: true, database: 'pages-static-fallback', schema: 'agx' }, {}, decision);
}

export const onRequestOptions = corsPreflightResponse;
