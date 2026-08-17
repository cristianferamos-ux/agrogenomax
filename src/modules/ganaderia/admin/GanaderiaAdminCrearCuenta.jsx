// SPRINT-2-CLIENT-PROVISIONING: única pantalla funcional nueva del panel
// admin -- provisiona organización + cuenta + membresía owner + envía la
// activación. Reutiliza el patrón ya aprobado de GanaderiaRecuperarAcceso.jsx
// (submitting/error/success, sin doble submit) y el CSRF client ya
// existente (fetchCsrfToken, GanaderiaAuthContext.jsx). Nunca muestra el
// token de activación -- el backend nunca lo devuelve en la respuesta.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchCsrfToken } from '../auth/GanaderiaAuthContext.jsx';
import '../styles/ganaderia-admin.css';
import '../styles/ganaderia-login.css';

const GENERIC_NETWORK_MESSAGE = 'No fue posible conectar con el servicio. Intenta nuevamente.';
// HOTFIX E2E-001 (ajuste UX): un 5xx significa que SÍ hubo comunicación con
// el servidor -- a diferencia de GENERIC_NETWORK_MESSAGE, este mensaje no
// invita a reintentar de inmediato (el resultado de la operación puede
// requerir verificación antes de repetir).
const SERVER_ERROR_MESSAGE =
  'Ocurrió un error al crear la cuenta. No vuelvas a intentarlo hasta verificar el estado.';
const SUCCESS_MESSAGE = 'Cuenta provisionada. Se envió el enlace de activación al correo del cliente.';
// MICROAUDITORÍA (caso B, DB OK + EMAIL FAIL): ambos casos son éxito de
// provisionamiento -- nunca se trata como si hubiera fallado la creación,
// nunca invita a "volver a crear la cuenta" (causaría 409).
const SUCCESS_EMAIL_FAILED_MESSAGE =
  'Cuenta creada, pero no pudimos enviar el correo de activación. No vuelvas a crear la cuenta; podrás reenviar la activación posteriormente.';

function resolveErrorMessage(status, body) {
  if (status === 409) return 'Ya existe una cuenta asociada a este correo.';
  if (status === 400) {
    if (body?.error === 'INVALID_EMAIL') return 'Ingresa un correo electrónico válido.';
    if (body?.error === 'INVALID_ORGANIZACION_NOMBRE') return 'Ingresa el nombre de la organización.';
    if (body?.error === 'INVALID_RESPONSABLE_NOMBRE') return 'Ingresa el nombre del responsable.';
    if (body?.error === 'INVALID_IDENTIFICADOR_FISCAL') return 'El identificador fiscal ingresado no es válido.';
    return 'Revisa los datos ingresados.';
  }
  if (status === 401 || status === 403) return 'Tu sesión no tiene permisos para esta acción. Vuelve a iniciar sesión.';
  if (status >= 500) return SERVER_ERROR_MESSAGE;
  return GENERIC_NETWORK_MESSAGE;
}

export default function GanaderiaAdminCrearCuenta() {
  const navigate = useNavigate();
  const [nombreOrganizacion, setNombreOrganizacion] = useState('');
  const [nombreResponsable, setNombreResponsable] = useState('');
  const [email, setEmail] = useState('');
  const [identificadorFiscal, setIdentificadorFiscal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [emailDelivered, setEmailDelivered] = useState(true);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setErrorMessage('');
    setSubmitting(true);

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch('/api/ganaderia/admin/clientes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          nombreOrganizacion,
          nombreResponsable,
          email,
          ...(identificadorFiscal.trim() ? { identificadorFiscal: identificadorFiscal.trim() } : {}),
        }),
      });

      if (!response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        setErrorMessage(resolveErrorMessage(response.status, body));
        setSubmitting(false);
        return;
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      // MICROAUDITORÍA (caso B): DB OK + EMAIL FAIL sigue siendo éxito de
      // provisionamiento -- `emailDelivered` solo cambia el mensaje, nunca
      // la rama de éxito/error del formulario.
      setEmailDelivered(body?.emailDelivered === true);
      setSubmitted(true);
      setSubmitting(false);
    } catch {
      setErrorMessage(GENERIC_NETWORK_MESSAGE);
      setSubmitting(false);
    }
  }

  return (
    <div className="gan-admin-shell">
      <header className="gan-admin-topbar">
        <div>
          <span className="gan-admin-eyebrow">AgroGenomaX</span>
          <h1>Crear cuenta de cliente</h1>
        </div>
      </header>

      <main className="gan-admin-main">
        <div className="gan-login-card" style={{ margin: '0 auto' }}>
          {submitted ? (
            <>
              <p className="gan-login-success" role="status">
                {emailDelivered ? SUCCESS_MESSAGE : SUCCESS_EMAIL_FAILED_MESSAGE}
              </p>
              <div className="gan-login-links">
                <Link to="/ganaderia/admin">Volver a administración</Link>
              </div>
            </>
          ) : (
            <form className="gan-login-form" onSubmit={handleSubmit}>
              <label className="gan-login-field">
                <span>Nombre de organización</span>
                <input
                  type="text"
                  name="nombreOrganizacion"
                  required
                  maxLength={200}
                  value={nombreOrganizacion}
                  onChange={(event) => setNombreOrganizacion(event.target.value)}
                />
              </label>

              <label className="gan-login-field">
                <span>Nombre del responsable</span>
                <input
                  type="text"
                  name="nombreResponsable"
                  required
                  maxLength={200}
                  value={nombreResponsable}
                  onChange={(event) => setNombreResponsable(event.target.value)}
                />
              </label>

              <label className="gan-login-field">
                <span>Correo</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="off"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label className="gan-login-field">
                <span>Identificador fiscal (opcional)</span>
                <input
                  type="text"
                  name="identificadorFiscal"
                  maxLength={60}
                  value={identificadorFiscal}
                  onChange={(event) => setIdentificadorFiscal(event.target.value)}
                />
              </label>

              {errorMessage ? (
                <p className="gan-login-error" role="alert">
                  {errorMessage}
                </p>
              ) : null}

              <button type="submit" className="gan-login-submit" disabled={submitting}>
                {submitting ? 'Creando...' : 'Crear cuenta y enviar activación'}
              </button>
            </form>
          )}

          <div className="gan-login-links">
            <button type="button" onClick={() => navigate('/ganaderia/admin')} className="gan-admin-logout">
              Cancelar y volver
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
