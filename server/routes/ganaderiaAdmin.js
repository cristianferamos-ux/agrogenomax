import { Router } from 'express';
import {
  createCuentaProvisionada,
  createMembresiaOwner,
  createOrganizacion,
  createResetToken,
  createRequireGanaderiaCsrf,
  createRequireGanaderiaIdentity,
  createRequireGanaderiaSuperAdmin,
  findCuentaParaLogin,
} from '../security/ganaderiaSession.js';
import { withAuthTransaction } from '../db/agxAuthPool.js';
import { normalizeEmail } from '../security/authFingerprint.js';
import { buildRestablecerContrasenaUrl, sendActivationEmail } from '../services/ganaderia/emailSender.js';

// SPRINT-2-CLIENT-PROVISIONING: router administrativo AISLADO del router
// de auth (server/routes/ganaderiaAuth.js) -- provisiona la identidad
// digital inicial de un cliente (organización + cuenta + membresía owner
// + token establecer_inicial). Único endpoint hoy: POST /clientes. Exige
// identidad Y rol interno super_admin (nunca requireGanaderiaIdentity a
// solas) -- una cuenta cliente autenticada normal, o un rol interno
// distinto (soporte/operaciones), recibe 403.
//
// PRECONDICIÓN DE PRODUCCIÓN NO CUMPLIDA HOY (ver informe Sprint 2,
// sección N): agx_auth solo tiene SELECT en agx.organizaciones/
// agx.membresias y SELECT+UPDATE en agx.cuentas (confirmado por auditoría
// read-only contra Postgres-AGX producción) -- sin INSERT no puede
// completar esta transacción. db/agx/migrations/0002_client_provisioning_grants.sql
// diseña el grant mínimo adicional necesario; NO se aplicó a producción
// en este sprint (fuera de alcance explícito).

const MAX_NOMBRE_LENGTH = 200;
const MAX_IDENTIFICADOR_FISCAL_LENGTH = 60;
const EMAIL_ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateClienteInput(body) {
  const nombreOrganizacion = body?.nombreOrganizacion;
  const nombreResponsable = body?.nombreResponsable;
  const email = body?.email;
  const identificadorFiscal = body?.identificadorFiscal;

  if (!isNonEmptyString(nombreOrganizacion) || nombreOrganizacion.trim().length > MAX_NOMBRE_LENGTH) {
    return { error: 'INVALID_ORGANIZACION_NOMBRE' };
  }
  if (!isNonEmptyString(nombreResponsable) || nombreResponsable.trim().length > MAX_NOMBRE_LENGTH) {
    return { error: 'INVALID_RESPONSABLE_NOMBRE' };
  }
  if (!isNonEmptyString(email) || !EMAIL_ADDRESS_PATTERN.test(email.trim())) {
    return { error: 'INVALID_EMAIL' };
  }

  let identificadorFiscalNormalizado = null;
  if (identificadorFiscal !== undefined && identificadorFiscal !== null && identificadorFiscal !== '') {
    if (typeof identificadorFiscal !== 'string' || identificadorFiscal.trim().length > MAX_IDENTIFICADOR_FISCAL_LENGTH) {
      return { error: 'INVALID_IDENTIFICADOR_FISCAL' };
    }
    identificadorFiscalNormalizado = identificadorFiscal.trim();
  }

  return {
    value: {
      nombreOrganizacion: nombreOrganizacion.trim(),
      nombreResponsable: nombreResponsable.trim(),
      email: email.trim(),
      identificadorFiscal: identificadorFiscalNormalizado,
    },
  };
}

/**
 * @param {{appEnv: string, csrfServerSecret?: string, allowedOrigins: readonly string[],
 *   sendActivationEmailFn?: typeof sendActivationEmail, buildRestablecerContrasenaUrlFn?: typeof buildRestablecerContrasenaUrl}} options
 *
 * Los dos últimos parámetros son un punto de inyección exclusivamente para
 * pruebas (MICROAUDITORÍA §4: casos A/B/C requieren controlar
 * determinísticamente `delivered`/excepción sin depender de mocking de
 * módulos ESM) -- en producción SIEMPRE usan las implementaciones reales
 * (valor por defecto), nunca se pasa un override real.
 */
export default function createGanaderiaAdminRouter({
  appEnv,
  csrfServerSecret,
  allowedOrigins,
  sendActivationEmailFn = sendActivationEmail,
  buildRestablecerContrasenaUrlFn = buildRestablecerContrasenaUrl,
} = {}) {
  const router = Router();

  const requireIdentity = createRequireGanaderiaIdentity({ appEnv });
  const requireSuperAdmin = createRequireGanaderiaSuperAdmin();
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.post('/clientes', requireIdentity, requireSuperAdmin, requireCsrf, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const validation = validateClienteInput(req.body);
      if (validation.error) {
        res.status(400).json({ error: validation.error });
        return;
      }
      const { nombreOrganizacion, nombreResponsable, email, identificadorFiscal } = validation.value;

      const emailNormalizado = normalizeEmail(email);

      // Precheck -- mismo patrón que findCuentaParaLogin en /login. La
      // barrera real de unicidad es la restricción UNIQUE de
      // agx.cuentas.email_normalizado (23505, capturada abajo) -- este
      // precheck solo evita abrir una transacción innecesaria en el caso
      // común (sin condición de carrera).
      const existente = await findCuentaParaLogin(emailNormalizado);
      if (existente) {
        res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });
        return;
      }

      let organizacionId = null;
      let cuentaId = null;
      let rawToken = null;

      try {
        await withAuthTransaction(async (client) => {
          // organizacion_id/cuenta_id/membresia_id/token siempre
          // server-side -- el body nunca puede imponer rol, estado,
          // cuenta_id, organizacion_id ni password_hash (§12): estos 4
          // INSERT son los únicos que aceptan esos valores, y ninguno los
          // toma de req.body.
          organizacionId = await createOrganizacion(client, { nombre: nombreOrganizacion, identificadorFiscal });
          cuentaId = await createCuentaProvisionada(client, { email, emailNormalizado, nombre: nombreResponsable });
          await createMembresiaOwner(client, { cuentaId, organizacionId });
          rawToken = await createResetToken(client, cuentaId, 'establecer_inicial', req.ganaderiaAuth.cuentaId);
        });
      } catch (transactionError) {
        if (transactionError?.code === '23505') {
          res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });
          return;
        }
        throw transactionError;
      }

      // Envío best-effort DESPUÉS del COMMIT -- I/O externo nunca dentro
      // de withAuthTransaction (mismo criterio que POST /recovery/request).
      // MICROAUDITORÍA (caso B, DB OK + EMAIL FAIL): un fallo de envío
      // NUNCA revierte ni oculta la creación ya confirmada -- se expone
      // `emailDelivered` para que el superadmin sepa la verdad, sin
      // filtrar provider/errorCode/stack/token. `delivered` nace `false`
      // (fail-closed): solo pasa a `true` si sendActivationEmail confirmó
      // la entrega explícitamente.
      const activationUrl = buildRestablecerContrasenaUrlFn(rawToken, appEnv);
      let emailDelivered = false;
      if (activationUrl) {
        try {
          const emailResult = await sendActivationEmailFn({ to: email, activationUrl, nombre: nombreResponsable });
          emailDelivered = emailResult?.delivered === true;
          if (!emailDelivered) {
            console.error('[Ganaderia Admin] envío de activación no confirmado', { errorCode: emailResult?.errorCode ?? 'UNKNOWN' });
          }
        } catch (sendError) {
          console.error('[Ganaderia Admin] envío de activación falló', { errorCode: sendError?.code ?? 'UNKNOWN' });
        }
      } else {
        console.error('[Ganaderia Admin] no se pudo resolver origin público para el correo de activación', { appEnv });
      }

      res.status(201).json({ ok: true, organizacionId, cuentaId, emailDelivered });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
