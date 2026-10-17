// SPRINT-3D11.3 (R1): /ganaderia/qr/:token (privada, RequireGanaderiaAuth).
// Resuelve el token con GET /api/ganaderia/qr/:token bajo la organización
// de la sesión y reemplaza la entrada del historial por la ficha del
// animal. Formato inválido -> estado controlado sin consultar la API. 404
// (otra organización, revocado, reemplazado) -> un único estado controlado.
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { StatusMessage } from '../components/FormField.jsx';
import { resolveQr } from './hatoApi.js';
import { isQrToken, qrResolutionOutcome } from './qrToken.js';
import '../styles/ganaderia-hato.css';

export default function HatoQrResolverPage() {
  const { token } = useParams();
  const tokenValido = isQrToken(token);
  const [outcome, setOutcome] = useState(tokenValido ? { status: 'loading' } : { status: 'not_found' });

  const resolve = useCallback(async () => {
    if (!tokenValido) return;
    setOutcome({ status: 'loading' });
    try {
      setOutcome(qrResolutionOutcome(await resolveQr(token)));
    } catch {
      setOutcome({ status: 'error' });
    }
  }, [token, tokenValido]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  if (outcome.status === 'found') return <Navigate to={outcome.to} replace />;

  return (
    <div className="gan-panel gan-hato">
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Identificación</span>
        <h2>Código QR</h2>
      </div>
      {outcome.status === 'loading' ? <StatusMessage>Buscando el animal...</StatusMessage> : null}
      {outcome.status === 'not_found' ? (
        <StatusMessage type="error">
          Este código QR no corresponde a ningún animal activo de tu cuenta. Puede haber sido revocado o reemplazado.
        </StatusMessage>
      ) : null}
      {outcome.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible consultar el código QR.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={resolve}>Reintentar</button>
        </div>
      ) : null}
      {outcome.status !== 'loading' ? (
        <div className="gan-hato-actions">
          <Link className="gan-secondary-button" to="/ganaderia/escanear-qr">Escanear otro QR</Link>
          <Link className="gan-secondary-button" to="/ganaderia/animales">Ir a mis animales</Link>
        </div>
      ) : null}
    </div>
  );
}
