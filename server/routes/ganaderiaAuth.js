import { Router } from 'express';
import {
  buildSessionClearCookieHeader,
  buildSessionSetCookieHeader,
  computeCsrfToken,
  consumeResetToken,
  createRequireGanaderiaCsrf,
  createRequireGanaderiaIdentity,
  createResetToken,
  createSession,
  findCuentaParaLogin,
  findResetTokenForPrecheck,
  generateSessionSecret,
  getSessionRawTokenFromCookieHeader,
  hashSessionSecret,
  invalidateActiveResetTokensForCuenta,
  isMembresiaActivaParaOrganizacion,
  isRequestOriginValid,
  listOrganizacionesDisponibles,
  recordSecurityEvent,
  resolveInternalRole,
  resolveSessionIdentity,
  resolveTenantAuthorization,
  revalidateCuentaActivaConHash,
  revokeAllSessionsForCuenta,
  revokeSession,
  revokeSessionByTokenHash,
  setOrganizacionActiva,
  setPasswordHash,
} from '../security/ganaderiaSession.js';
import { checkAndIncrementRateLimit, clearEmailRateLimit } from '../security/authRateLimit.js';
import { computeFingerprint, normalizeEmail, normalizeIp } from '../security/authFingerprint.js';
import { getDummyHash, hashPassword, verifyPassword } from '../security/passwordHashing.js';
import { validatePasswordPolicy } from '../security/passwordPolicy.js';
import { withAuthTransaction } from '../db/agxAuthPool.js';
import { buildRestablecerContrasenaUrl, sendRecoveryEmail } from '../services/ganaderia/emailSender.js';

// BFF-001 (ADR-009, aprobado v3) + AUTH-001 (ADR-015, aprobado v2.2): 6
// endpoints reales. Aislado de cualquier router de negocio -- no importa
// nada de server/db.js ni de los routers de CatastroX. Nunca responde en
// `demo` (sin backend real que proteger, mismo criterio que el resto del
// repo).
//
// AUTH-001 reemplaza por completo el antiguo stub de desarrollo
// (`createDevStubSession`/dev-only `/login`, ya retirados de
// ganaderiaSession.js): /login y /password/set son los mismos en TODOS
// los ambientes, sin ninguna rama condicional de bypass. Desarrollo local
// usa cuentas seed con password Argon2id real -- el mismo endpoint que
// producción.

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Precondiciones compartidas por /login y /password/set -- ambos son
 * pre-sesión (no hay `req.ganaderiaAuth` todavía, por lo que
 * `createRequireGanaderiaCsrf` no aplica), pero igual deben exigir
 * Origin/Referer del catálogo cerrado y `Content-Type: application/json`
 * antes de tocar cualquier dato de body.
 */
function rejectIfPreSessionRequestInvalid(req, res, allowedOrigins) {
  if (!isRequestOriginValid(req, allowedOrigins)) {
    res.status(403).json({ error: 'ORIGIN_INVALID' });
    return true;
  }
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    return true;
  }
  return false;
}

/**
 * @param {{appEnv: string, csrfServerSecret?: string, fingerprintSecret?: string, allowedOrigins: readonly string[]}} options
 */
export default function createGanaderiaAuthRouter({ appEnv, csrfServerSecret, fingerprintSecret, allowedOrigins } = {}) {
  const router = Router();

  const requireIdentity = createRequireGanaderiaIdentity({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use((_req, res, next) => {
    if (appEnv === 'demo') {
      res.status(404).end();
      return;
    }
    next();
  });

  router.get('/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const rawToken = getSessionRawTokenFromCookieHeader(req.headers.cookie, appEnv);
      if (!rawToken) {
        res.json({ authenticated: false });
        return;
      }

      const identity = await resolveSessionIdentity(rawToken);
      if (!identity) {
        res.json({ authenticated: false });
        return;
      }

      const cuenta = { cuentaId: identity.cuentaId, email: identity.email, nombre: identity.nombre };

      // AGX-ADMIN-001: identidad interna resuelta ANTES de cualquier lógica
      // de organización/tenant -- una cuenta staff_crh nunca se asigna
      // automáticamente a un tenant, así que nunca debe caer en la rama
      // "sin organización" (que renderizaría OrganizacionRequerida en el
      // frontend). Backend-derived en su totalidad: el frontend nunca
      // consulta staff_crh, solo lee este campo ya resuelto.
      const rolInterno = await resolveInternalRole(identity.cuentaId);
      if (rolInterno) {
        res.json({
          authenticated: true,
          cuenta,
          tipoAcceso: 'interno',
          rolInterno,
          organizacionActiva: null,
          organizacionesDisponibles: [],
        });
        return;
      }

      const organizacionesDisponibles = await listOrganizacionesDisponibles(identity.cuentaId);

      if (!identity.organizacionId) {
        res.json({
          authenticated: true,
          cuenta,
          tipoAcceso: 'cliente',
          rolInterno: null,
          organizacionActiva: null,
          organizacionesDisponibles,
        });
        return;
      }

      // Modelo 1: si la organización estaba fijada pero la cadena completa
      // ya no resuelve (revocación en curso vía trigger), no se reporta
      // como "autenticado sin tenant" -- se reporta como no autenticado.
      const tenant = await resolveTenantAuthorization(rawToken);
      if (!tenant) {
        res.json({ authenticated: false });
        return;
      }

      const orgInfo = organizacionesDisponibles.find((org) => org.organizacionId === tenant.organizacionId) || null;
      res.json({
        authenticated: true,
        cuenta,
        tipoAcceso: 'cliente',
        rolInterno: null,
        organizacionActiva: { organizacionId: tenant.organizacionId, rol: tenant.rol, nombre: orgInfo?.nombre ?? null },
        organizacionesDisponibles,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/csrf', requireIdentity, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const csrfToken = computeCsrfToken(req.ganaderiaAuth.rawToken, csrfServerSecret);
    res.json({ csrfToken });
  });

  router.post('/logout', requireIdentity, requireCsrf, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await revokeSession(req.ganaderiaAuth.sesionId);
      res.setHeader('Set-Cookie', buildSessionClearCookieHeader(appEnv));
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/organizacion', requireIdentity, requireCsrf, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const organizacionId = req.body?.organizacionId;
      if (!isNonEmptyString(organizacionId)) {
        res.status(400).json({ error: 'ORGANIZATION_ID_REQUIRED' });
        return;
      }

      const membership = await isMembresiaActivaParaOrganizacion(req.ganaderiaAuth.cuentaId, organizacionId);
      if (!membership) {
        res.status(403).json({ error: 'ORGANIZATION_NOT_AUTHORIZED' });
        return;
      }

      await setOrganizacionActiva(req.ganaderiaAuth.sesionId, organizacionId);
      res.json({ ok: true, organizacionActiva: { organizacionId, rol: membership.rol } });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------------
  // AUTH-001 (ADR-015, aprobado v2.2): autenticación nativa AGX.
  // ---------------------------------------------------------------------

  router.post('/login', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (rejectIfPreSessionRequestInvalid(req, res, allowedOrigins)) return;

      const email = req.body?.email;
      const password = req.body?.password;
      if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
        res.status(400).json({ error: 'INVALID_CREDENTIALS_FORMAT' });
        return;
      }

      const emailNormalizado = normalizeEmail(email);
      const emailFingerprint = computeFingerprint('email', emailNormalizado, fingerprintSecret);
      const ipFingerprint = computeFingerprint('ip', normalizeIp(req.ip), fingerprintSecret);

      // Rate limit atómico Postgres -- ambas dimensiones, nunca
      // `SELECT count -> decisión -> INSERT`. Se evalúan las dos SIEMPRE
      // (nunca cortocircuito), para no filtrar por timing cuál disparó.
      const [emailLimit, ipLimit] = await Promise.all([
        checkAndIncrementRateLimit('email', emailFingerprint),
        checkAndIncrementRateLimit('ip', ipFingerprint),
      ]);

      if (emailLimit.throttled || ipLimit.throttled) {
        const retryAfterSeconds = Math.max(emailLimit.retryAfterSeconds ?? 0, ipLimit.retryAfterSeconds ?? 0) || 60;
        await recordSecurityEvent({
          tipo: 'ACCOUNT_THROTTLED',
          emailFingerprint,
          ipFingerprint,
          motivo: emailLimit.throttled ? 'rate_limit_email' : 'rate_limit_ip',
        });
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
        return;
      }

      const cuenta = await findCuentaParaLogin(emailNormalizado);

      // Argon2 SIEMPRE se ejecuta exactamente una vez -- contra el hash
      // real si existe, contra DUMMY_HASH si la cuenta no existe o no
      // tiene password_hash todavía. Mantiene el costo computacional (y
      // por tanto el tiempo de respuesta) uniforme entre "cuenta
      // inexistente"/"sin password"/"password incorrecta", cerrando el
      // canal de user enumeration por timing.
      const hashParaVerificar = cuenta?.passwordHash ?? (await getDummyHash());
      const passwordValida = await verifyPassword(hashParaVerificar, password);

      let motivoRechazo = null;
      if (!cuenta) motivoRechazo = 'cuenta_no_encontrada';
      else if (!cuenta.passwordHash) motivoRechazo = 'sin_password';
      else if (!passwordValida) motivoRechazo = 'password_incorrecta';
      else if (cuenta.estado !== 'activa') motivoRechazo = 'cuenta_inactiva';

      if (motivoRechazo) {
        await recordSecurityEvent({
          tipo: 'LOGIN_FAILURE',
          cuentaId: cuenta?.cuentaId ?? null,
          emailFingerprint,
          ipFingerprint,
          motivo: motivoRechazo,
        });
        res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        return;
      }

      const oldRawToken = getSessionRawTokenFromCookieHeader(req.headers.cookie, appEnv);
      const rawSessionToken = generateSessionSecret();
      const newTokenHash = hashSessionSecret(rawSessionToken);

      try {
        await withAuthTransaction(async (client) => {
          // Condición final A (aprobación AUTH-001 v2.2): revalida el
          // password_hash EXACTO ya verificado fuera de la transacción --
          // nunca vuelve a invocar Argon2 aquí. Cierra la carrera entre
          // "se verificó el hash A" y "mientras tanto cambió a hash B" o
          // "la cuenta se desactivó".
          const sigueActiva = await revalidateCuentaActivaConHash(client, cuenta.cuentaId, cuenta.passwordHash);
          if (!sigueActiva) {
            const raceError = new Error('CUENTA_NO_LONGER_VALID');
            raceError.code = 'CUENTA_NO_LONGER_VALID';
            throw raceError;
          }

          if (oldRawToken) {
            await revokeSessionByTokenHash(client, hashSessionSecret(oldRawToken));
          }
          await createSession(client, cuenta.cuentaId, newTokenHash);
          await clearEmailRateLimit(emailFingerprint, client);
          await recordSecurityEvent({ tipo: 'LOGIN_SUCCESS', cuentaId: cuenta.cuentaId, emailFingerprint, ipFingerprint }, client);
        });
      } catch (transactionError) {
        if (transactionError?.code === 'CUENTA_NO_LONGER_VALID') {
          await recordSecurityEvent({
            tipo: 'LOGIN_FAILURE',
            cuentaId: cuenta.cuentaId,
            emailFingerprint,
            ipFingerprint,
            motivo: 'cuenta_invalidada_durante_login',
          });
          res.status(401).json({ error: 'INVALID_CREDENTIALS' });
          return;
        }
        throw transactionError;
      }

      res.setHeader('Set-Cookie', buildSessionSetCookieHeader(rawSessionToken, appEnv));
      res.json({
        authenticated: true,
        cuenta: { cuentaId: cuenta.cuentaId, email: cuenta.email, nombre: cuenta.nombre },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/password/set', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (rejectIfPreSessionRequestInvalid(req, res, allowedOrigins)) return;

      const token = req.body?.token;
      const newPassword = req.body?.newPassword;
      if (!isNonEmptyString(token) || !isNonEmptyString(newPassword)) {
        res.status(400).json({ error: 'INVALID_REQUEST_FORMAT' });
        return;
      }

      const tokenHash = hashSessionSecret(token);

      // Lectura de solo optimización -- descarta rápido un token
      // obviamente muerto antes de gastar Argon2. Nunca la frontera de
      // validez real (esa es consumeResetToken(), dentro de la
      // transacción, vía UPDATE...RETURNING atómico).
      const precheck = await findResetTokenForPrecheck(tokenHash);
      const precheckMuerto =
        !precheck || precheck.fechaUso !== null || new Date(precheck.fechaExpiracion).getTime() <= Date.now();
      if (precheckMuerto) {
        res.status(401).json({ error: 'INVALID_TOKEN' });
        return;
      }

      const emailNormalizado = normalizeEmail(precheck.email);
      const policyResult = validatePasswordPolicy(newPassword, { emailNormalizado, nombre: precheck.nombre });
      if (!policyResult.ok) {
        res.status(400).json({ error: policyResult.code });
        return;
      }

      // Argon2 SIEMPRE fuera de la transacción (mismo criterio que login
      // y que el contrato documentado de withAuthTransaction).
      const nuevoHash = await hashPassword(newPassword);
      const emailFingerprint = computeFingerprint('email', emailNormalizado, fingerprintSecret);

      let proposito = null;
      try {
        await withAuthTransaction(async (client) => {
          // Condición final B (aprobación AUTH-001 v2.2): la expiración se
          // decide DENTRO de este UPDATE, no en la lectura previa --
          // cierra la carrera de un token que expira/se consume entre el
          // precheck y este punto.
          const consumido = await consumeResetToken(client, tokenHash);
          if (!consumido) {
            const raceError = new Error('TOKEN_NO_LONGER_VALID');
            raceError.code = 'TOKEN_NO_LONGER_VALID';
            throw raceError;
          }

          await setPasswordHash(client, consumido.cuentaId, nuevoHash);
          proposito = consumido.proposito;
          const tipoEvento = proposito === 'establecer_inicial' ? 'PASSWORD_SET_INITIAL' : 'PASSWORD_RESET_SUCCESS';
          await recordSecurityEvent({ tipo: tipoEvento, cuentaId: consumido.cuentaId, emailFingerprint }, client);

          // AUTH-RECOVERY-002 §12: un reset (a diferencia de establecer_inicial,
          // que no tiene sesiones previas que proteger) invalida cualquier sesión
          // que pudiera haber quedado activa con la contraseña anterior.
          if (proposito === 'reset') {
            await revokeAllSessionsForCuenta(client, consumido.cuentaId);
            await recordSecurityEvent({ tipo: 'PASSWORD_CHANGED', cuentaId: consumido.cuentaId, emailFingerprint }, client);
          }
        });
      } catch (transactionError) {
        if (transactionError?.code === 'TOKEN_NO_LONGER_VALID') {
          res.status(401).json({ error: 'INVALID_TOKEN' });
          return;
        }
        throw transactionError;
      }

      // Sin auto-login -- el usuario debe iniciar sesión explícitamente
      // con la contraseña recién establecida, vía /login.
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // AUTH-RECOVERY-002 §3-8: respuesta SIEMPRE idéntica exista o no la
  // cuenta -- el único canal observable permitido es el rate limit (una
  // señal de volumen, no de existencia), con buckets propios separados de
  // /login vía dominio de fingerprint 'recovery_email'/'recovery_ip'.
  router.post('/recovery/request', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (rejectIfPreSessionRequestInvalid(req, res, allowedOrigins)) return;

      const email = req.body?.email;
      if (!isNonEmptyString(email)) {
        res.status(400).json({ error: 'INVALID_REQUEST_FORMAT' });
        return;
      }

      const emailNormalizado = normalizeEmail(email);
      const emailFingerprint = computeFingerprint('recovery_email', emailNormalizado, fingerprintSecret);
      const ipFingerprint = computeFingerprint('recovery_ip', normalizeIp(req.ip), fingerprintSecret);

      const [emailLimit, ipLimit] = await Promise.all([
        checkAndIncrementRateLimit('email', emailFingerprint),
        checkAndIncrementRateLimit('ip', ipFingerprint),
      ]);

      if (emailLimit.throttled || ipLimit.throttled) {
        const retryAfterSeconds = Math.max(emailLimit.retryAfterSeconds ?? 0, ipLimit.retryAfterSeconds ?? 0) || 60;
        await recordSecurityEvent({
          tipo: 'ACCOUNT_THROTTLED',
          emailFingerprint,
          ipFingerprint,
          motivo: emailLimit.throttled ? 'rate_limit_email' : 'rate_limit_ip',
        });
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
        return;
      }

      const cuenta = await findCuentaParaLogin(emailNormalizado);

      let rawToken = null;
      if (cuenta && cuenta.estado === 'activa') {
        await withAuthTransaction(async (client) => {
          await invalidateActiveResetTokensForCuenta(client, cuenta.cuentaId, 'reset');
          rawToken = await createResetToken(client, cuenta.cuentaId, 'reset');
          await recordSecurityEvent({ tipo: 'PASSWORD_RESET_REQUEST', cuentaId: cuenta.cuentaId, emailFingerprint, ipFingerprint }, client);
        });
      } else {
        await recordSecurityEvent({
          tipo: 'PASSWORD_RESET_REQUEST',
          cuentaId: cuenta?.cuentaId ?? null,
          emailFingerprint,
          ipFingerprint,
          motivo: cuenta ? 'cuenta_inactiva' : 'cuenta_no_encontrada',
        });
      }

      // Envío best-effort DESPUÉS de confirmar la transacción -- I/O externo
      // nunca dentro de withAuthTransaction (mismo criterio que Argon2 en
      // /login y /password/set). Cualquier fallo se registra internamente y
      // jamás cambia la respuesta pública.
      if (rawToken) {
        const recoveryUrl = buildRestablecerContrasenaUrl(rawToken, appEnv);
        if (recoveryUrl) {
          try {
            await sendRecoveryEmail({ to: cuenta.email, recoveryUrl });
          } catch (sendError) {
            console.error('[Ganaderia Recovery] envío fallido', { errorCode: sendError?.code ?? 'UNKNOWN' });
          }
        } else {
          console.error('[Ganaderia Recovery] no se pudo resolver origin público', { appEnv });
        }
      }

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
