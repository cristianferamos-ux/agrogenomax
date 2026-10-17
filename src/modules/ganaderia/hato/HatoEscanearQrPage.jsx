// SPRINT-3D11.3 (R1): /ganaderia/escanear-qr (privada). Cámara o código
// escrito -> parseQrContent -> /ganaderia/qr/:token, donde se resuelve
// bajo la organización de la sesión. Los códigos legacy (AGX-000001, ...)
// se reconocen pero no se consultan: aún no están migrados.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import HatoQrScanner from './HatoQrScanner.jsx';
import { parseQrContent, qrResolverPath } from './qrToken.js';
import '../styles/ganaderia-hato.css';

const LEGACY_MESSAGE = 'Este es un código QR del sistema anterior. Todavía no está vinculado a tus animales.';
const INVALID_MESSAGE = 'El código leído no es un QR de AgroGenomaX.';

export default function HatoEscanearQrPage() {
  const navigate = useNavigate();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');

  function handleContent(rawValue) {
    const parsed = parseQrContent(rawValue);
    if (parsed.kind === 'token') {
      setError('');
      navigate(qrResolverPath(parsed.token));
      return;
    }
    setError(parsed.kind === 'legacy' ? LEGACY_MESSAGE : INVALID_MESSAGE);
  }

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink to="/ganaderia/animales">Volver a mis animales</GanaderiaBackLink>
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Identificación</span>
        <h2>Escanear QR</h2>
      </div>
      <p className="gan-hato-hint">Apunta la cámara al QR del animal para abrir su ficha.</p>

      <HatoQrScanner onDecoded={handleContent} />

      <form
        className="gan-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleContent(manual);
        }}
      >
        <FormField label="O escribe el enlace o código del QR">
          <input
            type="text"
            value={manual}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setManual(event.target.value)}
          />
        </FormField>
        <div className="gan-hato-actions">
          <button type="submit" className="gan-secondary-button">Buscar animal</button>
        </div>
      </form>

      {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
    </div>
  );
}
