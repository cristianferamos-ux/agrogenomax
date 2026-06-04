import { findQr, json } from '../../_data/agxStatic.js';

export function onRequestGet({ params }) {
  const result = findQr(params.codigo);

  if (!result) {
    return json({ exists: false, codigo: params.codigo }, { status: 404 });
  }

  return json(result);
}
