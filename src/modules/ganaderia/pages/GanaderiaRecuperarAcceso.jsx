// AUTH-RECOVERY-002 §10: ruta PÚBLICA /ganaderia/recuperar-acceso, sin
// layout/sidebar privado (mismo criterio de AUTH-FRONT-001 §13 que ya
// clasificaba esta ruta junto a /ganaderia/acceso y /ganaderia/login).
// Reemplaza el stub "reservado para fase posterior" -- consume el nuevo
// POST /api/ganaderia/auth/recovery/request. La respuesta del backend es
// SIEMPRE {ok:true} con el mismo mensaje genérico exista o no la cuenta
// (§3/§4) -- este formulario nunca intenta inferir ni mostrar si el correo
// existe.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/ganaderia-login.css';

const GENERIC_SUCCESS_MESSAGE =
  'Si existe una cuenta asociada a ese correo, te enviaremos instrucciones para recuperar el acceso.';
const GENERIC_NETWORK_MESSAGE = 'No fue posible conectar con el servicio. Intenta nuevamente.';

function resolveErrorMessage(status) {
  if (status === 429) return 'Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.';
  if (status === 400) return 'Ingresa un correo electrónico.';
  return GENERIC_NETWORK_MESSAGE;
}

export default function GanaderiaRecuperarAcceso() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setErrorMessage('');
    setSubmitting(true);

    try {
      const response = await fetch('/api/ganaderia/auth/recovery/request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        setErrorMessage(resolveErrorMessage(response.status));
        setSubmitting(false);
        return;
      }

      setSubmitted(true);
      setSubmitting(false);
    } catch {
      setErrorMessage(GENERIC_NETWORK_MESSAGE);
      setSubmitting(false);
    }
  }

  return (
    <div className="gan-login-shell">
      <div className="gan-login-card">
        <h1 className="gan-login-title">Recuperar acceso</h1>
        <p className="gan-login-subtitle">
          Ingresa el correo de tu cuenta y te enviaremos instrucciones para establecer una nueva contraseña.
        </p>

        {submitted ? (
          <p className="gan-login-success" role="status">
            {GENERIC_SUCCESS_MESSAGE}
          </p>
        ) : (
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

            {errorMessage ? (
              <p className="gan-login-error" role="alert">
                {errorMessage}
              </p>
            ) : null}

            <button type="submit" className="gan-login-submit" disabled={submitting}>
              {submitting ? 'Enviando...' : 'Enviar enlace de recuperación'}
            </button>
          </form>
        )}

        <div className="gan-login-links">
          <Link to="/ganaderia/login">Volver a iniciar sesión</Link>
        </div>
      </div>
    </div>
  );
}
