import { useState } from 'react';

// CATX-FREEZE-01: acceso temporal por contraseña compartida -- nunca pide
// nombre/documento/email/teléfono/dirección. La contraseña vive solo en
// este input mientras el usuario escribe; se limpia del estado
// inmediatamente después de cada intento (exitoso o no), nunca se persiste
// en localStorage/sessionStorage/store global/URL/analytics.
export default function CatastroXTemporaryAccessModal({ packageLabel, onVerify, onCancel }) {
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('idle'); // idle | submitting | invalid | authorized | error
  const [errorMessage, setErrorMessage] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!password || status === 'submitting') return;

    setStatus('submitting');
    setErrorMessage(null);

    const result = await onVerify(password);

    // La contraseña se descarta del estado inmediatamente después del
    // intento -- nunca queda expuesta en el formulario más allá del POST
    // que ya se envió.
    setPassword('');

    if (result?.ok) {
      setStatus('authorized');
      return;
    }

    if (result?.code === 'INVALID_PASSWORD') {
      setStatus('invalid');
    } else {
      setStatus('error');
    }
    setErrorMessage(result?.message || 'No fue posible verificar el acceso temporal.');
  }

  if (status === 'authorized') {
    return (
      <div className="catastrox-card catastrox-form">
        <div className="catastrox-section-heading">
          <span>Acceso temporal autorizado</span>
          <h2>Descargas habilitadas para {packageLabel}</h2>
        </div>
        <div className="catastrox-success is-full">
          <strong>Acceso autorizado</strong>
          <span>Ya puede descargar los archivos incluidos en este paquete.</span>
        </div>
      </div>
    );
  }

  return (
    <form className="catastrox-card catastrox-form" onSubmit={handleSubmit}>
      <div className="catastrox-section-heading">
        <span>Acceso temporal autorizado</span>
        <h2>Ingrese la contraseña para {packageLabel}</h2>
      </div>

      <label className="catastrox-field is-full">
        <span>Contraseña</span>
        <input
          type="password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={status === 'submitting'}
        />
      </label>

      {(status === 'invalid' || status === 'error') && errorMessage ? (
        <div className="catastrox-inline-panel is-full">
          <strong>{status === 'invalid' ? 'Contraseña incorrecta' : 'No fue posible continuar'}</strong>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="catastrox-action-row is-full">
        <button type="submit" className="catastrox-button" disabled={status === 'submitting' || !password}>
          {status === 'submitting' ? 'Verificando...' : 'Continuar'}
        </button>
        <button type="button" className="catastrox-button is-ghost" onClick={onCancel} disabled={status === 'submitting'}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
