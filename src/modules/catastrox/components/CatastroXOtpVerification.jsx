import { useEffect, useRef, useState } from 'react';
import { getRuntimeConfig } from '../../../config/runtimeConfig.js';

const RESEND_COOLDOWN_SECONDS = 30;

const ERROR_COPY = {
  CODE_EXPIRED: {
    title: 'Código vencido',
    message: 'El código ya expiró. Solicite uno nuevo para continuar.',
  },
  CODE_MISMATCH: {
    title: 'Código inválido',
    message: 'El código ingresado no es correcto. Verifique e intente de nuevo.',
  },
  TOO_MANY_ATTEMPTS: {
    title: 'Demasiados intentos',
    message: 'Se agotaron los intentos para este código. Solicite uno nuevo.',
  },
  NETWORK_ERROR: {
    title: 'Error temporal',
    message: 'No fue posible comunicarse con el servidor. Intente nuevamente en unos segundos.',
  },
  EMAIL_VERIFICATION_ERROR: {
    title: 'Error temporal',
    message: 'No fue posible verificar el código en este momento. Intente nuevamente.',
  },
};

/**
 * Verificación de correo por OTP (Bloque 4 del pedido). El código nunca se
 * guarda en localStorage/sessionStorage -- vive solo en un input tipo
 * password mientras el usuario lo escribe, y se limpia del estado
 * inmediatamente después de un intento (exitoso o no).
 */
export default function CatastroXOtpVerification({
  maskedEmail,
  devOtpCode = null,
  onVerify,
  onResend,
  onCancel,
  onVerified,
}) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('sent'); // sent | verifying | verified | error
  const [errorCode, setErrorCode] = useState(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);
  const cooldownTimerRef = useRef(null);
  const { appEnv } = getRuntimeConfig();
  const isDevEnvironment = appEnv === 'development' || appEnv === 'test';

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) window.clearInterval(cooldownTimerRef.current);
    };
  }, []);

  function startCooldown() {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownTimerRef.current) window.clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = window.setInterval(() => {
      setResendCooldown((current) => {
        if (current <= 1) {
          window.clearInterval(cooldownTimerRef.current);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  }

  useEffect(() => {
    startCooldown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleVerify(event) {
    event.preventDefault();
    if (!code.trim()) return;

    setStatus('verifying');
    setErrorCode(null);

    const result = await onVerify(code.trim());

    // El código se descarta del estado inmediatamente después del intento,
    // exitoso o no -- nunca queda expuesto en el formulario más de lo
    // necesario para el POST que ya se envió.
    setCode('');

    if (result?.ok) {
      setStatus('verified');
      onVerified?.();
      return;
    }

    setStatus('error');
    setErrorCode(result?.code || 'EMAIL_VERIFICATION_ERROR');
  }

  async function handleResend() {
    if (resendCooldown > 0 || isResending) return;
    setIsResending(true);
    setErrorCode(null);
    await onResend();
    setIsResending(false);
    setStatus('sent');
    startCooldown();
  }

  const errorCopy = errorCode ? ERROR_COPY[errorCode] || ERROR_COPY.EMAIL_VERIFICATION_ERROR : null;

  return (
    <form className="catastrox-card catastrox-form" onSubmit={handleVerify}>
      <div className="catastrox-section-heading">
        <span>Verificación de correo</span>
        <h2>Ingrese el código enviado a {maskedEmail}</h2>
      </div>

      {status === 'verified' ? (
        <div className="catastrox-success is-full">
          <strong>Correo verificado</strong>
          <span>Su correo quedó confirmado. Puede continuar con la compra.</span>
        </div>
      ) : (
        <>
          <label className="catastrox-field is-full">
            <span>Código de verificación</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              disabled={status === 'verifying'}
            />
          </label>

          {/* Bloque 4 (revisión de seguridad): triple barrera, no una sola.
              1) el backend nunca envía devOtpCode fuera de development/test
              (server/routes/catastroxPayments.js); 2) isDevEnvironment
              vuelve a comprobarlo en runtime contra VITE_APP_ENV;
              3) !import.meta.env.PROD es una constante de COMPILACIÓN de
              Vite (true en cualquier `vite build`, sin importar el modo/
              ambiente de destino) -- al ser una constante, el minificador
              elimina esta rama completa (incluido el texto "SOLO
              DESARROLLO") de CUALQUIER build empaquetado, dejándola viva
              únicamente bajo `vite dev` en la máquina del desarrollador.
              Ver src/modules/catastrox/utils/__tests__/prodBuildOtpLeak.test.js. */}
          {!import.meta.env.PROD && isDevEnvironment && devOtpCode ? (
            <div className="catastrox-inline-panel is-full catastrox-dev-only-panel">
              <strong>SOLO DESARROLLO</strong>
              <span>Código de prueba (nunca disponible en producción): {devOtpCode}</span>
            </div>
          ) : null}

          {errorCopy ? (
            <div className="catastrox-inline-panel is-full">
              <strong>{errorCopy.title}</strong>
              <span>{errorCopy.message}</span>
            </div>
          ) : null}

          {status === 'sent' && !errorCopy ? (
            // Bloque 2 (revisión de seguridad): nunca afirmar "código
            // enviado" en development/test -- emailSender.js sigue siendo
            // un stub sin proveedor conectado (mode:'stub'), así que
            // ningún correo real salió. La presencia de devOtpCode es
            // exactamente la señal de "no hubo entrega real" (el backend
            // solo lo incluye en esa condición, ver catastroxPayments.js).
            isDevEnvironment && devOtpCode ? (
              <div className="catastrox-inline-panel is-full">
                <strong>Modo de desarrollo</strong>
                <span>No hay proveedor de correo conectado. Use el código de prueba mostrado.</span>
              </div>
            ) : (
              <div className="catastrox-inline-panel is-full">
                <strong>Código enviado</strong>
                <span>Revise su bandeja de entrada (y spam) e ingrese el código de 6 dígitos.</span>
              </div>
            )
          ) : null}

          <div className="catastrox-action-row is-full">
            <button type="submit" className="catastrox-button" disabled={status === 'verifying' || code.trim().length < 4}>
              {status === 'verifying' ? 'Verificando...' : 'Verificar código'}
            </button>
            <button
              type="button"
              className="catastrox-button is-secondary"
              onClick={handleResend}
              disabled={resendCooldown > 0 || isResending}
            >
              {isResending ? 'Reenviando...' : resendCooldown > 0 ? `Reenviar código (${resendCooldown}s)` : 'Reenviar código'}
            </button>
            <button type="button" className="catastrox-button is-ghost" onClick={onCancel} disabled={status === 'verifying'}>
              Cancelar
            </button>
          </div>
        </>
      )}
    </form>
  );
}
