// SPRINT-3D9.1: cliente API tenant-safe para el ciclo REAL de pastoreo
// (iniciar/finalizar/cancelar). Mismo patrón que
// ganaderiaDescansoReentradaApi.js -- fetchCsrfToken + credentials:'include'
// + X-CSRF-Token en mutaciones, GET sin CSRF. El cliente NUNCA envía
// fechas -- todas se resuelven server-side.
import { fetchCsrfToken } from '../auth/GanaderiaAuthContext.jsx';

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getJson(path) {
  const response = await fetch(path, { credentials: 'include' });
  const data = await parseJson(response);
  return { ok: response.ok, status: response.status, data };
}

async function postJson(path, body) {
  const csrfToken = await fetchCsrfToken();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  const data = await parseJson(response);
  return { ok: response.ok, status: response.status, data };
}

function base(predioId, potreroId) {
  return `/api/ganaderia/predios/${predioId}/potreros/${potreroId}/ciclos-pastoreo`;
}

export function getCicloActual(predioId, potreroId) {
  return getJson(`${base(predioId, potreroId)}/actual`);
}

export function getCicloHistorial(predioId, potreroId) {
  return getJson(`${base(predioId, potreroId)}/historial`);
}

// El ajuste opcional del lote real (numeroAnimales/pesoPromedioKg/
// categoriaCodigo) es lo ÚNICO que el cliente puede aportar -- nunca una
// fecha. Sin ajuste, precarga el lote de la recomendación de pastoreo vigente.
export function iniciarCicloPastoreo(predioId, potreroId, ajusteLote = {}) {
  return postJson(`${base(predioId, potreroId)}/iniciar`, ajusteLote);
}

export function finalizarCicloPastoreo(predioId, potreroId, cicloId) {
  return postJson(`${base(predioId, potreroId)}/${cicloId}/finalizar`, {});
}

export function cancelarCicloPastoreo(predioId, potreroId, cicloId, motivo) {
  return postJson(`${base(predioId, potreroId)}/${cicloId}/cancelar`, { motivo });
}

// SPRINT-3D9.2
export function getEstadoOperativoPotrero(predioId, potreroId) {
  return getJson(`${base(predioId, potreroId)}/estado-operativo`);
}

export function anularCicloPastoreo(predioId, potreroId, cicloId, motivo) {
  return postJson(`${base(predioId, potreroId)}/${cicloId}/anular`, { motivo });
}

// `cambios` es el objeto de campos a corregir (fechaIngresoReal/
// fechaSalidaReal/categoriaCodigo/numeroAnimales/pesoPromedioKg) -- solo
// se envían los que el usuario efectivamente editó.
export function corregirCicloPastoreo(predioId, potreroId, cicloId, cambios, motivo) {
  return postJson(`${base(predioId, potreroId)}/${cicloId}/corregir`, { ...cambios, motivo });
}

export function evaluarReingreso(predioId, potreroId, { fichaId, resultado, observacion }) {
  return postJson(`${base(predioId, potreroId)}/evaluar-reingreso`, { fichaId, resultado, observacion });
}
