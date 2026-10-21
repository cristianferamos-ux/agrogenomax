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

// FASE 1B: pesajes del animal (API Business de Fase 1A). GET devuelve el
// historial ascendente con diferencia/días/GMD y el resumen; el POST es
// idempotente por clientOperationId y nunca se reintenta automáticamente.
export function listPesajes(animalId) {
  return getJsonWithSession(`${BASE}/animales/${encodeURIComponent(animalId)}/pesajes`);
}

export function registrarPesaje(animalId, body) {
  return postJsonWithCsrf(`${BASE}/animales/${encodeURIComponent(animalId)}/pesajes`, body);
}

// SPRINT-3D11.3 (R1): chapetas QR de la organización (asignadas por el
// Super Admin). La organización nunca genera chapetas ni ve el stock central.
export function resolveQrToken(token) {
  return getJsonWithSession(`${BASE}/qr/token/${encodeURIComponent(token)}`);
}

export function resolveQrCodigo(codigo) {
  return getJsonWithSession(`${BASE}/qr/codigo/${encodeURIComponent(codigo)}`);
}

export function listChapetas({ estado } = {}) {
  return getJsonWithSession(`${BASE}/qr/chapetas${estado ? `?estado=${encodeURIComponent(estado)}` : ''}`);
}

export function registrarAnimalConChapeta(codigo, body) {
  return postJsonWithCsrf(`${BASE}/qr/chapetas/${encodeURIComponent(codigo)}/registrar-animal`, body);
}

export function getAnimalQr(animalId) {
  return getJsonWithSession(`${BASE}/animales/${encodeURIComponent(animalId)}/qr`);
}

export function asociarQr(animalId, codigoVisible) {
  return postJsonWithCsrf(`${BASE}/animales/${encodeURIComponent(animalId)}/qr/asociar`, { codigoVisible });
}

export function reemplazarQr(animalId, { codigoNuevo, motivo }) {
  return postJsonWithCsrf(`${BASE}/animales/${encodeURIComponent(animalId)}/qr/reemplazar`, { codigoNuevo, motivo });
}

export function bajaQr(animalId, { causa, motivo }) {
  return postJsonWithCsrf(`${BASE}/animales/${encodeURIComponent(animalId)}/qr/baja`, { causa, motivo });
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
