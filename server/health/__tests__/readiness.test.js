import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGanaderiaReadinessHandler,
  createCatastroxReadinessHandler,
  createGeneralReadinessHandler,
} from '../readiness.js';

// LOTE-007 (ADR-012 §5.3/§7): handlers ejercitados con req/res simulados y
// dependencias inyectadas -- nunca abren PostgreSQL/PostGIS reales.

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
  return res;
}

describe('LOTE-007: server/health/readiness.js -- ready/ganaderia', () => {
  test('dependencia sana responde 200 con Cache-Control no-store', async () => {
    const handler = createGanaderiaReadinessHandler({
      deps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.check, 'ready:ganaderia');
    assert.equal('code' in res.body, false);
  });

  test('dependencia caída responde 503 con causa clasificada, sin error.message crudo', async () => {
    const handler = createGanaderiaReadinessHandler({
      deps: {
        getPool: () => ({}),
        checker: async () => ({ ok: false, code: 'database_unreachable' }),
      },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'unavailable');
    assert.equal(res.body.code, 'database_unreachable');
  });
});

describe('LOTE-007: server/health/readiness.js -- ready/catastrox', () => {
  test('dependencia sana responde 200', async () => {
    const handler = createCatastroxReadinessHandler({
      deps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.check, 'ready:catastrox');
  });

  test('esquema crítico ausente responde 503 con schema_missing', async () => {
    const handler = createCatastroxReadinessHandler({
      deps: { getPool: () => ({}), checker: async () => ({ ok: false, code: 'schema_missing' }) },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'schema_missing');
  });
});

describe('LOTE-007: server/health/readiness.js -- ready (general, resumen por dominio)', () => {
  test('ambos dominios sanos responde 200 status ok', async () => {
    const handler = createGeneralReadinessHandler({
      ganaderiaDeps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
      catastroxDeps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.domains.ganaderia.status, 'ok');
    assert.equal(res.body.domains.catastrox.status, 'ok');
  });

  test('Ganadería caída y CatastroX sano: responde degraded, catastrox permanece ok (independencia)', async () => {
    const handler = createGeneralReadinessHandler({
      ganaderiaDeps: {
        getPool: () => ({}),
        checker: async () => ({ ok: false, code: 'database_unreachable' }),
      },
      catastroxDeps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.domains.ganaderia.status, 'unavailable');
    assert.equal(res.body.domains.ganaderia.code, 'database_unreachable');
    assert.equal(res.body.domains.catastrox.status, 'ok');
    assert.equal('code' in res.body.domains.catastrox, false);
  });

  test('CatastroX caído y Ganadería sana: responde degraded, ganaderia permanece ok (independencia)', async () => {
    const handler = createGeneralReadinessHandler({
      ganaderiaDeps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
      catastroxDeps: {
        getPool: () => ({}),
        checker: async () => ({ ok: false, code: 'schema_missing' }),
      },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.domains.ganaderia.status, 'ok');
    assert.equal(res.body.domains.catastrox.status, 'unavailable');
    assert.equal(res.body.domains.catastrox.code, 'schema_missing');
  });

  test('ambos dominios caídos: responde 503 degraded con ambas causas', async () => {
    const handler = createGeneralReadinessHandler({
      ganaderiaDeps: { getPool: () => ({}), checker: async () => ({ ok: false, code: 'pool_exhausted' }) },
      catastroxDeps: { getPool: () => ({}), checker: async () => ({ ok: false, code: 'not_configured' }) },
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.domains.ganaderia.code, 'pool_exhausted');
    assert.equal(res.body.domains.catastrox.code, 'not_configured');
  });
});
