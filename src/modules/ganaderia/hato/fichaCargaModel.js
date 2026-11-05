// Issue #116: decisión de carga de la ficha del animal (puro, sin React ni red).
//
// La página monta antes de que el proveedor offline abra IndexedDB, así que una
// primera carga puede pedir al servidor sin copia local a la vista, y una segunda
// (ya con repositorio) poner la copia. Dos reglas evitan que el resultado de la
// primera degrade la ficha:
//   1. Solo la carga más reciente toca el estado (crearControlCargas).
//   2. Un fallo remoto nunca retira una ficha vigente del mismo animal: queda como
//      aviso sobre ella (avisoRemoto). Sin ficha, el error se muestra igual que antes.
import { mensajeDeExcepcion, mensajeError } from '../api/errorModel.js';

export const MENSAJE_CARGA_ANIMAL = 'No fue posible cargar el animal.';
export const AVISO_COPIA_LOCAL = 'Mostrando la copia guardada en este dispositivo. No fue posible actualizarla desde el servidor.';
export const AVISO_DATOS_DISPONIBLES = 'No fue posible actualizar la ficha desde el servidor. Se muestran los últimos datos disponibles.';

export const ESTADO_INICIAL_FICHA = Object.freeze({ status: 'loading', animal: null });

/** Generación de cargas: iniciar() deja obsoletas las anteriores; invalidar() también. */
export function crearControlCargas() {
  let actual = 0;
  return {
    iniciar: () => {
      actual += 1;
      return actual;
    },
    vigente: (carga) => carga === actual,
    invalidar: () => {
      actual += 1;
    },
  };
}

function esFichaDe(animal, routeId) {
  if (!animal) return false;
  const id = String(routeId);
  return id.startsWith('local:') ? animal.localUuid === id.slice(6) : String(animal.animalId) === id;
}

/** Al cambiar de ruta se retira la ficha anterior; un refresco del mismo animal la conserva. */
function estadoAlIniciar(actual, routeId) {
  if (!actual.animal || esFichaDe(actual.animal, routeId)) return actual;
  return ESTADO_INICIAL_FICHA;
}

/** Mientras se resuelve la petición se conserva el aviso anterior (sin parpadeo). */
function estadoConCopiaLocal(actual, animal, routeId) {
  const siguiente = { status: 'ok', animal, origen: 'local' };
  return actual.avisoRemoto && esFichaDe(actual.animal, routeId) ? { ...siguiente, avisoRemoto: AVISO_COPIA_LOCAL } : siguiente;
}

/** Invariante #116: con ficha vigente del animal, el fallo remoto solo deja un aviso. */
function estadoTrasFalloRemoto(actual, routeId, estadoSinFicha) {
  if (!esFichaDe(actual.animal, routeId)) return estadoSinFicha;
  return {
    ...actual,
    status: 'ok',
    avisoRemoto: actual.origen === 'local' ? AVISO_COPIA_LOCAL : AVISO_DATOS_DISPONIBLES,
  };
}

function estadoDeRespuestaFallida(respuestaApi) {
  const { ok, status } = respuestaApi;
  if (status === 404) return { status: 'not_found', animal: null };
  // FASE 3C: 5xx con código de seguimiento.
  return { status: 'error', animal: null, mensaje: ok ? MENSAJE_CARGA_ANIMAL : mensajeError(respuestaApi, null, { fallback: MENSAJE_CARGA_ANIMAL }) };
}

/**
 * Una ejecución de la carga de la ficha. Copia local primero (si hay repositorio) y
 * luego el servidor. `setState` admite objeto o función, como el de React.
 */
export async function cargarFicha({ routeId, esLocal, local, obtenerRemoto, silencioso = false, control, setState, setChapetaLocal }) {
  const carga = control.iniciar();
  const vigente = () => control.vigente(carga);
  setState((actual) => estadoAlIniciar(actual, routeId));

  let localEncontrado = false;
  if (local) {
    const animalLocal = await local.getAnimal(routeId).catch(() => null);
    if (!vigente()) return;
    if (animalLocal?.redirectTo) {
      setState({ status: 'redirect', animal: null, to: animalLocal.redirectTo });
      return;
    }
    if (animalLocal) {
      localEncontrado = true;
      setState((actual) => estadoConCopiaLocal(actual, animalLocal, routeId));
      const chapeta = await local.getChapetaDeAnimal(animalLocal).catch(() => null);
      if (!vigente()) return;
      setChapetaLocal(chapeta);
    }
  }
  if (esLocal) {
    if (!localEncontrado) setState({ status: 'not_found', animal: null });
    return;
  }
  if (!localEncontrado && !silencioso) setState((actual) => ({ ...actual, status: 'loading' }));

  let respuestaApi;
  try {
    respuestaApi = await obtenerRemoto(routeId);
  } catch (err) {
    if (!vigente()) return;
    setState((actual) => estadoTrasFalloRemoto(actual, routeId, { status: 'error', animal: null, mensaje: mensajeDeExcepcion(err, MENSAJE_CARGA_ANIMAL) }));
    return;
  }
  if (!vigente()) return;
  if (respuestaApi.ok && respuestaApi.data?.animal) {
    setState({ status: 'ok', animal: respuestaApi.data.animal, origen: 'servidor' });
    return;
  }
  setState((actual) => estadoTrasFalloRemoto(actual, routeId, estadoDeRespuestaFallida(respuestaApi)));
}

/** Solo en la transición sin conexión -> con conexión, y sin pisar una edición abierta. */
export function debeRefrescarAlReconectar({ onlineAntes, online, esLocal, modo }) {
  return online && !onlineAntes && !esLocal && modo === 'ver';
}
