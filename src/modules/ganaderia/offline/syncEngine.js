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
import { OUTBOX_ESTADOS, backoffMs, estaLista, esErrorDeRed, ordenarOutbox } from './outbox.js';
import { handlerFor } from './operationHandlers.js';

const PULL_PATH = '/api/ganaderia/sync/pull';
/** Reintento fijo tras un fallo de red (sin crecer): la red suele volver sola. */
export const RED_REINTENTO_MS = 30_000;
/** Sin lock exclusivo, una operación SINCRONIZANDO más reciente puede estar enviándose en otro motor. */
export const SINCRONIZANDO_LEASE_MS = 2 * 60_000;

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
  if (isSessionFailure(result)) return 'SESION';
  if (isRoleForbidden(result)) return 'RECHAZADO';
  if (isRetryable(result)) return 'REINTENTABLE';
  if ([404, 409, 410].includes(result.status)) return 'CONFLICTO';
  return 'RECHAZADO';
}

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

  async function push({ forzar, exclusivo }) {
    // Recuperación: una operación que quedó SINCRONIZANDO (pestaña cerrada,
    // corte a mitad) se reenvía -- es idempotente en el servidor. Con el lock
    // exclusivo nadie más puede estar enviándola; sin él, solo pasado el
    // lease (evita reenviar lo que otra pestaña está enviando ahora).
    const limiteLease = now().getTime() - SINCRONIZANDO_LEASE_MS;
    for (const op of await repo.listOutbox()) {
      if (op.estado !== OUTBOX_ESTADOS.SINCRONIZANDO) continue;
      if (exclusivo || !op.updatedAt || new Date(op.updatedAt).getTime() <= limiteLease) {
        await guardarOp(op, { estado: OUTBOX_ESTADOS.PENDIENTE });
      }
    }
    const pendientes = ordenarOutbox(await repo.listOutbox());
    const bloqueadas = new Set();
    for (const original of pendientes) {
      if (bloqueadas.has(original.localUuid)) continue;
      if (original.estado === OUTBOX_ESTADOS.CONFLICTO || original.estado === OUTBOX_ESTADOS.RECHAZADO) {
        bloqueadas.add(original.localUuid);
        continue;
      }
      if (!estaLista(original, now(), { forzar })) continue;
      const handler = handlerFor(original.tipoOperacion);
      const request = await handler.request(original, repo);
      if (!request) continue;

      const op = await guardarOp(original, { estado: OUTBOX_ESTADOS.SINCRONIZANDO, intentos: original.intentos + 1 });
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
      if (clase === 'SESION') {
        await guardarOp(op, { estado: OUTBOX_ESTADOS.PENDIENTE, intentos: original.intentos, ultimoError: error });
        return RUN_RESULT.SESION_REQUERIDA;
      }
      if (clase === 'REINTENTABLE' && esFalloDeRed(result)) {
        // Sin red: no cuenta como intento ni hace crecer la espera.
        await guardarOp(op, {
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
          estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE,
          ultimoError: { ...error, tipo: 'http' },
          siguienteIntentoAt: new Date(now().getTime() + espera).toISOString(),
        });
        return RUN_RESULT.ERROR;
      }
      await repo.marcarOperacionBloqueada(op, {
        estado: clase === 'CONFLICTO' ? OUTBOX_ESTADOS.CONFLICTO : OUTBOX_ESTADOS.RECHAZADO,
        ...error,
      });
      bloqueadas.add(op.localUuid);
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
        await guardarOp(op, { siguienteIntentoAt: ahora });
        adelantadas += 1;
      }
      return adelantadas;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state }),
    /** Próximo instante en que conviene reintentar (backoff), o null. */
    async proximoReintentoAt() {
      const fechas = (await repo.listOutbox())
        .filter((op) => op.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE && op.siguienteIntentoAt)
        .map((op) => op.siguienteIntentoAt)
        .sort();
      return fechas[0] ?? null;
    },
  };
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
