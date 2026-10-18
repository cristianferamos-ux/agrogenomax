import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateGanaderiaReadiness } from '../ganaderiaReadiness.js';
import { checkPostgresReadiness } from '../dbReadiness.js';
import {
  createGanaderiaReadinessHandler,
  createCatastroxReadinessHandler,
  createGeneralReadinessHandler,
} from '../readiness.js';
import { createLivenessHandler } from '../liveness.js';

// FASE-14 (readiness real): Ganadería comprueba Business y Auth (además de
// la comprobación histórica legacy) y reporta agx_qr_admin como opcional.
// Pools simulados: nunca se abre PostgreSQL real.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ganaderiaSource = fs.readFileSync(path.resolve(__dirname, '..', 'ganaderiaReadiness.js'), 'utf8');
const healthRouteSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'routes', 'health.js'), 'utf8');

function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; },
  };
}

const POOLS = {
  business: { id: 'business' },
  auth: { id: 'auth' },
  legacy: { id: 'legacy' },
  qrAdmin: { id: 'qrAdmin' },
};

/** Cada pool responde según `estado[nombre]` (por defecto ok). */
function deps(estado = {}, overrides = {}) {
  const nombreDe = new Map(Object.entries(POOLS).map(([nombre, pool]) => [pool, nombre]));
  return {
    getBusinessPool: () => POOLS.business,
    getAuthPool: () => POOLS.auth,
    getLegacyPool: () => POOLS.legacy,
    getQrAdminPool: () => POOLS.qrAdmin,
    checker: async (pool) => estado[nombreDe.get(pool)] ?? { ok: true, code: 'ok' },
    ...overrides,
  };
}

async function viaHandler(d) {
  const res = fakeRes();
  await createGanaderiaReadinessHandler({ deps: d })({}, res);
  return res;
}

const CAIDA = { ok: false, code: 'database_unreachable' };

describe('FASE-14: readiness de Ganadería sobre sus bases reales', () => {
  test('1. todas las bases sanas -> 200 ok, checks por base', async () => {
    const res = await viaHandler(deps());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.dependency, 'ganaderia_databases');
    assert.deepEqual(res.body.checks, { business: 'ok', auth: 'ok', legacy: 'ok', qrAdmin: 'ok' });
    assert.equal('code' in res.body, false);
  });

  test('2. Business caída -> 503 unavailable', async () => {
    const res = await viaHandler(deps({ business: CAIDA }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'unavailable');
    assert.equal(res.body.code, 'database_unreachable');
    assert.equal(res.body.checks.business, 'error');
    assert.equal(res.body.checks.auth, 'ok');
  });

  test('3. Auth caída -> 503 unavailable', async () => {
    const res = await viaHandler(deps({ auth: { ok: false, code: 'auth_failed' } }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'auth_failed');
    assert.deepEqual(res.body.checks, { business: 'ok', auth: 'error', legacy: 'ok', qrAdmin: 'ok' });
  });

  test('4. Business y Auth caídas -> 503 con ambas en error', async () => {
    const res = await viaHandler(deps({ business: CAIDA, auth: CAIDA }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.checks.business, 'error');
    assert.equal(res.body.checks.auth, 'error');
  });

  test('Business sin configurar (getter lanza *_NOT_CONFIGURED) -> 503 not_configured', async () => {
    const res = await viaHandler(deps({}, {
      getBusinessPool: () => { throw Object.assign(new Error('x'), { code: 'AGX_BUSINESS_DB_NOT_CONFIGURED' }); },
    }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'not_configured');
  });

  test('la comprobación legacy sigue siendo requerida (cobertura sin cambios)', async () => {
    const res = await viaHandler(deps({ legacy: { ok: false, code: 'schema_missing' } }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.checks.legacy, 'error');
  });

  test('5. timeout real del motor (query que nunca responde) -> 503 query_timeout', async () => {
    const colgado = { query: () => new Promise(() => {}) };
    const sano = { query: async () => ({ rows: [{ schema_exists: true }] }) };
    const checker = (pool, options) => checkPostgresReadiness(pool, { ...options, timeoutMs: 20, cacheMs: 0 });
    const result = await evaluateGanaderiaReadiness({
      getBusinessPool: () => colgado,
      getAuthPool: () => sano,
      getLegacyPool: () => ({ query: async () => ({ rows: [{ schema_exists: true }] }) }),
      getQrAdminPool: () => ({ query: async () => ({ rows: [] }) }),
      checker,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'query_timeout');
    assert.equal(result.checks.business, 'error');
    assert.equal(result.checks.auth, 'ok');
  });

  test('6. qrAdmin es OPCIONAL: caída -> 200 degraded; sin configurar -> 200 ok not_configured', async () => {
    const caida = await viaHandler(deps({ qrAdmin: CAIDA }));
    assert.equal(caida.statusCode, 200);
    assert.equal(caida.body.status, 'degraded');
    assert.equal(caida.body.checks.qrAdmin, 'error');

    const sinConfig = await viaHandler(deps({}, {
      getQrAdminPool: () => { throw Object.assign(new Error('x'), { code: 'QR_ADMIN_DB_NOT_CONFIGURED' }); },
    }));
    assert.equal(sinConfig.statusCode, 200);
    assert.equal(sinConfig.body.status, 'ok');
    assert.equal(sinConfig.body.checks.qrAdmin, 'not_configured');
  });

  test('7. sin fugas: ni mensajes del driver ni connection strings llegan a la respuesta', async () => {
    const SECRETO = 'postgresql://agx_app:SuperSecreta@postgres-agx-business.railway.internal:5432/agx_business';
    const filtrador = { query: async () => { throw Object.assign(new Error(`connect ECONNREFUSED ${SECRETO}`), { code: 'ECONNREFUSED' }); } };
    const checker = (pool, options) => checkPostgresReadiness(pool, { ...options, timeoutMs: 50, cacheMs: 0 });
    const res = await viaHandler({
      getBusinessPool: () => filtrador,
      getAuthPool: () => { throw new Error(`no config ${SECRETO}`); },
      getLegacyPool: () => ({ query: async () => ({ rows: [{ schema_exists: true }] }) }),
      getQrAdminPool: () => filtrador,
      checker,
    });
    const body = JSON.stringify(res.body);
    assert.equal(res.statusCode, 503);
    for (const fuga of ['SuperSecreta', 'railway.internal', 'agx_business', 'agx_app', 'ECONNREFUSED', 'postgresql://']) {
      assert.ok(!body.includes(fuga), `la respuesta no debe contener ${fuga}`);
    }
    for (const valor of Object.values(res.body.checks)) assert.match(valor, /^(ok|error|not_configured)$/);
  });

  test('8. liveness responde 200 sin consultar ninguna base', async () => {
    const res = fakeRes();
    await createLivenessHandler('production')({}, res);
    assert.equal(res.statusCode, 200);
    const livenessSource = fs.readFileSync(path.resolve(__dirname, '..', 'liveness.js'), 'utf8');
    const imports = livenessSource.split(/\r?\n/).filter((line) => /^\s*import\s/.test(line)).join('\n');
    assert.doesNotMatch(imports, /db|Pool|catastroxDb/, 'liveness no importa ningún módulo de base de datos');
  });

  test('9. CatastroX no cambia: su readiness y su resumen no llevan checks ni degraded de Ganadería', async () => {
    const catastrox = fakeRes();
    await createCatastroxReadinessHandler({ deps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) } })({}, catastrox);
    assert.equal(catastrox.statusCode, 200);
    assert.equal(catastrox.body.status, 'ok');
    assert.equal('checks' in catastrox.body, false);

    const general = fakeRes();
    await createGeneralReadinessHandler({
      ganaderiaDeps: deps({ qrAdmin: CAIDA }),
      catastroxDeps: { getPool: () => ({}), checker: async () => ({ ok: true, code: 'ok' }) },
    })({}, general);
    assert.equal(general.statusCode, 200);
    assert.equal(general.body.domains.ganaderia.status, 'degraded');
    assert.equal(general.body.domains.ganaderia.checks.qrAdmin, 'error');
    assert.deepEqual(general.body.domains.catastrox, { status: 'ok' });
  });

  test('reutiliza los pools perezosos existentes y GET /api/health/db sigue siendo solo legacy', () => {
    assert.doesNotMatch(ganaderiaSource, /new Pool|new pg\.Pool/);
    for (const getter of ['getAgxBusinessPool', 'getAgxAuthPool', 'getAgxQrAdminPool', 'getDbPool']) {
      assert.match(ganaderiaSource, new RegExp(`\\b${getter}\\b`), getter);
    }
    assert.match(healthRouteSource, /const result = await evaluateLegacyAgxReadiness\(\);/);
    assert.doesNotMatch(healthRouteSource, /evaluateGanaderiaReadiness/);
  });
});
