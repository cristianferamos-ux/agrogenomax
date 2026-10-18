// SPRINT-3D11.3 (R1) -- disparadores AUTOMÁTICOS de sincronización (el
// usuario no depende de un botón; "Sincronizar ahora" es solo respaldo):
//   1. al abrir la app (arranque del proveedor offline);
//   2. al volver del background (visibilitychange -> visible);
//   3. cuando navigator pasa a online ('online');
//   4. después de cada operación local si hay red (cambios en el outbox);
//   5. Background Sync del Service Worker donde exista (tag
//      'agx-ganaderia-outbox'); el SW pide a la página que sincronice o, sin
//      páginas abiertas, ejecuta el PUSH él mismo (public/service-worker.js);
//   6. reintentos con backoff (temporizador al próximo siguienteIntentoAt) y
//      un barrido de respaldo cada 5 min mientras la app está visible.
// El entorno (window/document/serviceWorker/timers) es inyectable: el
// módulo se prueba sin navegador.
import { OUTBOX_ESTADOS } from './outbox.js';

export const BACKGROUND_SYNC_TAG = 'agx-ganaderia-outbox';
const DEBOUNCE_MS = 1_500;
const BARRIDO_MS = 5 * 60_000;

async function hayEnviables(repo) {
  return (await repo.listOutbox()).some((op) => op.estado === OUTBOX_ESTADOS.PENDIENTE);
}

async function hayPendientes(repo) {
  return (await repo.listOutbox()).some((op) => [OUTBOX_ESTADOS.PENDIENTE, OUTBOX_ESTADOS.ERROR_REINTENTABLE, OUTBOX_ESTADOS.SINCRONIZANDO].includes(op.estado));
}

export function startAutoSync({
  engine,
  repo,
  win = globalThis.window,
  doc = globalThis.document,
  serviceWorker = globalThis.navigator?.serviceWorker,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  now = () => new Date(),
}) {
  let stopped = false;
  let debounce = null;
  let retry = null;
  let barrido = null;
  const removers = [];

  async function registrarBackgroundSync() {
    try {
      if (!serviceWorker || !(await hayPendientes(repo))) return;
      const registration = await serviceWorker.ready;
      if (registration?.sync?.register) await registration.sync.register(BACKGROUND_SYNC_TAG);
    } catch {
      // Background Sync no disponible (Safari/Firefox/iOS) o denegado: los
      // demás disparadores siguen activos.
    }
  }

  async function programarReintento() {
    if (stopped) return;
    if (retry) clearTimer(retry);
    retry = null;
    const proximo = await engine.proximoReintentoAt();
    if (!proximo) return;
    const espera = Math.max(1_000, new Date(proximo).getTime() - now().getTime());
    retry = setTimer(() => trigger('reintento'), espera);
  }

  async function trigger(motivo) {
    if (stopped) return null;
    const resultado = await engine.syncNow({ motivo });
    await programarReintento();
    await registrarBackgroundSync();
    return resultado;
  }

  const listen = (target, type, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  };

  // FASE-14: al recuperar la red, lo que solo esperaba por un fallo de RED
  // sale ya (sin esperar su siguienteIntentoAt); un 408/429/5xx conserva su
  // backoff. reactivarFallosDeRed no hace nada si el motor está sin red.
  async function reconectar(motivo) {
    try {
      await engine.reactivarFallosDeRed?.();
    } catch {
      // nunca bloquea el disparo
    }
    return trigger(motivo);
  }

  listen(win, 'online', () => reconectar('online'));
  listen(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') reconectar('visible');
  });
  listen(serviceWorker, 'message', (event) => {
    if (event?.data?.type === 'AGX_SYNC_REQUEST') trigger('background-sync');
  });

  const unsubscribe = repo.subscribe(() => {
    if (stopped || debounce) return;
    debounce = setTimer(async () => {
      debounce = null;
      if (!engine.getState().enCurso && (await hayEnviables(repo))) trigger('operacion');
    }, DEBOUNCE_MS);
  });

  const tickBarrido = () => {
    barrido = setTimer(async () => {
      if (!stopped && (!doc || doc.visibilityState !== 'hidden') && (await hayPendientes(repo))) await trigger('barrido');
      if (!stopped) tickBarrido();
    }, BARRIDO_MS);
  };
  tickBarrido();

  const primera = trigger('apertura');

  return {
    primera,
    trigger,
    stop() {
      stopped = true;
      unsubscribe();
      removers.forEach((remove) => remove());
      for (const timer of [debounce, retry, barrido]) if (timer) clearTimer(timer);
    },
  };
}
