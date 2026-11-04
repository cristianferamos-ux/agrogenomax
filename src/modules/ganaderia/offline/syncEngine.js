// SPRINT-3D11.3 (R1) -- motor de sincronización offline-first. JS puro,
// desacoplado de React, del DOM y del transporte: corre en la página, en el
// Service Worker (Background Sync) y, en el futuro, en Capacitor/app nativa
// con otro `transport` y otro adaptador de almacenamiento.
//
// Ciclo (run): 1) PUSH -- envía el outbox en orden de creación, cada
// operación a un endpoint idempotente por clientOperationId y transaccional
// en el backend; 2) PULL -- GET /api/ganaderia/sync/pull?cursor=... y
// aplica los cambios sin pisar lo pendiente local (localRepo.aplicarPull).
//
// Clasificación de la respuesta de una operación:
//   2xx                               -> SINCRONIZADO (se aplica y se elimina)
//   red / no enviada (status 0)       -> ERROR_REINTENTABLE tipo 'red': NO suma intento ni
//                                        backoff exponencial; reintento fijo corto y, al volver
//                                        la red (online / visible), inmediato
//   408 / 429 / 5xx                   -> ERROR_REINTENTABLE tipo 'http' con backoff; corta el PUSH
//   sesión expirada / CSRF            -> vuelve a PENDIENTE; el ciclo se detiene (requiere login)
//   409 / 404 / 410                   -> CONFLICTO (dato incompatible: se conserva todo)
//   otros 4xx (400 validación)        -> RECHAZADO (requiere corrección del usuario)
//   403 ROLE_FORBIDDEN (FASE 3A)      -> RECHAZADO terminal: el rol ya no permite la
//                                        operación; nunca se reintenta en bucle
// Una operación idempotente repetida (200 yaExistia) es un éxito más.
//
// Concurrencia (FASE-14): un `lock` opcional (navigator.locks, clave por
// organización) serializa los motores de varias pestañas y del Service
// Worker. Sin lock, la idempotencia del servidor sigue evitando duplicados.
//
// FASE 4E.1 -- operaciones con `claveOrden` (cadena causal FIFO por animal):
//   * una operación que no se envía DETIENE su cadena: backoff, enviándose,
//     conflicto, rechazo, tipo desconocido o cuenta distinta. Las siguientes no
//     se adelantan; las demás cadenas siguen. Un conflicto o rechazo espera
//     resolución explícita: nunca se salta al siguiente evento.
//   * se reclama con una transición ATÓMICA (doble envío entre motores sin lock
//     y carrera con editar / cancelar) y `posibleEnServidor` queda persistido
//     antes del POST.
//   * identidad: antes de CADA envío se pregunta al servidor qué cuenta y
//     organización tiene la sesión. Si no son las de `origen`, la operación queda
//     BLOQUEADA_POR_IDENTIDAD sin enviarse y vuelve a salir con su cuenta
//     original. Sesión expirada, respuesta no verificable u `origen` incompleto:
//     tampoco se envía y queda igual de bloqueada (solo sin red sigue como
//     estaba, porque no se puede enviar nada). La autoridad es el servidor: el
//     POST lleva identidadEsperada y, si la cookie cambió tras la verificación,
//     responde 409 IDENTIDAD_NO_COINCIDE sin escribir nada.
// Tipo desconocido (bundle antiguo): la operación se conserva, se marca
// `runtimeNoSoporta` y nunca se descarta. Las operaciones sin claveOrden
// conservan su comportamiento anterior.
import { OUTBOX_ESTADOS, SINCRONIZANDO_LEASE_MS, backoffMs, estaLista, esErrorDeRed, operacionesEnTurno, ordenarOutbox, origenVerificable } from './outbox.js';
import { handlerDe } from './operationHandlers.js';

const PULL_PATH = '/api/ganaderia/sync/pull';
const SESSION_PATH = '/api/ganaderia/auth/session';
const REPRO_PULL_PATH = '/api/ganaderia/sync/reproduccion';
/** 40 páginas de 500: una descarga inicial grande reparte su coste entre ciclos. */
export const REPRO_MAX_PAGINAS_POR_CICLO = 40;
/** Reintento fijo tras un fallo de red (sin crecer): la red suele volver sola. */
export const RED_REINTENTO_MS = 30_000;
export { SINCRONIZANDO_LEASE_MS };

const FALLOS_SIN_ENVIO = new Set(['NETWORK_ERROR', 'REQUEST_NOT_SENT']);

/** Fallo de transporte: sin respuesta HTTP (fetch lanzó o /csrf sin red). Nunca un 5xx. */
export function esFalloDeRed(result) {
  return Boolean(result) && !result.ok && (result.status ?? 0) === 0 && (result.failure === undefined || FALLOS_SIN_ENVIO.has(result.failure));
}

export const RUN_RESULT = Object.freeze({
  OK: 'OK',
  OFFLINE: 'OFFLINE',
  SESION_REQUERIDA: 'SESION_REQUERIDA',
  ERROR: 'ERROR',
  EN_CURSO: 'EN_CURSO',
});

function isSessionFailure(result) {
  return result?.failure === 'SESSION_EXPIRED' || result?.failure === 'CSRF_REJECTED'
    || (result?.status === 401) || (result?.status === 403 && result?.data?.error === 'SUPERADMIN_REQUIRED');
}

function isRetryable(result) {
  if (!result) return true;
  if (result.failure === 'NETWORK_ERROR' || result.failure === 'REQUEST_NOT_SENT') return true;
  const status = result.status ?? 0;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** 403 por rol (RBAC): nunca sesión ni CSRF, nunca reintentable. */
export function isRoleForbidden(result) {
  return result?.failure === 'ROLE_FORBIDDEN' || (result?.status === 403 && result?.data?.error === 'ROLE_FORBIDDEN');
}

export function classifyResult(result) {
  if (result?.ok) return 'OK';
  if (result?.status === 409 && result?.data?.error === 'IDENTIDAD_NO_COINCIDE') return 'IDENTIDAD';
  if (isSessionFailure(result)) return 'SESION';
  if (isRoleForbidden(result)) return 'RECHAZADO';
  if (isRetryable(result)) return 'REINTENTABLE';
  if ([404, 409, 410].includes(result.status)) return 'CONFLICTO';
  return 'RECHAZADO';
}

/**
 * FASE 4E.1: ¿pudo quedar guardada la operación tras este resultado? Red, 408,
 * 429 y 5xx son inciertos. Un 404/409/410 viene de la transacción, después de
 * la búsqueda idempotente: esta intención no está. El resto (sesión, CSRF, rol,
 * validación, petición no enviada) se decide antes de esa búsqueda y no prueba
 * nada sobre un intento previo: se conserva el valor anterior.
 */
export function posibleEnServidorTras(result, clase, anterior) {
  if (result?.failure === 'REQUEST_NOT_SENT') return Boolean(anterior);
  if (clase === 'REINTENTABLE') return true;
  if (clase === 'CONFLICTO') return false;
  return Boolean(anterior);
}

/**
 * Cuenta y organización REALES de la sesión, preguntadas al servidor (nunca al
 * contexto local: otra pestaña pudo cambiar la cookie). Mismo camino en la
 * página y en el Service Worker.
 */
export async function leerIdentidadSesion(transport) {
  let result;
  try {
    result = await transport.getJson(SESSION_PATH);
  } catch {
    result = { ok: false, status: 0, failure: 'NETWORK_ERROR', data: null };
  }
  if (result?.ok) {
    if (!result.data?.authenticated || !result.data.cuenta?.cuentaId) return { estado: 'SIN_SESION' };
    return { estado: 'OK', cuentaId: result.data.cuenta.cuentaId, organizacionId: result.data.organizacionActiva?.organizacionId ?? null };
  }
  if (isSessionFailure(result)) return { estado: 'SIN_SESION' };
  return { estado: esFalloDeRed(result) ? 'SIN_RED' : 'NO_VERIFICABLE' };
}

const MOTIVO_IDENTIDAD = Object.freeze({
  CUENTA: 'IDENTIDAD_NO_COINCIDE',
  SESION: 'SESION_NO_VERIFICABLE',
  ORIGEN: 'ORIGEN_NO_VERIFICABLE',
});

const errorDeIdentidad = (codigo) => ({ codigo, mensaje: null, status: 0 });

const sesionEsDe = (sesion, op) => sesion.cuentaId === op.origen.cuentaId && sesion.organizacionId === op.origen.organizacionId;

/**
 * @param {object} deps
 * @param {object} deps.repo       localRepo de la organización
 * @param {{ postJson(path, body), getJson(path) }} deps.transport
 * @param {() => boolean} [deps.isOnline]
 * @param {() => Date} [deps.now]
 * @param {() => number} [deps.random]
 * @param {((fn: () => Promise<string>, opciones: { esperar: boolean }) => Promise<string>) | null} [deps.lock]
 *   sección crítica entre motores (createNavigatorLock); null = sin coordinación
 */
export function createSyncEngine({ repo, transport, isOnline = () => true, now = () => new Date(), random = Math.random, lock = null }) {
  let running = null;
  const listeners = new Set();
  const state = { enCurso: false, ultimoResultado: null, sesionRequerida: false, redCaidaAt: null };

  const emit = () => listeners.forEach((listener) => {
    try {
      listener({ ...state });
    } catch {
      // ignorado
    }
  });

  async function guardarOp(op, changes) {
    const updated = { ...op, ...changes, updatedAt: now().toISOString() };
    await repo.putOperacion(updated);
    return updated;
  }

  /** Con cadena la escritura es atómica: null si la operación cambió desde que se leyó. */
  async function actualizarOp(op, changes) {
    if (!op.claveOrden) return guardarOp(op, changes);
    return repo.transicionarOperacion(op, { ...changes, updatedAt: now().toISOString() });
  }

  /** Solo cambia estado y motivo; se reevalúa en cada ciclo y sale con su cuenta. */
  async function bloquearPorIdentidad(op, motivo) {
    if (op.estado === OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD && op.ultimoError?.codigo === motivo) return;
    await actualizarOp(op, { estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, ultimoError: errorDeIdentidad(motivo) });
  }

  async function push({ forzar, exclusivo }) {
    // Recuperación: una operación que quedó SINCRONIZANDO (pestaña cerrada,
    // corte a mitad) se reenvía -- es idempotente en el servidor. Con el lock
    // exclusivo nadie más puede estar enviándola; sin él, solo pasado el
    // lease (evita reenviar lo que otra pestaña está enviando ahora).
    const limiteLease = now().getTime() - SINCRONIZANDO_LEASE_MS;
    for (const op of await repo.listOutbox()) {
      if (op.estado !== OUTBOX_ESTADOS.SINCRONIZANDO) continue;
      if (exclusivo || !op.updatedAt || new Date(op.updatedAt).getTime() <= limiteLease) {
        await actualizarOp(op, { estado: OUTBOX_ESTADOS.PENDIENTE });
      }
    }
    const pendientes = ordenarOutbox(await repo.listOutbox());
    const bloqueadas = new Set();
    const cadenasDetenidas = new Set();
    const detener = (op) => {
      bloqueadas.add(op.localUuid);
      if (op.claveOrden) cadenasDetenidas.add(op.claveOrden);
    };
    for (const original of pendientes) {
      if (original.claveOrden ? cadenasDetenidas.has(original.claveOrden) : bloqueadas.has(original.localUuid)) continue;
      if (original.estado === OUTBOX_ESTADOS.CONFLICTO || original.estado === OUTBOX_ESTADOS.RECHAZADO) {
        detener(original);
        continue;
      }
      // Tipo desconocido: se conserva tal cual y solo se detiene lo suyo.
      const handler = handlerDe(original.tipoOperacion);
      if (!handler) {
        if (!original.runtimeNoSoporta) await repo.transicionarOperacion(original, { runtimeNoSoporta: { at: now().toISOString() } });
        detener(original);
        continue;
      }
      // BLOQUEADA_POR_IDENTIDAD se reevalúa abajo: puede haber vuelto su cuenta.
      if (original.estado !== OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD && !estaLista(original, now(), { forzar })) {
        if (original.claveOrden) detener(original);
        continue;
      }
      const request = await handler.request(original, repo);
      if (!request) {
        if (original.claveOrden) detener(original);
        continue;
      }

      if (original.claveOrden) {
        if (!origenVerificable(original)) {
          await bloquearPorIdentidad(original, MOTIVO_IDENTIDAD.ORIGEN);
          detener(original);
          continue;
        }
        const sesion = await leerIdentidadSesion(transport);
        // Sin red no hay nada que decidir: el ciclo termina y la operación sigue igual.
        if (sesion.estado === 'SIN_RED') return RUN_RESULT.OFFLINE;
        if (sesion.estado === 'SIN_SESION' || sesion.estado === 'NO_VERIFICABLE') {
          await bloquearPorIdentidad(original, MOTIVO_IDENTIDAD.SESION);
          return sesion.estado === 'SIN_SESION' ? RUN_RESULT.SESION_REQUERIDA : RUN_RESULT.ERROR;
        }
        if (!sesionEsDe(sesion, original)) {
          await bloquearPorIdentidad(original, MOTIVO_IDENTIDAD.CUENTA);
          detener(original);
          continue;
        }
      }

      const envio = { estado: OUTBOX_ESTADOS.SINCRONIZANDO, intentos: original.intentos + 1 };
      const op = await actualizarOp(original, original.claveOrden ? { ...envio, posibleEnServidor: true, runtimeNoSoporta: null } : envio);
      if (!op) {
        // Otro motor la reclamó, o el usuario la editó o canceló: esta lectura ya no vale.
        detener(original);
        continue;
      }
      let result;
      try {
        result = await transport.postJson(request.path, request.body);
      } catch {
        result = { ok: false, status: 0, failure: 'NETWORK_ERROR', data: null };
      }
      const clase = classifyResult(result);
      if (clase === 'OK') {
        await handler.onSuccess(repo, op, result.data ?? {});
        continue;
      }
      const error = {
        codigo: result?.data?.error ?? result?.failure ?? 'ERROR',
        mensaje: result?.data?.message ?? null,
        status: result?.status ?? 0,
      };
      const incierto = op.claveOrden ? { posibleEnServidor: posibleEnServidorTras(result, clase, original.posibleEnServidor) } : {};
      if (clase === 'SESION') {
        await guardarOp(op, { estado: OUTBOX_ESTADOS.PENDIENTE, intentos: original.intentos, ultimoError: error, ...incierto });
        return RUN_RESULT.SESION_REQUERIDA;
      }
      if (clase === 'IDENTIDAD') {
        // No es un conflicto del dato: el servidor no escribió y vuelve a salir con su cuenta.
        await guardarOp(op, { estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, intentos: original.intentos, ultimoError: error, ...incierto });
        detener(op);
        continue;
      }
      if (op.claveOrden && clase === 'RECHAZADO' && result?.status === 403) {
        // El rol se evalúa antes que la identidad: un 403 solo cuenta como rechazo
        // si la sesión sigue siendo la de origen. Si no, es de la cuenta que entró.
        const sesion = await leerIdentidadSesion(transport);
        if (sesion.estado !== 'OK' || !sesionEsDe(sesion, op)) {
          await guardarOp(op, {
            estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD,
            intentos: original.intentos,
            ultimoError: errorDeIdentidad(sesion.estado === 'OK' ? MOTIVO_IDENTIDAD.CUENTA : MOTIVO_IDENTIDAD.SESION),
            ...incierto,
          });
          detener(op);
          continue;
        }
      }
      if (clase === 'REINTENTABLE' && esFalloDeRed(result)) {
        // Sin red: no cuenta como intento ni hace crecer la espera.
        await guardarOp(op, {
          ...incierto,
          estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE,
          intentos: original.intentos,
          ultimoError: { ...error, tipo: 'red' },
          siguienteIntentoAt: new Date(now().getTime() + RED_REINTENTO_MS).toISOString(),
        });
        // Sin red no tiene sentido seguir: el resto espera al próximo ciclo.
        return RUN_RESULT.OFFLINE;
      }
      if (clase === 'REINTENTABLE') {
        const espera = backoffMs(op.intentos, random);
        await guardarOp(op, {
          ...incierto,
          estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE,
          ultimoError: { ...error, tipo: 'http' },
          siguienteIntentoAt: new Date(now().getTime() + espera).toISOString(),
        });
        return RUN_RESULT.ERROR;
      }
      await repo.marcarOperacionBloqueada({ ...op, ...incierto }, {
        estado: clase === 'CONFLICTO' ? OUTBOX_ESTADOS.CONFLICTO : OUTBOX_ESTADOS.RECHAZADO,
        ...error,
      });
      detener(op);
    }
    return RUN_RESULT.OK;
  }

  async function pull() {
    const meta = await repo.getMeta();
    const pedir = async (cursor) => {
      try {
        return await transport.getJson(cursor ? `${PULL_PATH}?cursor=${encodeURIComponent(cursor)}` : PULL_PATH);
      } catch {
        return { ok: false, status: 0, failure: 'NETWORK_ERROR', data: null };
      }
    };
    let result = await pedir(meta.cursor);
    if (!result.ok && result.status === 400 && result.data?.error === 'INVALID_CURSOR') result = await pedir(null);
    if (result.ok && result.data) {
      await repo.aplicarPull(result.data);
      return RUN_RESULT.OK;
    }
    const clase = classifyResult(result);
    if (clase === 'SESION') return RUN_RESULT.SESION_REQUERIDA;
    await repo.putMeta({ ultimaSyncOk: false, ultimoError: { codigo: result.data?.error ?? result.failure ?? 'ERROR', status: result.status ?? 0, at: now().toISOString() } });
    return result.status === 0 ? RUN_RESULT.OFFLINE : RUN_RESULT.ERROR;
  }

  /**
   * FASE 4E.1: pull reproductivo con su propio cursor. Un fallo aquí no cambia el
   * resultado del ciclo: un servidor sin este endpoint no puede frenar la
   * sincronización del resto. El cursor persiste en cada página, así que una
   * descarga grande continúa en el siguiente ciclo.
   */
  async function pullReproduccion() {
    // Solo si cambia: un fallo que se repite no debe notificar en cada ciclo.
    const registrar = async (codigo, status) => {
      const previo = (await repo.getMeta()).reproduccionUltimoError;
      if (previo?.codigo === codigo && previo?.status === status) return;
      await repo.putMeta({ reproduccionUltimoError: { codigo, status, at: now().toISOString() } });
    };
    try {
      let cursor = (await repo.getMeta()).reproduccionCursor ?? null;
      for (let pagina = 0; pagina < REPRO_MAX_PAGINAS_POR_CICLO; pagina += 1) {
        const result = await transport.getJson(cursor ? `${REPRO_PULL_PATH}?cursor=${encodeURIComponent(cursor)}` : REPRO_PULL_PATH);
        if (!result?.ok && result?.status === 400 && result?.data?.error === 'INVALID_CURSOR' && cursor) {
          await repo.reiniciarCursorReproduccion();
          cursor = null;
          continue;
        }
        if (!result?.ok) {
          await registrar(result?.data?.error ?? result?.failure ?? 'ERROR', result?.status ?? 0);
          return;
        }
        const { hayMas } = await repo.aplicarPullReproduccion(result.data);
        if (!hayMas) return;
        cursor = result.data.cursor;
      }
    } catch (error) {
      await registrar(error?.code ?? 'ERROR_LOCAL', 0).catch(() => {});
    }
  }

  async function run({ forzar = false, soloPush = false } = {}, { exclusivo = false } = {}) {
    if (!isOnline()) {
      state.ultimoResultado = RUN_RESULT.OFFLINE;
      emit();
      return RUN_RESULT.OFFLINE;
    }
    state.enCurso = true;
    emit();
    let resultado;
    try {
      resultado = await push({ forzar, exclusivo });
      if (resultado === RUN_RESULT.OK && !soloPush) resultado = await pull();
      if (resultado === RUN_RESULT.OK && !soloPush) await pullReproduccion();
    } catch (error) {
      resultado = RUN_RESULT.ERROR;
      await repo.putMeta({ ultimaSyncOk: false, ultimoError: { codigo: error?.code ?? 'ERROR_LOCAL', status: 0, at: now().toISOString() } }).catch(() => {});
    } finally {
      state.enCurso = false;
    }
    state.ultimoResultado = resultado;
    state.sesionRequerida = resultado === RUN_RESULT.SESION_REQUERIDA;
    state.redCaidaAt = resultado === RUN_RESULT.OFFLINE ? now().toISOString() : null;
    emit();
    return resultado;
  }

  return {
    /**
     * Un solo ciclo a la vez en este motor; llamadas concurrentes comparten
     * la promesa. Con `lock`, además, un solo motor por organización: los
     * disparos automáticos ceden (EN_CURSO) si otro motor está sincronizando
     * y los forzados (preparar / "Sincronizar ahora") esperan su turno.
     */
    syncNow(options = {}) {
      if (!running) {
        const ciclo = lock
          ? lock(() => run(options, { exclusivo: true }), { esperar: Boolean(options.forzar) })
          : run(options);
        running = ciclo.finally(() => {
          running = null;
        });
      }
      return running;
    },
    /**
     * Red recuperada (online / visible con red): las operaciones que solo
     * esperan por un fallo de RED vuelven a estar listas ya. Un 408/429/5xx
     * conserva su backoff. Devuelve cuántas se adelantaron.
     */
    async reactivarFallosDeRed() {
      if (!isOnline()) return 0;
      const ahora = now().toISOString();
      let adelantadas = 0;
      for (const op of await repo.listOutbox()) {
        if (op.estado !== OUTBOX_ESTADOS.ERROR_REINTENTABLE || !esErrorDeRed(op)) continue;
        if (op.siguienteIntentoAt && op.siguienteIntentoAt <= ahora) continue;
        if (await actualizarOp(op, { siguienteIntentoAt: ahora })) adelantadas += 1;
      }
      return adelantadas;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state }),
    /**
     * El navegador dice que hay red, pero este motor no lo ha confirmado: su
     * último ciclo no llegó al servidor o nunca completó uno porque cedió ante
     * otro motor (los EN_CURSO no fijan resultado). Nada más lo va a revisar.
     */
    reconexionPendiente: () => isOnline() && (state.ultimoResultado === RUN_RESULT.OFFLINE || state.ultimoResultado === null),
    /** Próximo instante en que conviene reintentar (backoff), o null. */
    async proximoReintentoAt() {
      // Solo lo que le toca salir: una retenida en su cadena con la fecha vencida reprogramaría cada segundo.
      const fechas = operacionesEnTurno(await repo.listOutbox(), { soportado: (op) => Boolean(handlerDe(op.tipoOperacion)) })
        .filter((op) => op.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE && op.siguienteIntentoAt)
        .map((op) => op.siguienteIntentoAt)
        .sort();
      return fechas[0] ?? null;
    },
  };
}

/**
 * Conectividad que ve la interfaz. `sesionOffline` es la sesión reconstruida
 * sin servidor: su revalidación es de un solo intento y un fallo transitorio
 * la deja activa, así que una respuesta real del servidor a este motor la
 * desmiente. Sin esa respuesta se sigue tratando como sin conexión.
 */
export function calcularOnline({ navegadorOnline, sesionOffline, ultimoResultado }) {
  if (!navegadorOnline || ultimoResultado === RUN_RESULT.OFFLINE) return false;
  if (!sesionOffline) return true;
  return ultimoResultado === RUN_RESULT.OK || ultimoResultado === RUN_RESULT.SESION_REQUERIDA;
}

/**
 * Indicador de estado de Ganadería (siempre visible):
 *   OFFLINE | SINCRONIZANDO | CONFLICTO | ERROR | PENDIENTES | SINCRONIZADO
 */
export function computeSyncIndicator({ online, enCurso, pendientes = 0, conflictos = 0, ultimoResultado = null, ultimaSyncOk = null }) {
  if (!online) return { estado: 'OFFLINE', etiqueta: pendientes > 0 ? `OFFLINE — ${pendientes} ${pendientes === 1 ? 'CAMBIO PENDIENTE' : 'CAMBIOS PENDIENTES'}` : 'OFFLINE' };
  if (enCurso) return { estado: 'SINCRONIZANDO', etiqueta: 'SINCRONIZANDO' };
  if (conflictos > 0) return { estado: 'CONFLICTO', etiqueta: 'CONFLICTO DE SINCRONIZACIÓN' };
  if (ultimoResultado === RUN_RESULT.ERROR || ultimoResultado === RUN_RESULT.SESION_REQUERIDA || ultimaSyncOk === false) {
    return { estado: 'ERROR', etiqueta: ultimoResultado === RUN_RESULT.SESION_REQUERIDA ? 'ERROR DE SINCRONIZACIÓN — INICIA SESIÓN' : 'ERROR DE SINCRONIZACIÓN' };
  }
  if (pendientes > 0) return { estado: 'PENDIENTES', etiqueta: `${pendientes} ${pendientes === 1 ? 'CAMBIO PENDIENTE' : 'CAMBIOS PENDIENTES'}` };
  return { estado: 'SINCRONIZADO', etiqueta: 'ONLINE — SINCRONIZADO' };
}
