// AUTH-RECOVERY-002 §11/§13: ruta PÚBLICA /ganaderia/restablecer-contrasena
// ?token=..., sin layout/sidebar privado (mismo criterio que /login y
// /recuperar-acceso). Reutiliza el endpoint YA existente y aprobado en
// AUTH-001, POST /api/ganaderia/auth/password/set -- NO se crea un
// endpoint paralelo. La validación de longitud aquí es solo UX: el
// backend (server/security/passwordPolicy.js) sigue siendo la única
// autoridad real. Sin auto-login en ningún caso (§11/§13).
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import '../styles/ganaderia-login.css';

const PASSWORD_MIN_LENGTH = 15;
const PASSWORD_MAX_LENGTH = 128;
const GENERIC_NETWORK_MESSAGE = 'No fue posible conectar con el servicio. Intenta nuevamente.';
const INVALID_TOKEN_MESSAGE = 'Este enlace de recuperación no es válido o ha expirado.';

function resolveClientValidationError(newPassword, confirmPassword) {
  if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
    return `La contraseña debe tener entre ${PASSWORD_MIN_LENGTH} y ${PASSWORD_MAX_LENGTH} caracteres.`;
  }
  if (newPassword !== confirmPassword) {
    return 'Las contraseñas no coinciden.';
  }
  return null;
}

async function resolveServerErrorMessage(response) {
  if (response.status === 401) return { message: INVALID_TOKEN_MESSAGE, invalidToken: true };
  try {
    const body = await response.json();
    if (body?.error && body.error.startsWith('PASSWORD_')) {
      return { message: `La contraseña no cumple los requisitos (${body.error}).`, invalidToken: false };
    }
  } catch {
    // sin cuerpo JSON útil -- se usa el mensaje genérico de red abajo.
  }
  return { message: GENERIC_NETWORK_MESSAGE, invalidToken: false };
}

export default function GanaderiaRestablecerContrasena() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [invalidToken, setInvalidToken] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setErrorMessage('');
    setInvalidToken(false);

    if (!token) {
      setInvalidToken(true);
      return;
    }

    const clientError = resolveClientValidationError(newPassword, confirmPassword);
    if (clientError) {
      setErrorMessage(clientError);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/ganaderia/auth/password/set', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });

      if (!response.ok) {
        const { message, invalidToken: tokenInvalido } = await resolveServerErrorMessage(response);
        if (tokenInvalido) {
          setInvalidToken(true);
        } else {
          setErrorMessage(message);
        }
        setSubmitting(false);
        return;
      }

      setSuccess(true);
      setSubmitting(false);
    } catch {
      setErrorMessage(GENERIC_NETWORK_MESSAGE);
      setSubmitting(false);
    }
  }

  if (!token || invalidToken) {
    return (
      <div className="gan-login-shell">
        <div className="gan-login-card">
          <h1 className="gan-login-title">Enlace no válido</h1>
          <p className="gan-login-error" role="alert">
            {INVALID_TOKEN_MESSAGE}
          </p>
          <div className="gan-login-links">
            <Link to="/ganaderia/recuperar-acceso">Solicitar un nuevo enlace</Link>
            <Link to="/ganaderia/login">Volver a iniciar sesión</Link>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="gan-login-shell">
        <div className="gan-login-card">
          <h1 className="gan-login-title">Contraseña actualizada</h1>
          <p className="gan-login-success" role="status">
            Tu contraseña se estableció correctamente. Ya puedes iniciar sesión con ella.
          </p>
          <div className="gan-login-links">
            <Link to="/ganaderia/login">Ir a iniciar sesión</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gan-login-shell">
      <div className="gan-login-card">
        <h1 className="gan-login-title">Establecer nueva contraseña</h1>
        <p className="gan-login-subtitle">Elige una nueva contraseña para tu cuenta.</p>

        <form className="gan-login-form" onSubmit={handleSubmit}>
          <label className="gan-login-field">
            <span>Nueva contraseña</span>
            <input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>

          <label className="gan-login-field">
            <span>Confirmar contraseña</span>
            <input
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>

          {errorMessage ? (
            <p className="gan-login-error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <button type="submit" className="gan-login-submit" disabled={submitting}>
            {submitting ? 'Guardando...' : 'Guardar nueva contraseña'}
          </button>
        </form>

        <div className="gan-login-links">
          <Link to="/ganaderia/login">Volver a iniciar sesión</Link>
        </div>
      </div>
    </div>
  );
}
