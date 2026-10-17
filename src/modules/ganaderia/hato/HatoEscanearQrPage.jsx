// SPRINT-3D11.3 (R1): /ganaderia/escanear-qr (privada). Cámara o código de
// chapeta digitado -> parseQrContent -> /ganaderia/qr/:valor. La entrada
// manual resuelve EXACTAMENTE igual que el escaneo (mismo resolver): es la
// alternativa obligatoria en campo cuando falla la cámara o el QR está
// sucio, dañado o mal iluminado.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import HatoQrScanner from './HatoQrScanner.jsx';
import { parseQrContent, qrResolverPath } from './qrToken.js';
import '../styles/ganaderia-hato.css';

const INVALID_SCAN_MESSAGE = 'El QR leído no es una chapeta AgroGenomaX.';
const INVALID_CODE_MESSAGE = 'Revisa el código: tiene la forma AGX-7KM4-P2XZ.';

export default function HatoEscanearQrPage() {
  const navigate = useNavigate();
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState('');

  function handleContent(rawValue, invalidMessage) {
    const parsed = parseQrContent(rawValue);
    if (parsed.kind === 'invalid') {
      setError(invalidMessage);
      return;
    }
    setError('');
    navigate(qrResolverPath(parsed));
  }

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink to="/ganaderia/animales">Volver a mis animales</GanaderiaBackLink>
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Identificación</span>
        <h2>Escanear chapeta</h2>
      </div>
      <p className="gan-hato-hint">
        Escanea una chapeta nueva para registrar el animal, o una chapeta en uso para abrir su ficha.
      </p>

      <HatoQrScanner onDecoded={(text) => handleContent(text, INVALID_SCAN_MESSAGE)} />

      <form
        className="gan-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleContent(codigo, INVALID_CODE_MESSAGE);
        }}
      >
        <FormField label="Código de chapeta">
          <input
            type="text"
            value={codigo}
            placeholder="AGX-7KM4-P2XZ"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            onChange={(event) => setCodigo(event.target.value)}
          />
        </FormField>
        <div className="gan-hato-actions">
          <button type="submit" className="gan-submit">Buscar</button>
        </div>
      </form>

      {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
    </div>
  );
}
