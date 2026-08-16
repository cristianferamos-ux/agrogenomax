import crypto from 'crypto';
import { isOriginAllowed } from './corsPolicyCore.js';
import { getAgxAuthPool } from '../db/agxAuthPool.js';

// BFF-001 (ADR-009, aprobado v3): módulo de seguridad aislado del canal
// navegador-BFF de Ganadería. No importa nada de
// server/security/recoveryCookie.js (CatastroX) ni de ningún router de
// negocio. Usa exclusivamente el pool `agx_auth` (plano de seguridad,
// agxAuthPool.js) -- nunca el pool de negocio.
//
// Arquitectura B (identidad != tenant resuelto), Modelo 1 (revocación
// mata la sesión completa -- ver los triggers ya validados en ACCESO-001:
// fn_revocar_sesiones_por_membresia / fn_revocar_sesiones_por_cuenta_inactiva /
// fn_revocar_sesiones_por_organizacion_suspendida, todos fijan
// sesiones.fecha_revocacion). Este módulo nunca reinterpreta una sesión
// revocada como "sesión sin tenant" -- las dos consultas de abajo
// (resolveSessionIdentity / resolveTenantAuthorization) comparten el
// mismo criterio de "revocada = inválida por completo".

export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 horas, ver diseño BFF-001 v1 §1

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function shouldUseSecureCookie(appEnv) {
  // __Host- exige Secure + contexto realmente HTTPS -- en development
  // local (HTTP plano) el navegador simplemente descartaría el cookie si
  // se marcara Secure/__Host-, rompiendo las pruebas locales. Mismo
  // criterio que server/security/recoveryCookie.js (CatastroX).
  return appEnv === 'production' || appEnv === 'staging';
}

/**
 * Nombre exacto de la cookie de sesión, condicionado al ambiente --
 * decisión técnica DISTINTA del diseño aprobado literal (que fijaba
 * `__Host-agx_session` sin condición): el prefijo `__Host-` exige Secure
 * true SIEMPRE, y un navegador real rechaza fijar esa cookie sobre HTTP
 * plano -- rompería development/test. Reportado explícitamente como
 * desviación en el informe de entrega de este lote.
 */
export function sessionCookieName(appEnv) {
  return shouldUseSecureCookie(appEnv) ? '__Host-agx_session' : 'agx_session';
}

export function generateSessionSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionSecret(rawSecret) {
  return crypto.createHash('sha256').update(String(rawSecret), 'utf8').digest('hex');
}

function sessionCookieAttributes(appEnv, maxAgeSeconds) {
  const attrs = [`Max-Age=${maxAgeSeconds}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (shouldUseSecureCookie(appEnv)) attrs.push('Secure');
  return attrs;
}

export function buildSessionSetCookieHeader(rawSecret, appEnv) {
  const name = sessionCookieName(appEnv);
  return [`${name}=${rawSecret}`, ...sessionCookieAttributes(appEnv, SESSION_TTL_SECONDS)].join('; ');
}

export function buildSessionClearCookieHeader(appEnv) {
  const name = sessionCookieName(appEnv);
  return [`${name}=`, ...sessionCookieAttributes(appEnv, 0)].join('; ');
}

/**
 * Parser manual, sin `cookie-parser` -- mismo criterio que
 * recoveryCookie.js de CatastroX, pero implementado de forma
 * independiente (aislamiento explícito de este módulo).
 */
export function getSessionRawTokenFromCookieHeader(cookieHeader, appEnv) {
  if (!cookieHeader) return null;
  const name = sessionCookieName(appEnv);

  for (const pair of String(cookieHeader).split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = pair.slice(0, separatorIndex).trim();
    if (key !== name) continue;

    const rawValue = pair.slice(separatorIndex + 1).trim();
    return rawValue || null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// CSRF (BFF-001 v2/v3): token derivado, sin persistencia. Ver diseño
// aprobado -- csrfToken = base64url(HMAC-SHA256(AGX_CSRF_SERVER_SECRET,
// rawSessionCookie)). `agx.sesiones.csrf_secret_hash` queda sin uso.
// ---------------------------------------------------------------------------

export function computeCsrfToken(rawSessionToken, csrfServerSecretBase64) {
  const keyBytes = Buffer.from(csrfServerSecretBase64, 'base64');
  return crypto.createHmac('sha256', keyBytes).update(String(rawSessionToken), 'utf8').digest('base64url');
}

export function validateCsrfToken(rawSessionToken, providedToken, csrfServerSecretBase64) {
  if (!isNonEmptyString(providedToken)) return false;

  const expected = computeCsrfToken(rawSessionToken, csrfServerSecretBase64);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(providedToken, 'utf8');

  // timingSafeEqual lanza si las longitudes difieren -- se trata como "no
  // coincide", nunca como error 500 (el 99.9% de los intentos inválidos
  // tendrá longitud distinta, así que este chequeo previo es lo esperado).
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

// ---------------------------------------------------------------------------
// Política Origin/Referer (ADR-009 §11.1, catálogo cerrado)
// ---------------------------------------------------------------------------

export function isRequestOriginValid(req, allowedOrigins) {
  const origin = req.headers.origin;

  if (isNonEmptyString(origin)) {
    if (origin === 'null') return false;
    return isOriginAllowed({ allowedOrigins }, origin);
  }

  const referer = req.headers.referer;
  if (isNonEmptyString(referer)) {
    let refererOrigin;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      return false;
    }
    return (allowedOrigins || []).includes(refererOrigin);
  }

  // Ausencia de ambos -- rechazo por defecto, nunca aceptación implícita.
  return false;
}

// ---------------------------------------------------------------------------
// Resolución de identidad / tenant (agx_auth, rol A)
// ---------------------------------------------------------------------------

/**
 * Identidad de sesión, SIN exigir organización (Arquitectura B). Válida
 * si: la fila existe, no está revocada, no expiró, y la cuenta está
 * activa. Modelo 1: los triggers ya validados en ACCESO-001 fijan
 * `fecha_revocacion` ante membresía/organización/cuenta inválida -- esta
 * consulta ya captura esos tres casos sin necesidad de repetir la lógica.
 */
export async function resolveSessionIdentity(rawToken) {
  const hash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `select s.sesion_id, s.cuenta_id, s.organizacion_id, s.fecha_expiracion, s.fecha_revocacion,
            c.estado as cuenta_estado, c.email, c.nombre
       from agx.sesiones s
       join agx.cuentas c on c.cuenta_id = s.cuenta_id
      where s.token_hash = $1`,
    [hash],
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.fecha_revocacion !== null) return null;
  if (!(new Date(row.fecha_expiracion).getTime() > Date.now())) return null;
  if (row.cuenta_estado !== 'activa') return null;

  return {
    sesionId: row.sesion_id,
    cuentaId: row.cuenta_id,
    organizacionId: row.organizacion_id,
    email: row.email,
    nombre: row.nombre,
  };
}

/**
 * Cadena completa (sesión + cuenta + membresía + organización, las 4
 * ya validadas en ACCESO-001 vía agx.fn_resolver_autorizacion_sesion).
 * Solo debe llamarse cuando resolveSessionIdentity() ya fue válida y
 * organizacionId no es null.
 */
export async function resolveTenantAuthorization(rawToken) {
  const hash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool();
  const result = await pool.query('select * from agx.fn_resolver_autorizacion_sesion($1)', [hash]);

  const row = result.rows[0];
  if (!row) return null;

  return {
    sesionId: row.sesion_id,
    cuentaId: row.cuenta_id,
    organizacionId: row.organizacion_id,
    rol: row.rol,
  };
}

export async function listOrganizacionesDisponibles(cuentaId) {
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `select m.organizacion_id, m.rol, o.nombre
       from agx.membresias m
       join agx.organizaciones o on o.organizacion_id = m.organizacion_id
      where m.cuenta_id = $1 and m.estado = 'activa' and o.estado = 'activa'
      order by o.nombre`,
    [cuentaId],
  );

  return result.rows.map((row) => ({ organizacionId: row.organizacion_id, rol: row.rol, nombre: row.nombre }));
}

// AGX-ADMIN-001: identidad interna CRH -- completamente independiente de
// membresías/organizaciones (una cuenta staff_crh nunca se asigna
// automáticamente a un tenant). Auditado: MODEL GAP confirmado y
// aprobado explícitamente -- rol_interno='administrador_plataforma' es
// el valor real ya existente en staff_crh (CHECK constraint) que se
// mapea a la etiqueta 'super_admin' expuesta al frontend, sin ningún
// cambio de esquema (DDL) en este lote. soporte/operaciones se exponen
// tal cual -- sin comportamiento nuevo definido para ellos todavía.
export async function resolveInternalRole(cuentaId) {
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `select rol_interno from agx.staff_crh where cuenta_id = $1 and estado = 'activo'`,
    [cuentaId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.rol_interno === 'administrador_plataforma' ? 'super_admin' : row.rol_interno;
}

export async function isMembresiaActivaParaOrganizacion(cuentaId, organizacionId) {
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `select m.rol
       from agx.membresias m
       join agx.organizaciones o on o.organizacion_id = m.organizacion_id
      where m.cuenta_id = $1 and m.organizacion_id = $2
        and m.estado = 'activa' and o.estado = 'activa'`,
    [cuentaId, organizacionId],
  );

  const row = result.rows[0];
  return row ? { rol: row.rol } : null;
}

export async function setOrganizacionActiva(sesionId, organizacionId) {
  const pool = getAgxAuthPool();
  await pool.query('update agx.sesiones set organizacion_id = $1 where sesion_id = $2', [organizacionId, sesionId]);
}

export async function revokeSession(sesionId) {
  const pool = getAgxAuthPool();
  await pool.query(
    'update agx.sesiones set fecha_revocacion = now() where sesion_id = $1 and fecha_revocacion is null',
    [sesionId],
  );
}

/**
 * AUTH-RECOVERY-002 §12: revoca TODAS las sesiones activas de una cuenta
 * de una sola vez -- usada al completar un reset de contraseña, para que
 * una sesión robada no sobreviva a que el dueño real recupere el control
 * de su cuenta. Debe invocarse dentro de la misma transacción que cambia
 * `password_hash` (acepta `client`, mismo patrón que el resto de este
 * módulo). No confundir con `revokeSession` (una sola fila por
 * `sesion_id`) ni con `revokeSessionByTokenHash` (una sola fila por
 * `token_hash`, protección de session fixation en login).
 */
export async function revokeAllSessionsForCuenta(client, cuentaId) {
  await client.query('update agx.sesiones set fecha_revocacion = now() where cuenta_id = $1 and fecha_revocacion is null', [
    cuentaId,
  ]);
}

// ---------------------------------------------------------------------------
// AUTH-001 (aprobado v2.2): login real (password propio) + establecimiento
// de contraseña inicial/reset. Sustituye por completo el stub de
// desarrollo -- sin ninguna rama de bypass, ni siquiera detrás de un flag
// de ambiente. Desarrollo local usa cuentas seed con password Argon2id
// real, exactamente el mismo endpoint que producción.
// ---------------------------------------------------------------------------

/**
 * Localiza una cuenta por su email normalizado para el flujo de login --
 * a diferencia de las demás funciones de este módulo, SÍ devuelve
 * `password_hash` (necesario para verificarlo) y `estado` sin filtrar
 * (la decisión de aceptar/rechazar la toma el llamador, para poder
 * auditar la causa real internamente sin filtrarla en la respuesta
 * externa). Usa `email_normalizado` -- la columna generada, misma
 * normalización que `normalizeEmail()` -- para poder usar su índice
 * único.
 */
export async function findCuentaParaLogin(emailNormalizado) {
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `select cuenta_id, email, nombre, estado, password_hash
       from agx.cuentas
      where email_normalizado = $1`,
    [emailNormalizado],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    cuentaId: row.cuenta_id,
    email: row.email,
    nombre: row.nombre,
    estado: row.estado,
    passwordHash: row.password_hash,
  };
}

/**
 * Revalidación dentro de `BEGIN` (AUTH-001, condición final A): cierra la
 * carrera entre "Argon2 verificó un hash fuera de la transacción" y
 * "mientras tanto la cuenta se desactivó o el password_hash cambió".
 * `FOR SHARE` serializa correctamente contra cualquier `UPDATE` admin
 * concurrente sobre la misma fila. Compara el `password_hash` EXACTO ya
 * verificado -- nunca solo `IS NOT NULL` -- y nunca vuelve a invocar
 * Argon2 aquí.
 */
export async function revalidateCuentaActivaConHash(client, cuentaId, passwordHashVerificado) {
  const result = await client.query(
    `select cuenta_id
       from agx.cuentas
      where cuenta_id = $1 and estado = 'activa' and password_hash = $2
      for share`,
    [cuentaId, passwordHashVerificado],
  );
  return result.rows.length === 1;
}

/**
 * Revoca por `token_hash` sin necesidad de resolverlo primero -- si el
 * hash no existe o ya estaba revocado, es un no-op seguro (WHERE no
 * matchea ninguna fila). Usada por login para invalidar cualquier sesión
 * previa asociada a la cookie entrante (protección de session fixation).
 */
export async function revokeSessionByTokenHash(client, tokenHash) {
  await client.query(
    'update agx.sesiones set fecha_revocacion = now() where token_hash = $1 and fecha_revocacion is null',
    [tokenHash],
  );
}

/** Crea la sesión nueva dentro de la transacción de login -- siempre organizacion_id NULL (Arquitectura B). */
export async function createSession(client, cuentaId, tokenHash) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await client.query(
    'insert into agx.sesiones (cuenta_id, organizacion_id, token_hash, fecha_expiracion) values ($1, NULL, $2, $3)',
    [cuentaId, tokenHash, expiresAt.toISOString()],
  );
}

/**
 * Auditoría de seguridad (agx.eventos_seguridad_auth) -- acepta un
 * `client` transaccional opcional (mismo patrón `runner = client || pool`
 * que `insertDynamic`/`updateDynamic` de server/db.js): dentro de
 * `withAuthTransaction` para LOGIN_SUCCESS/PASSWORD_SET_INITIAL/
 * PASSWORD_RESET_SUCCESS (deben confirmarse o revertirse junto con la
 * escritura principal), suelto para LOGIN_FAILURE/ACCOUNT_THROTTLED (una
 * sola sentencia, atómica por sí misma, sin escritura hermana con la que
 * deba mantenerse consistente).
 */
export async function recordSecurityEvent(
  { tipo, cuentaId = null, emailFingerprint, ipFingerprint = null, motivo = null },
  client = null,
) {
  const runner = client || getAgxAuthPool();
  await runner.query(
    `insert into agx.eventos_seguridad_auth (tipo, cuenta_id, email_fingerprint, ip_fingerprint, motivo)
     values ($1, $2, $3, $4, $5)`,
    [tipo, cuentaId, emailFingerprint, ipFingerprint, motivo],
  );
}

/**
 * Lectura de solo optimización (nunca la frontera de validez) para
 * `POST /password/set` -- permite descartar rápido un token obviamente
 * muerto antes de gastar Argon2, y provee `email`/`nombre` para
 * `validatePasswordPolicy`. La frontera real de validez/single-use es
 * `consumeResetToken()`.
 */
export async function findResetTokenForPrecheck(tokenHash) {
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `select crt.cuenta_id, crt.fecha_uso, crt.fecha_expiracion, c.email, c.nombre
       from agx.credenciales_reset_tokens crt
       join agx.cuentas c on c.cuenta_id = crt.cuenta_id
      where crt.token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    cuentaId: row.cuenta_id,
    fechaUso: row.fecha_uso,
    fechaExpiracion: row.fecha_expiracion,
    email: row.email,
    nombre: row.nombre,
  };
}

/**
 * Consumo atómico de un solo uso (AUTH-001, condición final B) -- la
 * expiración se decide DENTRO de este `UPDATE`, no en la lectura previa.
 * `rowCount === 0` cubre uso previo, expiración, inexistencia y pérdida
 * de una carrera concurrente, todo con la misma respuesta externa.
 */
export async function consumeResetToken(client, tokenHash) {
  const result = await client.query(
    `update agx.credenciales_reset_tokens
        set fecha_uso = now()
      where token_hash = $1 and fecha_uso is null and fecha_expiracion > now()
      returning cuenta_id, proposito`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? { cuentaId: row.cuenta_id, proposito: row.proposito } : null;
}

// AUTH-RECOVERY-002 §5: modelo ya soporta esto sin DDL --
// `credenciales_reset_tokens.proposito` ya permite 'reset' desde AUTH-001.
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 60; // 60 minutos, §6 aprobado

/**
 * §6: crea un token de recuperación de un solo uso. El token PLANO solo
 * se devuelve al llamador de esta función (para construir el enlace del
 * correo) -- únicamente su hash SHA-256 (mismo algoritmo que
 * hashSessionSecret, reutilizado aquí a propósito, no un segundo
 * mecanismo de hashing) se persiste. Nunca se loguea el token plano.
 * Debe invocarse dentro de una transacción (`client`), típicamente
 * después de `invalidateActiveResetTokensForCuenta` en la misma
 * transacción -- §6: "solo el último enlace de recuperación debe
 * permanecer válido".
 *
 * @param {import('pg').PoolClient} client
 * @param {string} cuentaId
 * @param {'establecer_inicial'|'reset'} proposito
 * @returns {Promise<string>} rawToken
 */
export async function createResetToken(client, cuentaId, proposito) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const fechaExpiracion = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);

  await client.query(
    `insert into agx.credenciales_reset_tokens (cuenta_id, token_hash, proposito, fecha_expiracion)
     values ($1, $2, $3, $4)`,
    [cuentaId, tokenHash, proposito, fechaExpiracion.toISOString()],
  );

  return rawToken;
}

/**
 * §6: invalida cualquier token 'reset' previo de esta cuenta que todavía
 * fuera utilizable (no usado, no expirado) -- sin DDL, reutilizando el
 * mismo mecanismo de single-use ya existente: marcar `fecha_uso` hace que
 * `consumeResetToken()` los rechace exactamente igual que un token ya
 * consumido (misma respuesta externa, INVALID_TOKEN). Debe llamarse
 * ANTES de `createResetToken` dentro de la misma transacción, para que
 * "solicitar un nuevo enlace" invalide atómicamente cualquier enlace
 * anterior todavía vivo.
 */
export async function invalidateActiveResetTokensForCuenta(client, cuentaId, proposito) {
  await client.query(
    `update agx.credenciales_reset_tokens
        set fecha_uso = now()
      where cuenta_id = $1 and proposito = $2 and fecha_uso is null and fecha_expiracion > now()`,
    [cuentaId, proposito],
  );
}

export async function setPasswordHash(client, cuentaId, passwordHashNuevo) {
  await client.query('update agx.cuentas set password_hash = $1, password_changed_at = now() where cuenta_id = $2', [
    passwordHashNuevo,
    cuentaId,
  ]);
}

// ---------------------------------------------------------------------------
// Middlewares Express
// ---------------------------------------------------------------------------

/**
 * Helper interno compartido -- NUNCA exportado. Evita la composición vía
 * callback `next` entre dos middlewares async (fuente de un bug real
 * detectado en pruebas: encadenar `requireIdentity(req, res, asyncNext)`
 * sin `await` deja que la promesa externa se resuelva antes de que el
 * trabajo async interno termine). Cada middleware hace su propio
 * `await` lineal sobre esta función.
 */
async function resolveIdentityForRequest(req, appEnv) {
  const rawToken = getSessionRawTokenFromCookieHeader(req.headers.cookie, appEnv);
  if (!rawToken) return { status: 401, error: 'SESSION_REQUIRED' };

  const identity = await resolveSessionIdentity(rawToken);
  if (!identity) return { status: 401, error: 'SESSION_INVALID' };

  return { identity: { ...identity, rawToken } };
}

/** Solo exige identidad de sesión -- no exige organización elegida. */
export function createRequireGanaderiaIdentity({ appEnv } = {}) {
  return async function requireGanaderiaIdentity(req, res, next) {
    try {
      const result = await resolveIdentityForRequest(req, appEnv);
      if (result.status) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      req.ganaderiaAuth = result.identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Exige identidad Y tenant resuelto -- para rutas de negocio futuras (no
 * usada por los 4 endpoints de BFF-001). Modelo 1: si `organizacion_id`
 * está fijado pero `resolveTenantAuthorization` igual falla (ventana de
 * carrera con la revocación por trigger), se trata como sesión inválida
 * (401) -- nunca se degrada a "tenant-less pero autenticada".
 */
export function createRequireGanaderiaSession({ appEnv } = {}) {
  return async function requireGanaderiaSession(req, res, next) {
    try {
      const result = await resolveIdentityForRequest(req, appEnv);
      if (result.status) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      const identity = result.identity;
      if (!identity.organizacionId) {
        res.status(409).json({ error: 'ORGANIZATION_REQUIRED' });
        return;
      }

      const tenant = await resolveTenantAuthorization(identity.rawToken);
      if (!tenant) {
        res.status(401).json({ error: 'SESSION_INVALID' });
        return;
      }

      req.ganaderiaAuth = { ...identity, organizacionId: tenant.organizacionId, rol: tenant.rol };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createRequireGanaderiaRole(...allowedRoles) {
  return function requireGanaderiaRole(req, res, next) {
    if (!req.ganaderiaAuth?.rol || !allowedRoles.includes(req.ganaderiaAuth.rol)) {
      res.status(403).json({ error: 'ROLE_FORBIDDEN' });
      return;
    }
    next();
  };
}

/**
 * Debe montarse DESPUÉS de requireGanaderiaIdentity/requireGanaderiaSession
 * en rutas mutantes. GET/HEAD/OPTIONS nunca pasan por esta validación.
 */
export function createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins } = {}) {
  return function requireGanaderiaCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase())) {
      next();
      return;
    }

    if (!req.ganaderiaAuth?.rawToken) {
      res.status(401).json({ error: 'SESSION_REQUIRED' });
      return;
    }

    if (!isRequestOriginValid(req, allowedOrigins)) {
      res.status(403).json({ error: 'ORIGIN_INVALID' });
      return;
    }

    const header = req.get('X-CSRF-Token');
    if (!isNonEmptyString(header)) {
      res.status(403).json({ error: 'CSRF_REQUIRED' });
      return;
    }

    if (!validateCsrfToken(req.ganaderiaAuth.rawToken, header, csrfServerSecret)) {
      res.status(403).json({ error: 'CSRF_INVALID' });
      return;
    }

    next();
  };
}
