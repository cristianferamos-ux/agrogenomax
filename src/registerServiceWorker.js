function shouldDisableServiceWorker() {
  if (typeof window === 'undefined') return true;

  const host = window.location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;

  return Boolean(isLocalHost || isDev);
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
