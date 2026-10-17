function shouldDisableServiceWorker() {
  if (typeof window === 'undefined') return true;

  const host = window.location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
  // SPRINT-3D11.3 (R1): opt-in explícito para probar la PWA offline con
  // `vite preview` en localhost (VITE_AGX_LOCAL_SW=1 al construir). Nunca
  // activo en desarrollo ni por defecto en localhost.
  const allowLocal = typeof import.meta !== 'undefined' && import.meta.env?.VITE_AGX_LOCAL_SW === '1';

  return Boolean((isLocalHost && !allowLocal) || isDev);
}

async function unregisterServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(registrations.map((registration) => registration.unregister()));

  if ('caches' in window) {
    const cacheKeys = await window.caches.keys();
    await Promise.allSettled(cacheKeys.map((cacheKey) => window.caches.delete(cacheKey)));
  }
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  if (shouldDisableServiceWorker()) {
    window.addEventListener('load', () => {
      unregisterServiceWorkers().catch((error) => {
        console.warn('No se pudo limpiar service workers locales:', error);
      });
    });
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.error('No se pudo registrar el service worker:', error);
    });
  });
}
