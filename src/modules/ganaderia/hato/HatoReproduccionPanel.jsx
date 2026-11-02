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
// - Sin conexión: se ve lo ya cargado; registrar/anular/corregir quedan
//   deshabilitados con aviso. No hay outbox reproductiva (Fase 4C).
// - Toros del hato: una sola consulta al listado (sexo=MACHO), nunca N+1.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { useGanaderiaPermisos } from '../auth/useGanaderiaPermisos.js';
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
  crearControlOperacion,
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
import { fechaHoyNegocio } from '../engine/fechaNegocio.js';

const MENSAJE_NAVEGADOR = 'Este navegador no permite registrar de forma segura. Actualízalo e inténtalo de nuevo.';

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

function DialogoAnular({ evento, motivo, setMotivo, confirmado, setConfirmado, error, fallo, enviando, deshabilitado, aviso, onCancelar, onConfirmar }) {
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
            {enviando ? 'Anulando…' : 'Anular evento'}
          </button>
        </div>
        {aviso ? <p className="gan-hato-hint">{aviso}</p> : null}
      </div>
    </div>
  );
}

function EventoHistorial({ evento, toros, administrar, habilitado, ocupado, onAnular, onCorregir }) {
  const anulado = evento.estadoRegistro === 'ANULADO';
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
          <button type="button" className="gan-repro-accion" onClick={(e) => onCorregir(evento, e)} disabled={!habilitado || ocupado}>Corregir</button>
          <button type="button" className="gan-repro-accion gan-repro-accion-peligro" onClick={(e) => onAnular(evento, e)} disabled={!habilitado || ocupado}>Anular evento</button>
        </div>
      ) : null}
    </li>
  );
}

export default function HatoReproduccionPanel({ animal, visible, online, onCambio }) {
  const animalId = animal.animalId;
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
  const enviandoRef = useRef(false);
  const cargadoRef = useRef(null);
  const torosRef = useRef(false);
  const abridorRef = useRef(null);
  // Un control (y por tanto un clientOperationId) por tipo de operación.
  const controles = useRef({
    crear: crearControlOperacion(newClientOperationId),
    anular: crearControlOperacion(newClientOperationId),
    corregir: crearControlOperacion(newClientOperationId),
  });

  const cargar = useCallback(async () => {
    cargadoRef.current = animalId;
    setCarga((actual) => ({ ...actual, status: actual.status === 'ok' ? 'refrescando' : 'loading' }));
    let siguiente;
    try {
      siguiente = estadoCarga(await getReproduccion(animalId));
    } catch (error) {
      siguiente = estadoCarga({ ok: false, status: 0, error });
    }
    // Sin conexión se conserva lo ya cargado en memoria.
    setCarga((actual) => (siguiente.status === 'error' && actual.eventos.length ? { ...actual, status: 'ok', mensaje: siguiente.mensaje } : siguiente));
  }, [animalId]);

  useEffect(() => {
    if (visible && cargadoRef.current !== animalId) cargar();
  }, [visible, animalId, cargar]);

  const tipoFormulario = modo?.accion === 'crear' || modo?.accion === 'corregir' ? form.tipoEvento : null;
  useEffect(() => {
    if (torosRef.current || !necesitaToros(carga.eventos, tipoFormulario)) return;
    torosRef.current = true;
    listAnimales({ sexo: 'MACHO', estado: 'TODOS', estadoOperativo: 'TODOS', limit: LIMITE_TOROS })
      .then((result) => setToros(torosDesdeListado(result, formatIdentidad)))
      .catch(() => { torosRef.current = false; });
  }, [carga.eventos, tipoFormulario]);

  const acciones = accionesReproduccion({
    animal,
    sexo: carga.sexo,
    puedeRegistrar: permisos.registrarReproduccion,
    puedeAdministrar: permisos.administrarReproduccion,
    online,
  });

  function cerrar() {
    if (enviandoRef.current) return;
    if (modo?.accion) controles.current[modo.accion].descartar();
    setModo(null);
    setErrores({});
    setMotivo('');
    setConfirmado(false);
    requestAnimationFrame(() => abridorRef.current?.isConnected && abridorRef.current.focus());
  }

  function abrirCrear(event) {
    abridorRef.current = event.currentTarget;
    setMensaje(null);
    setErrores({});
    setForm(formInicialEvento('', hoy));
    setModo({ accion: 'crear' });
  }

  function abrirCorregir(evento, event) {
    abridorRef.current = event?.currentTarget ?? null;
    setMensaje(null);
    setErrores({});
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

  async function ejecutar(accion, firma, enviar) {
    if (enviandoRef.current || !online) return;
    const clientOperationId = controles.current[accion].revisar(firma);
    if (!clientOperationId) {
      setMensaje({ type: 'error', text: MENSAJE_NAVEGADOR });
      return;
    }
    enviandoRef.current = true;
    setEnviando(true);
    let resultado;
    try {
      resultado = resultadoOperacion(accion, await enviar(clientOperationId));
    } catch {
      resultado = resultadoOperacion(accion, null);
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
    if (resultado.descartarOperacion) controles.current[accion].descartar();
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

  function enviarCrear(event) {
    event.preventDefault();
    const encontrados = validarEvento(form, { hoy });
    setErrores(encontrados);
    if (Object.keys(encontrados).length) return;
    ejecutar('crear', firmaOperacion('crear', { form }), (id) => registrarEventoReproductivo(animalId, buildCrearBody(form, id)));
  }

  function enviarCorregir(event) {
    event.preventDefault();
    const encontrados = validarEvento(form, { hoy });
    const errMotivo = validarMotivo(motivo);
    if (errMotivo) encontrados.motivo = errMotivo;
    setErrores(encontrados);
    if (Object.keys(encontrados).length) return;
    const { eventoId } = modo.evento;
    ejecutar('corregir', firmaOperacion('corregir', { eventoId, form, motivo }), (id) => corregirEventoReproductivo(animalId, eventoId, buildCorregirBody(form, motivo, id)));
  }

  function confirmarAnular() {
    const errMotivo = validarMotivo(motivo);
    setErrores(errMotivo ? { motivo: errMotivo } : {});
    if (errMotivo || !confirmado) return;
    const { eventoId } = modo.evento;
    ejecutar('anular', firmaOperacion('anular', { eventoId, motivo }), (id) => anularEventoReproductivo(animalId, eventoId, buildAnularBody(motivo, id)));
  }

  const formularioAbierto = modo?.accion === 'crear' || modo?.accion === 'corregir';
  const accionAbierta = modo?.accion ?? null;
  // Al abrir el formulario (también desde una fila del historial) el foco va a su primer campo.
  useEffect(() => {
    if (accionAbierta !== 'crear' && accionAbierta !== 'corregir') return;
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
          <EstadoReproductivo estado={carga.estado} />

          {acciones.registrar && !formularioAbierto ? (
            <div className="gan-hato-actions gan-repro-acciones">
              <button type="button" className="gan-submit" onClick={abrirCrear} disabled={!acciones.habilitado} aria-describedby={acciones.aviso ? 'repro-aviso-offline' : undefined}>
                Registrar evento
              </button>
            </div>
          ) : null}
          {(acciones.registrar || acciones.administrar) && acciones.aviso ? <p id="repro-aviso-offline" className="gan-hato-hint">{acciones.aviso}</p> : null}

          {formularioAbierto ? (
            <FormularioEvento
              titulo={modo.accion === 'crear' ? 'Nuevo evento reproductivo' : 'Corregir evento'}
              prefijo={`repro-${modo.accion}`}
              form={form}
              setForm={setForm}
              errores={errores}
              setErrores={setErrores}
              toros={toros}
              hoy={hoy}
              motivo={motivo}
              setMotivo={modo.accion === 'corregir' ? setMotivo : null}
              enviando={enviando}
              deshabilitado={!acciones.habilitado}
              aviso={acciones.aviso}
              textoEnviar={modo.accion === 'crear' ? 'Registrar evento' : 'Guardar corrección'}
              onEnviar={modo.accion === 'crear' ? enviarCrear : enviarCorregir}
              onCancelar={cerrar}
            />
          ) : null}
          {modo?.accion === 'corregir' ? (
            <p className="gan-hato-hint">La corrección no edita el evento: el original queda anulado en el historial y se registra uno nuevo.</p>
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
                    habilitado={acciones.habilitado}
                    ocupado={enviando || Boolean(modo)}
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
          deshabilitado={!acciones.habilitado}
          aviso={acciones.aviso}
          onCancelar={cerrar}
          onConfirmar={confirmarAnular}
        />
      ) : null}
    </section>
  );
}
