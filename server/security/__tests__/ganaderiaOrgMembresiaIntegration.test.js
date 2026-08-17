import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

// FIX/GANADERIA-SPRINT-1A-ORG-MEMBRESIA-AUTH §13: A-G. Prueba, contra un
// PostgreSQL REAL con la migración db/agx/migrations/0001_organizaciones_
// membresias_auth.sql ya aplicada, los escenarios que un stub de
// pool.query no puede ejercitar -- en particular el trigger de
// revocación (D) y las FKs/CHECK que impiden fijar una organización de
// sesión sin membresía activa (G). Mismo patrón de auto-skip que
// server/routes/__tests__/catastroxDeliveryLifecycle.test.js: si
// AGX_AUTH_DATABASE_URL / AGX_AUTH_INTEGRATION_ADMIN_DATABASE_URL no
// apuntan a una base real con agx.organizaciones ya migrada, esta suite
// se omite por completo (no falla el pipeline sin Postgres real
// disponible). Ver db/agx/migrations/README.md para el entorno local
// desechable.
//
// Dos conexiones deliberadamente distintas, replicando el principio de
// mínimo privilegio real (ADR-008 §14): `pool` usa agx_auth (el mismo
// rol de aplicación que server/security/ganaderiaSession.js usa en
// producción, con sus grants mínimos reales -- SELECT en organizaciones/
// membresias, sin INSERT) para ejecutar el código bajo prueba; `adminPool`
// (rol admin/superusuario SOLO de este entorno de prueba local) sirve
// EXCLUSIVAMENTE para sembrar/limpiar fixtures (INSERT directo de
// cuentas/organizaciones/membresias), algo que agx_auth no puede ni debe
// poder hacer hoy. Si el código de aplicación necesitara escribir esas
// tablas, usar agx_auth para el fixture setup habría ocultado esa falta
// de grant en vez de confirmarla.
//
// H (regresión login/session/recovery/password/superadmin) NO se repite
// aquí -- ya cubierta por server/routes/__tests__/ganaderiaAuth.test.js y
// server/security/__tests__/ganaderiaSession.test.js, ninguno de los
// cuales fue modificado por este sprint; se ejecutan como parte de la
// misma corrida de test:node.

let dbAvailable = false;
let pool;
let adminPool;
let ganaderiaSession;

try {
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
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  ganaderiaSession = await import('../ganaderiaSession.js');
}

function randomEmail(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}@sprint1a-test.local`;
}

async function insertCuenta(email, { activa = true } = {}) {
  const result = await adminPool.query(
    `insert into agx.cuentas (email, email_normalizado, nombre, estado, password_hash)
     values ($1, $1, 'Test', $2, 'x') returning cuenta_id`,
    [email, activa ? 'activa' : 'inactiva'],
  );
  return result.rows[0].cuenta_id;
}

async function insertStaff(cuentaId) {
  await adminPool.query(
    `insert into agx.staff_crh (cuenta_id, rol_interno, estado) values ($1, 'administrador_plataforma', 'activo')`,
    [cuentaId],
  );
}

async function insertOrganizacion(nombre) {
  const result = await adminPool.query(`insert into agx.organizaciones (nombre) values ($1) returning organizacion_id`, [nombre]);
  return result.rows[0].organizacion_id;
}

async function insertMembresia(cuentaId, organizacionId, rol = 'owner') {
  await adminPool.query(`insert into agx.membresias (cuenta_id, organizacion_id, rol, estado) values ($1, $2, $3, 'activa')`, [
    cuentaId,
    organizacionId,
    rol,
  ]);
}

async function insertSesion(cuentaId, organizacionId = null) {
  const rawToken = crypto.randomBytes(16).toString('base64url');
  const tokenHash = ganaderiaSession.hashSessionSecret(rawToken);
  const result = await pool.query(
    `insert into agx.sesiones (cuenta_id, organizacion_id, token_hash, fecha_expiracion)
     values ($1, $2, $3, now() + interval '1 hour') returning sesion_id`,
    [cuentaId, organizacionId, tokenHash],
  );
  return { sesionId: result.rows[0].sesion_id, rawToken, tokenHash };
}

describe('FIX/GANADERIA-SPRINT-1A: organizaciones/membresias contra Postgres real', { skip: !dbAvailable }, () => {
  after(async () => {
    // Limpieza best-effort de cualquier fila que un test individual no
    // haya limpiado ya (los tests limpian explícitamente, esto es una
    // red de seguridad final para no dejar residuos en la base local).
    await adminPool.query(`delete from agx.sesiones where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint1a-test.local')`);
    await adminPool.query(`delete from agx.membresias where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint1a-test.local')`);
    await adminPool.query(`delete from agx.staff_crh where cuenta_id in (select cuenta_id from agx.cuentas where email like '%sprint1a-test.local')`);
    await adminPool.query(`delete from agx.cuentas where email like '%sprint1a-test.local'`);
    await adminPool.query(`delete from agx.organizaciones where nombre like 'Sprint1A Test %'`);
    await adminPool.end();
  });

  test('A. superadmin sin organización: resolveInternalRole resuelve, sesión no requiere membresía', async () => {
    const cuentaId = await insertCuenta(randomEmail('super'));
    await insertStaff(cuentaId);
    const { rawToken } = await insertSesion(cuentaId, null);

    const rol = await ganaderiaSession.resolveInternalRole(cuentaId);
    assert.equal(rol, 'super_admin');

    const identity = await ganaderiaSession.resolveSessionIdentity(rawToken);
    assert.ok(identity, 'la sesión debe resolver identidad aunque organizacion_id sea null');
    assert.equal(identity.organizacionId, null);

    const disponibles = await ganaderiaSession.listOrganizacionesDisponibles(cuentaId);
    assert.deepEqual(disponibles, []);
  });

  test('B. cuenta cliente sin membresía: listOrganizacionesDisponibles vacío, sin organización activa', async () => {
    const cuentaId = await insertCuenta(randomEmail('cliente-sin-membresia'));
    const disponibles = await ganaderiaSession.listOrganizacionesDisponibles(cuentaId);
    assert.deepEqual(disponibles, []);

    const rol = await ganaderiaSession.resolveInternalRole(cuentaId);
    assert.equal(rol, null);
  });

  test('C. cuenta cliente con membresía owner activa: resuelve organización y tenant completo', async () => {
    const cuentaId = await insertCuenta(randomEmail('cliente-owner'));
    const orgId = await insertOrganizacion(`Sprint1A Test ${crypto.randomBytes(4).toString('hex')}`);
    await insertMembresia(cuentaId, orgId, 'owner');

    const membership = await ganaderiaSession.isMembresiaActivaParaOrganizacion(cuentaId, orgId);
    assert.deepEqual(membership, { rol: 'owner' });

    const disponibles = await ganaderiaSession.listOrganizacionesDisponibles(cuentaId);
    assert.equal(disponibles.length, 1);
    assert.equal(disponibles[0].organizacionId, orgId);
    assert.equal(disponibles[0].rol, 'owner');

    const { sesionId, rawToken } = await insertSesion(cuentaId, null);
    await ganaderiaSession.setOrganizacionActiva(sesionId, orgId);

    const tenant = await ganaderiaSession.resolveTenantAuthorization(rawToken);
    assert.equal(tenant.organizacionId, orgId);
    assert.equal(tenant.rol, 'owner');
  });

  test('D. membresía revocada: el trigger revoca la sesión asociada, resolveTenantAuthorization deja de resolver', async () => {
    const cuentaId = await insertCuenta(randomEmail('cliente-revocado'));
    const orgId = await insertOrganizacion(`Sprint1A Test ${crypto.randomBytes(4).toString('hex')}`);
    await insertMembresia(cuentaId, orgId, 'operador');
    const { sesionId, rawToken } = await insertSesion(cuentaId, orgId);

    const tenantAntes = await ganaderiaSession.resolveTenantAuthorization(rawToken);
    assert.equal(tenantAntes.organizacionId, orgId);

    await adminPool.query(`update agx.membresias set estado = 'revocada' where cuenta_id = $1 and organizacion_id = $2`, [
      cuentaId,
      orgId,
    ]);

    const sesionRow = await pool.query('select fecha_revocacion from agx.sesiones where sesion_id = $1', [sesionId]);
    assert.notEqual(sesionRow.rows[0].fecha_revocacion, null, 'el trigger debe fijar fecha_revocacion');

    const tenantDespues = await ganaderiaSession.resolveTenantAuthorization(rawToken);
    assert.equal(tenantDespues, null);

    const identity = await ganaderiaSession.resolveSessionIdentity(rawToken);
    assert.equal(identity, null, 'resolveSessionIdentity también debe tratar la sesión revocada como inválida');
  });

  test('E. organización inexistente: isMembresiaActivaParaOrganizacion devuelve null', async () => {
    const cuentaId = await insertCuenta(randomEmail('cliente-org-inexistente'));
    const orgFalsa = '00000000-0000-0000-0000-000000000000';
    const result = await ganaderiaSession.isMembresiaActivaParaOrganizacion(cuentaId, orgFalsa);
    assert.equal(result, null);
  });

  test('F. cuenta no miembro de una organización real: isMembresiaActivaParaOrganizacion devuelve null', async () => {
    const cuentaId = await insertCuenta(randomEmail('cliente-no-miembro'));
    const orgId = await insertOrganizacion(`Sprint1A Test ${crypto.randomBytes(4).toString('hex')}`);
    // orgId existe, pero cuentaId nunca tuvo membresía en ella.
    const result = await ganaderiaSession.isMembresiaActivaParaOrganizacion(cuentaId, orgId);
    assert.equal(result, null);
  });

  test('G. la base de datos nunca confía en un organizacion_id arbitrario: fijar sesión sin membresía activa falla (23514)', async () => {
    const cuentaId = await insertCuenta(randomEmail('cliente-sin-confiar'));
    const orgId = await insertOrganizacion(`Sprint1A Test ${crypto.randomBytes(4).toString('hex')}`);
    // Ninguna membresía creada -- setOrganizacionActiva es una capa de
    // aplicación que NO revalida por sí sola (esa responsabilidad, en las
    // rutas reales, la tiene isMembresiaActivaParaOrganizacion llamada
    // ANTES en server/routes/ganaderiaAuth.js). Esta prueba demuestra que
    // incluso si esa validación de aplicación se omitiera por error, la
    // base de datos (trigger fn_sesiones_valida_membresia_activa) igual
    // rechaza la escritura -- defensa en profundidad real, no solo de
    // diseño en papel.
    const { sesionId } = await insertSesion(cuentaId, null);
    await assert.rejects(
      () => ganaderiaSession.setOrganizacionActiva(sesionId, orgId),
      /membresía ACTIVA/,
    );
  });
});
