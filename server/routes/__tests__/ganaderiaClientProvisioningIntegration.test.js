import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// FIX/GANADERIA-SPRINT-2-CLIENT-PROVISIONING §16 (21-25): cadena completa
// CUENTA->MEMBRESÍA->ORGANIZACIÓN->ACTIVACIÓN->LOGIN->SESSION contra un
// PostgreSQL REAL (0001 + 0002 ya aplicadas). Auto-skip si
// AGX_AUTH_DATABASE_URL/AGX_AUTH_INTEGRATION_ADMIN_DATABASE_URL no
// apuntan a una base real con agx.organizaciones ya migrada -- mismo
// patrón que ganaderiaOrgMembresiaIntegration.test.js. Nunca toca
// producción. Ver db/agx/migrations/README.md para el entorno local.

let dbAvailable = false;
let pool;
let adminPool;
let ganaderiaSession;
let createGanaderiaAuthRouter;

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const TEST_FINGERPRINT_SECRET = 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc=';
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com']);

try {
  const pg = (await import('pg')).default;
  const adminConnectionString = process.env.AGX_AUTH_INTEGRATION_ADMIN_DATABASE_URL;
  if (!adminConnectionString) throw new Error('AGX_AUTH_INTEGRATION_ADMIN_DATABASE_URL no configurada');

  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});
  const { getAgxAuthPool } = await import('../../db/agxAuthPool.js');
  pool = getAgxAuthPool();
  await pool.query('select 1');

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.organizaciones') as t");
  const grantCheck = await adminPool.query(
    "select has_table_privilege('agx_auth', 'agx.organizaciones', 'INSERT') as can_insert",
  );
  dbAvailable = Boolean(tableCheck.rows[0]?.t) && grantCheck.rows[0]?.can_insert === true;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  ganaderiaSession = await import('../../security/ganaderiaSession.js');
  ({ default: createGanaderiaAuthRouter } = await import('../ganaderiaAuth.js'));
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

function startAuthApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/ganaderia/auth',
    createGanaderiaAuthRouter({
      appEnv: 'development',
      csrfServerSecret: TEST_CSRF_SECRET,
      fingerprintSecret: TEST_FINGERPRINT_SECRET,
      allowedOrigins: ALLOWED_ORIGINS,
    }),
  );
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/ganaderia/auth` });
    });
  });
}

function extractCookieValue(setCookieHeader) {
  return setCookieHeader.split(';')[0];
}

describe('FIX/GANADERIA-SPRINT-2: aprovisionamiento de cliente contra Postgres real', { skip: !dbAvailable }, () => {
  after(async () => {
    await adminPool.query(
      `delete from agx.sesiones where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint2-test.local')`,
    );
    await adminPool.query(
      `delete from agx.credenciales_reset_tokens where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint2-test.local')`,
    );
    await adminPool.query(
      `delete from agx.membresias where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint2-test.local')`,
    );
    await adminPool.query(
      `delete from agx.eventos_seguridad_auth where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint2-test.local')`,
    );
    await adminPool.query(`delete from agx.cuentas where email like '%sprint2-test.local'`);
    await adminPool.query(`delete from agx.organizaciones where nombre like 'Sprint2 Test %'`);
    await adminPool.end();
  });

  test('21-25: provisionar -> activar -> login -> session devuelve la organización con rol owner', async () => {
    const email = `cliente-${randomSuffix()}@sprint2-test.local`;
    const orgNombre = `Sprint2 Test ${randomSuffix()}`;

    // 21. Crear organización + cuenta + membresía owner (mismas funciones
    // que POST /api/ganaderia/admin/clientes, ejecutadas directamente
    // dentro de una transacción real -- el flujo HTTP de superadmin ya
    // está cubierto por server/routes/__tests__/ganaderiaAdmin.test.js).
    let organizacionId;
    let cuentaId;
    let rawToken;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      organizacionId = await ganaderiaSession.createOrganizacion(client, { nombre: orgNombre });
      cuentaId = await ganaderiaSession.createCuentaProvisionada(client, {
        email,
        emailNormalizado: email,
        nombre: 'Cliente Sprint2',
      });
      await ganaderiaSession.createMembresiaOwner(client, { cuentaId, organizacionId });
      rawToken = await ganaderiaSession.createResetToken(client, cuentaId, 'establecer_inicial', null);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    assert.ok(organizacionId);
    assert.ok(cuentaId);
    assert.ok(rawToken);

    // 22. El owner resuelve su organización (misma función que
    // GET /session usa vía listOrganizacionesDisponibles).
    const disponibles = await ganaderiaSession.listOrganizacionesDisponibles(cuentaId);
    assert.equal(disponibles.length, 1);
    assert.equal(disponibles[0].organizacionId, organizacionId);
    assert.equal(disponibles[0].rol, 'owner');

    // 23. Activar contraseña -- reutiliza POST /password/set real, sin
    // ningún endpoint nuevo (§8 del sprint).
    const authApp = await startAuthApp();
    try {
      const setPasswordResponse = await fetch(`${authApp.baseUrl}/password/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://agrogenomax.com' },
        body: JSON.stringify({ token: rawToken, newPassword: 'Contraseña-Cliente-Segura-2026!' }),
      });
      assert.equal(setPasswordResponse.status, 200);
      const setPasswordBody = await setPasswordResponse.json();
      assert.equal(setPasswordBody.ok, true);

      // 24. Login normal del cliente con la contraseña recién definida.
      const loginResponse = await fetch(`${authApp.baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://agrogenomax.com' },
        body: JSON.stringify({ email, password: 'Contraseña-Cliente-Segura-2026!' }),
      });
      assert.equal(loginResponse.status, 200);
      const setCookieHeader = loginResponse.headers.get('set-cookie');
      assert.ok(setCookieHeader);
      const sessionCookie = extractCookieValue(setCookieHeader);

      // 25. GET /session refleja la organización disponible con rol owner.
      const sessionResponse = await fetch(`${authApp.baseUrl}/session`, {
        method: 'GET',
        headers: { Cookie: sessionCookie },
      });
      assert.equal(sessionResponse.status, 200);
      const sessionBody = await sessionResponse.json();
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.tipoAcceso, 'cliente');
      assert.equal(sessionBody.organizacionesDisponibles.length, 1);
      assert.equal(sessionBody.organizacionesDisponibles[0].organizacionId, organizacionId);
      assert.equal(sessionBody.organizacionesDisponibles[0].rol, 'owner');
    } finally {
      await new Promise((resolve) => authApp.server.close(resolve));
    }
  });
});
