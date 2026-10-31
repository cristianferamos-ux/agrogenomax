// SPRINT-3D11.3 (R1): /ganaderia/sincronizacion -- preparar el dispositivo
// para trabajo sin señal, estado de la sincronización y resolución de
// conflictos. Ningún conflicto se resuelve en silencio: el usuario elige.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { useGanaderiaOffline } from './GanaderiaOfflineProvider.jsx';
import { formatUltimaSync } from './OfflineStatusBar.jsx';
import { OUTBOX_ESTADOS } from './outbox.js';
import { formatFecha, formatKg, formatMetodo } from '../hato/pesajesModel.js';
import { mensajeBloqueoPesaje } from '../hato/pesajesOfflineModel.js';
import { MENSAJE_OFFLINE_ROLE_FORBIDDEN } from '../auth/ganaderiaPermisos.js';
import { useGanaderiaPermisos } from '../auth/useGanaderiaPermisos.js';
import { mensajeDeExcepcion } from '../api/errorModel.js';
import '../styles/ganaderia-hato.css';
import '../styles/ganaderia-offline.css';

const CONFLICTO_MENSAJES = Object.freeze({
  QR_YA_ASOCIADO: 'Otra persona ya usó esta chapeta en otro animal.',
  QR_NO_OPERATIVO: 'La chapeta fue revocada, dañada o reemplazada.',
  QR_NOT_FOUND: 'La chapeta ya no pertenece a tu organización.',
  ANIMAL_NUMERO_VISUAL_DUPLICADO: 'Ya existe otro animal activo con ese número de chapeta visual.',
  CLIENT_OPERATION_ID_REUSED: 'Este registro ya existe en el servidor con otros datos.',
  PREDIO_NOT_FOUND: 'El predio ya no está disponible.',
  PREDIO_ARCHIVADO: 'El predio fue archivado.',
  // FASE 3A: 403 por rol -> RECHAZADO terminal, sin reintentos.
  ROLE_FORBIDDEN: MENSAJE_OFFLINE_ROLE_FORBIDDEN,
});

// FASE 1D.1: un pesaje (PESAJE_CREAR) que el servidor no aceptó. No se
// reintenta solo ni se le cambia el clientOperationId: el usuario lo revisa
// en la ficha y, si corresponde, lo descarta (no afecta al servidor).
function ConflictoPesajeItem({ op, animal, repo, onDone }) {
  const [confirmar, setConfirmar] = useState(false);
  const [error, setError] = useState('');
  const p = op.payload ?? {};
  async function descartar() {
    setError('');
    try {
      await repo.descartarPesajePendiente(op.operationId);
      onDone();
    } catch (err) {
      // FASE 3C: solo errores de dominio del repositorio local (con código) o un genérico.
      setError(mensajeDeExcepcion(err, 'No fue posible descartar el pesaje.'));
    }
  }
  return (
    <li className="gan-offline-conflicto">
      <strong>Pesaje de {animal ? animal.numeroVisual || animal.nombre || 'animal sin identificar' : `animal ${p.animalId}`}</strong>
      <span>{formatFecha(p.fecha)} · {formatKg(p.pesoKg)} · {formatMetodo(p.metodo)}</span>
      <span>{mensajeBloqueoPesaje(op.ultimoError?.codigo)}</span>
      <Link to={`/ganaderia/animales/${p.animalId}`}>Ver ficha del animal</Link>
      <div className="gan-hato-actions">
        <button type="button" className="gan-secondary-button" onClick={() => setConfirmar(true)}>Descartar pesaje pendiente</button>
      </div>
      {confirmar ? (
        <div className="gan-hato-actions">
          <StatusMessage type="info">El pesaje pendiente se eliminará de este dispositivo. No afecta al servidor.</StatusMessage>
          <button type="button" className="gan-submit" onClick={descartar}>Confirmar descarte</button>
        </div>
      ) : null}
      {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
    </li>
  );
}

function ConflictoItem({ op, animal, repo, onDone }) {
  const [modo, setModo] = useState(null);
  const [valor, setValor] = useState('');
  const [error, setError] = useState('');
  const codigo = op.ultimoError?.codigo;
  // FASE 3A: sin permiso (rol actual o rechazo 403 ROLE_FORBIDDEN) no se
  // ofrece reenviar; solo descartar el registro local.
  const permisos = useGanaderiaPermisos();
  const puedeReenviar = permisos.crearAnimal && codigo !== 'ROLE_FORBIDDEN';

  async function ejecutar(accion) {
    setError('');
    try {
      await accion();
      setModo(null);
      onDone();
    } catch (err) {
      setError(mensajeDeExcepcion(err, 'No fue posible aplicar el cambio.'));
    }
  }

  return (
    <li className="gan-offline-conflicto">
      <strong>{animal ? animal.numeroVisual || animal.nombre || 'Animal sin identificar' : 'Registro local'}</strong>
      <span>{CONFLICTO_MENSAJES[codigo] ?? `No se pudo sincronizar (${codigo ?? 'error'}).`}</span>
      {op.payload?.chapetaCodigo ? <span>Chapeta: {op.payload.chapetaCodigo}</span> : null}
      {animal ? <Link to={`/ganaderia/animales/local:${op.localUuid}`}>Ver registro local</Link> : null}
      <div className="gan-hato-actions">
        {puedeReenviar && op.payload?.chapetaCodigo ? (
          <>
            <button type="button" className="gan-secondary-button" onClick={() => ejecutar(() => repo.resolverSinChapeta(op.localUuid))}>Registrar sin chapeta</button>
            <button type="button" className="gan-secondary-button" onClick={() => setModo('chapeta')}>Usar otra chapeta</button>
          </>
        ) : null}
        {puedeReenviar && codigo === 'ANIMAL_NUMERO_VISUAL_DUPLICADO' ? (
          <button type="button" className="gan-secondary-button" onClick={() => setModo('numero')}>Cambiar número</button>
        ) : null}
        <button type="button" className="gan-secondary-button" onClick={() => setModo('descartar')}>Descartar registro local</button>
      </div>
      {modo === 'chapeta' || modo === 'numero' ? (
        <form
          className="gan-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            ejecutar(() => (modo === 'chapeta'
              ? repo.resolverConOtraChapeta(op.localUuid, valor)
              : repo.resolverEditando(op.localUuid, { numeroVisual: valor.trim() || null })));
          }}
        >
          <FormField label={modo === 'chapeta' ? 'Código de la otra chapeta' : 'Nuevo número de chapeta visual'}>
            <input type="text" value={valor} onChange={(event) => setValor(event.target.value)} autoCapitalize="characters" />
          </FormField>
          <button type="submit" className="gan-submit">Guardar y reintentar</button>
        </form>
      ) : null}
      {modo === 'descartar' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="info">El registro local se eliminará de este dispositivo. No afecta al servidor.</StatusMessage>
          <button type="button" className="gan-submit" onClick={() => ejecutar(() => repo.descartarLocal(op.localUuid))}>Confirmar descarte</button>
        </div>
      ) : null}
      {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
    </li>
  );
}

export default function OfflineSyncPage() {
  const offline = useGanaderiaOffline();
  const [preparando, setPreparando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [bloqueadas, setBloqueadas] = useState([]);

  const cargar = useCallback(async () => {
    if (!offline.repo) return;
    const ops = (await offline.repo.listOutbox()).filter((op) => op.estado === OUTBOX_ESTADOS.CONFLICTO || op.estado === OUTBOX_ESTADOS.RECHAZADO);
    const conAnimal = await Promise.all(ops.map(async (op) => ({
      op,
      animal: op.tipoOperacion === 'PESAJE_CREAR'
        ? await offline.repo.getAnimal(op.payload?.animalId)
        : await offline.repo.getAnimal(`local:${op.localUuid}`),
    })));
    setBloqueadas(conAnimal);
  }, [offline.repo]);

  useEffect(() => {
    cargar();
    if (!offline.repo) return undefined;
    return offline.repo.subscribe(cargar);
  }, [cargar, offline.repo]);

  async function preparar() {
    setPreparando(true);
    setResultado(null);
    try {
      setResultado(await offline.preparar());
    } finally {
      setPreparando(false);
    }
  }

  if (offline.status === 'no_disponible') {
    return (
      <div className="gan-panel gan-hato">
        <GanaderiaBackLink />
        <StatusMessage type="info">El trabajo sin conexión no está disponible en este navegador.</StatusMessage>
      </div>
    );
  }

  const { stats } = offline;
  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink />
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Trabajo en campo</span>
        <h2>Sincronización y modo sin señal</h2>
      </div>

      <div className="gan-hato-ficha">
        <div className="gan-ficha-row"><span>Estado</span><strong>{offline.indicador?.etiqueta}</strong></div>
        <div className="gan-ficha-row"><span>Última sincronización</span><strong>{formatUltimaSync(stats?.ultimaSyncAt)}</strong></div>
        <div className="gan-ficha-row"><span>Dispositivo preparado</span><strong>{stats?.preparadoAt ? formatUltimaSync(stats.preparadoAt) : 'No'}</strong></div>
        <div className="gan-ficha-row"><span>Animales en el dispositivo</span><strong>{stats?.animales ?? 0}</strong></div>
        <div className="gan-ficha-row"><span>Chapetas disponibles</span><strong>{stats?.chapetasDisponibles ?? 0}</strong></div>
        <div className="gan-ficha-row"><span>Operaciones pendientes</span><strong>{stats?.pendientes ?? 0}</strong></div>
      </div>

      <div className="gan-hato-actions">
        <button type="button" className="gan-submit" onClick={preparar} disabled={preparando || !offline.online}>
          {preparando ? 'Preparando...' : 'Preparar dispositivo para trabajo offline'}
        </button>
        {offline.online ? (
          <button type="button" className="gan-secondary-button" onClick={() => offline.syncNow()} disabled={offline.engineState?.enCurso}>
            Sincronizar ahora
          </button>
        ) : null}
      </div>
      {!offline.online ? <StatusMessage type="info">Sin conexión: los cambios se guardan en este dispositivo y se enviarán solos al recuperar la señal.</StatusMessage> : null}
      {resultado?.ok ? (
        <StatusMessage type="success">
          Dispositivo listo: {resultado.stats.animales} animales y {resultado.stats.chapetasDisponibles} chapetas disponibles.
          {resultado.precache?.ok ? ' La aplicación quedó guardada para abrir sin señal.' : ' La aplicación se guardará para abrir sin señal en la próxima visita.'}
        </StatusMessage>
      ) : null}
      {resultado && !resultado.ok ? <StatusMessage type="error">{resultado.error}</StatusMessage> : null}

      {bloqueadas.length > 0 ? (
        <section className="gan-offline-conflictos" aria-labelledby="gan-offline-conflictos-title">
          <h3 id="gan-offline-conflictos-title">Conflictos de sincronización ({bloqueadas.length})</h3>
          <p className="gan-hato-hint">Los registros se conservan en este dispositivo hasta que decidas qué hacer.</p>
          <ul>
            {bloqueadas.map(({ op, animal }) => (
              op.tipoOperacion === 'PESAJE_CREAR'
                ? <ConflictoPesajeItem key={op.operationId} op={op} animal={animal} repo={offline.repo} onDone={cargar} />
                : <ConflictoItem key={op.operationId} op={op} animal={animal} repo={offline.repo} onDone={cargar} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
