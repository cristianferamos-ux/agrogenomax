// SPRINT-3D11.2: cliente del módulo de animales. Habla EXCLUSIVAMENTE con
// /api/ganaderia/* (Postgres-AGX-Business, sesión + CSRF) vía el cliente
// autenticado compartido -- nunca con api/ganaderiaApi.js ni con las rutas
// legacy /api/animales, /api/qr o /api/razas (desmontadas). Ninguna
// función reintenta un POST automáticamente.
import { getJsonWithSession, postJsonWithCsrf } from '../auth/ganaderiaAuthedRequest.js';

const BASE = '/api/ganaderia';

export function listAnimales({ predioId, estado, sexo, q, limit, offset } = {}) {
  const params = new URLSearchParams();
  if (predioId) params.set('predioId', predioId);
  if (estado) params.set('estado', estado);
  if (sexo) params.set('sexo', sexo);
  if (q) params.set('q', q);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const query = params.toString();
  return getJsonWithSession(`${BASE}/animales${query ? `?${query}` : ''}`);
}

export function getAnimal(animalId) {
  return getJsonWithSession(`${BASE}/animales/${encodeURIComponent(animalId)}`);
}

export function createAnimal(body) {
  return postJsonWithCsrf(`${BASE}/animales`, body);
}

export function corregirAnimal(animalId, body) {
  return postJsonWithCsrf(`${BASE}/animales/${encodeURIComponent(animalId)}/corregir`, body);
}

export function anularAnimal(animalId, motivo) {
  return postJsonWithCsrf(`${BASE}/animales/${encodeURIComponent(animalId)}/anular`, { motivo });
}

export function listRazas() {
  return getJsonWithSession(`${BASE}/catalogo-razas`);
}

export function listCategoriasProductivas() {
  return getJsonWithSession(`${BASE}/categorias-productivas`);
}

export function listPrediosActivos() {
  return getJsonWithSession(`${BASE}/predios`);
}
