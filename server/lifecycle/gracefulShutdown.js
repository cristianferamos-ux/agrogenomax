/**
 * Graceful shutdown del backend Express (LOTE-007, ADR-012 §21).
 *
 * Secuencia al recibir SIGTERM/SIGINT: marcar `shuttingDown` (idempotente),
 * registrar el inicio, arrancar un timeout global de seguridad, cerrar el
 * servidor HTTP (deja de aceptar conexiones nuevas, espera las activas),
 * cerrar todos los recursos registrados (nunca antes que el servidor HTTP),
 * limpiar el timer si todo termina a tiempo, y finalizar con exit code 0
 * (éxito) o 1 (fallo de un recurso, error de `server.close`, o timeout).
 *
 * Este módulo NUNCA registra `process.on('SIGTERM'|'SIGINT', ...)` por sí
 * mismo -- eso es responsabilidad exclusiva del entrypoint real
 * (server/index.js). Importarlo no tiene efectos laterales de ningún tipo.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15000;
const MIN_SHUTDOWN_TIMEOUT_MS = 2000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120000;

/**
 * Resuelve `SHUTDOWN_TIMEOUT_MS` (opcional). Un valor ausente, no entero,
 * o fuera del rango [2000, 120000] usa el default seguro -- nunca lanza,
 * nunca añade esta variable a la validación central de APP_ENV.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
export function resolveShutdownTimeoutMs(source = process.env) {
  const raw = source?.SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_SHUTDOWN_TIMEOUT_MS || parsed > MAX_SHUTDOWN_TIMEOUT_MS) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  return parsed;
}

/**
 * Telemetría segura. Nunca incluye DATABASE_URL/CATASTROX_DATABASE_URL,
 * credenciales, cookies, tokens, stack traces completas ni payloads de
 * usuario -- únicamente signal/resource/durationMs/timeoutMs/exitCode/
 * reason. `reporter` es el punto de inyección para pruebas; en producción
 * usa console.info/warn/error como *fallback* (observabilidad completa
 * diferida a un lote posterior).
 */
/**
 * Reduce cualquier error a un `reason` seguro: prefiere `error.code`
 * (estable, no sensible -- p. ej. `ECONNREFUSED`, `28P01`) y NUNCA usa
 * `error.message` crudo, que en drivers como `pg` puede, en algunos
 * casos, incluir fragmentos de la cadena de conexión u otros detalles no
 * previstos. Ante ausencia de `.code`, cae a una etiqueta genérica fija.
 */
function toSafeReason(error) {
  if (typeof error?.code === 'string' && error.code.trim() !== '') {
    return error.code;
  }
  return 'resource_close_failed';
}

function reportShutdownEvent(event, reporter) {
  if (typeof reporter === 'function') {
    reporter(event);
    return;
  }

  const level =
    event.type === 'graceful_shutdown_resource_failed' || event.type === 'graceful_shutdown_timeout'
      ? 'error'
      : event.type === 'graceful_shutdown_duplicate_signal'
        ? 'warn'
        : 'info';

  if (typeof console !== 'undefined' && typeof console[level] === 'function') {
    console[level](`[graceful-shutdown] ${event.type}`, {
      signal: event.signal,
      resource: event.resource,
      durationMs: event.durationMs,
      timeoutMs: event.timeoutMs,
      exitCode: event.exitCode,
      reason: event.reason,
    });
  }
}

/**
 * @param {{
 *   server: import('http').Server,
 *   resources?: Array<{name: string, close: () => Promise<void>|void}>,
 *   timeoutMs?: number,
 *   reporter?: (event: object) => void,
 *   exit?: (code: number) => void,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 */
export function createGracefulShutdown({
  server,
  resources = [],
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  reporter,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('createGracefulShutdown requiere `server` con un método close().');
  }

  if (!Array.isArray(resources)) {
    throw new TypeError('createGracefulShutdown requiere `resources` como arreglo.');
  }

  for (const resource of resources) {
    if (!resource || typeof resource.close !== 'function') {
      throw new TypeError(
        `createGracefulShutdown: recurso inválido (falta close()): ${resource?.name ?? 'desconocido'}.`,
      );
    }
  }

  let shutdownPromise = null;

  function closeHttpServer() {
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async function closeAllResources() {
    let allOk = true;
    for (const resource of resources) {
      try {
        await resource.close();
        reportShutdownEvent({ type: 'graceful_shutdown_resource_closed', resource: resource.name }, reporter);
      } catch (error) {
        allOk = false;
        reportShutdownEvent(
          {
            type: 'graceful_shutdown_resource_failed',
            resource: resource.name,
            reason: toSafeReason(error),
          },
          reporter,
        );
      }
    }
    return allOk;
  }

  function shutdown(signal) {
    if (shutdownPromise) {
      reportShutdownEvent({ type: 'graceful_shutdown_duplicate_signal', signal }, reporter);
      return shutdownPromise;
    }

    const startedAt = Date.now();
    reportShutdownEvent({ type: 'graceful_shutdown_started', signal }, reporter);

    let settled = false;
    let resolveShutdown;
    shutdownPromise = new Promise((resolve) => {
      resolveShutdown = resolve;
    });

    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reportShutdownEvent(
        { type: 'graceful_shutdown_timeout', signal, timeoutMs, durationMs: Date.now() - startedAt, exitCode: 1 },
        reporter,
      );
      exit(1);
      resolveShutdown(1);
    }, timeoutMs);

    (async () => {
      let exitCode = 0;

      try {
        await closeHttpServer();
        reportShutdownEvent(
          { type: 'graceful_shutdown_http_closed', signal, durationMs: Date.now() - startedAt },
          reporter,
        );
      } catch (error) {
        exitCode = 1;
        reportShutdownEvent(
          {
            type: 'graceful_shutdown_resource_failed',
            signal,
            resource: 'http_server',
            reason: toSafeReason(error),
          },
          reporter,
        );
      }

      const resourcesOk = await closeAllResources();
      if (!resourcesOk) exitCode = 1;

      if (settled) return; // el timeout ya resolvió/salió primero
      settled = true;
      clearTimer(timer);

      reportShutdownEvent(
        { type: 'graceful_shutdown_completed', signal, durationMs: Date.now() - startedAt, exitCode },
        reporter,
      );
      exit(exitCode);
      resolveShutdown(exitCode);
    })();

    return shutdownPromise;
  }

  return {
    handleSignal: shutdown,
    isShuttingDown: () => shutdownPromise !== null,
    waitForShutdown: () => shutdownPromise,
  };
}
