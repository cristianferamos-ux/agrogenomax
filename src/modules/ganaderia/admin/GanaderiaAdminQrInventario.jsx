// SPRINT-3D11.3 (R1): Administración > QR Ganadería / Inventario de
// chapetas (/ganaderia/admin/qr, RequireGanaderiaSuperAdmin). Mismo layout
// administrativo propio que el resto del panel (nunca el sidebar de
// cliente). Lotes: crear (genera códigos + tokens), avanzar estado físico,
// descargar archivo del proveedor, asignar todo o parte a una
// organización. Chapetas: buscar por código/estado/lote/organización, ver
// organización + animal + historial, revocar, marcar dañada, reemplazar.
// Importación legacy controlada (AGX-000001...). Cada formulario usa un
// clientOperationId propio; ningún POST se reintenta solo.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  asignarLote,
  bajaChapeta,
  buscarChapetas,
  cambiarEstadoLote,
  crearLote,
  getChapeta,
  getLote,
  importarLegacy,
  listLotes,
  listOrganizaciones,
  proveedorUrl,
  reemplazarChapeta,
} from './adminQrApi.js';
import {
  ASIGNACION_LABELS,
  ESTADO_CHAPETA_ADMIN_LABELS,
  ESTADO_LOTE_LABELS,
  adminQrErrorMessage,
  codigosLegacyConsecutivos,
  newOperationId,
  parseCodigosTexto,
  siguienteEstadoLote,
} from './adminQrModel.js';
import '../styles/ganaderia-admin.css';
import '../styles/ganaderia-admin-qr.css';

function formatFecha(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

function Msg({ type = 'info', children }) {
  if (!children) return null;
  return <p className={`gan-aqr-msg gan-aqr-msg-${type}`} role={type === 'error' ? 'alert' : 'status'}>{children}</p>;
}

/** Ejecuta un POST y devuelve data o lanza un mensaje legible. */
async function run(action) {
  const { ok, data } = await action();
  if (!ok) throw new Error(adminQrErrorMessage(data));
  return data;
}

// ---------------------------------------------------------------------
// Crear lote
// ---------------------------------------------------------------------

function CrearLoteForm({ onCreated }) {
  const [cantidad, setCantidad] = useState('100');
  const [proveedor, setProveedor] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [operationId, setOperationId] = useState(newOperationId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n < 1 || n > 5000) {
      setError('La cantidad debe ser un número entre 1 y 5000.');
      return;
    }
    if (!operationId) {
      setError('No se pudo iniciar una operación segura. Recarga la página.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data = await run(() => crearLote({
        cantidad: n,
        proveedor: proveedor.trim() || undefined,
        observaciones: observaciones.trim() || undefined,
        clientOperationId: operationId,
      }));
      setOperationId(newOperationId());
      setProveedor('');
      setObservaciones('');
      onCreated(data.lote);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="gan-aqr-card gan-aqr-form" onSubmit={submit} noValidate>
      <h3>Crear lote</h3>
      <p className="gan-aqr-hint">Genera los códigos visibles y los tokens QR. El dominio del QR es el de este panel.</p>
      <label>
        <span>Cantidad de chapetas</span>
        <input type="number" min="1" max="5000" value={cantidad} onChange={(e) => setCantidad(e.target.value)} disabled={saving} />
      </label>
      <label>
        <span>Proveedor (opcional)</span>
        <input type="text" maxLength={160} value={proveedor} onChange={(e) => setProveedor(e.target.value)} disabled={saving} />
      </label>
      <label>
        <span>Observaciones (opcional)</span>
        <textarea rows={2} maxLength={1000} value={observaciones} onChange={(e) => setObservaciones(e.target.value)} disabled={saving} />
      </label>
      <Msg type="error">{error}</Msg>
      <button type="submit" className="gan-aqr-primary" disabled={saving}>{saving ? 'Generando...' : 'Crear lote'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------
// Detalle de lote: estado, descargas, asignación
// ---------------------------------------------------------------------

function LoteDetalle({ loteId, organizaciones, nombreOrg, onChanged }) {
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [saving, setSaving] = useState(false);
  const [organizacionId, setOrganizacionId] = useState('');
  const [modo, setModo] = useState('todo');
  const [cantidad, setCantidad] = useState('');
  const [codigosTexto, setCodigosTexto] = useState('');
  const [referencia, setReferencia] = useState('');
  const [operationId, setOperationId] = useState(newOperationId);

  const load = useCallback(async () => {
    setError('');
    try {
      const { ok, data } = await getLote(loteId);
      if (ok) setDetalle(data);
      else setError(adminQrErrorMessage(data));
    } catch {
      setError(adminQrErrorMessage(null));
    }
  }, [loteId]);

  useEffect(() => {
    setDetalle(null);
    load();
  }, [load]);

  async function cambiarEstado(estado) {
    if (saving) return;
    setSaving(true);
    setError('');
    setAviso('');
    try {
      await run(() => cambiarEstadoLote(loteId, estado));
      setAviso(`Lote en estado ${ESTADO_LOTE_LABELS[estado]}.`);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function asignar(event) {
    event.preventDefault();
    if (saving) return;
    if (!organizacionId) {
      setError('Selecciona una organización.');
      return;
    }
    const body = { organizacionId, referencia: referencia.trim() || undefined, clientOperationId: operationId };
    if (modo === 'cantidad') {
      const n = Number(cantidad);
      if (!Number.isInteger(n) || n < 1) {
        setError('Indica una cantidad válida.');
        return;
      }
      body.cantidad = n;
    } else if (modo === 'codigos') {
      const codigos = parseCodigosTexto(codigosTexto);
      if (codigos.length === 0) {
        setError('Pega al menos un código.');
        return;
      }
      body.codigos = codigos;
    }
    if (!operationId) {
      setError('No se pudo iniciar una operación segura. Recarga la página.');
      return;
    }
    setSaving(true);
    setError('');
    setAviso('');
    try {
      const data = await run(() => asignarLote(loteId, body));
      setAviso(`${data.cantidad} chapetas asignadas a ${nombreOrg(organizacionId)}.`);
      setOperationId(newOperationId());
      setCantidad('');
      setCodigosTexto('');
      setReferencia('');
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!detalle) return <div className="gan-aqr-card"><Msg type="error">{error}</Msg>{error ? null : <Msg>Cargando lote...</Msg>}</div>;

  const { lote, asignaciones, historial } = detalle;
  const siguiente = siguienteEstadoLote(lote.estado);

  return (
    <div className="gan-aqr-card">
      <h3>Lote {lote.codigoLote}</h3>
      <dl className="gan-aqr-dl">
        <div><dt>Tipo</dt><dd>{lote.tipo === 'QR_LEGACY' ? 'Legacy (AGX-000000)' : 'QR AgroGenomaX'}</dd></div>
        <div><dt>Estado</dt><dd>{ESTADO_LOTE_LABELS[lote.estado]}</dd></div>
        <div><dt>Asignación</dt><dd>{ASIGNACION_LABELS[lote.asignacion]}</dd></div>
        <div><dt>Cantidad</dt><dd>{lote.cantidad}</dd></div>
        <div><dt>En inventario</dt><dd>{lote.stock.enInventario}</dd></div>
        <div><dt>En organizaciones</dt><dd>{lote.stock.asignadasOrganizacion}</dd></div>
        <div><dt>En animales</dt><dd>{lote.stock.asignadasAnimal}</dd></div>
        <div><dt>De baja</dt><dd>{lote.stock.deBaja}</dd></div>
        {lote.proveedor ? <div><dt>Proveedor</dt><dd>{lote.proveedor}</dd></div> : null}
        {lote.urlBase ? <div><dt>Dominio QR</dt><dd>{lote.urlBase}</dd></div> : null}
      </dl>

      <Msg type="success">{aviso}</Msg>
      <Msg type="error">{error}</Msg>

      <div className="gan-aqr-actions">
        {siguiente ? (
          <button type="button" className="gan-aqr-primary" onClick={() => cambiarEstado(siguiente)} disabled={saving}>
            Marcar {ESTADO_LOTE_LABELS[siguiente]}
          </button>
        ) : null}
        {lote.estado !== 'CERRADO' ? (
          <button type="button" className="gan-aqr-secondary" onClick={() => cambiarEstado('CERRADO')} disabled={saving}>Cerrar lote</button>
        ) : null}
        {lote.tipo === 'QR_AGX' ? (
          <>
            <a className="gan-aqr-secondary" href={proveedorUrl(loteId, 'csv')}>Descargar CSV proveedor</a>
            <a className="gan-aqr-secondary" href={proveedorUrl(loteId, 'html')}>Descargar hoja imprimible (PDF)</a>
          </>
        ) : null}
      </div>

      {lote.estado === 'EN_STOCK' && lote.stock.enInventario > 0 ? (
        <form className="gan-aqr-form gan-aqr-subform" onSubmit={asignar} noValidate>
          <h4>Asignar a organización</h4>
          <label>
            <span>Organización</span>
            <select value={organizacionId} onChange={(e) => setOrganizacionId(e.target.value)} disabled={saving}>
              <option value="">Selecciona...</option>
              {organizaciones.map((o) => <option key={o.organizacionId} value={o.organizacionId}>{o.nombre}</option>)}
            </select>
          </label>
          <fieldset className="gan-aqr-radios">
            <legend>Chapetas</legend>
            <label><input type="radio" checked={modo === 'todo'} onChange={() => setModo('todo')} /> Todo el stock ({lote.stock.enInventario})</label>
            <label><input type="radio" checked={modo === 'cantidad'} onChange={() => setModo('cantidad')} /> Una cantidad (en orden del lote)</label>
            <label><input type="radio" checked={modo === 'codigos'} onChange={() => setModo('codigos')} /> Códigos específicos</label>
          </fieldset>
          {modo === 'cantidad' ? (
            <label><span>Cantidad</span><input type="number" min="1" max={lote.stock.enInventario} value={cantidad} onChange={(e) => setCantidad(e.target.value)} disabled={saving} /></label>
          ) : null}
          {modo === 'codigos' ? (
            <label><span>Códigos (uno por línea)</span><textarea rows={4} value={codigosTexto} onChange={(e) => setCodigosTexto(e.target.value)} disabled={saving} /></label>
          ) : null}
          <label><span>Referencia comercial (plan / factura, opcional)</span><input type="text" maxLength={200} value={referencia} onChange={(e) => setReferencia(e.target.value)} disabled={saving} /></label>
          <button type="submit" className="gan-aqr-primary" disabled={saving}>{saving ? 'Asignando...' : 'Asignar'}</button>
        </form>
      ) : null}

      {asignaciones.length > 0 ? (
        <>
          <h4>Asignaciones</h4>
          <ul className="gan-aqr-list">
            {asignaciones.map((a) => (
              <li key={a.asignacionId}>{formatFecha(a.creadoAt)} — {a.cantidad} a {nombreOrg(a.organizacionId)}{a.referencia ? ` (${a.referencia})` : ''}</li>
            ))}
          </ul>
        </>
      ) : null}
      <details>
        <summary>Historial del lote ({historial.length})</summary>
        <ul className="gan-aqr-list">
          {historial.map((h, index) => <li key={index}>{formatFecha(h.ocurridoEn)} — {h.tipoEvento}</li>)}
        </ul>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------
// Chapetas: búsqueda, detalle y acciones
// ---------------------------------------------------------------------

function ChapetaDetalle({ qrId, nombreOrg, onChanged }) {
  const [detalle, setDetalle] = useState(null);
  const [accion, setAccion] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [codigoNuevo, setCodigoNuevo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const load = useCallback(async () => {
    try {
      const { ok, data } = await getChapeta(qrId);
      if (ok) setDetalle(data);
      else setError(adminQrErrorMessage(data));
    } catch {
      setError(adminQrErrorMessage(null));
    }
  }, [qrId]);

  useEffect(() => {
    setDetalle(null);
    setAccion(null);
    load();
  }, [load]);

  async function confirmar(event) {
    event.preventDefault();
    if (saving) return;
    if (!motivo.trim()) {
      setError('Escribe el motivo.');
      return;
    }
    setSaving(true);
    setError('');
    setAviso('');
    try {
      if (accion === 'reemplazar') await run(() => reemplazarChapeta(qrId, { codigoNuevo, motivo: motivo.trim() }));
      else await run(() => bajaChapeta(qrId, accion, motivo.trim()));
      setAviso('Cambio registrado.');
      setAccion(null);
      setMotivo('');
      setCodigoNuevo('');
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!detalle) return <div className="gan-aqr-card"><Msg type="error">{error}</Msg></div>;
  const { chapeta, animal, historial } = detalle;
  const activa = ['EN_INVENTARIO', 'ASIGNADO_ORGANIZACION', 'ASIGNADO_ANIMAL'].includes(chapeta.estado);

  return (
    <div className="gan-aqr-card">
      <h3 className="gan-aqr-mono">{chapeta.codigoVisible}</h3>
      <dl className="gan-aqr-dl">
        <div><dt>Estado</dt><dd>{ESTADO_CHAPETA_ADMIN_LABELS[chapeta.estado]}</dd></div>
        <div><dt>Lote</dt><dd>{chapeta.codigoLote}</dd></div>
        <div><dt>Organización</dt><dd>{chapeta.organizacionId ? nombreOrg(chapeta.organizacionId) : '— (inventario central)'}</dd></div>
        <div>
          <dt>Animal</dt>
          <dd>{animal ? `${animal.numeroVisual ?? ''} ${animal.nombre ?? ''} (#${animal.animalId}${animal.estado === 'ANULADO' ? ', anulado' : ''})` : '—'}</dd>
        </div>
        {chapeta.motivo ? <div><dt>Motivo</dt><dd>{chapeta.motivo}</dd></div> : null}
      </dl>
      <Msg type="success">{aviso}</Msg>
      <Msg type="error">{error}</Msg>
      {activa && !accion ? (
        <div className="gan-aqr-actions">
          <button type="button" className="gan-aqr-secondary" onClick={() => setAccion('REVOCADO')}>Revocar</button>
          <button type="button" className="gan-aqr-secondary" onClick={() => setAccion('DANADO')}>Marcar dañada</button>
          {chapeta.estado === 'ASIGNADO_ANIMAL' ? (
            <button type="button" className="gan-aqr-secondary" onClick={() => setAccion('reemplazar')}>Reemplazar</button>
          ) : null}
        </div>
      ) : null}
      {accion ? (
        <form className="gan-aqr-form gan-aqr-subform" onSubmit={confirmar} noValidate>
          <h4>{accion === 'reemplazar' ? 'Reemplazar chapeta' : accion === 'DANADO' ? 'Marcar dañada' : 'Revocar chapeta'}</h4>
          {accion === 'reemplazar' ? (
            <label><span>Código de la chapeta nueva (de la misma organización)</span><input type="text" value={codigoNuevo} onChange={(e) => setCodigoNuevo(e.target.value)} disabled={saving} /></label>
          ) : null}
          <label><span>Motivo</span><textarea rows={2} maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} disabled={saving} /></label>
          <div className="gan-aqr-actions">
            <button type="submit" className="gan-aqr-primary" disabled={saving}>{saving ? 'Guardando...' : 'Confirmar'}</button>
            <button type="button" className="gan-aqr-secondary" onClick={() => setAccion(null)} disabled={saving}>Cancelar</button>
          </div>
        </form>
      ) : null}
      <details open>
        <summary>Historial ({historial.length})</summary>
        <ul className="gan-aqr-list">
          {historial.map((h, index) => (
            <li key={index}>{formatFecha(h.ocurridoEn)} — {h.tipoEvento}{h.metadata?.motivo ? ` (${h.metadata.motivo})` : ''}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function BuscarChapetas({ lotes, organizaciones, nombreOrg, refreshKey, onChanged }) {
  const [filtros, setFiltros] = useState({ codigo: '', estado: '', loteId: '', organizacionId: '' });
  const [resultado, setResultado] = useState(null);
  const [seleccion, setSeleccion] = useState(null);
  const [error, setError] = useState('');

  async function buscar(event) {
    event?.preventDefault();
    setError('');
    try {
      const { ok, data } = await buscarChapetas({
        codigo: filtros.codigo.trim() || undefined,
        estado: filtros.estado || undefined,
        loteId: filtros.loteId || undefined,
        organizacionId: filtros.organizacionId || undefined,
      });
      if (ok) setResultado(data);
      else setError(adminQrErrorMessage(data));
    } catch {
      setError(adminQrErrorMessage(null));
    }
  }

  const set = (key) => (e) => setFiltros((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="gan-aqr-grid">
      <div className="gan-aqr-card">
        <form className="gan-aqr-form" onSubmit={buscar} noValidate>
          <h3>Buscar chapetas</h3>
          <label><span>Código visible</span><input type="text" placeholder="AGX-7KM4-P2XZ-R" value={filtros.codigo} onChange={set('codigo')} /></label>
          <label>
            <span>Estado</span>
            <select value={filtros.estado} onChange={set('estado')}>
              <option value="">Todos</option>
              {Object.entries(ESTADO_CHAPETA_ADMIN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Lote</span>
            <select value={filtros.loteId} onChange={set('loteId')}>
              <option value="">Todos</option>
              {lotes.map((l) => <option key={l.loteId} value={l.loteId}>{l.codigoLote}</option>)}
            </select>
          </label>
          <label>
            <span>Organización</span>
            <select value={filtros.organizacionId} onChange={set('organizacionId')}>
              <option value="">Todas</option>
              {organizaciones.map((o) => <option key={o.organizacionId} value={o.organizacionId}>{o.nombre}</option>)}
            </select>
          </label>
          <Msg type="error">{error}</Msg>
          <button type="submit" className="gan-aqr-primary">Buscar</button>
        </form>
        {resultado ? (
          <>
            <p className="gan-aqr-hint">{resultado.total} chapetas{resultado.total > resultado.chapetas.length ? ` (mostrando ${resultado.chapetas.length})` : ''}</p>
            <ul className="gan-aqr-rows">
              {resultado.chapetas.map((c) => (
                <li key={c.qrId}>
                  <button type="button" className={seleccion === c.qrId ? 'is-selected' : ''} onClick={() => setSeleccion(c.qrId)}>
                    <span className="gan-aqr-mono">{c.codigoVisible}</span>
                    <span>{ESTADO_CHAPETA_ADMIN_LABELS[c.estado]}</span>
                    <span>{c.organizacionId ? nombreOrg(c.organizacionId) : 'Inventario'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      {seleccion ? (
        <ChapetaDetalle
          key={`${seleccion}-${refreshKey}`}
          qrId={seleccion}
          nombreOrg={nombreOrg}
          onChanged={() => {
            onChanged();
            buscar();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Importación legacy
// ---------------------------------------------------------------------

function ImportarLegacy({ onImported }) {
  const [desde, setDesde] = useState('1');
  const [hasta, setHasta] = useState('30');
  const [observaciones, setObservaciones] = useState('');
  const [operationId, setOperationId] = useState(newOperationId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const codigos = useMemo(() => codigosLegacyConsecutivos(desde, hasta), [desde, hasta]);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    if (!codigos) {
      setError('Rango inválido.');
      return;
    }
    if (!operationId) {
      setError('No se pudo iniciar una operación segura. Recarga la página.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data = await run(() => importarLegacy({ codigos, observaciones: observaciones.trim() || undefined, clientOperationId: operationId }));
      setOperationId(newOperationId());
      onImported(data.lote);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="gan-aqr-card gan-aqr-form" onSubmit={submit} noValidate>
      <h3>Importar chapetas legacy</h3>
      <p className="gan-aqr-hint">
        Importación controlada de códigos impresos del sistema anterior (AGX-000001 ...). Se crean como QR_LEGACY en un
        lote EN STOCK; no se migra ningún animal. Úsalo solo con autorización (staging / pruebas).
      </p>
      <div className="gan-aqr-inline">
        <label><span>Desde</span><input type="number" min="1" value={desde} onChange={(e) => setDesde(e.target.value)} disabled={saving} /></label>
        <label><span>Hasta</span><input type="number" min="1" value={hasta} onChange={(e) => setHasta(e.target.value)} disabled={saving} /></label>
      </div>
      <p className="gan-aqr-hint">{codigos ? `${codigos.length} códigos: ${codigos[0]} … ${codigos[codigos.length - 1]}` : 'Rango inválido'}</p>
      <label><span>Observaciones (opcional)</span><input type="text" maxLength={1000} value={observaciones} onChange={(e) => setObservaciones(e.target.value)} disabled={saving} /></label>
      <Msg type="error">{error}</Msg>
      <button type="submit" className="gan-aqr-primary" disabled={saving || !codigos}>{saving ? 'Importando...' : 'Importar'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------

export default function GanaderiaAdminQrInventario() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('lotes');
  const [lotes, setLotes] = useState([]);
  const [organizaciones, setOrganizaciones] = useState([]);
  const [loteSeleccionado, setLoteSeleccionado] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const loadLotes = useCallback(async () => {
    try {
      const { ok, data } = await listLotes();
      if (ok) setLotes(data.lotes ?? []);
      else setError(adminQrErrorMessage(data));
    } catch {
      setError(adminQrErrorMessage(null));
    }
  }, []);

  useEffect(() => {
    loadLotes();
    listOrganizaciones()
      .then(({ ok, data }) => { if (ok) setOrganizaciones(data.organizaciones ?? []); })
      .catch(() => {});
  }, [loadLotes]);

  const nombres = useMemo(() => new Map(organizaciones.map((o) => [o.organizacionId, o.nombre])), [organizaciones]);
  const nombreOrg = useCallback((orgId) => nombres.get(orgId) ?? `Organización ${String(orgId).slice(0, 8)}`, [nombres]);

  function changed() {
    setRefreshKey((k) => k + 1);
    loadLotes();
  }

  function loteCreado(lote, mensaje) {
    setAviso(mensaje);
    setTab('lotes');
    setLoteSeleccionado(lote.loteId);
    changed();
  }

  return (
    <div className="gan-admin-shell">
      <header className="gan-admin-topbar">
        <div>
          <span className="gan-admin-eyebrow">Administración</span>
          <h1>QR Ganadería · Inventario de chapetas</h1>
        </div>
        <button type="button" className="gan-admin-logout" onClick={() => navigate('/ganaderia/admin')}>
          <ArrowLeft size={16} />
          Volver al panel
        </button>
      </header>
      <main className="gan-admin-main">
        <nav className="gan-aqr-tabs" aria-label="Secciones del inventario">
          {[['lotes', 'Lotes'], ['chapetas', 'Chapetas'], ['legacy', 'Importar legacy']].map(([value, label]) => (
            <button key={value} type="button" className={tab === value ? 'is-active' : ''} onClick={() => setTab(value)}>{label}</button>
          ))}
        </nav>
        <Msg type="success">{aviso}</Msg>
        <Msg type="error">{error}</Msg>

        {tab === 'lotes' ? (
          <div className="gan-aqr-grid">
            <div>
              <CrearLoteForm onCreated={(lote) => loteCreado(lote, `Lote ${lote.codigoLote} creado con ${lote.cantidad} chapetas.`)} />
              <div className="gan-aqr-card">
                <h3>Lotes</h3>
                {lotes.length === 0 ? <p className="gan-aqr-hint">Todavía no hay lotes.</p> : null}
                <ul className="gan-aqr-rows">
                  {lotes.map((l) => (
                    <li key={l.loteId}>
                      <button type="button" className={loteSeleccionado === l.loteId ? 'is-selected' : ''} onClick={() => setLoteSeleccionado(l.loteId)}>
                        <span className="gan-aqr-mono">{l.codigoLote}</span>
                        <span>{ESTADO_LOTE_LABELS[l.estado]} · {ASIGNACION_LABELS[l.asignacion]}</span>
                        <span>{l.stock.enInventario}/{l.cantidad} en stock</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {loteSeleccionado ? (
              <LoteDetalle
                key={`${loteSeleccionado}-${refreshKey}`}
                loteId={loteSeleccionado}
                organizaciones={organizaciones}
                nombreOrg={nombreOrg}
                onChanged={changed}
              />
            ) : null}
          </div>
        ) : null}

        {tab === 'chapetas' ? (
          <BuscarChapetas lotes={lotes} organizaciones={organizaciones} nombreOrg={nombreOrg} refreshKey={refreshKey} onChanged={changed} />
        ) : null}

        {tab === 'legacy' ? (
          <ImportarLegacy onImported={(lote) => loteCreado(lote, `Lote legacy ${lote.codigoLote} importado (${lote.cantidad} códigos).`)} />
        ) : null}
      </main>
    </div>
  );
}
