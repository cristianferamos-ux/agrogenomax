// FASE 4B: pestaña "Reproducción" de la ficha. Consume EXCLUSIVAMENTE el
// backend de la Fase 4A (hatoApi.js): GET .../reproduccion y los POST
// .../eventos, .../anular, .../corregir (CSRF). Reglas, textos y body en
// reproduccionModel.js (puro, probado).
//
// - Estado reproductivo, gestación y fecha probable de parto: los entrega el
//   servidor; aquí no se recalculan.
// - Historial cronológico completo: los ANULADO siguen visibles (marcados) y
//   cada corrección enlaza original <-> corrector.
// - RBAC (solo UX; el backend responde 403 ROLE_FORBIDDEN): lector solo lee;
//   operador registra; owner/admin además anulan y corrigen.
// - Idempotencia: un clientOperationId por operación (crear, anular y
//   corregir nunca comparten uno); se conserva en un resultado incierto
//   (reintento seguro) y se descarta tras éxito o rechazo. Doble envío
//   bloqueado (ref + botones deshabilitados).
// - FASE 4E.1 sin conexión: con el historial ya descargado se lee la copia local y
//   registrar va al outbox (REPRODUCCION_EVENTO_CREAR). Con pendientes del animal,
//   registrar online también se encola para no adelantar la cadena FIFO. Un pendiente se
//   muestra aparte, como no confirmado: no cambia el estado ni la fecha probable de parto.
// - FASE 4E.2B: anular y corregir siguen la misma regla (outbox sin red o con cadena
//   pendiente). Online sin cadena van directos con identidadEsperada; si no hay resultado
//   definitivo se persisten con el MISMO clientOperationId. Corregir diferido exige
//   aceptar su advertencia. El rol y la cuenta solo gobiernan la UX: decide el servidor.
// - Toros del hato: una sola consulta al listado (sexo=MACHO), nunca N+1.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { useGanaderiaAuthOptional } from '../auth/GanaderiaAuthContext.jsx';
import { useGanaderiaPermisos } from '../auth/useGanaderiaPermisos.js';
import { mensajeDeExcepcion } from '../api/errorModel.js';
import {
  anularEventoReproductivo,
  corregirEventoReproductivo,
  getReproduccion,
  listAnimales,
  registrarEventoReproductivo,
} from './hatoApi.js';
import { formatIdentidad, newClientOperationId } from './hatoFormModel.js';
import {
  CAMPOS,
  ETIQUETAS_TIPO_EVENTO,
  LIMITE_TOROS,
  MAX_MOTIVO_ANULACION,
  MAX_OBSERVACIONES_REPRODUCCION,
  OPCIONES,
  TEXTO_CARGANDO_REPRODUCCION,
  TEXTO_SIN_EVENTOS,
  TIPOS_EVENTO_REPRODUCTIVO,
  accionesReproduccion,
  buildAnularBody,
  buildCorregirBody,
  buildCrearBody,
  camposDelFormulario,
  cambiarTipoForm,
  crearOperacionesReproduccion,
  detalleEvento,
  estadoCarga,
  etiquetaCampo,
  fechaHoraEvento,
  firmaOperacion,
  formDesdeEvento,
  formInicialEvento,
  necesitaToros,
  relacionCorreccion,
  resultadoOperacion,
  resumenEstado,
  torosDesdeListado,
  validarEvento,
  validarMotivo,
} from './reproduccionModel.js';
import {
  ADVERTENCIA_CORRECCION_DIFERIDA,
  MENSAJE_ADMIN_NO_CONFIRMADA,
  MENSAJE_ANULACION_PENDIENTE,
  MENSAJE_CORRECCION_PENDIENTE,
  MENSAJE_EVENTO_PENDIENTE,
  MENSAJE_GUARDADO_LOCAL,
  TEXTO_COPIA_LOCAL,
  TEXTO_PENDIENTES_NO_CUENTAN,
  accionesEventoPendiente,
  destinoRegistro,
  estadoEventoPendiente,
  eventoDesdePendiente,
  identidadEsperadaDe,
  leerCopiaLocal,
  operacionAdministrativaDe,
  persistenciaTrasFallo,
  tituloOperacionPendiente,
  torosLocales,
} from './reproduccionOfflineModel.js';
import { REPRODUCCION_EVENTO_ANULAR, REPRODUCCION_EVENTO_CORREGIR } from '../offline/outbox.js';
import { huboConfirmaciones, idsPendientes } from './pesajesOfflineModel.js';
import { fechaHoyNegocio } from '../engine/fechaNegocio.js';

const MENSAJE_NAVEGADOR = 'Este navegador no permite registrar de forma segura. Actualízalo e inténtalo de nuevo.';
const ACCIONES_FORMULARIO = Object.freeze(['crear', 'corregir', 'editar', 'editarCorreccion']);

function campoError(id, mensaje) {
  return mensaje ? <span id={id} className="gan-field-error" role="alert">{mensaje}</span> : null;
}

function Fila({ label, children }) {
  return (
    <div className="gan-ficha-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function EstadoReproductivo({ estado }) {
  const r = resumenEstado(estado);
  return (
    <section className="gan-repro-estado" data-estado={r.estado} aria-labelledby="repro-estado-titulo">
      <h3 id="repro-estado-titulo">Estado reproductivo</h3>
      <p className="gan-repro-estado-valor">
        <span className={`gan-repro-badge gan-repro-badge-${r.estado.toLowerCase()}`}>{r.etiqueta}</span>
        {r.desde ? <span className="gan-hato-hint"> desde {r.desde}</span> : null}
      </p>
      {r.descripcion ? <p className="gan-hato-hint">{r.descripcion}</p> : null}
      {r.filas.length ? (
        <div className="gan-hato-ficha">
          {r.filas.map(([label, valor]) => <Fila key={label} label={label}>{valor}</Fila>)}
        </div>
      ) : null}
      {r.gestacion?.length ? (
        <div className="gan-hato-ficha gan-repro-gestacion" aria-label="Gestación estimada">
          {r.gestacion.map(([label, valor]) => <Fila key={label} label={label}>{valor}</Fila>)}
          <p className="gan-hato-hint">Estimación de referencia calculada por el sistema.</p>
        </div>
      ) : null}
    </section>
  );
}

function CampoEvento({ campo, form, errores, toros, onChange, prefijo }) {
  const def = CAMPOS[campo];
  const id = `${prefijo}-${campo}`;
  const err = errores[campo];
  const comunes = {
    id,
    value: form[campo],
    'aria-invalid': err ? 'true' : undefined,
    'aria-describedby': err ? `${id}-error` : undefined,
    onChange: (event) => onChange(campo, event.target.value),
  };
  let control;
  if (def.kind === 'select') {
    control = (
      <select {...comunes} required={def.required}>
        <option value="">{def.required ? 'Selecciona...' : 'Sin dato'}</option>
        {OPCIONES[campo].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (def.kind === 'toro') {
    const actual = form[campo];
    const conocido = !actual || toros.opciones.some((o) => o.value === actual);
    control = (
      <select {...comunes}>
        <option value="">Ninguno / externo</option>
        {!conocido ? <option value={actual}>{toros.mapa.get(actual) ?? `Animal #${actual}`}</option> : null}
        {toros.opciones.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (def.kind === 'entero') {
    control = <input {...comunes} type="number" inputMode="numeric" min={def.min} max={def.max} step={1} required={def.required} />;
  } else {
    control = <input {...comunes} type="text" maxLength={def.max} autoComplete="off" />;
  }
  return (
    <label className="gan-field" htmlFor={id}>
      <span>{etiquetaCampo(form.tipoEvento, campo)}{def.required ? '' : ' (opcional)'}</span>
      {control}
      {campoError(`${id}-error`, err)}
    </label>
  );
}

/**
 * Formulario dinámico por tipo. Sirve para registrar (sin motivo) y para
 * corregir (precargado + motivo obligatorio).
 */
function FormularioEvento({ titulo, prefijo, form, setForm, errores, setErrores, toros, hoy, motivo, setMotivo, enviando, deshabilitado, aviso, textoEnviar, onEnviar, onCancelar }) {
  const update = (campo, valor) => {
    setForm((actual) => (campo === 'tipoEvento' ? cambiarTipoForm(actual, valor) : { ...actual, [campo]: valor }));
    setErrores((actual) => ({ ...actual, [campo]: undefined }));
  };
  const largoObs = String(form.observaciones ?? '').trim().length;
  const conMotivo = typeof setMotivo === 'function';
  return (
    <form className="gan-form gan-repro-form" onSubmit={onEnviar} noValidate aria-label={titulo}>
      <h4>{titulo}</h4>
      <label className="gan-field" htmlFor={`${prefijo}-tipoEvento`}>
        <span>Tipo de evento</span>
        <select
          id={`${prefijo}-tipoEvento`}
          value={form.tipoEvento}
          required
          aria-invalid={errores.tipoEvento ? 'true' : undefined}
          aria-describedby={errores.tipoEvento ? `${prefijo}-tipoEvento-error` : undefined}
          onChange={(event) => update('tipoEvento', event.target.value)}
        >
          <option value="">Selecciona...</option>
          {TIPOS_EVENTO_REPRODUCTIVO.map((t) => <option key={t} value={t}>{ETIQUETAS_TIPO_EVENTO[t]}</option>)}
        </select>
        {campoError(`${prefijo}-tipoEvento-error`, errores.tipoEvento)}
      </label>
      {form.tipoEvento ? (
        <>
          <div className="gan-repro-form-grid">
            <label className="gan-field" htmlFor={`${prefijo}-fechaEvento`}>
              <span>Fecha</span>
              <input
                id={`${prefijo}-fechaEvento`}
                type="date"
                value={form.fechaEvento}
                max={hoy}
                required
                aria-invalid={errores.fechaEvento ? 'true' : undefined}
                aria-describedby={errores.fechaEvento ? `${prefijo}-fechaEvento-error` : undefined}
                onChange={(event) => update('fechaEvento', event.target.value)}
              />
              {campoError(`${prefijo}-fechaEvento-error`, errores.fechaEvento)}
            </label>
            <label className="gan-field" htmlFor={`${prefijo}-horaEvento`}>
              <span>Hora (opcional)</span>
              <input
                id={`${prefijo}-horaEvento`}
                type="time"
                value={form.horaEvento}
                aria-invalid={errores.horaEvento ? 'true' : undefined}
                aria-describedby={errores.horaEvento ? `${prefijo}-horaEvento-error` : undefined}
                onChange={(event) => update('horaEvento', event.target.value)}
              />
              {campoError(`${prefijo}-horaEvento-error`, errores.horaEvento)}
            </label>
            {camposDelFormulario(form).map((campo) => (
              <CampoEvento key={campo} campo={campo} form={form} errores={errores} toros={toros} onChange={update} prefijo={prefijo} />
            ))}
          </div>
          <label className="gan-field" htmlFor={`${prefijo}-observaciones`}>
            <span>Observaciones (opcional)</span>
            <textarea
              id={`${prefijo}-observaciones`}
              rows={3}
              value={form.observaciones}
              aria-invalid={errores.observaciones ? 'true' : undefined}
              aria-describedby={`${prefijo}-observaciones-ayuda`}
              onChange={(event) => update('observaciones', event.target.value)}
            />
            <span id={`${prefijo}-observaciones-ayuda`} className="gan-hato-hint">{largoObs}/{MAX_OBSERVACIONES_REPRODUCCION}</span>
            {campoError(`${prefijo}-observaciones-error`, errores.observaciones)}
          </label>
        </>
      ) : null}
      {conMotivo ? (
        <label className="gan-field" htmlFor={`${prefijo}-motivo`}>
          <span>Motivo de la corrección</span>
          <textarea
            id={`${prefijo}-motivo`}
            rows={2}
            value={motivo}
            maxLength={MAX_MOTIVO_ANULACION}
            required
            aria-invalid={errores.motivo ? 'true' : undefined}
            aria-describedby={errores.motivo ? `${prefijo}-motivo-error` : undefined}
            onChange={(event) => {
              setMotivo(event.target.value);
              setErrores((actual) => ({ ...actual, motivo: undefined }));
            }}
          />
          {campoError(`${prefijo}-motivo-error`, errores.motivo)}
        </label>
      ) : null}
      <div className="gan-hato-actions gan-repro-form-acciones">
        <button type="submit" className="gan-submit" disabled={enviando || deshabilitado} aria-busy={enviando ? 'true' : undefined}>
          {enviando ? 'Guardando…' : textoEnviar}
        </button>
        <button type="button" className="gan-secondary-button" onClick={onCancelar} disabled={enviando}>Cancelar</button>
      </div>
      {aviso ? <p className="gan-hato-hint">{aviso}</p> : null}
    </form>
  );
}

function DialogoAnular({ evento, motivo, setMotivo, confirmado, setConfirmado, error, fallo, enviando, deshabilitado, aviso, textoConfirmar, onCancelar, onConfirmar }) {
  const dialogRef = useRef(null);
  const motivoRef = useRef(null);

  useEffect(() => {
    motivoRef.current?.focus();
  }, []);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!enviando) onCancelar();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...(dialogRef.current?.querySelectorAll('textarea, input, button:not([disabled])') ?? [])];
    if (!focusables.length) return;
    const primero = focusables[0];
    const ultimo = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === primero) {
      event.preventDefault();
      ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
      event.preventDefault();
      primero.focus();
    }
  }

  return (
    <div className="gan-cierre-overlay">
      <div
        ref={dialogRef}
        className="gan-cierre-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="repro-anular-titulo"
        aria-describedby="repro-anular-texto"
        onKeyDown={onKeyDown}
      >
        <h3 id="repro-anular-titulo">Anular evento</h3>
        <p id="repro-anular-texto">
          {ETIQUETAS_TIPO_EVENTO[evento.tipoEvento]} del {fechaHoraEvento(evento)}. El evento no se elimina: queda en el historial marcado como anulado y deja de contar para el estado reproductivo.
        </p>
        <label className="gan-field" htmlFor="repro-anular-motivo">
          <span>Motivo</span>
          <textarea
            id="repro-anular-motivo"
            ref={motivoRef}
            rows={3}
            value={motivo}
            maxLength={MAX_MOTIVO_ANULACION}
            required
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'repro-anular-motivo-error' : undefined}
            onChange={(event) => setMotivo(event.target.value)}
          />
          {campoError('repro-anular-motivo-error', error)}
        </label>
        <label className="gan-repro-confirmar" htmlFor="repro-anular-confirmo">
          <input id="repro-anular-confirmo" type="checkbox" checked={confirmado} onChange={(event) => setConfirmado(event.target.checked)} />
          <span>Confirmo que quiero anular este evento.</span>
        </label>
        <div aria-live="polite">{fallo ? <StatusMessage type="error">{fallo}</StatusMessage> : null}</div>
        <div className="gan-hato-actions gan-cierre-dialog-acciones">
          <button type="button" className="gan-secondary-button" onClick={onCancelar} disabled={enviando}>Cancelar</button>
          <button
            type="button"
            className="gan-submit gan-cierre-confirmar"
            onClick={onConfirmar}
            disabled={enviando || deshabilitado || !confirmado}
            aria-busy={enviando ? 'true' : undefined}
          >
            {enviando ? 'Anulando…' : textoConfirmar}
          </button>
        </div>
        {aviso ? <p className="gan-hato-hint">{aviso}</p> : null}
      </div>
    </div>
  );
}

function EventoHistorial({ evento, toros, administrar, habilitado, ocupado, operacionPendiente, onAnular, onCorregir }) {
  const anulado = evento.estadoRegistro === 'ANULADO';
  const bloqueadoPorOperacion = Boolean(operacionPendiente);
  const relacion = relacionCorreccion(evento);
  const filas = detalleEvento(evento, { toros: toros.mapa });
  return (
    <li className={`gan-repro-evento${anulado ? ' is-anulado' : ''}`} data-tipo={evento.tipoEvento} id={`repro-evento-${evento.eventoId}`}>
      <div className="gan-actividad-cabecera">
        <strong className="gan-repro-evento-tipo">{ETIQUETAS_TIPO_EVENTO[evento.tipoEvento] ?? 'Evento reproductivo'}</strong>
        <time className="gan-actividad-fecha" dateTime={evento.fechaEvento}>{fechaHoraEvento(evento)}</time>
      </div>
      <p className="gan-repro-evento-estado">
        <span className={`gan-repro-badge ${anulado ? 'gan-repro-badge-anulado' : 'gan-repro-badge-activo'}`}>{anulado ? 'Anulado' : 'Activo'}</span>
        {relacion.corrige ? <span className="gan-hato-hint">{relacion.corrige}</span> : null}
        {relacion.corregidoPor ? <span className="gan-hato-hint">{relacion.corregidoPor}</span> : null}
        {bloqueadoPorOperacion ? <span className="gan-repro-badge gan-repro-badge-pendiente">{tituloOperacionPendiente(operacionPendiente)} pendiente</span> : null}
      </p>
      {filas.length ? (
        <dl className="gan-repro-detalle">
          {filas.map(([label, valor]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {evento.observaciones ? <p className="gan-repro-observaciones">Observaciones: {evento.observaciones}</p> : null}
      {anulado && evento.anulacion?.motivo ? <p className="gan-repro-observaciones">Motivo de anulación: {evento.anulacion.motivo}</p> : null}
      {administrar && !anulado ? (
        <div className="gan-repro-evento-acciones">
          <button type="button" className="gan-repro-accion" onClick={(e) => onCorregir(evento, e)} disabled={!habilitado || ocupado || bloqueadoPorOperacion}>Corregir</button>
          <button type="button" className="gan-repro-accion gan-repro-accion-peligro" onClick={(e) => onAnular(evento, e)} disabled={!habilitado || ocupado || bloqueadoPorOperacion}>Anular evento</button>
        </div>
      ) : null}
    </li>
  );
}

function EventoPendiente({ pendiente, objetivo, toros, cuentaId, puedeRegistrar, puedeAdministrar, ocupado, onEditar, onCancelar, onReintentar }) {
  const [confirmando, setConfirmando] = useState(false);
  const evento = eventoDesdePendiente(pendiente);
  const estado = estadoEventoPendiente(pendiente);
  const acciones = accionesEventoPendiente(pendiente, { cuentaId, puedeRegistrar, puedeAdministrar });
  const filas = pendiente.tipoEvento ? detalleEvento(evento, { toros: toros.mapa }) : [];
  const tituloAdministrativo = tituloOperacionPendiente(pendiente);
  // Una anulación no trae datos propios: se describe con el evento al que apunta.
  const referencia = pendiente.tipoEvento ? pendiente : objetivo;
  return (
    <li className={`gan-repro-evento gan-repro-evento-pendiente is-${estado.clase}`} data-tipo={pendiente.tipoEvento ?? objetivo?.tipoEvento}>
      <div className="gan-actividad-cabecera">
        <strong className="gan-repro-evento-tipo">
          {tituloAdministrativo ? `${tituloAdministrativo}: ` : ''}
          {ETIQUETAS_TIPO_EVENTO[referencia?.tipoEvento] ?? 'Evento reproductivo'}
        </strong>
        {referencia?.fechaEvento ? <time className="gan-actividad-fecha" dateTime={referencia.fechaEvento}>{fechaHoraEvento(referencia)}</time> : null}
      </div>
      <p className="gan-repro-evento-estado">
        <span className={`gan-repro-badge gan-repro-badge-${estado.clase}`}>{estado.etiqueta}</span>
        <span className="gan-hato-hint">{estado.detalle}</span>
      </p>
      {filas.length ? (
        <dl className="gan-repro-detalle">
          {filas.map(([label, valor]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {pendiente.observaciones ? <p className="gan-repro-observaciones">Observaciones: {pendiente.observaciones}</p> : null}
      {pendiente.motivo ? <p className="gan-repro-observaciones">Motivo: {pendiente.motivo}</p> : null}
      {acciones.editar || acciones.cancelar || acciones.reintentar ? (
        <div className="gan-repro-evento-acciones">
          {acciones.reintentar ? <button type="button" className="gan-repro-accion" onClick={() => onReintentar(pendiente)} disabled={ocupado}>Reintentar</button> : null}
          {acciones.editar ? <button type="button" className="gan-repro-accion" onClick={(e) => onEditar(pendiente, e)} disabled={ocupado}>Editar</button> : null}
          {acciones.cancelar ? <button type="button" className="gan-repro-accion gan-repro-accion-peligro" onClick={() => setConfirmando(true)} disabled={ocupado}>Descartar</button> : null}
        </div>
      ) : null}
      {confirmando ? (
        <div className="gan-hato-actions">
          <StatusMessage type="info">
            {acciones.confirmarIncierto
              ? 'Se quitará de este dispositivo, pero pudo haberse registrado en el servidor: revisa el historial al sincronizar.'
              : `${tituloAdministrativo ? 'La operación pendiente' : 'El evento pendiente'} se eliminará de este dispositivo. No afecta al servidor.`}
          </StatusMessage>
          <button type="button" className="gan-submit" onClick={() => onCancelar(pendiente, acciones.confirmarIncierto)} disabled={ocupado}>Confirmar descarte</button>
          <button type="button" className="gan-secondary-button" onClick={() => setConfirmando(false)} disabled={ocupado}>Conservar</button>
        </div>
      ) : null}
    </li>
  );
}

export default function HatoReproduccionPanel({ animal, visible, online, repoOffline = null, syncNow = null, onCambio }) {
  const animalId = animal.animalId;
  const auth = useGanaderiaAuthOptional();
  const cuentaId = auth?.cuenta?.cuentaId ?? null;
  const permisos = useGanaderiaPermisos();
  const hoy = fechaHoyNegocio();
  const [carga, setCarga] = useState({ status: 'idle', sexo: null, estado: null, eventos: [], mensaje: null });
  const [toros, setToros] = useState({ mapa: new Map(), opciones: [] });
  const [mensaje, setMensaje] = useState(null);
  // modo: null | { accion: 'crear' } | { accion: 'corregir', evento } | { accion: 'anular', evento }
  const [modo, setModo] = useState(null);
  const [form, setForm] = useState(() => formInicialEvento('', hoy));
  const [errores, setErrores] = useState({});
  const [motivo, setMotivo] = useState('');
  const [confirmado, setConfirmado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [pendientes, setPendientes] = useState([]);
  const [registroLocal, setRegistroLocal] = useState(false);
  const [advertencia, setAdvertencia] = useState(null);
  const enviandoRef = useRef(false);
  const idsPendientesRef = useRef(new Set());
  const onCambioRef = useRef(onCambio);
  onCambioRef.current = onCambio;
  const cargadoRef = useRef(null);
  const torosRef = useRef(false);
  const abridorRef = useRef(null);
  // Un clientOperationId por tipo de operación (crearOperacionesReproduccion):
  // sobrevive a cerrar/reabrir mientras el panel esté montado.
  const operaciones = useRef(null);
  if (!operaciones.current) operaciones.current = crearOperacionesReproduccion(newClientOperationId);

  const cargar = useCallback(async () => {
    cargadoRef.current = animalId;
    setCarga((actual) => ({ ...actual, status: actual.status === 'ok' ? 'refrescando' : 'loading' }));
    let siguiente;
    try {
      siguiente = estadoCarga(await getReproduccion(animalId));
    } catch (error) {
      siguiente = estadoCarga({ ok: false, status: 0, error });
    }
    if (siguiente.status === 'error') {
      const local = await leerCopiaLocal(repoOffline, { animalId, sexo: animal.sexo, hoy }).catch(() => null);
      if (local) {
        setCarga(local);
        return;
      }
    }
    // Sin conexión se conserva lo ya cargado en memoria.
    setCarga((actual) => (siguiente.status === 'error' && actual.eventos.length ? { ...actual, status: 'ok', mensaje: siguiente.mensaje } : siguiente));
  }, [animalId, animal.sexo, hoy, repoOffline]);

  useEffect(() => {
    if (visible && cargadoRef.current !== animalId) cargar();
  }, [visible, animalId, cargar]);

  // Al volver la conexión se sustituye la copia local por los datos del servidor.
  useEffect(() => {
    if (visible && online && carga.origen === 'local') cargar();
  }, [visible, online, carga.origen, cargar]);

  const leerPendientes = useCallback(async () => {
    if (!repoOffline) return;
    let lista;
    let meta;
    try {
      [lista, meta] = await Promise.all([repoOffline.listEventosReproductivosPendientes(animalId), repoOffline.getMeta()]);
    } catch {
      return;
    }
    const ids = idsPendientes(lista);
    const cerrada = huboConfirmaciones(idsPendientesRef.current, ids);
    idsPendientesRef.current = ids;
    setPendientes(lista);
    setRegistroLocal(Boolean(meta.reproduccionListaAt));
    if (cerrada) {
      cargar();
      onCambioRef.current?.();
    }
  }, [repoOffline, animalId, cargar]);

  useEffect(() => {
    leerPendientes();
    return repoOffline ? repoOffline.subscribe(() => { leerPendientes(); }) : undefined;
  }, [repoOffline, leerPendientes]);

  const tipoFormulario = ACCIONES_FORMULARIO.includes(modo?.accion) ? form.tipoEvento : null;
  const eventosConToro = [...carga.eventos, ...pendientes.map(eventoDesdePendiente)];
  const requiereToros = necesitaToros(eventosConToro, tipoFormulario);
  useEffect(() => {
    if (torosRef.current || !requiereToros) return;
    torosRef.current = true;
    const lectura = online || !repoOffline
      ? listAnimales({ sexo: 'MACHO', estado: 'TODOS', estadoOperativo: 'TODOS', limit: LIMITE_TOROS }).then((result) => torosDesdeListado(result, formatIdentidad))
      : torosLocales(repoOffline, formatIdentidad);
    lectura.then(setToros).catch(() => { torosRef.current = false; });
  }, [requiereToros, online, repoOffline]);

  const acciones = accionesReproduccion({
    animal,
    sexo: carga.sexo,
    puedeRegistrar: permisos.registrarReproduccion,
    puedeAdministrar: permisos.administrarReproduccion,
    online,
    registroLocal: Boolean(repoOffline) && registroLocal,
  });
  const registroEnOutbox = destinoRegistro({ online, pendientes }) === 'local';

  // Cerrar NO descarta el clientOperationId: tras un resultado incierto el
  // servidor pudo haber guardado la operación, y reabrir la misma intención
  // debe reutilizar el mismo id (solo un resultado definitivo lo descarta).
  function cerrar() {
    if (enviandoRef.current) return;
    setModo(null);
    setErrores({});
    setMotivo('');
    setConfirmado(false);
    setAdvertencia(null);
    requestAnimationFrame(() => abridorRef.current?.isConnected && abridorRef.current.focus());
  }

  function abrirCrear(event) {
    abridorRef.current = event.currentTarget;
    setMensaje(null);
    setErrores({});
    setAdvertencia(null);
    setForm(formInicialEvento('', hoy));
    setModo({ accion: 'crear' });
  }

  function abrirEditarPendiente(pendiente, event) {
    abridorRef.current = event?.currentTarget ?? null;
    setMensaje(null);
    setErrores({});
    setAdvertencia(null);
    setForm(formDesdeEvento(eventoDesdePendiente(pendiente)));
    if (pendiente.tipoOperacion === REPRODUCCION_EVENTO_CORREGIR) {
      setMotivo(pendiente.motivo ?? '');
      setModo({ accion: 'editarCorreccion', pendiente });
      return;
    }
    setModo({ accion: 'editar', pendiente });
  }

  function abrirCorregir(evento, event) {
    abridorRef.current = event?.currentTarget ?? null;
    setMensaje(null);
    setErrores({});
    setAdvertencia(null);
    setMotivo('');
    setForm(formDesdeEvento(evento));
    setModo({ accion: 'corregir', evento });
  }

  function abrirAnular(evento, event) {
    abridorRef.current = event?.currentTarget ?? null;
    setMensaje(null);
    setErrores({});
    setMotivo('');
    setConfirmado(false);
    setModo({ accion: 'anular', evento });
  }

  // `conservar(id, respuesta)`: anular y corregir sin resultado definitivo se persisten
  // con el mismo id; true si ya quedó a salvo en el outbox. El envío lo lanza el motor al
  // notificar el repositorio: syncNow va forzado y se saltaría el backoff de un 408/429/5xx.
  async function ejecutar(accion, firma, enviar, conservar = null) {
    if (enviandoRef.current || !online) return;
    const clientOperationId = operaciones.current.idPara(accion, firma);
    if (!clientOperationId) {
      setMensaje({ type: 'error', text: MENSAJE_NAVEGADOR });
      return;
    }
    enviandoRef.current = true;
    setEnviando(true);
    let respuesta = null;
    let resultado;
    try {
      respuesta = await enviar(clientOperationId);
      resultado = resultadoOperacion(accion, respuesta);
    } catch {
      resultado = resultadoOperacion(accion, null);
    }
    let conservada = false;
    if (!resultado.exito && conservar) {
      try {
        conservada = await conservar(clientOperationId, respuesta);
      } catch {
        conservada = false;
      }
    }
    enviandoRef.current = false;
    setEnviando(false);
    if (conservada) {
      operaciones.current.resolver(accion, { descartarOperacion: true });
      setModo(null);
      setMotivo('');
      setConfirmado(false);
      setAdvertencia(null);
      setMensaje({ type: 'info', text: MENSAJE_ADMIN_NO_CONFIRMADA });
      // Sin red no hay backoff que respetar: comprobarlo ya actualiza la conectividad.
      if (persistenciaTrasFallo(respuesta)?.fallo?.tipo !== 'http') syncNow?.();
      return;
    }
    operaciones.current.resolver(accion, resultado);
    setMensaje({ type: resultado.exito ? 'success' : 'error', text: resultado.mensaje });
    if (resultado.exito) {
      setModo(null);
      setMotivo('');
      setConfirmado(false);
      onCambio?.();
    } else if (resultado.campo) {
      setErrores((actual) => ({ ...actual, [resultado.campo]: resultado.mensaje }));
    } else if (resultado.recargar && accion !== 'crear') {
      // El evento cambió en el servidor (ya anulado/corregido): cerrar y recargar.
      setModo(null);
    }
    if (resultado.recargar) cargar();
  }

  // Trabajo sobre el outbox: un solo guardado a la vez, y el error siempre es seguro de mostrar.
  async function enLocal(accion, fallback = MENSAJE_GUARDADO_LOCAL) {
    if (enviandoRef.current) return;
    enviandoRef.current = true;
    setEnviando(true);
    try {
      await accion();
    } catch (error) {
      setMensaje({ type: 'error', text: mensajeDeExcepcion(error, fallback) });
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  }

  function trasGuardarLocal(resultado) {
    if (resultado.requiereConfirmacion) {
      setAdvertencia(resultado.advertencia);
      return false;
    }
    setAdvertencia(null);
    setModo(null);
    setMensaje({ type: 'info', text: resultado.sinCambios ? 'No había cambios que guardar.' : MENSAJE_EVENTO_PENDIENTE });
    if (online && !resultado.sinCambios) syncNow?.();
    return true;
  }

  function guardarLocal(confirmarAdvertencia = false) {
    const clientOperationId = operaciones.current.idPara('crear', firmaOperacion('crear', { form }));
    if (!clientOperationId) {
      setMensaje({ type: 'error', text: MENSAJE_NAVEGADOR });
      return;
    }
    enLocal(async () => {
      const resultado = await repoOffline.registrarEventoReproductivoLocal({
        animalId, body: buildCrearBody(form, clientOperationId), cuentaId, confirmarAdvertencia,
      });
      if (trasGuardarLocal(resultado)) operaciones.current.resolver('crear', { descartarOperacion: true });
    });
  }

  function guardarEdicion(confirmarAdvertencia = false) {
    enLocal(async () => {
      trasGuardarLocal(await repoOffline.editarEventoReproductivoPendiente({
        operationId: modo.pendiente.localOperationId, body: buildCrearBody(form), cuentaId, confirmarAdvertencia,
      }));
    });
  }

  function cancelarPendiente(pendiente, confirmarIncierto) {
    setMensaje(null);
    enLocal(() => repoOffline.cancelarEventoReproductivoPendiente(pendiente.localOperationId, { cuentaId, confirmarIncierto }), 'No fue posible descartar el evento.');
  }

  function reintentarPendiente(pendiente) {
    setMensaje(null);
    enLocal(async () => {
      await repoOffline.reintentarEventoPendiente(pendiente.localOperationId, { cuentaId });
      if (online) syncNow?.();
    }, 'No fue posible reintentar el evento.');
  }

  function enviarEdicion(event) {
    event.preventDefault();
    const encontrados = validarEvento(form, { hoy });
    setErrores(encontrados);
    if (!Object.keys(encontrados).length) guardarEdicion();
  }

  function enviarCrear(event) {
    event.preventDefault();
    const encontrados = validarEvento(form, { hoy });
    setErrores(encontrados);
    if (Object.keys(encontrados).length) return;
    if (registroEnOutbox) {
      guardarLocal();
      return;
    }
    ejecutar('crear', firmaOperacion('crear', { form }), (id) => registrarEventoReproductivo(animalId, buildCrearBody(form, id)));
  }

  // La lectura del estado puede ir por detrás de otra pestaña: se pregunta al repositorio.
  async function debeEncolarAdministrativa() {
    if (!online) return Boolean(repoOffline);
    if (!repoOffline) return false;
    const cadena = await repoOffline.cadenaReproductiva(animalId).catch(() => pendientes);
    return destinoRegistro({ online, pendientes: cadena }) === 'local';
  }

  function datosAdministrativos(accion, id) {
    const esCorreccion = accion === 'corregir';
    return {
      tipoOperacion: esCorreccion ? REPRODUCCION_EVENTO_CORREGIR : REPRODUCCION_EVENTO_ANULAR,
      animalId,
      eventoId: modo.evento.eventoId,
      motivo,
      evento: esCorreccion ? buildCorregirBody(form, motivo, id).evento : null,
      clientOperationId: id,
      cuentaId,
      rol: permisos.rol,
    };
  }

  function encolarAdministrativa(accion, firma, confirmarAdvertencia = false) {
    const clientOperationId = operaciones.current.idPara(accion, firma);
    if (!clientOperationId) {
      setMensaje({ type: 'error', text: MENSAJE_NAVEGADOR });
      return;
    }
    enLocal(async () => {
      const resultado = await repoOffline.encolarOperacionAdministrativa({ ...datosAdministrativos(accion, clientOperationId), confirmarAdvertencia });
      if (resultado.requiereConfirmacion) {
        setAdvertencia(resultado.advertencia);
        return;
      }
      operaciones.current.resolver(accion, { descartarOperacion: true });
      setAdvertencia(null);
      setModo(null);
      setMotivo('');
      setConfirmado(false);
      setMensaje({ type: 'info', text: accion === 'corregir' ? MENSAJE_CORRECCION_PENDIENTE : MENSAJE_ANULACION_PENDIENTE });
    }, 'No se pudo guardar la operación en este dispositivo. Intenta nuevamente.');
  }

  async function conservarAdministrativa(accion, id, respuesta) {
    const persistencia = repoOffline ? persistenciaTrasFallo(respuesta) : null;
    if (!persistencia) return false;
    await repoOffline.encolarOperacionAdministrativa({ ...datosAdministrativos(accion, id), ...persistencia, confirmarAdvertencia: true });
    return true;
  }

  async function enviarAdministrativa(accion, firma, enviar) {
    if (enviandoRef.current) return;
    if (await debeEncolarAdministrativa()) {
      encolarAdministrativa(accion, firma);
      return;
    }
    ejecutar(accion, firma, enviar, (id, respuesta) => conservarAdministrativa(accion, id, respuesta));
  }

  function enviarCorregir(event) {
    event.preventDefault();
    const encontrados = validarEvento(form, { hoy });
    const errMotivo = validarMotivo(motivo);
    if (errMotivo) encontrados.motivo = errMotivo;
    setErrores(encontrados);
    if (Object.keys(encontrados).length) return;
    const { eventoId } = modo.evento;
    const identidadEsperada = identidadEsperadaDe(auth);
    enviarAdministrativa('corregir', firmaOperacion('corregir', { eventoId, form, motivo }), (id) => corregirEventoReproductivo(animalId, eventoId, { ...buildCorregirBody(form, motivo, id), ...(identidadEsperada ? { identidadEsperada } : {}) }));
  }

  function confirmarCorreccionDiferida() {
    const { eventoId } = modo.evento;
    encolarAdministrativa('corregir', firmaOperacion('corregir', { eventoId, form, motivo }), true);
  }

  function enviarEdicionCorreccion(event) {
    event.preventDefault();
    const encontrados = validarEvento(form, { hoy });
    const errMotivo = validarMotivo(motivo);
    if (errMotivo) encontrados.motivo = errMotivo;
    setErrores(encontrados);
    if (Object.keys(encontrados).length) return;
    enLocal(async () => {
      const { sinCambios } = await repoOffline.editarCorreccionPendiente({
        operationId: modo.pendiente.localOperationId, motivo, evento: buildCorregirBody(form, motivo).evento, cuentaId, rol: permisos.rol,
      });
      setModo(null);
      setMotivo('');
      setMensaje({ type: 'info', text: sinCambios ? 'No había cambios que guardar.' : MENSAJE_CORRECCION_PENDIENTE });
    }, 'No se pudo guardar la corrección en este dispositivo. Intenta nuevamente.');
  }

  function confirmarAnular() {
    const errMotivo = validarMotivo(motivo);
    setErrores(errMotivo ? { motivo: errMotivo } : {});
    if (errMotivo || !confirmado) return;
    const { eventoId } = modo.evento;
    const identidadEsperada = identidadEsperadaDe(auth);
    enviarAdministrativa('anular', firmaOperacion('anular', { eventoId, motivo }), (id) => anularEventoReproductivo(animalId, eventoId, { ...buildAnularBody(motivo, id), ...(identidadEsperada ? { identidadEsperada } : {}) }));
  }

  const formularioAbierto = ACCIONES_FORMULARIO.includes(modo?.accion);
  const accionAbierta = modo?.accion ?? null;
  // Al abrir el formulario (también desde una fila del historial) el foco va a su primer campo.
  useEffect(() => {
    if (!ACCIONES_FORMULARIO.includes(accionAbierta)) return;
    const primero = document.getElementById(`repro-${accionAbierta}-tipoEvento`);
    primero?.focus();
    primero?.scrollIntoView?.({ block: 'center' });
  }, [accionAbierta]);

  return (
    <section className="gan-repro" aria-label="Reproducción">
      <div aria-live="polite" className="gan-cierre-live">
        {mensaje && modo?.accion !== 'anular' ? <StatusMessage type={mensaje.type}>{mensaje.text}</StatusMessage> : null}
      </div>

      {carga.status === 'idle' || carga.status === 'loading' ? <StatusMessage>{TEXTO_CARGANDO_REPRODUCCION}</StatusMessage> : null}
      {carga.status === 'not_found' || carga.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">{carga.mensaje}</StatusMessage>
          {carga.status === 'error' ? <button type="button" className="gan-secondary-button" onClick={cargar}>Reintentar</button> : null}
        </div>
      ) : null}

      {carga.status === 'ok' || carga.status === 'refrescando' ? (
        <>
          {carga.mensaje ? <StatusMessage type="error">{carga.mensaje}</StatusMessage> : null}
          {carga.origen === 'local' ? <StatusMessage type="info">{TEXTO_COPIA_LOCAL}</StatusMessage> : null}
          <EstadoReproductivo estado={carga.estado} />

          {acciones.registrar && !formularioAbierto ? (
            <div className="gan-hato-actions gan-repro-acciones">
              <button type="button" className="gan-submit" onClick={abrirCrear} disabled={!acciones.registrarHabilitado} aria-describedby={acciones.aviso ? 'repro-aviso-offline' : undefined}>
                Registrar evento
              </button>
            </div>
          ) : null}
          {(acciones.registrar || acciones.administrar) && acciones.aviso ? <p id="repro-aviso-offline" className="gan-hato-hint">{acciones.aviso}</p> : null}

          {formularioAbierto ? (
            <FormularioEvento
              titulo={{ crear: 'Nuevo evento reproductivo', corregir: 'Corregir evento', editar: 'Editar evento pendiente', editarCorreccion: 'Editar corrección pendiente' }[modo.accion]}
              prefijo={`repro-${modo.accion}`}
              form={form}
              setForm={setForm}
              errores={errores}
              setErrores={setErrores}
              toros={toros}
              hoy={hoy}
              motivo={motivo}
              setMotivo={modo.accion === 'corregir' || modo.accion === 'editarCorreccion' ? setMotivo : null}
              enviando={enviando}
              deshabilitado={modo.accion === 'corregir' ? !acciones.administrarHabilitado : false}
              aviso={acciones.aviso}
              textoEnviar={{
                crear: registroEnOutbox ? 'Guardar para sincronizar' : 'Registrar evento',
                corregir: registroEnOutbox ? 'Guardar para sincronizar' : 'Guardar corrección',
                editar: 'Guardar cambios',
                editarCorreccion: 'Guardar cambios',
              }[modo.accion]}
              onEnviar={{ crear: enviarCrear, corregir: enviarCorregir, editar: enviarEdicion, editarCorreccion: enviarEdicionCorreccion }[modo.accion]}
              onCancelar={cerrar}
            />
          ) : null}
          {formularioAbierto && advertencia?.code === 'CORRECCION_DIFERIDA' ? (
            <div className="gan-hato-actions" role="alert">
              <StatusMessage type="info">{ADVERTENCIA_CORRECCION_DIFERIDA}</StatusMessage>
              <button type="button" className="gan-secondary-button" onClick={confirmarCorreccionDiferida} disabled={enviando}>Confirmar corrección pendiente</button>
            </div>
          ) : null}
          {formularioAbierto && advertencia && advertencia.code !== 'CORRECCION_DIFERIDA' ? (
            <div className="gan-hato-actions" role="alert">
              <StatusMessage type="info">{advertencia.message} Según la copia de este dispositivo, que puede estar desactualizada. El servidor decidirá al sincronizar.</StatusMessage>
              <button type="button" className="gan-secondary-button" onClick={() => (modo.accion === 'editar' ? guardarEdicion(true) : guardarLocal(true))} disabled={enviando}>Guardar de todos modos</button>
            </div>
          ) : null}
          {modo?.accion === 'corregir' ? (
            <p className="gan-hato-hint">La corrección no edita el evento: el original queda anulado en el historial y se registra uno nuevo.</p>
          ) : null}

          {pendientes.length ? (
            <section className="gan-repro-pendientes" aria-labelledby="repro-pendientes-titulo">
              <h3 id="repro-pendientes-titulo">Pendientes de sincronizar ({pendientes.length})</h3>
              <p className="gan-hato-hint">{TEXTO_PENDIENTES_NO_CUENTAN}</p>
              <ol className="gan-repro-lista">
                {pendientes.map((pendiente) => (
                  <EventoPendiente
                    key={pendiente.localOperationId}
                    pendiente={pendiente}
                    objetivo={carga.eventos.find((evento) => evento.eventoId === pendiente.eventoObjetivoId) ?? null}
                    toros={toros}
                    cuentaId={cuentaId}
                    puedeRegistrar={permisos.registrarReproduccion}
                    puedeAdministrar={permisos.administrarReproduccion}
                    ocupado={enviando || Boolean(modo)}
                    onEditar={abrirEditarPendiente}
                    onCancelar={cancelarPendiente}
                    onReintentar={reintentarPendiente}
                  />
                ))}
              </ol>
            </section>
          ) : null}

          <section className="gan-repro-historial" aria-labelledby="repro-historial-titulo">
            <h3 id="repro-historial-titulo">Historial reproductivo</h3>
            {carga.eventos.length ? (
              <ol className="gan-repro-lista" aria-busy={carga.status === 'refrescando' ? 'true' : undefined}>
                {carga.eventos.map((evento) => (
                  <EventoHistorial
                    key={evento.eventoId}
                    evento={evento}
                    toros={toros}
                    administrar={acciones.administrar}
                    habilitado={acciones.administrarHabilitado}
                    ocupado={enviando || Boolean(modo)}
                    operacionPendiente={operacionAdministrativaDe(pendientes, evento.eventoId)}
                    onAnular={abrirAnular}
                    onCorregir={abrirCorregir}
                  />
                ))}
              </ol>
            ) : (
              <p className="gan-actividad-vacio">{TEXTO_SIN_EVENTOS}</p>
            )}
          </section>
        </>
      ) : null}

      {modo?.accion === 'anular' ? (
        <DialogoAnular
          evento={modo.evento}
          motivo={motivo}
          setMotivo={(valor) => {
            setMotivo(valor);
            setErrores({});
          }}
          confirmado={confirmado}
          setConfirmado={setConfirmado}
          error={errores.motivo}
          fallo={mensaje?.type === 'error' ? mensaje.text : null}
          enviando={enviando}
          deshabilitado={!acciones.administrarHabilitado}
          aviso={acciones.aviso}
          textoConfirmar={registroEnOutbox ? 'Guardar para sincronizar' : 'Anular evento'}
          onCancelar={cerrar}
          onConfirmar={confirmarAnular}
        />
      ) : null}
    </section>
  );
}
