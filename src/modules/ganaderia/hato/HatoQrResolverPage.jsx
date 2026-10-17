// SPRINT-3D11.3 (R1): /ganaderia/qr/:valor (privada, RequireGanaderiaAuth).
// :valor es el token del QR escaneado o el código visible digitado; ambos
// se resuelven bajo la organización de la sesión y llevan al mismo destino:
//   chapeta en uso       -> ficha del animal
//   chapeta disponible   -> registro de animal con esa chapeta
//   inexistente / ajena  -> estado controlado único (404)
//   revocada / dañada / reemplazada -> estado controlado (410)
// Formato inválido -> estado controlado sin consultar la API. La entrada
// del historial se reemplaza al navegar (el token no queda en el historial).
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { StatusMessage } from '../components/FormField.jsx';
import { resolveQrCodigo, resolveQrToken } from './hatoApi.js';
import { parseQrContent, qrResolutionOutcome } from './qrToken.js';
import '../styles/ganaderia-hato.css';

export default function HatoQrResolverPage() {
  const { valor } = useParams();
  const parsed = parseQrContent(valor);
  const { kind } = parsed;
  const valido = kind !== 'invalid';
  const clave = kind === 'token' ? parsed.token : parsed.codigo;
  const [outcome, setOutcome] = useState(valido ? { status: 'loading' } : { status: 'not_found' });

  const resolve = useCallback(async () => {
    if (!valido) return;
    setOutcome({ status: 'loading' });
    try {
      const response = kind === 'token' ? await resolveQrToken(clave) : await resolveQrCodigo(clave);
      setOutcome(qrResolutionOutcome(response));
    } catch {
      setOutcome({ status: 'error' });
    }
  }, [clave, kind, valido]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  if (outcome.status === 'found') return <Navigate to={outcome.to} replace />;

  return (
    <div className="gan-panel gan-hato">
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Identificación</span>
        <h2>Chapeta QR</h2>
      </div>
      {outcome.status === 'loading' ? <StatusMessage>Buscando la chapeta...</StatusMessage> : null}
      {outcome.status === 'not_found' ? (
        <StatusMessage type="error">
          Esta chapeta no pertenece a tu cuenta o el código no es válido. Revisa el código impreso.
        </StatusMessage>
      ) : null}
      {outcome.status === 'no_operativa' ? (
        <StatusMessage type="error">
          Esta chapeta está fuera de uso ({outcome.estado}). Usa otra chapeta disponible.
        </StatusMessage>
      ) : null}
      {outcome.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible consultar la chapeta.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={resolve}>Reintentar</button>
        </div>
      ) : null}
      {outcome.status !== 'loading' ? (
        <div className="gan-hato-actions">
          <Link className="gan-secondary-button" to="/ganaderia/escanear-qr">Escanear otra chapeta</Link>
          <Link className="gan-secondary-button" to="/ganaderia/animales">Ir a mis animales</Link>
        </div>
      ) : null}
    </div>
  );
}
