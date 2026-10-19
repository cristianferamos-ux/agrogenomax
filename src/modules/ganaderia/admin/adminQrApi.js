// SPRINT-3D11.3 (R1): cliente del inventario QR (Super Admin). Habla SOLO
// con /api/ganaderia/admin/qr (y sus subrutas) vía el cliente autenticado compartido
// (sesión + CSRF). Ningún POST se reintenta automáticamente.
import { getFileWithSession, getJsonWithSession, postJsonWithCsrf } from '../auth/ganaderiaAuthedRequest.js';

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

const FABRICACION_ARCHIVOS = Object.freeze({
  paquete: 'paquete.zip',
  pdf: 'referencia.pdf',
  manifest: 'manifest.csv',
  html: 'proveedor.html',
});

/** Descarga directa (GET same-origin con cookie de sesión). */
export function fabricacionUrl(loteId, archivo) {
  return `${BASE}/lotes/${id(loteId)}/${FABRICACION_ARCHIVOS[archivo] ?? FABRICACION_ARCHIVOS.manifest}`;
}

export function arteSvgUrl(qrId) {
  return `${BASE}/chapetas/${id(qrId)}/arte.svg`;
}

/**
 * Paquete de fabricación (ZIP) vía el cliente autenticado: devuelve el
 * archivo y el SHA-256 anunciado por el servidor (X-Content-SHA256) para
 * compararlo con el calculado en el navegador.
 */
export async function descargarPaqueteFabricacion(loteId) {
  const result = await getFileWithSession(fabricacionUrl(loteId, 'paquete'));
  if (!result.ok) return result;
  const disposition = result.headers.get('Content-Disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'paquete-fabricacion.zip';
  return { ...result, filename, sha256Servidor: result.headers.get('X-Content-SHA256') };
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
