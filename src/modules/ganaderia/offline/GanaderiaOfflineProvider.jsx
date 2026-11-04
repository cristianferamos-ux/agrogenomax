// SPRINT-3D11.3 (R1): proveedor React del modo offline-first de Ganadería.
// Abre la base local de la organización de la sesión, arranca el motor de
// sincronización y los disparadores automáticos (autoSync.js), y expone:
//   repo, engine, preparado, stats, indicador, online, syncNow, preparar.
// La APP abre siempre sin esperar a la red: las páginas leen primero la
// copia local cuando el dispositivo está preparado.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useGanaderiaAuth } from '../auth/GanaderiaAuthContext.jsx';
import {
  borrarBaseOrg,
  contarPendientesOrg,
  createBrowserOffline,
  esBaseMasNueva,
  indexedDbDisponible,
  isNavigatorOnline,
  openDeviceStorage,
} from './browserOffline.js';
import { activarOrganizacion, getOrCreateDeviceId, guardarPerfilOffline } from './offlineSession.js';
import { startAutoSync } from './autoSync.js';
import { RUN_RESULT, computeSyncIndicator } from './syncEngine.js';

const GanaderiaOfflineContext = createContext(null);

const NO_DISPONIBLE = Object.freeze({
  status: 'no_disponible',
  repo: null,
  engine: null,
  preparado: false,
  stats: null,
  online: true,
  indicador: null,
  syncNow: async () => null,
  preparar: async () => ({ ok: false, error: 'No disponible en este dispositivo.' }),
});

/** Pide al Service Worker precachear el build vigente (arranque sin red). */
function precacheApp(timeoutMs = 60_000) {
  const controller = globalThis.navigator?.serviceWorker?.controller;
  if (!controller || typeof MessageChannel === 'undefined') return Promise.resolve({ ok: false, reason: 'sin_service_worker' });
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data ?? { ok: false });
    };
    controller.postMessage({ type: 'AGX_PRECACHE' }, [channel.port2]);
  });
}

export function GanaderiaOfflineProvider({ children }) {
  const auth = useGanaderiaAuth();
  const organizacionId = auth.rolInterno ? null : auth.organizacionActiva?.organizacionId ?? null;
  const [instancia, setInstancia] = useState({ status: 'iniciando', repo: null, engine: null });
  const [stats, setStats] = useState(null);
  const [engineState, setEngineState] = useState({ enCurso: false, ultimoResultado: null });
  const [navigatorOnline, setNavigatorOnline] = useState(isNavigatorOnline());
  const [intentoApertura, setIntentoApertura] = useState(0);
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    const on = () => setNavigatorOnline(true);
    const off = () => setNavigatorOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (!organizacionId || !indexedDbDisponible()) {
      setInstancia({ status: 'no_disponible', repo: null, engine: null });
      return undefined;
    }
    let cancelado = false;
    let cleanup = () => {};
    // FASE 4E.1: otra pestaña puede impedir el upgrade (la apertura sigue
    // pendiente y continúa sola al cerrarse) o pedir que esta cierre su conexión.
    const apertura = {
      onBlocked: () => {
        if (!cancelado) setInstancia({ status: 'actualizacion_bloqueada', repo: null, engine: null });
      },
      onVersionChange: () => {
        if (cancelado) return;
        cleanup();
        cleanup = () => {};
        setInstancia({ status: 'requiere_recarga', repo: null, engine: null });
      },
    };
    const contarPendientes = (id) => contarPendientesOrg(id, { onBlocked: apertura.onBlocked });
    (async () => {
      try {
        const device = await openDeviceStorage();
        let deviceId;
        try {
          deviceId = await getOrCreateDeviceId(device);
          if (!authRef.current.offline) {
            // Sesión validada online: perfil offline + aislamiento por organización.
            await guardarPerfilOffline(device, authRef.current);
            await activarOrganizacion(device, organizacionId, { contarPendientes, borrarBase: borrarBaseOrg });
          }
        } finally {
          await device.close();
        }
        const { storage, repo, engine } = await createBrowserOffline({ organizacionId, deviceId, apertura });
        if (cancelado) {
          await storage.close();
          return;
        }
        const refrescar = () => repo.contar().then(setStats).catch(() => {});
        const unsubRepo = repo.subscribe(refrescar);
        const unsubEngine = engine.subscribe(setEngineState);
        await refrescar();
        const auto = startAutoSync({ engine, repo });
        cleanup = () => {
          auto.stop();
          unsubRepo();
          unsubEngine();
          storage.close();
        };
        setInstancia({ status: 'listo', repo, engine, deviceId });
      } catch (error) {
        if (!cancelado) setInstancia({ status: esBaseMasNueva(error) ? 'requiere_recarga' : 'error', repo: null, engine: null });
      }
    })();
    return () => {
      cancelado = true;
      cleanup();
    };
  }, [organizacionId, intentoApertura]);

  const reintentarApertura = useCallback(() => setIntentoApertura((n) => n + 1), []);

  const online = navigatorOnline && !auth.offline && engineState.ultimoResultado !== RUN_RESULT.OFFLINE;

  // Dispositivo ya preparado: al abrir Ganadería con red se refresca el
  // precache del build vigente (tras un despliegue, los archivos nuevos
  // quedan disponibles sin señal). Solo Ganadería lo pide; el SW nunca
  // precachea por su cuenta.
  const precacheRefrescado = useRef(false);
  useEffect(() => {
    if (precacheRefrescado.current || !stats?.preparadoAt || !online) return;
    precacheRefrescado.current = true;
    precacheApp().catch(() => {});
  }, [stats?.preparadoAt, online]);

  const syncNow = useCallback(async () => {
    if (!instancia.engine) return null;
    return instancia.engine.syncNow({ forzar: true });
  }, [instancia.engine]);

  /**
   * "Preparar dispositivo para trabajo offline": 1) sesión y organización
   * verificadas con el servidor; 2-5) descarga completa (chapetas asignadas,
   * animales, predios, potreros, catálogos); 6) fecha de sincronización;
   * además precachea la app en el Service Worker.
   */
  const preparar = useCallback(async () => {
    const { repo, engine } = instancia;
    if (!repo || !engine) return { ok: false, error: 'El almacenamiento local no está disponible en este dispositivo.' };
    if (!isNavigatorOnline()) return { ok: false, error: 'Necesitas conexión a Internet para preparar el dispositivo.' };
    let session;
    try {
      const response = await fetch('/api/ganaderia/auth/session', { credentials: 'include' });
      session = response.ok ? await response.json() : null;
    } catch {
      session = null;
    }
    if (!session?.authenticated || session.organizacionActiva?.organizacionId !== organizacionId) {
      return { ok: false, error: 'No pudimos verificar tu sesión. Vuelve a iniciar sesión.' };
    }
    await repo.putMeta({ cursor: null });
    const resultado = await engine.syncNow({ forzar: true });
    if (resultado !== RUN_RESULT.OK) {
      return { ok: false, error: resultado === RUN_RESULT.OFFLINE ? 'Se perdió la conexión durante la descarga. Intenta de nuevo.' : 'No fue posible descargar los datos. Intenta de nuevo.' };
    }
    const precache = await precacheApp();
    await repo.putMeta({ preparadoAt: new Date().toISOString() });
    return { ok: true, precache, stats: await repo.contar() };
  }, [instancia, organizacionId]);

  const value = useMemo(() => {
    if (instancia.status === 'no_disponible') return NO_DISPONIBLE;
    return {
      status: instancia.status,
      repo: instancia.repo,
      engine: instancia.engine,
      deviceId: instancia.deviceId ?? null,
      preparado: Boolean(stats?.preparadoAt),
      stats,
      online,
      engineState,
      indicador: computeSyncIndicator({
        online,
        enCurso: engineState.enCurso,
        pendientes: stats?.pendientes ?? 0,
        conflictos: stats?.conflictos ?? 0,
        ultimoResultado: engineState.ultimoResultado,
        ultimaSyncOk: stats?.ultimaSyncOk ?? null,
      }),
      syncNow,
      preparar,
      reintentarApertura,
    };
  }, [instancia, stats, online, engineState, syncNow, preparar, reintentarApertura]);

  return <GanaderiaOfflineContext.Provider value={value}>{children}</GanaderiaOfflineContext.Provider>;
}

/** Nunca lanza: fuera del proveedor o sin IndexedDB devuelve el modo no disponible (online clásico). */
export function useGanaderiaOffline() {
  return useContext(GanaderiaOfflineContext) ?? NO_DISPONIBLE;
}
