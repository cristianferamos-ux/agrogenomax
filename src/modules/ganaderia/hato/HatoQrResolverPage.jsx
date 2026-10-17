// SPRINT-3D11.3 (R1): /ganaderia/qr/:valor (privada, RequireGanaderiaAuth).
// :valor es el token del QR escaneado o el código visible digitado; ambos
// se resuelven bajo la organización de la sesión y llevan al mismo destino:
//   chapeta en uso       -> ficha del animal
//   chapeta disponible   -> registro de animal con esa chapeta
//   inexistente / ajena  -> estado controlado único (404)
//   revocada / dañada / reemplazada -> estado controlado (410)
// Formato inválido -> estado controlado sin consultar la API. La entrada
// del historial se reemplaza al navegar (el token no queda en el historial).
// SPRINT-3D11.3 (R1): con el dispositivo preparado resuelve primero contra
// la copia local (sin red): token por SHA-256, código por su valor.
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { StatusMessage } from '../components/FormField.jsx';
import { resolveQrCodigo, resolveQrToken } from './hatoApi.js';
import { ESTADO_CHAPETA_LABELS, parseQrContent, qrResolutionOutcome } from './qrToken.js';
import { useGanaderiaOffline } from '../offline/GanaderiaOfflineProvider.jsx';
import '../styles/ganaderia-hato.css';

export default function HatoQrResolverPage() {
  const { valor } = useParams();
  const parsed = parseQrContent(valor);
  const { kind } = parsed;
  const valido = kind !== 'invalid';
  const clave = kind === 'token' ? parsed.token : parsed.codigo;
  const [outcome, setOutcome] = useState(valido ? { status: 'loading' } : { status: 'not_found' });
  const offline = useGanaderiaOffline();
  const local = offline.preparado && offline.repo ? offline.repo : null;
  const online = offline.online;

  const resolve = useCallback(async () => {
    if (!valido) return;
    setOutcome({ status: 'loading' });
    // SPRINT-3D11.3 (R1) offline-first: primero la copia local (funciona sin
    // red). Un código que NO está en el dispositivo no se da por inválido:
    // con red se verifica en el servidor; sin red se informa.
    if (local) {
      try {
        const localResult = await local.resolverLocal(kind === 'token' ? { kind, token: clave } : { kind, codigo: clave });
        if (localResult.resultado === 'ANIMAL' || localResult.resultado === 'DISPONIBLE') {
          setOutcome({ status: 'found', to: localResult.to });
          return;
        }
        if (localResult.resultado === 'NO_OPERATIVA') {
          setOutcome({ status: 'no_operativa', estado: ESTADO_CHAPETA_LABELS[localResult.estado] ?? 'Fuera de uso' });
          return;
        }
      } catch {
        // Copia local ilegible: se intenta con el servidor.
      }
      if (!online) {
        setOutcome({ status: 'desconocida_offline' });
        return;
      }
    }
    try {
      const response = kind === 'token' ? await resolveQrToken(clave) : await resolveQrCodigo(clave);
      setOutcome(qrResolutionOutcome(response));
    } catch {
      setOutcome(local ? { status: 'desconocida_offline' } : { status: 'error' });
    }
  }, [clave, kind, valido, local, online]);

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
      {outcome.status === 'desconocida_offline' ? (
        <StatusMessage type="info">Código no disponible en este dispositivo. Conéctese para verificarlo.</StatusMessage>
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
