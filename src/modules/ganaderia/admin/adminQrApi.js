// SPRINT-3D11.3 (R1): cliente del inventario QR (Super Admin). Habla SOLO
// con /api/ganaderia/admin/qr (y sus subrutas) vía el cliente autenticado compartido
// (sesión + CSRF). Ningún POST se reintenta automáticamente.
import { getJsonWithSession, postJsonWithCsrf } from '../auth/ganaderiaAuthedRequest.js';

const BASE = '/api/ganaderia/admin/qr';
const id = (value) => encodeURIComponent(value);

export function listOrganizaciones() {
  return getJsonWithSession(`${BASE}/organizaciones`);
}

export function listLotes() {
  return getJsonWithSession(`${BASE}/lotes?limit=100`);
}

export function getLote(loteId) {
  return getJsonWithSession(`${BASE}/lotes/${id(loteId)}`);
}

export function crearLote(body) {
  return postJsonWithCsrf(`${BASE}/lotes`, body);
}

export function importarLegacy(body) {
  return postJsonWithCsrf(`${BASE}/lotes/importar-legacy`, body);
}

export function cambiarEstadoLote(loteId, estado) {
  return postJsonWithCsrf(`${BASE}/lotes/${id(loteId)}/estado`, { estado });
}

export function asignarLote(loteId, body) {
  return postJsonWithCsrf(`${BASE}/lotes/${id(loteId)}/asignar`, body);
}

/** Descarga directa (GET same-origin con cookie de sesión). */
export function proveedorUrl(loteId, formato) {
  return `${BASE}/lotes/${id(loteId)}/proveedor.${formato === 'html' ? 'html' : 'csv'}`;
}

export function buscarChapetas({ codigo, loteId, estado, organizacionId } = {}) {
  const params = new URLSearchParams();
  if (codigo) params.set('codigo', codigo);
  if (loteId) params.set('loteId', loteId);
  if (estado) params.set('estado', estado);
  if (organizacionId) params.set('organizacionId', organizacionId);
  params.set('limit', '100');
  return getJsonWithSession(`${BASE}/chapetas?${params.toString()}`);
}

export function getChapeta(qrId) {
  return getJsonWithSession(`${BASE}/chapetas/${id(qrId)}`);
}

export function bajaChapeta(qrId, causa, motivo) {
  return postJsonWithCsrf(`${BASE}/chapetas/${id(qrId)}/${causa === 'DANADO' ? 'danada' : 'revocar'}`, { motivo });
}

export function reemplazarChapeta(qrId, { codigoNuevo, motivo }) {
  return postJsonWithCsrf(`${BASE}/chapetas/${id(qrId)}/reemplazar`, { codigoNuevo, motivo });
}
