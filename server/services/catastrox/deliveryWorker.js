// R4/B5-03: worker autónomo de entrega -- procesa delivery jobs sin depender
// de ninguna request HTTP (webhook/verify/retry manual). Antes de esta
// pieza, un job QUEUED sin tráfico adicional no lo procesaba nada (ver
// diagnóstico R4/B5-03 Fase 0), y un stale GENERATING/READY/SENDING solo se
// recuperaba si alguna request volvía a llamar processDeliveryJob(jobId).
//
// POLÍTICA DE SEGURIDAD OBLIGATORIA (Fase 0.5, ver
// deliveryJobService.js#findAutonomousDeliveryJobIds): este worker NUNCA
// reclama SENDING -- delega esa exclusión a la función de descubrimiento
// inyectada como `findJobIds`, y nunca la reimplementa aquí. La
// exclusividad real entre invocaciones concurrentes (incluyendo múltiples
// réplicas corriendo su propio worker, o dos ticks obteniendo el mismo id
// candidato) es responsabilidad exclusiva de `processJob` (en producción,
// processDeliveryJob(), cuyo CAS por status+attempt_count ya está probado
// -- ver catastroxDeliveryLifecycle.test.js, prueba "10) dos
// processDeliveryJob concurrentes..."). Este worker nunca agrega locks en
// memoria ni asume una sola réplica.

const DEFAULT_POLL_INTERVAL_MS = 10000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DRAIN_BUDGET_MS = 8000;

/**
 * Crea un worker de entrega autónomo. Todas las dependencias externas
 * (descubrimiento de jobs, procesamiento, temporizadores, aleatoriedad,
 * logger) se inyectan -- nunca importa deliveryJobService.js directamente,
 * para poder probarse por completo sin Postgres real (ver
 * __tests__/deliveryWorker.test.js, sección de pruebas unitarias).
 *
 * @param {{
 *   findJobIds: (opts: {limit: number}) => Promise<string[]>,
 *   processJob: (jobId: string) => Promise<unknown>,
 *   pollIntervalMs?: number,
 *   jitterRatio?: number,
 *   batchSize?: number,
 *   concurrency?: number,
 *   drainBudgetMs?: number,
 *   logger?: Console,
 *   random?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} options
 */
export function createDeliveryWorker({
  findJobIds,
  processJob,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  jitterRatio = DEFAULT_JITTER_RATIO,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  drainBudgetMs = DEFAULT_DRAIN_BUDGET_MS,
  logger = console,
  random = Math.random,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof findJobIds !== 'function') {
    throw new TypeError('createDeliveryWorker requiere `findJobIds` como función.');
  }
  if (typeof processJob !== 'function') {
    throw new TypeError('createDeliveryWorker requiere `processJob` como función.');
  }

  let started = false;
  let stopped = true;
  let stopping = false;
  let pendingTimer = null;
  let inFlightBatch = null;
  let stopPromise = null;
  const stats = { ticks: 0, lastTickAt: null, lastError: null };

  function log(event, fields = {}) {
    const level = fields.errorCode ? 'error' : 'log';
    const emit = typeof logger[level] === 'function' ? logger[level] : logger.log;
    if (typeof emit !== 'function') return;
    emit.call(logger, '[CatastroX DeliveryWorker]', { timestamp: new Date().toISOString(), event, ...fields });
  }

  // Jitter simétrico alrededor de pollIntervalMs (por defecto ±20%, es
  // decir ~8000-12000ms sobre una base de 10000ms) -- nunca negativo. No
  // usa aleatoriedad criptográfica: no es un valor de seguridad, solo evita
  // que réplicas reiniciadas al mismo tiempo sincronicen sus ticks.
  function nextDelay() {
    const factor = 1 + (random() * 2 - 1) * jitterRatio;
    return Math.max(0, Math.round(pollIntervalMs * factor));
  }

  // Concurrencia acotada sin dependencia externa: como máximo `limit`
  // llamadas a processJob en vuelo simultáneamente. El fallo de un job
  // individual se captura y se registra -- nunca aborta a los demás ni se
  // propaga fuera de esta función (processDeliveryJob ya resuelve sus
  // propias transiciones a FAILED; cualquier excepción que SÍ llegue aquí
  // es, en producción, un caso verdaderamente inesperado).
  async function runWithConcurrencyLimit(jobIds, limit) {
    let cursor = 0;
    let processed = 0;
    let rejected = 0;

    async function lane() {
      while (cursor < jobIds.length) {
        const jobId = jobIds[cursor];
        cursor += 1;
        try {
          await processJob(jobId);
          processed += 1;
        } catch (error) {
          rejected += 1;
          log('delivery_worker_job_failed', {
            jobId,
            errorCode: error?.code || 'UNKNOWN',
            errorMessage: error?.message,
          });
        }
      }
    }

    const laneCount = Math.max(0, Math.min(limit, jobIds.length));
    await Promise.all(Array.from({ length: laneCount }, () => lane()));
    return { processed, rejected };
  }

  // Todo el cuerpo vive dentro de un único try/catch: un error de
  // findJobIds (p.ej. una falla transitoria de Postgres) o cualquier fallo
  // inesperado dentro de runWithConcurrencyLimit nunca debe propagarse --
  // el servidor HTTP sigue healthy y el worker simplemente programa el
  // siguiente tick.
  async function tick() {
    stats.ticks += 1;
    stats.lastTickAt = new Date().toISOString();
    try {
      const ids = await findJobIds({ limit: batchSize });
      if (!Array.isArray(ids) || ids.length === 0) {
        return { selected: 0, processed: 0, rejected: 0 };
      }

      const batchIds = ids.slice(0, batchSize);
      const batchPromise = runWithConcurrencyLimit(batchIds, concurrency);
      inFlightBatch = batchPromise;
      try {
        const { processed, rejected } = await batchPromise;
        return { selected: batchIds.length, processed, rejected };
      } finally {
        inFlightBatch = null;
      }
    } catch (error) {
      stats.lastError = error?.code || error?.message || 'UNKNOWN';
      log('delivery_worker_tick_failed', { errorCode: error?.code, errorMessage: error?.message });
      return { selected: 0, processed: 0, rejected: 0 };
    }
  }

  function scheduleNext() {
    if (stopping) return;
    pendingTimer = setTimeoutFn(runTickAndSchedule, nextDelay());
  }

  // Encadenado explícito (nunca setInterval): el siguiente tick solo se
  // programa DESPUÉS de que el anterior termina por completo -- así nunca
  // hay dos ticks solapados en una misma instancia, y un batch lento nunca
  // acumula ticks pendientes.
  async function runTickAndSchedule() {
    pendingTimer = null;
    await tick();
    scheduleNext();
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    stopping = false;
    log('delivery_worker_started', { pollIntervalMs, batchSize, concurrency, drainBudgetMs });
    // Primer tick inmediato (sin esperar el primer intervalo) -- disparado
    // sin await: start() nunca bloquea al llamador en un round-trip a la DB.
    runTickAndSchedule();
  }

  // stop() es idempotente: llamadas concurrentes/repetidas comparten la
  // misma promesa en curso y nunca reinician la secuencia de apagado.
  // Nunca lanza. Nunca espera indefinidamente -- el drenado del batch en
  // curso está acotado por drainBudgetMs; si se excede, stop() igual
  // resuelve (el job en curso queda para el mecanismo de recuperación de
  // stale existente, no se cancela violentamente).
  function stop() {
    if (stopPromise) return stopPromise;
    if (!started) {
      stopped = true;
      return Promise.resolve();
    }

    stopping = true;
    log('delivery_worker_stopping', {});
    if (pendingTimer) {
      clearTimeoutFn(pendingTimer);
      pendingTimer = null;
    }

    stopPromise = (async () => {
      if (inFlightBatch) {
        await Promise.race([
          inFlightBatch.catch(() => {}),
          new Promise((resolve) => setTimeoutFn(resolve, drainBudgetMs)),
        ]);
      }
      started = false;
      stopped = true;
      stopping = false;
      stopPromise = null;
      log('delivery_worker_stopped', {});
    })();

    return stopPromise;
  }

  // Ejecuta un único tick de forma directamente esperable -- para pruebas
  // y para invocación manual puntual. No programa ningún tick posterior.
  function runOnce() {
    return tick();
  }

  // Estado mínimo, no sensible -- nunca email/PDF/payload de orden.
  function getState() {
    return {
      started,
      stopping,
      stopped,
      ticks: stats.ticks,
      lastTickAt: stats.lastTickAt,
      lastError: stats.lastError,
    };
  }

  return { start, stop, close: stop, runOnce, getState };
}
