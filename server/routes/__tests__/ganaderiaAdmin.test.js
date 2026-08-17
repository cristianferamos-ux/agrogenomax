import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'crypto';

import createGanaderiaAdminRouter from '../ganaderiaAdmin.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { computeCsrfToken, hashSessionSecret } from '../../security/ganaderiaSession.js';

// FIX/GANADERIA-SPRINT-2-CLIENT-PROVISIONING §16: mismo patrón de fake DB
// en memoria + servidor HTTP real que server/routes/__tests__/ganaderiaAuth.test.js
// (agx_auth simulado, sin Postgres real). No se simula ROLLBACK real de
// Postgres aquí (mismo criterio ya documentado en ese archivo: "no se
// simula atomicidad real -- las pruebas de ROLLBACK real están cubiertas
// aparte") -- la prueba #6/#7 verifica el comportamiento observable por
// HTTP (nunca 201 si una escritura intermedia falla); la prueba de
// ROLLBACK real de Postgres vive en
// server/security/__tests__/ganaderiaOrgMembresiaIntegration.test.js
// (Postgres 18 desechable).

const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com']);

function sha256(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function makeFakeDb() {
  const db = {
    cuentas: [
      {
        cuenta_id: 'cuenta-superadmin',
        email: 'superadmin@agrogenomax.internal',
        email_normalizado: 'superadmin@agrogenomax.internal',
        nombre: 'Super Admin',
        estado: 'activa',
        password_hash: null,
      },
      {
        cuenta_id: 'cuenta-cliente-normal',
        email: 'cliente@fincaa.test',
        email_normalizado: 'cliente@fincaa.test',
        nombre: 'Cliente Normal',
        estado: 'activa',
        password_hash: 'x',
      },
      {
        cuenta_id: 'cuenta-existente',
        email: 'yaexiste@fincaa.test',
        email_normalizado: 'yaexiste@fincaa.test',
        nombre: 'Ya Existe',
        estado: 'activa',
        password_hash: 'x',
      },
    ],
    staffCrh: [{ cuenta_id: 'cuenta-superadmin', rol_interno: 'administrador_plataforma', estado: 'activo' }],
    organizaciones: [],
    membresias: [],
    resetTokens: [],
    sesiones: [],
  };

  let failNextInsertTable = null;
  function failNextInsert(table) {
    failNextInsertTable = table;
  }

  async function query(text, params = []) {
    if (text.includes('s.cuenta_id, s.organizacion_id, s.fecha_expiracion, s.fecha_revocacion')) {
      const [tokenHash] = params;
      const sesion = db.sesiones.find((s) => s.token_hash === tokenHash);
      if (!sesion) return { rows: [] };
      const cuenta = db.cuentas.find((c) => c.cuenta_id === sesion.cuenta_id);
      return {
        rows: [
          {
            sesion_id: sesion.sesion_id,
            cuenta_id: sesion.cuenta_id,
            organizacion_id: sesion.organizacion_id,
            fecha_expiracion: sesion.fecha_expiracion,
            fecha_revocacion: sesion.fecha_revocacion,
            cuenta_estado: cuenta?.estado ?? 'inactiva',
            email: cuenta?.email ?? null,
            nombre: cuenta?.nombre ?? null,
          },
        ],
      };
    }

    if (text.includes('from agx.staff_crh')) {
      const [cuentaId] = params;
      const staff = db.staffCrh.find((s) => s.cuenta_id === cuentaId && s.estado === 'activo');
      return staff ? { rows: [{ rol_interno: staff.rol_interno }] } : { rows: [] };
    }

    if (text.includes('email_normalizado = $1')) {
      const [emailNormalizado] = params;
      const cuenta = db.cuentas.find((c) => c.email_normalizado === emailNormalizado);
      if (!cuenta) return { rows: [] };
      return {
        rows: [
          {
            cuenta_id: cuenta.cuenta_id,
            email: cuenta.email,
            nombre: cuenta.nombre,
            estado: cuenta.estado,
            password_hash: cuenta.password_hash,
          },
        ],
      };
    }

    if (text.includes('insert into agx.organizaciones')) {
      if (failNextInsertTable === 'organizaciones') {
        failNextInsertTable = null;
        throw new Error('SIMULATED_ORGANIZACIONES_FAILURE');
      }
      const [nombre, identificadorFiscal] = params;
      const organizacionId = `org-${db.organizaciones.length + 1}`;
      db.organizaciones.push({ organizacion_id: organizacionId, nombre, identificador_fiscal: identificadorFiscal, estado: 'activa' });
      return { rows: [{ organizacion_id: organizacionId }] };
    }

    if (text.includes('insert into agx.cuentas')) {
      if (failNextInsertTable === 'cuentas') {
        failNextInsertTable = null;
        throw new Error('SIMULATED_CUENTAS_FAILURE');
      }
      const [email, emailNormalizado, nombre] = params;
      if (db.cuentas.some((c) => c.email_normalizado === emailNormalizado)) {
        const conflictError = new Error('duplicate key value violates unique constraint "cuentas_email_normalizado_key"');
        conflictError.code = '23505';
        throw conflictError;
      }
      const cuentaId = `cuenta-${db.cuentas.length + 1}`;
      db.cuentas.push({ cuenta_id: cuentaId, email, email_normalizado: emailNormalizado, nombre, estado: 'activa', password_hash: null });
      return { rows: [{ cuenta_id: cuentaId }] };
    }

    if (text.includes('insert into agx.membresias')) {
      if (failNextInsertTable === 'membresias') {
        failNextInsertTable = null;
        throw new Error('SIMULATED_MEMBRESIAS_FAILURE');
      }
      const [cuentaId, organizacionId] = params;
      db.membresias.push({ cuenta_id: cuentaId, organizacion_id: organizacionId, rol: 'owner', estado: 'activa' });
      return { rows: [] };
    }

    if (text.includes('insert into agx.credenciales_reset_tokens')) {
      if (failNextInsertTable === 'resetTokens') {
        failNextInsertTable = null;
        throw new Error('SIMULATED_TOKEN_FAILURE');
      }
      const [cuentaId, tokenHash, proposito, fechaExpiracion, creadoPorCuentaId] = params;
      db.resetTokens.push({ token_hash: tokenHash, cuenta_id: cuentaId, proposito, fecha_uso: null, fecha_expiracion: fechaExpiracion, creado_por_cuenta_id: creadoPorCuentaId });
      return { rows: [] };
    }

    throw new Error(`Query no reconocida por el fake DB: ${text}`);
  }

  return { db, query, failNextInsert };
}

function wireFakePoolConnect(pool, fakeDb) {
  pool.connect = async () => ({
    async query(text, params) {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      return fakeDb.query(text, params);
    },
    release() {},
  });
}

function insertRawSession(fakeDb, cuentaId) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  fakeDb.db.sesiones.push({
    sesion_id: `sesion-${fakeDb.db.sesiones.length + 1}`,
    cuenta_id: cuentaId,
    organizacion_id: null,
    token_hash: tokenHash,
    fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
    fecha_revocacion: null,
  });
  return rawToken;
}

// MICROAUDITORÍA §4: casos A/B/C (delivered:true / delivered:false /
// excepción) requieren controlar determinísticamente el resultado de
// sendActivationEmail -- appEnv:'test' por sí solo siempre lo stubea a
// delivered:false sin excepción (server/services/ganaderia/emailSender.js),
// insuficiente para probar el caso A (delivered:true) o C (excepción). Se
// usa el punto de inyección de createGanaderiaAdminRouter (exclusivo para
// pruebas, nunca usado así en producción).
function startApp({ emailOutcome = 'default' } = {}) {
  __resetAgxAuthPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'test' }, {});

  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
  const fakeDb = makeFakeDb();
  pool.query = fakeDb.query;
  wireFakePoolConnect(pool, fakeDb);

  const app = express();
  app.use(express.json());

  const routerOptions = { appEnv: 'test', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: ALLOWED_ORIGINS };
  if (emailOutcome !== 'default') {
    routerOptions.buildRestablecerContrasenaUrlFn = () => 'https://agrogenomax.com/ganaderia/restablecer-contrasena?token=fake';
    if (emailOutcome === 'delivered') {
      routerOptions.sendActivationEmailFn = async () => ({ delivered: true, provider: 'resend', errorCode: null });
    } else if (emailOutcome === 'not-delivered') {
      routerOptions.sendActivationEmailFn = async () => ({ delivered: false, provider: 'resend', errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' });
    } else if (emailOutcome === 'throws') {
      routerOptions.sendActivationEmailFn = async () => {
        throw new Error('SIMULATED_EMAIL_TRANSPORT_ERROR');
      };
    }
  }

  app.use('/api/ganaderia/admin', createGanaderiaAdminRouter(routerOptions));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, fakeDb, baseUrl: `http://127.0.0.1:${port}/api/ganaderia/admin` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

const VALID_BODY = { nombreOrganizacion: 'Finca Test S.A.S.', nombreResponsable: 'Juan Pérez', email: 'nuevo.cliente@fincaa.test' };

describe('FIX/GANADERIA-SPRINT-2-CLIENT-PROVISIONING: POST /api/ganaderia/admin/clientes', () => {
  test('1. sin sesión -> 401', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'SESSION_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('2. sesión cliente normal (no superadmin) -> 403', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-cliente-normal');
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `agx_session=${rawToken}`, Origin: 'https://agrogenomax.com' },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'SUPERADMIN_REQUIRED');
      assert.equal(ctx.fakeDb.db.organizaciones.length, 0);
    } finally {
      await closeApp(ctx);
    }
  });

  test('3. sesión superadmin sin CSRF -> 403', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `agx_session=${rawToken}`, Origin: 'https://agrogenomax.com' },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'CSRF_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('4. superadmin + CSRF + input válido -> crea organización + cuenta + membresía owner + token establecer_inicial', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.ok(body.organizacionId);
      assert.ok(body.cuentaId);
      assert.equal(ctx.fakeDb.db.organizaciones.length, 1);
      assert.equal(ctx.fakeDb.db.organizaciones[0].nombre, 'Finca Test S.A.S.');
      const cuentaCreada = ctx.fakeDb.db.cuentas.find((c) => c.cuenta_id === body.cuentaId);
      assert.equal(cuentaCreada.email_normalizado, 'nuevo.cliente@fincaa.test');
      assert.equal(ctx.fakeDb.db.membresias.length, 1);
      assert.equal(ctx.fakeDb.db.membresias[0].organizacion_id, body.organizacionId);
      assert.equal(ctx.fakeDb.db.resetTokens.length, 1);
    } finally {
      await closeApp(ctx);
    }
  });

  test('5. email duplicado -> 409, no crea nada', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ ...VALID_BODY, email: 'yaexiste@fincaa.test' }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'EMAIL_ALREADY_EXISTS');
      assert.equal(ctx.fakeDb.db.organizaciones.length, 0);
      assert.equal(ctx.fakeDb.db.membresias.length, 0);
    } finally {
      await closeApp(ctx);
    }
  });

  test('6. falla INSERT membresía -> nunca responde 201, no confirma el alta (rollback real de Postgres probado aparte, ver ganaderiaOrgMembresiaIntegration.test.js)', async () => {
    const ctx = await startApp();
    try {
      ctx.fakeDb.failNextInsert('membresias');
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.notEqual(response.status, 201);
      assert.equal(response.status, 500);
    } finally {
      await closeApp(ctx);
    }
  });

  test('7. falla token establecer_inicial -> nunca responde 201', async () => {
    const ctx = await startApp();
    try {
      ctx.fakeDb.failNextInsert('resetTokens');
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.notEqual(response.status, 201);
      assert.equal(response.status, 500);
    } finally {
      await closeApp(ctx);
    }
  });

  test('8. owner siempre server-side -- el body nunca puede elegir el rol de la membresía', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ ...VALID_BODY, rol: 'admin', estado: 'suspendida', cuentaId: 'inyectado', organizacionId: 'inyectado', password_hash: 'inyectado' }),
      });
      assert.equal(response.status, 201);
      assert.equal(ctx.fakeDb.db.membresias[0].rol, 'owner');
      assert.equal(ctx.fakeDb.db.membresias[0].estado, 'activa');
      const body = await response.json();
      assert.notEqual(body.cuentaId, 'inyectado');
      assert.notEqual(body.organizacionId, 'inyectado');
    } finally {
      await closeApp(ctx);
    }
  });

  test('9. password_hash queda NULL', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      const body = await response.json();
      const cuentaCreada = ctx.fakeDb.db.cuentas.find((c) => c.cuenta_id === body.cuentaId);
      assert.equal(cuentaCreada.password_hash, null);
    } finally {
      await closeApp(ctx);
    }
  });

  test('10. token creado con proposito=establecer_inicial y creado_por_cuenta_id del superadmin', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(ctx.fakeDb.db.resetTokens.length, 1);
      assert.equal(ctx.fakeDb.db.resetTokens[0].proposito, 'establecer_inicial');
      assert.equal(ctx.fakeDb.db.resetTokens[0].creado_por_cuenta_id, 'cuenta-superadmin');
    } finally {
      await closeApp(ctx);
    }
  });

  test('11. el envío de correo ocurre después del commit -- un 201 nunca depende de que el envío haya tenido éxito (appEnv=test -> stub, delivered:false, sin lanzar)', async () => {
    const ctx = await startApp();
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 201);
      // La transacción ya se confirmó (fila real en el fake DB) para el
      // momento en que la respuesta 201 llega -- el envío del correo,
      // estructuralmente, ocurre en la línea de código siguiente al
      // `await withAuthTransaction(...)`, nunca dentro de ella.
      assert.equal(ctx.fakeDb.db.organizaciones.length, 1);
      const body = await response.json();
      assert.equal(body.emailDelivered, false, 'appEnv=test siempre stubea delivered:false, sin lanzar');
    } finally {
      await closeApp(ctx);
    }
  });

  // -------------------------------------------------------------------
  // MICROAUDITORÍA (semántica post-commit del email, casos A/B/C)
  // -------------------------------------------------------------------

  test('MICROAUDITORÍA caso A: DB OK + email OK -> 201, ok:true, emailDelivered:true', async () => {
    const ctx = await startApp({ emailOutcome: 'delivered' });
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.emailDelivered, true);
    } finally {
      await closeApp(ctx);
    }
  });

  test('MICROAUDITORÍA caso B: DB OK + sendActivationEmail devuelve delivered:false -> 201, ok:true, emailDelivered:false, sin rollback', async () => {
    const ctx = await startApp({ emailOutcome: 'not-delivered' });
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.emailDelivered, false);
      // No exponer provider/errorCode/stack -- solo el booleano.
      assert.equal('provider' in body, false);
      assert.equal('errorCode' in body, false);
      assert.equal('error' in body, false);
      // Sin rollback: organización + cuenta + membresía + token quedan creados.
      assert.equal(ctx.fakeDb.db.organizaciones.length, 1);
      assert.equal(ctx.fakeDb.db.cuentas.some((c) => c.cuenta_id === body.cuentaId), true);
      assert.equal(ctx.fakeDb.db.membresias.length, 1);
      assert.equal(ctx.fakeDb.db.resetTokens.length, 1);
    } finally {
      await closeApp(ctx);
    }
  });

  test('MICROAUDITORÍA caso B2: sendActivationEmail lanza excepción -> 201, ok:true, emailDelivered:false, sin rollback, sin relanzar', async () => {
    const ctx = await startApp({ emailOutcome: 'throws' });
    try {
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.emailDelivered, false);
      assert.equal('provider' in body, false);
      assert.equal('errorCode' in body, false);
      assert.equal(ctx.fakeDb.db.organizaciones.length, 1);
      assert.equal(ctx.fakeDb.db.membresias.length, 1);
      assert.equal(ctx.fakeDb.db.resetTokens.length, 1);
    } finally {
      await closeApp(ctx);
    }
  });

  test('MICROAUDITORÍA caso C: DB FAIL (falla INSERT membresía) -- comportamiento previo intacto, nunca 201', async () => {
    const ctx = await startApp({ emailOutcome: 'delivered' });
    try {
      ctx.fakeDb.failNextInsert('membresias');
      const rawToken = insertRawSession(ctx.fakeDb, 'cuenta-superadmin');
      const csrfToken = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/clientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `agx_session=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.notEqual(response.status, 201);
      assert.equal(response.status, 500);
      assert.equal(ctx.fakeDb.db.membresias.length, 0);
      assert.equal(ctx.fakeDb.db.resetTokens.length, 0);
    } finally {
      await closeApp(ctx);
    }
  });
});
