import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_FRONTEND_ENVIRONMENTS,
  resolveFrontendEnvironment,
  isLocalDevelopment,
  isLocalHostname,
  validateApiUrl,
  normalizeApiBase,
  resolveApiBaseCandidates,
  resolveApiBaseUrl,
  clearDisallowedApiOverrides,
  reportDisallowedOverrideAttempt,
  getRuntimeConfig,
} from '../runtimeConfig.js';

// Todas las pruebas de este archivo operan exclusivamente sobre objetos
// planos inyectados (`env`, `hostname`, `storage`, `search`, `reporter`)
// -- nunca sobre `window`/`localStorage`/`import.meta.env` reales. Esto
// garantiza aislamiento total: no hay navegador, no hay red, no hay
// localStorage real, y no hace falta restaurar nada entre casos.

function makeMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    __dump: () => Object.fromEntries(store),
  };
}

describe('LOTE-003: src/config/runtimeConfig.js', () => {
  test('ALLOWED_FRONTEND_ENVIRONMENTS contiene exactamente los cinco valores permitidos', () => {
    assert.deepEqual(
      [...ALLOWED_FRONTEND_ENVIRONMENTS],
      ['development', 'test', 'demo', 'staging', 'production'],
    );
  });

  test('resolveFrontendEnvironment: VITE_APP_ENV explícita se respeta', () => {
    const { appEnv, isLocalDevelopmentFallback } = resolveFrontendEnvironment({
      env: { VITE_APP_ENV: 'staging' },
      hostname: 'staging.agrogenomax.com',
    });
    assert.equal(appEnv, 'staging');
    assert.equal(isLocalDevelopmentFallback, false);
  });

  test('20. ausencia de VITE_APP_ENV en un hostname desplegado NUNCA cae a production', () => {
    const { appEnv } = resolveFrontendEnvironment({ env: {}, hostname: 'agrogenomax.com' });
    assert.notEqual(appEnv, 'production');
    assert.equal(appEnv, 'unresolved');
  });

  test('valor inválido de VITE_APP_ENV en hostname desplegado tampoco infiere production', () => {
    const { appEnv } = resolveFrontendEnvironment({
      env: { VITE_APP_ENV: 'preproduccion' },
      hostname: 'agrogenomax.com',
    });
    assert.equal(appEnv, 'unresolved');
  });

  test('ausencia de VITE_APP_ENV en localhost se resuelve conservadoramente a development', () => {
    const { appEnv, isLocalDevelopmentFallback } = resolveFrontendEnvironment({ env: {}, hostname: 'localhost' });
    assert.equal(appEnv, 'development');
    assert.equal(isLocalDevelopmentFallback, true);
  });

  test('1. development + localhost permite override (isLocalDevelopment true)', () => {
    assert.equal(isLocalDevelopment({ env: { VITE_APP_ENV: 'development' }, hostname: 'localhost' }), true);
  });

  test('2. development + 127.0.0.1 permite override', () => {
    assert.equal(isLocalDevelopment({ env: { VITE_APP_ENV: 'development' }, hostname: '127.0.0.1' }), true);
  });

  test('3. development + hostname remoto rechaza override (falta la condición de hostname)', () => {
    assert.equal(
      isLocalDevelopment({ env: { VITE_APP_ENV: 'development' }, hostname: 'agrogenomax.com' }),
      false,
    );
  });

  test('4. staging + localhost rechaza override (falta la condición de ambiente)', () => {
    assert.equal(isLocalDevelopment({ env: { VITE_APP_ENV: 'staging' }, hostname: 'localhost' }), false);
  });

  test('5. production + localhost rechaza override', () => {
    assert.equal(isLocalDevelopment({ env: { VITE_APP_ENV: 'production' }, hostname: 'localhost' }), false);
  });

  test('6. demo rechaza override en cualquier hostname', () => {
    assert.equal(isLocalDevelopment({ env: { VITE_APP_ENV: 'demo' }, hostname: 'localhost' }), false);
    assert.equal(isLocalDevelopment({ env: { VITE_APP_ENV: 'demo' }, hostname: 'demo.agrogenomax.com' }), false);
  });

  test('7. test con configuración explícita inyectada la usa (nunca asume /api por defecto)', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'test', VITE_API_URL: 'https://mock-api.test/api' },
      hostname: 'localhost',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['https://mock-api.test/api']);
  });

  test('8. query agx_api_url válida se normaliza (sin barra final)', () => {
    const value = validateApiUrl('https://example.com/api/');
    assert.equal(value, 'https://example.com/api');
  });

  test('9. query apiUrl válida se normaliza', () => {
    const storage = makeMemoryStorage();
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development' },
      hostname: 'localhost',
      search: '?apiUrl=http://192.168.1.50:4000/api/',
      storage,
    });
    assert.equal(candidates[0], 'http://192.168.1.50:4000/api');
  });

  test('10. protocolo javascript: se rechaza', () => {
    assert.equal(validateApiUrl('javascript:alert(1)'), null);
  });

  test('11. protocolo data: se rechaza', () => {
    assert.equal(validateApiUrl('data:text/html,<script>alert(1)</script>'), null);
  });

  test('12. URL con credenciales embebidas se rechaza', () => {
    assert.equal(validateApiUrl('http://user:pass@evil.example/api'), null);
  });

  test('13. URL malformada se rechaza', () => {
    assert.equal(validateApiUrl('no-es-una-url-valida::::'), null);
    assert.equal(validateApiUrl(''), null);
    assert.equal(validateApiUrl(null), null);
  });

  test('protocolo file: se rechaza', () => {
    assert.equal(validateApiUrl('file:///etc/passwd'), null);
  });

  test('ruta relativa (/api) se acepta sin validación de protocolo', () => {
    assert.equal(validateApiUrl('/api/'), '/api');
  });

  test('14. override persistido en localStorage se usa solo en development local', () => {
    const storage = makeMemoryStorage({ agx_api_url: 'http://192.168.1.99:5000/api' });

    const local = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development' },
      hostname: 'localhost',
      search: '',
      storage,
    });
    assert.ok(local.includes('http://192.168.1.99:5000/api'));

    const remote = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development' },
      hostname: 'agrogenomax.com',
      search: '',
      storage,
    });
    assert.deepEqual(remote, ['/api']);
  });

  test('15. override persistido se elimina en staging', () => {
    const storage = makeMemoryStorage({ agx_api_url: 'http://evil.example/api', apiUrl: 'http://otro.example' });
    resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'staging' },
      hostname: 'staging.agrogenomax.com',
      search: '',
      storage,
    });
    assert.deepEqual(storage.__dump(), {});
  });

  test('16. override persistido se elimina en production', () => {
    const storage = makeMemoryStorage({ agx_api_url: 'http://evil.example/api' });
    resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'production' },
      hostname: 'agrogenomax.com',
      search: '',
      storage,
    });
    assert.deepEqual(storage.__dump(), {});
  });

  test('17. override persistido se elimina en demo (y además se lanza ApiDisabledError, ver bloque de corrección)', () => {
    const storage = makeMemoryStorage({ apiUrl: 'http://evil.example/api' });
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage,
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
    assert.deepEqual(storage.__dump(), {});
  });

  test('18. localStorage bloqueado (null) no rompe la aplicación', () => {
    assert.doesNotThrow(() => clearDisallowedApiOverrides({ storage: null }));
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'production' },
      hostname: 'agrogenomax.com',
      search: '?agx_api_url=http://evil.example',
      storage: null,
    });
    assert.deepEqual(candidates, ['/api']);
  });

  test('18b. localStorage que lanza SecurityError en cada acceso no rompe la resolución', () => {
    const throwingStorage = {
      getItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    assert.doesNotThrow(() =>
      resolveApiBaseCandidates({
        env: { VITE_APP_ENV: 'development' },
        hostname: 'localhost',
        search: '?agx_api_url=http://127.0.0.1:9999/api',
        storage: throwingStorage,
      }),
    );
  });

  test('19. la URL de Railway (u otra externa configurada) nunca se usa como fallback fuera de development local', () => {
    const candidates = resolveApiBaseCandidates({
      env: {
        VITE_APP_ENV: 'production',
        VITE_API_URL: 'https://agrogenomax-production.up.railway.app/api',
      },
      hostname: 'agrogenomax.com',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['/api']);
    assert.ok(!candidates.some((c) => c.includes('railway.app')));
  });

  test('19b. lo mismo aplica a staging, incluso con hostname local mezclado por error de configuración', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'staging', VITE_API_URL: 'https://agrogenomax-production.up.railway.app/api' },
      hostname: 'staging.agrogenomax.com',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['/api']);
  });

  test('21. configuración resultante de getRuntimeConfig() es inmutable', () => {
    const config = getRuntimeConfig({ env: { VITE_APP_ENV: 'development' }, hostname: 'localhost' });
    assert.ok(Object.isFrozen(config));
    assert.throws(() => {
      'use strict';
      config.appEnv = 'production';
    });
    assert.equal(config.appEnv, 'development');
  });

  test('resolveFrontendEnvironment() también devuelve un objeto inmutable', () => {
    const resolved = resolveFrontendEnvironment({ env: { VITE_APP_ENV: 'test' }, hostname: 'localhost' });
    assert.ok(Object.isFrozen(resolved));
  });

  test('22. el warning/telemetría no incluye el valor sensible del override', () => {
    const events = [];
    const reporter = (event) => events.push(event);

    resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'production' },
      hostname: 'agrogenomax.com',
      search: '?agx_api_url=http://usuario:secreto123@evil.example/robar-datos',
      storage: makeMemoryStorage(),
      reporter,
    });

    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events[0]);
    assert.ok(!serialized.includes('secreto123'));
    assert.ok(!serialized.includes('evil.example'));
    assert.ok(!serialized.includes('usuario'));
    assert.equal(events[0].type, 'disallowed_api_override_attempt');
    assert.equal(events[0].key, 'agx_api_url');
    assert.equal(events[0].appEnv, 'production');
  });

  test('reportDisallowedOverrideAttempt(): con console.warn como fallback, el mensaje tampoco expone el valor', () => {
    const originalWarn = console.warn;
    const captured = [];
    console.warn = (...args) => captured.push(args.join(' '));
    try {
      reportDisallowedOverrideAttempt(
        { appEnv: 'staging', hostname: 'staging.agrogenomax.com', key: 'apiUrl' },
        {},
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(captured.length, 1);
    assert.ok(captured[0].includes('apiUrl'));
    assert.ok(captured[0].includes('staging'));
  });

  test('23. precedencia: query string tiene prioridad sobre localStorage', () => {
    const storage = makeMemoryStorage({ agx_api_url: 'http://192.168.1.10:4000/api' });
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development' },
      hostname: 'localhost',
      search: '?agx_api_url=http://192.168.1.20:4000/api',
      storage,
    });
    assert.equal(candidates[0], 'http://192.168.1.20:4000/api');
  });

  test('24. valor inválido en query no contamina localStorage', () => {
    const storage = makeMemoryStorage();
    resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development' },
      hostname: 'localhost',
      search: '?agx_api_url=javascript:alert(1)',
      storage,
    });
    assert.deepEqual(storage.__dump(), {});
  });

  test('25. staging resuelve exclusivamente al relay same-origin', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'staging' },
      hostname: 'staging.agrogenomax.com',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['/api']);
  });

  test('25b. production resuelve exclusivamente al relay same-origin', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'production' },
      hostname: 'agrogenomax.com',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['/api']);
  });

  test('resolveApiBaseUrl() devuelve el primer candidato resuelto', () => {
    assert.equal(
      resolveApiBaseUrl({ env: { VITE_APP_ENV: 'production' }, hostname: 'agrogenomax.com', storage: makeMemoryStorage() }),
      '/api',
    );
    assert.equal(
      resolveApiBaseUrl({
        env: { VITE_APP_ENV: 'development' },
        hostname: 'localhost',
        search: '?apiUrl=http://10.0.0.5:3001/api',
        storage: makeMemoryStorage(),
      }),
      'http://10.0.0.5:3001/api',
    );
  });

  test('normalizeApiBase(): elimina barra(s) final(es) y recorta espacios', () => {
    assert.equal(normalizeApiBase('  https://example.com/api///  '), 'https://example.com/api');
    assert.equal(normalizeApiBase(''), '');
    assert.equal(normalizeApiBase(null), '');
  });

  test('isLocalHostname(): solo localhost/127.0.0.1 son locales', () => {
    assert.equal(isLocalHostname({ hostname: 'localhost' }), true);
    assert.equal(isLocalHostname({ hostname: '127.0.0.1' }), true);
    assert.equal(isLocalHostname({ hostname: 'agrogenomax.com' }), false);
    assert.equal(isLocalHostname({ hostname: '192.168.1.5' }), false);
    assert.equal(isLocalHostname({ hostname: '' }), false);
  });

  test('development local sin ningún override configurado incluye el backend local conocido y el relay', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development' },
      hostname: 'localhost',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['http://127.0.0.1:3001/api', '/api']);
  });
});

describe('LOTE-003 (corrección): APP_ENV=demo sin backend/relay (ADR-014 §7)', () => {
  test('C1. demo lanza ApiDisabledError en lugar de devolver /api u otro candidato', () => {
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        }),
      (error) => error.code === 'API_DISABLED_IN_DEMO' && error.environment === 'demo',
    );
  });

  test('C2. demo con query agx_api_url: limpia la clave y de todas formas lanza (nunca la usa)', () => {
    const storage = makeMemoryStorage();
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '?agx_api_url=http://evil.example/api',
          storage,
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
    assert.deepEqual(storage.__dump(), {});
  });

  test('C3. demo con query apiUrl: limpia la clave y de todas formas lanza (nunca la usa)', () => {
    const storage = makeMemoryStorage();
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '?apiUrl=http://evil.example/api',
          storage,
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
    assert.deepEqual(storage.__dump(), {});
  });

  test('C4. demo con ambas claves en localStorage: elimina las dos y lanza', () => {
    const storage = makeMemoryStorage({
      agx_api_url: 'http://evil.example/api',
      apiUrl: 'http://otro-evil.example/api',
    });
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage,
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
    assert.deepEqual(storage.__dump(), {});
  });

  test('C5. demo con VITE_API_URL configurada: no se usa, igual lanza', () => {
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo', VITE_API_URL: 'https://agrogenomax-production.up.railway.app/api' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
  });

  test('C6. demo con VITE_AGX_API_URL configurada: no se usa, igual lanza', () => {
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo', VITE_AGX_API_URL: 'https://agrogenomax-production.up.railway.app/api' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
  });

  test('C7. demo: el reporter recibe el intento de override sin el valor sensible', () => {
    const events = [];
    const reporter = (event) => events.push(event);
    assert.throws(
      () =>
        resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '?agx_api_url=http://usuario:secreto123@evil.example/robar-datos',
          storage: makeMemoryStorage(),
          reporter,
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events[0]);
    assert.ok(!serialized.includes('secreto123'));
    assert.ok(!serialized.includes('evil.example'));
    assert.equal(events[0].appEnv, 'demo');
    assert.equal(events[0].key, 'agx_api_url');
  });

  test('C8. resolveApiBaseUrl() también propaga ApiDisabledError en demo (no enmascara con /api)', () => {
    assert.throws(
      () =>
        resolveApiBaseUrl({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        }),
      { code: 'API_DISABLED_IN_DEMO' },
    );
  });

  test('C9. mensaje de ApiDisabledError no incluye URLs, dominios ni valores de override', () => {
    try {
      resolveApiBaseCandidates({
        env: { VITE_APP_ENV: 'demo' },
        hostname: 'demo.agrogenomax.com',
        search: '?agx_api_url=http://evil.example/secreto',
        storage: makeMemoryStorage(),
      });
      assert.fail('debía lanzar ApiDisabledError');
    } catch (error) {
      assert.equal(error.code, 'API_DISABLED_IN_DEMO');
      assert.ok(!error.message.includes('evil.example'));
      assert.ok(!/https?:\/\//.test(error.message));
    }
  });

  test('C10. simulación del patrón de consumidor CatastroX (bucle for-of): no se ejecuta fetch en demo', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({}) };
    };
    try {
      let thrown = null;
      try {
        for (const apiBase of resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        })) {
          await fetch(`${apiBase}/catastrox/lookups/x/full-result`);
        }
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown?.code, 'API_DISABLED_IN_DEMO');
      assert.equal(fetchCalls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('C11. simulación del patrón de pagos CatastroX (bucle for-of): no se ejecuta fetch en demo', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({}) };
    };
    try {
      let thrown = null;
      try {
        for (const apiBase of resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        })) {
          await fetch(`${apiBase}/catastrox/payments/checkout`, { method: 'POST' });
        }
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown?.code, 'API_DISABLED_IN_DEMO');
      assert.equal(fetchCalls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('C12. simulación del patrón Ganadería (bucle for-of): no se ejecuta fetch en demo', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({}) };
    };
    try {
      let thrown = null;
      try {
        for (const apiBase of resolveApiBaseCandidates({
          env: { VITE_APP_ENV: 'demo' },
          hostname: 'demo.agrogenomax.com',
          search: '',
          storage: makeMemoryStorage(),
        })) {
          await fetch(`${apiBase}/predios`);
        }
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown?.code, 'API_DISABLED_IN_DEMO');
      assert.equal(fetchCalls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('C13. test sin configuración explícita: sin candidatos, sin red', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'test' },
      hostname: 'ci-runner',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, []);
    assert.equal(
      resolveApiBaseUrl({ env: { VITE_APP_ENV: 'test' }, hostname: 'ci-runner', storage: makeMemoryStorage() }),
      null,
    );
  });

  test('C14. staging continúa resolviendo /api después de la corrección de demo/test', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'staging' },
      hostname: 'staging.agrogenomax.com',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['/api']);
  });

  test('C15. production continúa resolviendo /api después de la corrección de demo/test', () => {
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'production' },
      hostname: 'agrogenomax.com',
      search: '',
      storage: makeMemoryStorage(),
    });
    assert.deepEqual(candidates, ['/api']);
  });

  test('C16. development local conserva su precedencia previa (no afectada por la corrección)', () => {
    const storage = makeMemoryStorage({ agx_api_url: 'http://192.168.1.99:5000/api' });
    const candidates = resolveApiBaseCandidates({
      env: { VITE_APP_ENV: 'development', VITE_API_URL: 'http://127.0.0.1:9000/api' },
      hostname: 'localhost',
      search: '?apiUrl=http://10.0.0.9:4000/api',
      storage,
    });
    assert.equal(candidates[0], 'http://10.0.0.9:4000/api');
  });
});
