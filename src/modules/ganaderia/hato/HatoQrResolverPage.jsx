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
// FASE 2B: chapeta fuera de uso con vínculo histórico (animalId SOLO de la
// misma organización: respuesta del servidor bajo la sesión o copia local
// del dispositivo) -> "Ver ficha del animal". Sin animalId no hay pista.
// FASE 3B.2: el SPA nunca pone el token en su URL ni en la de la API (el
// primer GET legacy de una chapeta impresa sí lo trae hasta el edge; ver
// functions/qr/[codigo].js). /ganaderia/qr (URL limpia)
// resuelve el token pendiente en memoria (escáner) o, sin él, la cookie
// HttpOnly de la chapeta impresa, vía POST /api/ganaderia/qr/resolver. Un
// token en /ganaderia/qr/:valor (URL antigua) pasa a memoria y se
// reemplaza por la URL limpia. 5xx -> código de seguimiento, sin detalles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { StatusMessage } from '../components/FormField.jsx';
import { resolveQrCodigo, resolveQrPendiente } from './hatoApi.js';
import { ESTADO_CHAPETA_LABELS, parseQrContent, qrResolutionOutcome } from './qrToken.js';
import { descartarTokenPendiente, leerTokenPendiente, rutaResolverQr } from './qrPendiente.js';
import { useGanaderiaOffline } from '../offline/GanaderiaOfflineProvider.jsx';
import { MENSAJE_QR_HISTORICA } from './cierreModel.js';
import '../styles/ganaderia-hato.css';

const DEFINITIVOS = new Set(['found', 'not_found', 'no_operativa', 'sin_pendiente']);

export default function HatoQrResolverPage() {
  const { valor } = useParams();
  // Sin :valor -> modo pendiente (token en memoria o cookie HttpOnly).
  const pendiente = valor === undefined;
  const parsed = pendiente ? null : parseQrContent(valor);
  const tokenEnUrl = parsed?.kind === 'token';
  const valido = pendiente || (parsed.kind !== 'invalid' && !tokenEnUrl);
  const [tokenMemoria] = useState(() => (pendiente ? leerTokenPendiente() : null));
  const kind = pendiente ? (tokenMemoria ? 'token' : 'cookie') : parsed.kind;
  const clave = pendiente ? tokenMemoria : parsed.codigo;
  const [outcome, setOutcome] = useState(valido ? { status: 'loading' } : { status: 'not_found' });
  const offline = useGanaderiaOffline();
  const local = offline.preparado && offline.repo ? offline.repo : null;
  const online = offline.online;
  // Una sola solicitud al servidor por montaje: la cookie se consume en la
  // primera respuesta, así que un segundo POST (re-render, StrictMode) daría
  // QR_PENDIENTE_AUSENTE. Solo "Reintentar" tras un error la vuelve a pedir.
  const solicitudRef = useRef(null);

  const resolve = useCallback(async () => {
    if (!valido) return;
    setOutcome({ status: 'loading' });
    // SPRINT-3D11.3 (R1) offline-first: primero la copia local (funciona sin
    // red). Un código que NO está en el dispositivo no se da por inválido:
    // con red se verifica en el servidor; sin red se informa. La cookie
    // HttpOnly no es legible desde el SPA: solo el servidor la resuelve.
    if (local && kind !== 'cookie') {
      try {
        const localResult = await local.resolverLocal(kind === 'token' ? { kind, token: clave } : { kind, codigo: clave });
        if (localResult.resultado === 'ANIMAL' || localResult.resultado === 'DISPONIBLE') {
          if (kind === 'token') descartarTokenPendiente();
          setOutcome({ status: 'found', to: localResult.to });
          return;
        }
        if (localResult.resultado === 'NO_OPERATIVA') {
          if (kind === 'token') descartarTokenPendiente();
          setOutcome({
            status: 'no_operativa',
            estado: ESTADO_CHAPETA_LABELS[localResult.estado] ?? 'Fuera de uso',
            animalId: /^[1-9]\d{0,17}$/.test(String(localResult.animalId ?? '')) ? String(localResult.animalId) : null,
          });
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
      const llave = `${kind}:${clave ?? ''}`;
      if (solicitudRef.current?.llave !== llave) {
        solicitudRef.current = { llave, promesa: kind === 'codigo' ? resolveQrCodigo(clave) : resolveQrPendiente(clave) };
      }
      const next = qrResolutionOutcome(await solicitudRef.current.promesa);
      if (DEFINITIVOS.has(next.status)) {
        if (pendiente) descartarTokenPendiente();
      } else {
        solicitudRef.current = null;
      }
      setOutcome(next);
    } catch {
      solicitudRef.current = null;
      setOutcome(local ? { status: 'desconocida_offline' } : { status: 'error' });
    }
  }, [clave, kind, valido, local, online, pendiente]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  // URL antigua /ganaderia/qr/<token>: a memoria y URL limpia, sin consultar.
  if (tokenEnUrl) return <Navigate to={rutaResolverQr(parsed)} replace />;
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
      {outcome.status === 'sin_pendiente' ? (
        <StatusMessage type="info">No hay una chapeta por consultar. Vuelve a escanearla o digita su código.</StatusMessage>
      ) : null}
      {outcome.status === 'no_operativa' && !outcome.animalId ? (
        <StatusMessage type="error">
          Esta chapeta está fuera de uso ({outcome.estado}). Usa otra chapeta disponible.
        </StatusMessage>
      ) : null}
      {outcome.status === 'no_operativa' && outcome.animalId ? (
        <div className="gan-hato-actions">
          <StatusMessage type="info">
            Esta chapeta está fuera de uso ({outcome.estado}). {MENSAJE_QR_HISTORICA}
          </StatusMessage>
          <Link className="gan-submit" to={`/ganaderia/animales/${outcome.animalId}`}>Ver ficha del animal</Link>
        </div>
      ) : null}
      {outcome.status === 'desconocida_offline' ? (
        <StatusMessage type="info">Código no disponible en este dispositivo. Conéctese para verificarlo.</StatusMessage>
      ) : null}
      {outcome.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">
            {outcome.seguimiento
              ? `Ocurrió un error. Código de seguimiento: ${outcome.seguimiento}`
              : 'No fue posible consultar la chapeta.'}
          </StatusMessage>
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
