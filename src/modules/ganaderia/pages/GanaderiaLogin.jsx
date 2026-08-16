// AUTH-FRONT-001: ruta PÚBLICA /ganaderia/login. Layout propio y aislado
// (NUNCA GanaderiaShell/GanaderiaSidebar, el layout operativo privado --
// ver §4/§12). Sin registro/signup (§5, cuentas provisionadas por
// AgroGenomaX/CRH). Consume POST /api/ganaderia/auth/login exactamente
// como está definido hoy (server/routes/ganaderiaAuth.js, NO modificado
// aquí) -- same-origin, cookie HttpOnly manejada por el navegador, sin
// localStorage/sessionStorage (§6).
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useGanaderiaAuth } from '../auth/GanaderiaAuthContext.jsx';
import '../styles/ganaderia-login.css';

const GENERIC_CREDENTIALS_MESSAGE = 'Correo o contraseña incorrectos.';
const GENERIC_NETWORK_MESSAGE = 'No fue posible conectar con el servicio. Intenta nuevamente.';

// §7: la semántica del backend se preserva -- ningún código de error real
// (cuenta_no_encontrada, sin_password, password_incorrecta, cuenta_inactiva)
// se expone nunca en el mensaje. 401 siempre es el mismo texto genérico.
function resolveErrorMessage(status) {
  if (status === 401) return GENERIC_CREDENTIALS_MESSAGE;
  if (status === 429) return 'Demasiados intentos. Espera un momento antes de volver a intentarlo.';
  if (status === 400) return 'Ingresa tu correo y contraseña.';
  return GENERIC_NETWORK_MESSAGE;
}

export default function GanaderiaLogin() {
  const { status, rolInterno, refresh } = useGanaderiaAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // §11: usuario ya autenticado que visita /login -> redirect, solo
  // después de confirmar sesión real (nunca antes de que status deje de
  // ser 'loading'). AGX-ADMIN-001 §6: super_admin -> su propio shell
  // administrativo, nunca el dashboard cliente.
  if (status === 'authenticated' || status === 'authenticated_without_org') {
    if (rolInterno === 'super_admin') {
      return <Navigate to="/ganaderia/admin" replace />;
    }
    return <Navigate to="/ganaderia/dashboard" replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setErrorMessage('');
    setSubmitting(true);

    try {
      const response = await fetch('/api/ganaderia/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        setErrorMessage(resolveErrorMessage(response.status));
        setSubmitting(false);
        return;
      }

      const freshSession = await refresh();
      const destination = freshSession?.rolInterno === 'super_admin' ? '/ganaderia/admin' : '/ganaderia/dashboard';
      navigate(destination, { replace: true });
    } catch {
      setErrorMessage(GENERIC_NETWORK_MESSAGE);
      setSubmitting(false);
    }
  }

  return (
    <div className="gan-login-shell">
      <div className="gan-login-card">
        <h1 className="gan-login-title">AgroGenomaX Ganadería Inteligente</h1>
        <p className="gan-login-subtitle">Ingresa con tu cuenta para gestionar tu operación.</p>

        <form className="gan-login-form" onSubmit={handleSubmit}>
          <label className="gan-login-field">
            <span>Correo electrónico</span>
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="gan-login-field">
            <span>Contraseña</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {errorMessage ? (
            <p className="gan-login-error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <button type="submit" className="gan-login-submit" disabled={submitting}>
            {submitting ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>

        <div className="gan-login-links">
          <Link to="/ganaderia/recuperar-acceso">Recuperar acceso</Link>
          <Link to="/ganaderia/acceso">Volver a la pantalla de acceso</Link>
        </div>
      </div>
    </div>
  );
}
