import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'crypto';

import createGanaderiaAuthRouter from '../ganaderiaAuth.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { computeCsrfToken } from '../../security/ganaderiaSession.js';
import { hashPassword } from '../../security/passwordHashing.js';
import { computeFingerprint, normalizeEmail } from '../../security/authFingerprint.js';

// BFF-001 + AUTH-001: pruebas de integración reales vía HTTP (servidor
// Express real en 127.0.0.1) contra un pool `agx_auth` con una base de
// datos en memoria que imita exactamente la forma de agx.sesiones/
// agx.cuentas/agx.membresias/agx.organizaciones/
// agx.credenciales_reset_tokens/agx.eventos_seguridad_auth/
// agx.auth_rate_limits ya validadas en ACCESO-001/AUTH-001. Cubre el
// ciclo completo de sesión + login real + password/set de punta a punta a
// través de HTTP real, sin Postgres (fuera de alcance de este lote -- ver
// informe).

const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const TEST_FINGERPRINT_SECRET = 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc=';
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com']);
const REAL_PASSWORD = 'contraseña-real-de-prueba-123';

function sha256(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

let OPERADOR_A_HASH;
let INACTIVA_HASH;

before(async () => {
  OPERADOR_A_HASH = await hashPassword(REAL_PASSWORD);
  INACTIVA_HASH = await hashPassword('contrasena-cuenta-inactiva-01');
});

// --- Base de datos en memoria, forma idéntica a la DDL de ACCESO-001/AUTH-001 ---
function makeFakeDb() {
  const db = {
    cuentas: [
      {
        cuenta_id: 'cuenta-a',
        email: 'operador@fincaa.test',
        email_normalizado: 'operador@fincaa.test',
        nombre: 'Operador A',
        estado: 'activa',
        get password_hash() {
          return OPERADOR_A_HASH;
        },
      },
      {
        cuenta_id: 'cuenta-inactiva',
        email: 'inactivo@fincaa.test',
        email_normalizado: 'inactivo@fincaa.test',
        nombre: 'Inactivo',
        estado: 'inactiva',
        get password_hash() {
          return INACTIVA_HASH;
        },
      },
      {
        cuenta_id: 'cuenta-sin-password',
        email: 'sinpassword@fincaa.test',
        email_normalizado: 'sinpassword@fincaa.test',
        nombre: 'Sin Password',
        estado: 'activa',
        password_hash: null,
      },
      // AGX-ADMIN-001: cuentas internas -- staff_crh, sin membresía en
      // agx.membresias (nunca se les asigna organización automáticamente).
      {
        cuenta_id: 'cuenta-staff-superadmin',
        email: 'superadmin@agrogenomax.internal',
        email_normalizado: 'superadmin@agrogenomax.internal',
        nombre: 'Super Admin AGX',
        estado: 'activa',
        password_hash: null,
      },
      {
        cuenta_id: 'cuenta-staff-inactivo',
        email: 'staff-inactivo@agrogenomax.internal',
        email_normalizado: 'staff-inactivo@agrogenomax.internal',
        nombre: 'Staff Inactivo',
        estado: 'activa',
        password_hash: null,
      },
      {
        cuenta_id: 'cuenta-staff-soporte',
        email: 'soporte@agrogenomax.internal',
        email_normalizado: 'soporte@agrogenomax.internal',
        nombre: 'Staff Soporte',
        estado: 'activa',
        password_hash: null,
      },
    ],
    organizaciones: [
      { organizacion_id: 'org-a', nombre: 'Finca A', estado: 'activa' },
      { organizacion_id: 'org-b', nombre: 'Finca B', estado: 'activa' },
    ],
    membresias: [
      { cuenta_id: 'cuenta-a', organizacion_id: 'org-a', rol: 'admin', estado: 'activa' },
    ],
    // AGX-ADMIN-001: modelo real auditado -- rol_interno='administrador_plataforma'
    // (único valor real permitido hoy por el CHECK de agx.staff_crh) se
    // mapea a la etiqueta 'super_admin' expuesta al frontend
    // (resolveInternalRole, sin ningún cambio de esquema/DDL).
    staffCrh: [
      { cuenta_id: 'cuenta-staff-superadmin', rol_interno: 'administrador_plataforma', estado: 'activo' },
      { cuenta_id: 'cuenta-staff-inactivo', rol_interno: 'administrador_plataforma', estado: 'inactivo' },
      { cuenta_id: 'cuenta-staff-soporte', rol_interno: 'soporte', estado: 'activo' },
    ],
    sesiones: [],
    resetTokens: [], // {token_hash, cuenta_id, proposito, fecha_uso, fecha_expiracion}
    rateLimits: [], // {dimension, key_fingerprint, window_started_at, attempt_count}
    eventosSeguridad: [], // {tipo, cuenta_id, email_fingerprint, ip_fingerprint, motivo}
  };

  async function query(text, params = []) {
    if (text.includes('email_normalizado = $1')) {
      // findCuentaParaLogin
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

    if (text.includes('for share')) {
      // revalidateCuentaActivaConHash
      const [cuentaId, passwordHash] = params;
      const cuenta = db.cuentas.find((c) => c.cuenta_id === cuentaId && c.estado === 'activa' && c.password_hash === passwordHash);
      return cuenta ? { rows: [{ cuenta_id: cuenta.cuenta_id }] } : { rows: [] };
    }

    if (text.includes('token_hash = $1 and fecha_revocacion is null')) {
      // revokeSessionByTokenHash
      const [tokenHash] = params;
      const sesion = db.sesiones.find((s) => s.token_hash === tokenHash && !s.fecha_revocacion);
      if (sesion) sesion.fecha_revocacion = new Date().toISOString();
      return { rows: [] };
    }

    if (text.includes('insert into agx.eventos_seguridad_auth')) {
      const [tipo, cuentaId, emailFingerprint, ipFingerprint, motivo] = params;
      db.eventosSeguridad.push({ tipo, cuenta_id: cuentaId, email_fingerprint: emailFingerprint, ip_fingerprint: ipFingerprint, motivo });
      return { rows: [] };
    }

    if (text.includes('insert into agx.auth_rate_limits')) {
      const [dimension, keyFingerprint, windowIntervalText] = params;
      const windowSeconds = parseInt(String(windowIntervalText), 10);
      const now = new Date();
      let row = db.rateLimits.find((r) => r.dimension === dimension && r.key_fingerprint === keyFingerprint);
      if (!row) {
        row = { dimension, key_fingerprint: keyFingerprint, window_started_at: now, attempt_count: 1 };
        db.rateLimits.push(row);
      } else if (row.window_started_at.getTime() <= now.getTime() - windowSeconds * 1000) {
        row.window_started_at = now;
        row.attempt_count = 1;
      } else {
        row.attempt_count += 1;
      }
      return { rows: [{ window_started_at: row.window_started_at.toISOString(), attempt_count: row.attempt_count }] };
    }

    if (text.includes('delete from agx.auth_rate_limits')) {
      const [keyFingerprint] = params;
      db.rateLimits = db.rateLimits.filter((r) => !(r.dimension === 'email' && r.key_fingerprint === keyFingerprint));
      return { rows: [] };
    }

    if (text.includes('crt.token_hash = $1')) {
      // findResetTokenForPrecheck
      const [tokenHash] = params;
      const token = db.resetTokens.find((t) => t.token_hash === tokenHash);
      if (!token) return { rows: [] };
      const cuenta = db.cuentas.find((c) => c.cuenta_id === token.cuenta_id);
      return {
        rows: [
          {
            cuenta_id: token.cuenta_id,
            fecha_uso: token.fecha_uso,
            fecha_expiracion: token.fecha_expiracion,
            email: cuenta?.email ?? null,
            nombre: cuenta?.nombre ?? null,
          },
        ],
      };
    }

    if (text.includes('insert into agx.credenciales_reset_tokens')) {
      // createResetToken
      const [cuentaId, tokenHash, proposito, fechaExpiracion] = params;
      db.resetTokens.push({ token_hash: tokenHash, cuenta_id: cuentaId, proposito, fecha_uso: null, fecha_expiracion: fechaExpiracion });
      return { rows: [] };
    }

    if (text.includes('update agx.credenciales_reset_tokens') && text.includes('cuenta_id = $1 and proposito = $2')) {
      // invalidateActiveResetTokensForCuenta -- invalida cualquier token
      // 'reset' previo aún vigente ANTES de crear el nuevo (AUTH-RECOVERY-002 §6).
      const [cuentaId, proposito] = params;
      const now = Date.now();
      db.resetTokens
        .filter((t) => t.cuenta_id === cuentaId && t.proposito === proposito && t.fecha_uso === null && new Date(t.fecha_expiracion).getTime() > now)
        .forEach((t) => {
          t.fecha_uso = new Date().toISOString();
        });
      return { rows: [] };
    }

    if (text.includes('update agx.credenciales_reset_tokens')) {
      // consumeResetToken -- atómico: solo consume si fecha_uso IS NULL y no expiró
      const [tokenHash] = params;
      const token = db.resetTokens.find((t) => t.token_hash === tokenHash);
      if (!token || token.fecha_uso !== null || new Date(token.fecha_expiracion).getTime() <= Date.now()) {
        return { rows: [] };
      }
      token.fecha_uso = new Date().toISOString();
      return { rows: [{ cuenta_id: token.cuenta_id, proposito: token.proposito }] };
    }

    if (text.includes('update agx.cuentas set password_hash')) {
      const [passwordHashNuevo, cuentaId] = params;
      const cuenta = db.cuentas.find((c) => c.cuenta_id === cuentaId);
      if (cuenta) {
        // password_hash está definido con un getter fijo arriba (fixtures
        // OPERADOR_A_HASH/INACTIVA_HASH) -- para permitir que password/set
        // lo sobrescriba de verdad en las pruebas, se reemplaza por una
        // propiedad de datos normal en el momento del primer UPDATE real.
        Object.defineProperty(cuenta, 'password_hash', { value: passwordHashNuevo, writable: true, configurable: true });
      }
      return { rows: [] };
    }

    if (text.includes('s.cuenta_id, s.organizacion_id, s.fecha_expiracion, s.fecha_revocacion')) {
      // resolveSessionIdentity
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
      // resolveInternalRole
      const [cuentaId] = params;
      const staff = db.staffCrh.find((s) => s.cuenta_id === cuentaId && s.estado === 'activo');
      return staff ? { rows: [{ rol_interno: staff.rol_interno }] } : { rows: [] };
    }

    if (text.includes('fn_resolver_autorizacion_sesion')) {
      const [tokenHash] = params;
      const sesion = db.sesiones.find((s) => s.token_hash === tokenHash);
      if (!sesion || sesion.fecha_revocacion || new Date(sesion.fecha_expiracion).getTime() <= Date.now()) {
        return { rows: [] };
      }
      const cuenta = db.cuentas.find((c) => c.cuenta_id === sesion.cuenta_id && c.estado === 'activa');
      if (!cuenta) return { rows: [] };
      const membresia = db.membresias.find(
        (m) => m.cuenta_id === sesion.cuenta_id && m.organizacion_id === sesion.organizacion_id && m.estado === 'activa',
      );
      if (!membresia) return { rows: [] };
      const org = db.organizaciones.find((o) => o.organizacion_id === sesion.organizacion_id && o.estado === 'activa');
      if (!org) return { rows: [] };
      return { rows: [{ sesion_id: sesion.sesion_id, cuenta_id: sesion.cuenta_id, organizacion_id: sesion.organizacion_id, rol: membresia.rol }] };
    }

    if (text.includes('m.organizacion_id, m.rol, o.nombre')) {
      // listOrganizacionesDisponibles
      const [cuentaId] = params;
      const rows = db.membresias
        .filter((m) => m.cuenta_id === cuentaId && m.estado === 'activa')
        .map((m) => {
          const org = db.organizaciones.find((o) => o.organizacion_id === m.organizacion_id);
          return org && org.estado === 'activa' ? { organizacion_id: m.organizacion_id, rol: m.rol, nombre: org.nombre } : null;
        })
        .filter(Boolean);
      return { rows };
    }

    if (text.includes('select m.rol') && text.includes('agx.membresias m')) {
      // isMembresiaActivaParaOrganizacion
      const [cuentaId, organizacionId] = params;
      const membresia = db.membresias.find(
        (m) => m.cuenta_id === cuentaId && m.organizacion_id === organizacionId && m.estado === 'activa',
      );
      if (!membresia) return { rows: [] };
      const org = db.organizaciones.find((o) => o.organizacion_id === organizacionId && o.estado === 'activa');
      return org ? { rows: [{ rol: membresia.rol }] } : { rows: [] };
    }

    if (text.includes('update agx.sesiones set organizacion_id')) {
      const [organizacionId, sesionId] = params;
      const sesion = db.sesiones.find((s) => s.sesion_id === sesionId);
      if (sesion) sesion.organizacion_id = organizacionId;
      return { rows: [] };
    }

    if (text.includes('fecha_revocacion = now()') && text.includes('cuenta_id = $1 and fecha_revocacion is null')) {
      // revokeAllSessionsForCuenta -- revoca TODAS las sesiones activas de
      // la cuenta (AUTH-RECOVERY-002 §12), no una sola por sesion_id.
      const [cuentaId] = params;
      db.sesiones
        .filter((s) => s.cuenta_id === cuentaId && !s.fecha_revocacion)
        .forEach((s) => {
          s.fecha_revocacion = new Date().toISOString();
        });
      return { rows: [] };
    }

    if (text.includes('fecha_revocacion = now()')) {
      const [sesionId] = params;
      const sesion = db.sesiones.find((s) => s.sesion_id === sesionId);
      if (sesion && !sesion.fecha_revocacion) sesion.fecha_revocacion = new Date().toISOString();
      return { rows: [] };
    }

    if (text.includes('insert into agx.sesiones')) {
      const [cuentaId, tokenHash, fechaExpiracion] = params;
      const sesionId = `sesion-${db.sesiones.length + 1}`;
      db.sesiones.push({
        sesion_id: sesionId,
        cuenta_id: cuentaId,
        organizacion_id: null,
        token_hash: tokenHash,
        fecha_expiracion: fechaExpiracion,
        fecha_revocacion: null,
      });
      return { rows: [] };
    }

    throw new Error(`Query no reconocida por el fake DB: ${text}`);
  }

  return { db, query };
}

function insertRawSession(fakeDb, { cuentaId, organizacionId = null, revoked = false, expired = false }) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  fakeDb.db.sesiones.push({
    sesion_id: `sesion-manual-${fakeDb.db.sesiones.length + 1}`,
    cuenta_id: cuentaId,
    organizacion_id: organizacionId,
    token_hash: tokenHash,
    fecha_expiracion: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
    fecha_revocacion: revoked ? new Date().toISOString() : null,
  });
  return rawToken;
}

/** AUTH-001: inserta un token de reset/establecimiento en el fake DB, devuelve el token crudo. */
function insertRawResetToken(fakeDb, { cuentaId, proposito = 'establecer_inicial', used = false, expired = false }) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  fakeDb.db.resetTokens.push({
    token_hash: tokenHash,
    cuenta_id: cuentaId,
    proposito,
    fecha_uso: used ? new Date().toISOString() : null,
    fecha_expiracion: new Date(Date.now() + (expired ? -60_000 : 60 * 60_000)).toISOString(),
  });
  return rawToken;
}

/**
 * withAuthTransaction llama a pool.connect() -- el fake pool necesita un
 * cliente cuyo .query delegue al mismo fakeDb.query (mismo estado en
 * memoria) y trate BEGIN/COMMIT/ROLLBACK como no-ops. No se simula
 * atomicidad real (aislamiento de una sola hebra JS es suficiente para
 * estas pruebas) -- las pruebas de ROLLBACK real ya están cubiertas
 * aparte en server/db/__tests__/agxAuthPool.test.js.
 */
function wireFakePoolConnect(pool, fakeDb) {
  pool.connect = async () => ({
    async query(text, params) {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      return fakeDb.query(text, params);
    },
    release() {},
  });
}

// REQUIRED_VARIABLES_BY_ENV.production (server/config/env.js) -- valores
// sintéticos fijos, solo para poder validar APP_ENV=production en estas
// pruebas de integración (nada de esto se usa realmente, el pool sigue
// apuntando al fake DB en memoria).
const PRODUCTION_REQUIRED_VARS = {
  DATABASE_URL: 'postgres://real-host/agx',
  CATASTROX_DATABASE_URL: 'postgres://real-host/gis',
  HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
  CATASTROX_PII_ENCRYPTION_KEY: '/7cHJDrllkKZ+qVKEMuaM+205+vEvpCTRKUArWkx+cc=',
  CATASTROX_PII_HASH_SECRET: 'b'.repeat(32),
  CATASTROX_VERIFY_HANDLE_KEY: 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=',
  CATASTROX_CHECKOUT_IDENTITY_KEY: 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc=',
  // AGX-SUPERADMIN-AUTH-006: obligatoria en production desde este fix.
  PUBLIC_APP_ORIGIN: 'https://agrogenomax.com',
};

function startApp(appEnv) {
  __resetAgxAuthPoolForTests();
  __resetValidationStateForTests();
  const source = { APP_ENV: appEnv, ...(appEnv === 'production' ? PRODUCTION_REQUIRED_VARS : {}) };
  getConfig(source, {});

  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
  const fakeDb = makeFakeDb();
  pool.query = fakeDb.query;
  wireFakePoolConnect(pool, fakeDb);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/ganaderia/auth',
    createGanaderiaAuthRouter({
      appEnv,
      csrfServerSecret: TEST_CSRF_SECRET,
      fingerprintSecret: TEST_FINGERPRINT_SECRET,
      allowedOrigins: ALLOWED_ORIGINS,
    }),
  );

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, fakeDb, baseUrl: `http://127.0.0.1:${port}/api/ganaderia/auth` });
    });
  });
}

function extractCookieValue(setCookieHeader) {
  return setCookieHeader.split(';')[0];
}

describe('BFF-001: server/routes/ganaderiaAuth.js (integración HTTP real)', () => {
  let ctx;

  beforeEach(async () => {
    if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await startApp('test');
  });

  after(async () => {
    if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
  });

  test('demo: todas las rutas responden 404', async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await startApp('demo');
    const response = await fetch(`${ctx.baseUrl}/session`);
    assert.equal(response.status, 404);
  });

  test('GET /session sin cookie -> 200 {authenticated:false}', async () => {
    const response = await fetch(`${ctx.baseUrl}/session`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { authenticated: false });
  });

  test('GET /session con cookie inválida -> 200 {authenticated:false}', async () => {
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: 'agx_session=no-existe' } });
    const body = await response.json();
    assert.deepEqual(body, { authenticated: false });
  });

  test('GET /session con sesión válida NUEVA sin organización -> authenticated:true, organizacionActiva:null', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.organizacionActiva, null);
    assert.deepEqual(body.organizacionesDisponibles, [{ organizacionId: 'org-a', rol: 'admin', nombre: 'Finca A' }]);
  });

  test('GET /session con sesión válida + organización activa -> tenant expuesto', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a', organizacionId: 'org-a' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.deepEqual(body.organizacionActiva, { organizacionId: 'org-a', rol: 'admin', nombre: 'Finca A' });
  });

  test('GET /session: sesión revocada por trigger (Modelo 1) -> authenticated:false, nunca tenant-less-pero-autenticada', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a', organizacionId: 'org-a', revoked: true });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.deepEqual(body, { authenticated: false });
  });

  test('GET /session: sesión expirada -> authenticated:false', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a', expired: true });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.deepEqual(body, { authenticated: false });
  });

  test('GET /session: cuenta inactiva -> authenticated:false', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-inactiva' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.deepEqual(body, { authenticated: false });
  });

  // AGX-ADMIN-001: identidad interna resuelta 100% en backend
  // (resolveInternalRole), auditada contra el modelo real de
  // agx.staff_crh -- ningún caso aquí depende de comparar email/nombre.
  test('GET /session: super_admin (rol_interno=administrador_plataforma, activo) -> tipoAcceso interno, rolInterno super_admin, sin organización', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-staff-superadmin' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.tipoAcceso, 'interno');
    assert.equal(body.rolInterno, 'super_admin');
    assert.equal(body.organizacionActiva, null);
    assert.deepEqual(body.organizacionesDisponibles, []);
  });

  test('GET /session: staff con estado=inactivo -> tratado como cliente (nunca super_admin, nunca acceso interno)', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-staff-inactivo' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.tipoAcceso, 'cliente');
    assert.equal(body.rolInterno, null);
  });

  test('GET /session: staff activo con rol_interno=soporte -> tipoAcceso interno, rolInterno soporte (nunca super_admin)', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-staff-soporte' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.tipoAcceso, 'interno');
    assert.equal(body.rolInterno, 'soporte');
    assert.notEqual(body.rolInterno, 'super_admin');
  });

  test('GET /session: cliente normal (sin fila en staff_crh) -> tipoAcceso cliente, rolInterno null (regresión AUTH-FRONT-001)', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a', organizacionId: 'org-a' });
    const response = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await response.json();
    assert.equal(body.tipoAcceso, 'cliente');
    assert.equal(body.rolInterno, null);
    assert.deepEqual(body.organizacionActiva, { organizacionId: 'org-a', rol: 'admin', nombre: 'Finca A' });
  });

  test('GET /csrf sin cookie -> 401', async () => {
    const response = await fetch(`${ctx.baseUrl}/csrf`);
    assert.equal(response.status, 401);
  });

  test('GET /csrf con sesión válida -> 200, csrfToken coincide con el algoritmo aprobado', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
    const response = await fetch(`${ctx.baseUrl}/csrf`, { headers: { Cookie: `agx_session=${raw}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.csrfToken, computeCsrfToken(raw, TEST_CSRF_SECRET));
  });

  test('POST /logout sin X-CSRF-Token -> 403 CSRF_REQUIRED', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
    const response = await fetch(`${ctx.baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: `agx_session=${raw}`, Origin: 'https://agrogenomax.com' },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, 'CSRF_REQUIRED');
  });

  test('POST /logout con CSRF válido -> revoca la sesión, limpia la cookie, siguiente /session ya no autentica', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
    const csrfToken = computeCsrfToken(raw, TEST_CSRF_SECRET);

    const logoutResponse = await fetch(`${ctx.baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: `agx_session=${raw}`, Origin: 'https://agrogenomax.com', 'X-CSRF-Token': csrfToken },
    });
    assert.equal(logoutResponse.status, 200);
    const setCookie = logoutResponse.headers.get('set-cookie');
    assert.match(setCookie, /^agx_session=;/);
    assert.match(setCookie, /Max-Age=0/);

    const sessionAfter = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const body = await sessionAfter.json();
    assert.deepEqual(body, { authenticated: false });
  });

  test('POST /organizacion sin membresía activa en esa organización -> 403 ORGANIZATION_NOT_AUTHORIZED, org A nunca ve datos de B', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
    const csrfToken = computeCsrfToken(raw, TEST_CSRF_SECRET);
    const response = await fetch(`${ctx.baseUrl}/organizacion`, {
      method: 'POST',
      headers: {
        Cookie: `agx_session=${raw}`,
        Origin: 'https://agrogenomax.com',
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ organizacionId: 'org-b' }), // cuenta-a NO tiene membresía en org-b
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, 'ORGANIZATION_NOT_AUTHORIZED');
  });

  test('POST /organizacion con membresía activa -> 200, fija el tenant, siguiente /session lo refleja', async () => {
    const raw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
    const csrfToken = computeCsrfToken(raw, TEST_CSRF_SECRET);
    const response = await fetch(`${ctx.baseUrl}/organizacion`, {
      method: 'POST',
      headers: {
        Cookie: `agx_session=${raw}`,
        Origin: 'https://agrogenomax.com',
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ organizacionId: 'org-a' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.organizacionActiva, { organizacionId: 'org-a', rol: 'admin' });

    const sessionAfter = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
    const sessionBody = await sessionAfter.json();
    assert.equal(sessionBody.organizacionActiva.organizacionId, 'org-a');
  });

  describe('AUTH-001: POST /login -- autenticación nativa real, sin bypass de ninguna clase', () => {
    function loginRequest(baseUrl, { email, password, origin = 'https://agrogenomax.com', contentType = 'application/json', cookie } = {}) {
      const headers = { Origin: origin };
      if (contentType) headers['Content-Type'] = contentType;
      if (cookie) headers.Cookie = cookie;
      return fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers,
        body: contentType === 'application/json' ? JSON.stringify({ email, password }) : undefined,
      });
    }

    test('Origin inválido -> 403 ORIGIN_INVALID, nunca llega a evaluar credenciales', async () => {
      const response = await loginRequest(ctx.baseUrl, {
        email: 'operador@fincaa.test',
        password: REAL_PASSWORD,
        origin: 'https://evil.example',
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'ORIGIN_INVALID');
    });

    test('Content-Type distinto de application/json -> 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      const response = await fetch(`${ctx.baseUrl}/login`, {
        method: 'POST',
        headers: { Origin: 'https://agrogenomax.com', 'Content-Type': 'text/plain' },
        body: 'email=x&password=y',
      });
      assert.equal(response.status, 415);
      assert.equal((await response.json()).error, 'UNSUPPORTED_MEDIA_TYPE');
    });

    test('falta email o password -> 400 INVALID_CREDENTIALS_FORMAT', async () => {
      const soloEmail = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: '' });
      assert.equal(soloEmail.status, 400);
      assert.equal((await soloEmail.json()).error, 'INVALID_CREDENTIALS_FORMAT');

      const soloPassword = await loginRequest(ctx.baseUrl, { email: '', password: REAL_PASSWORD });
      assert.equal(soloPassword.status, 400);
    });

    test('credenciales correctas -> 200, Set-Cookie de sesión, /session refleja autenticado, sin X-Auth-Mode alguno', async () => {
      const response = await loginRequest(ctx.baseUrl, { email: '  Operador@FincaA.Test  ', password: REAL_PASSWORD });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-auth-mode'), null);
      const body = await response.json();
      assert.equal(body.authenticated, true);
      assert.equal(body.cuenta.cuentaId, 'cuenta-a');

      const setCookie = response.headers.get('set-cookie');
      assert.match(setCookie, /^agx_session=/);
      const raw = extractCookieValue(setCookie).split('=')[1];

      const sessionResponse = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${raw}` } });
      const sessionBody = await sessionResponse.json();
      assert.equal(sessionBody.authenticated, true);
    });

    test('password incorrecta -> 401 INVALID_CREDENTIALS, mensaje genérico', async () => {
      const response = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: 'contrasena-equivocada-00000' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_CREDENTIALS');
      assert.equal(response.headers.get('set-cookie'), null);
    });

    test('cuenta inexistente -> 401 INVALID_CREDENTIALS (MISMO código que password incorrecta -- nunca auto-registro, nunca enumeration)', async () => {
      const response = await loginRequest(ctx.baseUrl, { email: 'no-existe@fincaa.test', password: 'cualquier-cosa-larga-00000' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_CREDENTIALS');
    });

    test('cuenta sin password_hash todavía (nunca completó /password/set) -> 401 INVALID_CREDENTIALS', async () => {
      const response = await loginRequest(ctx.baseUrl, { email: 'sinpassword@fincaa.test', password: 'cualquier-cosa-larga-00000' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_CREDENTIALS');
    });

    test('cuenta inactiva con password correcto -> 401 INVALID_CREDENTIALS', async () => {
      const response = await loginRequest(ctx.baseUrl, { email: 'inactivo@fincaa.test', password: 'contrasena-cuenta-inactiva-01' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_CREDENTIALS');
    });

    test('revoca la sesión previa asociada a la cookie entrante (protección de session fixation)', async () => {
      const oldRaw = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
      const response = await loginRequest(ctx.baseUrl, {
        email: 'operador@fincaa.test',
        password: REAL_PASSWORD,
        cookie: `agx_session=${oldRaw}`,
      });
      assert.equal(response.status, 200);

      const oldSessionCheck = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${oldRaw}` } });
      assert.deepEqual(await oldSessionCheck.json(), { authenticated: false });
    });

    test('rate limit por email: 6º intento fallido consecutivo -> 429 TOO_MANY_ATTEMPTS con Retry-After', async () => {
      for (let i = 0; i < 5; i += 1) {
        const attempt = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: 'incorrecta-00000000000000' });
        assert.equal(attempt.status, 401, `intento ${i + 1} debía ser 401, no throttle todavía`);
      }
      const sixth = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: 'incorrecta-00000000000000' });
      assert.equal(sixth.status, 429);
      assert.equal((await sixth.json()).error, 'TOO_MANY_ATTEMPTS');
      assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    });

    test('login exitoso limpia el contador de rate limit de email (no bloquea intentos legítimos futuros)', async () => {
      for (let i = 0; i < 4; i += 1) {
        await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: 'incorrecta-00000000000000' });
      }
      const success = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: REAL_PASSWORD });
      assert.equal(success.status, 200);

      const emailFingerprint = computeFingerprint('email', normalizeEmail('operador@fincaa.test'), TEST_FINGERPRINT_SECRET);
      assert.equal(
        ctx.fakeDb.db.rateLimits.some((r) => r.dimension === 'email' && r.key_fingerprint === emailFingerprint),
        false,
      );
    });

    test('condición final A -- password_hash cambia ENTRE la verificación Argon2 y el BEGIN -> 401, NUNCA crea sesión (revalidación FOR SHARE)', async () => {
      const originalQuery = ctx.fakeDb.query;
      let precheckSeen = false;
      const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
      pool.query = async (text, params) => {
        const result = await originalQuery(text, params);
        if (!precheckSeen && text.includes('email_normalizado = $1')) {
          precheckSeen = true;
          // Simula que, justo después de leerse el hash para Argon2 (fuera
          // de la transacción), otra operación cambia el password_hash de
          // la cuenta (p. ej. un password/set concurrente) -- ANTES de que
          // la revalidación FOR SHARE se ejecute dentro de BEGIN.
          const cuenta = ctx.fakeDb.db.cuentas.find((c) => c.cuenta_id === 'cuenta-a');
          Object.defineProperty(cuenta, 'password_hash', {
            value: await hashPassword('password-cambiado-durante-la-carrera'),
            writable: true,
            configurable: true,
          });
        }
        return result;
      };

      const response = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: REAL_PASSWORD });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_CREDENTIALS');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(ctx.fakeDb.db.sesiones.length, 0, 'no debe haberse creado ninguna sesión pese a que Argon2 verificó el hash original');
    });

    test('funciona igual en producción -- SIN ninguna rama condicional de bypass por ambiente', async () => {
      await new Promise((resolve) => ctx.server.close(resolve));
      ctx = await startApp('production');
      const response = await loginRequest(ctx.baseUrl, { email: 'operador@fincaa.test', password: REAL_PASSWORD });
      assert.equal(response.status, 200);
    });
  });

  describe('AUTH-001: GET /callback -- ELIMINADO (Cognito cancelado, ADR-015)', () => {
    test('ya no existe ninguna ruta -- 404 llano, sin 501, sin referencias a Cognito', async () => {
      // Autocontenido -- no depende del appEnv que haya dejado el test
      // anterior (algunos, dentro del describe de /login, cambian
      // deliberadamente a 'production' para probar ausencia de bypass).
      await new Promise((resolve) => ctx.server.close(resolve));
      ctx = await startApp('test');

      const response = await fetch(`${ctx.baseUrl}/callback`);
      assert.equal(response.status, 404);
    });

    test('también 404 en development -- no es un gate de ambiente, la ruta no existe en absoluto', async () => {
      await new Promise((resolve) => ctx.server.close(resolve));
      ctx = await startApp('development');

      const response = await fetch(`${ctx.baseUrl}/callback`);
      assert.equal(response.status, 404);
    });
  });

  describe('AUTH-001: POST /password/set -- establecimiento inicial / reset', () => {
    function passwordSetRequest(baseUrl, { token, newPassword, origin = 'https://agrogenomax.com' } = {}) {
      return fetch(`${baseUrl}/password/set`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
    }

    test('token válido -> 200 {ok:true}, sin Set-Cookie (nunca auto-login), el nuevo password permite /login', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-sin-password', proposito: 'establecer_inicial' });
      const nuevoPassword = 'password-nuevo-establecido-01';

      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: nuevoPassword });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(response.headers.get('set-cookie'), null);

      const loginResponse = await fetch(`${ctx.baseUrl}/login`, {
        method: 'POST',
        headers: { Origin: 'https://agrogenomax.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sinpassword@fincaa.test', password: nuevoPassword }),
      });
      assert.equal(loginResponse.status, 200);
    });

    test('token inexistente -> 401 INVALID_TOKEN', async () => {
      const response = await passwordSetRequest(ctx.baseUrl, { token: 'token-que-no-existe', newPassword: 'password-cualquiera-largo-01' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_TOKEN');
    });

    test('token ya usado -> 401 INVALID_TOKEN', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-sin-password', used: true });
      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-cualquiera-largo-01' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_TOKEN');
    });

    test('token expirado -> 401 INVALID_TOKEN', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-sin-password', expired: true });
      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-cualquiera-largo-01' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_TOKEN');
    });

    test('password que no cumple la política -> 400 con el código de política, token NO se consume', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-sin-password' });
      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'corta' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'PASSWORD_TOO_SHORT');

      // El token sigue vivo -- puede reintentarse con un password válido.
      const retry = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-valido-esta-vez-01' });
      assert.equal(retry.status, 200);
    });

    test('condición final B -- consumo concurrente del MISMO token: exactamente una de dos solicitudes simultáneas tiene éxito', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-sin-password' });

      const [first, second] = await Promise.all([
        passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'primer-intento-concurrente-01' }),
        passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'segundo-intento-concurrente-01' }),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 401]);
    });
  });

  describe('AUTH-RECOVERY-002: POST /recovery/request -- anti-enumeración + creación de token', () => {
    function recoveryRequest(baseUrl, { email, origin = 'https://agrogenomax.com', contentType = 'application/json' } = {}) {
      const headers = { Origin: origin };
      if (contentType) headers['Content-Type'] = contentType;
      return fetch(`${baseUrl}/recovery/request`, {
        method: 'POST',
        headers,
        body: contentType === 'application/json' ? JSON.stringify({ email }) : undefined,
      });
    }

    test('Origin inválido -> 403 ORIGIN_INVALID', async () => {
      const response = await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test', origin: 'https://evil.example' });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'ORIGIN_INVALID');
    });

    test('email vacío -> 400 INVALID_REQUEST_FORMAT (único status que puede diferir, nunca revela existencia)', async () => {
      const response = await recoveryRequest(ctx.baseUrl, { email: '' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'INVALID_REQUEST_FORMAT');
    });

    test('(A) cuenta existente y activa -> {ok:true}, crea exactamente un token reset, el hash persistido nunca es el token crudo', async () => {
      const response = await recoveryRequest(ctx.baseUrl, { email: '  Operador@FincaA.Test  ' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });

      const tokens = ctx.fakeDb.db.resetTokens.filter((t) => t.cuenta_id === 'cuenta-a' && t.proposito === 'reset');
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].token_hash.length, 64); // sha256 hex -- nunca el token base64url crudo
      assert.equal(tokens[0].fecha_uso, null);
    });

    test('(B) cuenta inexistente -> respuesta idéntica (status + cuerpo) a la de una cuenta existente, ningún token creado para ella', async () => {
      const responseExistente = await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test' });
      const bodyExistente = await responseExistente.json();

      const responseInexistente = await recoveryRequest(ctx.baseUrl, { email: 'jamas-existio@fincaa.test' });
      const bodyInexistente = await responseInexistente.json();

      assert.equal(responseExistente.status, responseInexistente.status);
      assert.deepEqual(bodyExistente, bodyInexistente);
      assert.equal(
        ctx.fakeDb.db.resetTokens.filter((t) => t.proposito === 'reset').every((t) => t.cuenta_id === 'cuenta-a'),
        true,
        'ningún token reset debe quedar asociado a una cuenta inexistente',
      );
    });

    test('cuenta inactiva -> misma respuesta genérica, ningún token creado', async () => {
      const response = await recoveryRequest(ctx.baseUrl, { email: 'inactivo@fincaa.test' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(ctx.fakeDb.db.resetTokens.some((t) => t.cuenta_id === 'cuenta-inactiva'), false);
    });

    test('(C) una nueva solicitud invalida el token reset previo aún vigente de la misma cuenta -- solo el más nuevo queda usable', async () => {
      await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test' });
      const firstToken = ctx.fakeDb.db.resetTokens.find((t) => t.cuenta_id === 'cuenta-a' && t.proposito === 'reset' && t.fecha_uso === null);
      assert.ok(firstToken, 'debe existir un token vigente tras la primera solicitud');

      await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test' });

      const firstAfter = ctx.fakeDb.db.resetTokens.find((t) => t.token_hash === firstToken.token_hash);
      assert.notEqual(firstAfter.fecha_uso, null, 'el token anterior debe quedar invalidado');

      const vigentes = ctx.fakeDb.db.resetTokens.filter(
        (t) => t.cuenta_id === 'cuenta-a' && t.proposito === 'reset' && t.fecha_uso === null,
      );
      assert.equal(vigentes.length, 1, 'solo el enlace más nuevo debe seguir vigente');
    });

    test('(J) el rate limit de recovery es independiente del de /login (mismo email, mismo IP)', async () => {
      for (let i = 0; i < 5; i += 1) {
        await fetch(`${ctx.baseUrl}/login`, {
          method: 'POST',
          headers: { Origin: 'https://agrogenomax.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'operador@fincaa.test', password: 'incorrecta-00000000000000' }),
        });
      }
      const loginThrottled = await fetch(`${ctx.baseUrl}/login`, {
        method: 'POST',
        headers: { Origin: 'https://agrogenomax.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operador@fincaa.test', password: 'incorrecta-00000000000000' }),
      });
      assert.equal(loginThrottled.status, 429, 'precondición: /login debe estar bloqueado');

      const recovery = await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test' });
      assert.equal(recovery.status, 200, 'recovery/request para el mismo email debe seguir funcionando -- bucket propio');
    });

    test('recovery/request: 6ª solicitud consecutiva -> 429 TOO_MANY_ATTEMPTS con Retry-After (bucket propio)', async () => {
      for (let i = 0; i < 5; i += 1) {
        const attempt = await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test' });
        assert.equal(attempt.status, 200, `intento ${i + 1} no debía estar bloqueado todavía`);
      }
      const sixth = await recoveryRequest(ctx.baseUrl, { email: 'operador@fincaa.test' });
      assert.equal(sixth.status, 429);
      assert.equal((await sixth.json()).error, 'TOO_MANY_ATTEMPTS');
      assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    });
  });

  describe('AUTH-RECOVERY-002: POST /password/set con proposito=reset -- revocación de sesiones', () => {
    function passwordSetRequest(baseUrl, { token, newPassword, origin = 'https://agrogenomax.com' } = {}) {
      return fetch(`${baseUrl}/password/set`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
    }

    test('(D)(H) token reset válido -> password cambia, TODAS las sesiones previas de la cuenta quedan revocadas, PASSWORD_CHANGED registrado', async () => {
      const sesionVieja1 = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a', organizacionId: 'org-a' });
      const sesionVieja2 = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-a' });
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-a', proposito: 'reset' });

      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-reestablecido-nuevo-01' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });

      const check1 = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${sesionVieja1}` } });
      assert.deepEqual(await check1.json(), { authenticated: false }, 'sesión vieja 1 debe quedar revocada');
      const check2 = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${sesionVieja2}` } });
      assert.deepEqual(await check2.json(), { authenticated: false }, 'sesión vieja 2 debe quedar revocada');

      assert.equal(
        ctx.fakeDb.db.eventosSeguridad.some((e) => e.tipo === 'PASSWORD_CHANGED' && e.cuenta_id === 'cuenta-a'),
        true,
      );

      const loginConNuevo = await fetch(`${ctx.baseUrl}/login`, {
        method: 'POST',
        headers: { Origin: 'https://agrogenomax.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operador@fincaa.test', password: 'password-reestablecido-nuevo-01' }),
      });
      assert.equal(loginConNuevo.status, 200, 'la contraseña nueva debe funcionar de inmediato -- sin auto-login previo');
    });

    test('(E) token reset ya usado -> 401 INVALID_TOKEN', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-a', proposito: 'reset', used: true });
      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-cualquiera-largo-01' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_TOKEN');
    });

    test('(F) token reset expirado -> 401 INVALID_TOKEN', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-a', proposito: 'reset', expired: true });
      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-cualquiera-largo-01' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'INVALID_TOKEN');
    });

    test('(G) password que no cumple la política -> 400 con el código de política, token reset NO se consume', async () => {
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-a', proposito: 'reset' });
      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'corta' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'PASSWORD_TOO_SHORT');

      const retry = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-valido-esta-vez-02' });
      assert.equal(retry.status, 200);
    });

    test('(I) regresión: establecer_inicial NO revoca sesiones ni registra PASSWORD_CHANGED (comportamiento AUTH-001 aprobado intacto)', async () => {
      const sesionExistente = insertRawSession(ctx.fakeDb, { cuentaId: 'cuenta-sin-password' });
      const rawToken = insertRawResetToken(ctx.fakeDb, { cuentaId: 'cuenta-sin-password', proposito: 'establecer_inicial' });

      const response = await passwordSetRequest(ctx.baseUrl, { token: rawToken, newPassword: 'password-inicial-establecido-02' });
      assert.equal(response.status, 200);

      const check = await fetch(`${ctx.baseUrl}/session`, { headers: { Cookie: `agx_session=${sesionExistente}` } });
      const body = await check.json();
      assert.equal(body.authenticated, true, 'establecer_inicial no debe introducir ningún efecto secundario de revocación nuevo');

      assert.equal(
        ctx.fakeDb.db.eventosSeguridad.some((e) => e.tipo === 'PASSWORD_CHANGED'),
        false,
      );
    });
  });
});
