// Issue #116: decisión de carga de la ficha del animal (puro, sin React ni red).
//
// La página monta antes de que el proveedor offline abra IndexedDB, así que una
// primera carga puede pedir al servidor sin copia local a la vista, y una segunda
// (ya con repositorio) poner la copia. Reglas:
//   1. Solo la carga más reciente toca el estado (crearControlCargas).
//   2. Un fallo remoto nunca retira una ficha vigente: queda como aviso sobre ella
//      (avisoRemoto). Sin ficha vigente, el error se muestra igual que antes.
//   3. Una ficha es vigente solo para el MISMO animal y la MISMA organización
//      activa: la de otra organización nunca se conserva ni se muestra.
//   4. Con una edición abierta no se refresca la entidad base por debajo del
//      formulario: el refresco se aplaza hasta cerrarla (crearGuardEdicion).
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

function esAnimalDeRuta(animal, routeId) {
  if (!animal) return false;
  const id = String(routeId);
  return id.startsWith('local:') ? animal.localUuid === id.slice(6) : String(animal.animalId) === id;
}

/** La ficha del estado es de este animal Y de la organización activa. */
export function esFichaDe(actual, routeId, organizacionId) {
  return Boolean(actual?.animal) && actual.organizacionId === organizacionId && esAnimalDeRuta(actual.animal, routeId);
}

/** Lo que la página puede pintar: una ficha ajena (otro animal u organización) nunca. */
export function vistaFicha(actual, routeId, organizacionId) {
  if (!actual?.animal || esFichaDe(actual, routeId, organizacionId)) return actual;
  return ESTADO_INICIAL_FICHA;
}

/** Repositorio local solo si pertenece a la organización activa (IndexedDB por organización). */
export function repoDeOrganizacion(repo, organizacionId) {
  return repo && organizacionId && repo.organizacionId === organizacionId ? repo : null;
}

/** Ficha confirmada por el servidor para la organización activa (cargas y guardados). */
export function estadoDeServidor(animal, organizacionId) {
  return { status: 'ok', animal, origen: 'servidor', organizacionId };
}

/** Al cambiar de animal u organización se retira la ficha; un refresco de la misma la conserva. */
function estadoAlIniciar(actual, routeId, organizacionId) {
  if (!actual.animal || esFichaDe(actual, routeId, organizacionId)) return actual;
  return ESTADO_INICIAL_FICHA;
}

/** Mientras se resuelve la petición se conserva el aviso anterior (sin parpadeo). */
function estadoConCopiaLocal(actual, animal, routeId, organizacionId) {
  const siguiente = { status: 'ok', animal, origen: 'local', organizacionId };
  return actual.avisoRemoto && esFichaDe(actual, routeId, organizacionId) ? { ...siguiente, avisoRemoto: AVISO_COPIA_LOCAL } : siguiente;
}

/** Invariante #116: con ficha vigente (animal y organización), el fallo remoto solo deja un aviso. */
function estadoTrasFalloRemoto(actual, routeId, organizacionId, estadoSinFicha) {
  if (!esFichaDe(actual, routeId, organizacionId)) return estadoSinFicha;
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
 * Una ejecución de la carga de la ficha. Copia local primero (si hay repositorio de
 * la organización activa) y luego el servidor. `setState` admite objeto o función.
 */
export async function cargarFicha({ routeId, organizacionId = null, esLocal, local, obtenerRemoto, silencioso = false, control, setState, setChapetaLocal }) {
  const carga = control.iniciar();
  const vigente = () => control.vigente(carga);
  const repo = repoDeOrganizacion(local, organizacionId);
  setState((actual) => estadoAlIniciar(actual, routeId, organizacionId));

  let localEncontrado = false;
  if (repo) {
    const animalLocal = await repo.getAnimal(routeId).catch(() => null);
    if (!vigente()) return;
    if (animalLocal?.redirectTo) {
      setState({ status: 'redirect', animal: null, to: animalLocal.redirectTo });
      return;
    }
    if (animalLocal) {
      localEncontrado = true;
      setState((actual) => estadoConCopiaLocal(actual, animalLocal, routeId, organizacionId));
      const chapeta = await repo.getChapetaDeAnimal(animalLocal).catch(() => null);
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
    setState((actual) => estadoTrasFalloRemoto(actual, routeId, organizacionId, { status: 'error', animal: null, mensaje: mensajeDeExcepcion(err, MENSAJE_CARGA_ANIMAL) }));
    return;
  }
  if (!vigente()) return;
  if (respuestaApi.ok && respuestaApi.data?.animal) {
    setState(estadoDeServidor(respuestaApi.data.animal, organizacionId));
    return;
  }
  setState((actual) => estadoTrasFalloRemoto(actual, routeId, organizacionId, estadoDeRespuestaFallida(respuestaApi)));
}

/** Solo en la transición sin conexión -> con conexión (el guard de edición decide si se aplica). */
export function debeRefrescarAlReconectar({ onlineAntes, online, esLocal }) {
  return online && !onlineAntes && !esLocal;
}

/** "Actualizar" solo con la ficha en lectura: nunca con una corrección o anulación abierta. */
export function puedeActualizarManual(modo) {
  return modo === 'ver';
}

/**
 * C2: con una edición abierta, ningún refresco toca la entidad base. solicitar()
 * dice si se aplica ya; si no, queda pendiente y cerrar() indica que toca refrescar.
 * El conflicto ANIMAL_MODIFICADO cierra la edición antes de recargar.
 */
export function crearGuardEdicion() {
  let editando = false;
  let pendiente = false;
  return {
    editando: () => editando,
    abrir: () => {
      editando = true;
      // Lo que estuviera en curso al abrir no se aplica: se vuelve a pedir al cerrar.
      pendiente = true;
    },
    solicitar: () => {
      if (!editando) return true;
      pendiente = true;
      return false;
    },
    cerrar: () => {
      editando = false;
      const refrescar = pendiente;
      pendiente = false;
      return refrescar;
    },
    /** Cambio de animal u organización: la edición abierta deja de tener sentido. */
    descartar: () => {
      editando = false;
      pendiente = false;
    },
  };
}
