// FASE 2B: registrar SALIDA o MUERTE del animal desde la ficha (Resumen).
// Consume EXCLUSIVAMENTE POST /api/ganaderia/animales/:id/salida | /muerte
// (hatoApi.js, CSRF; owner/admin en el servidor). Reglas y textos en
// cierreModel.js (puro, probado).
//
// Flujo en dos pasos: formulario -> "Revisar" (resumen) -> alertdialog con
// foco inicial en "Cancelar". El clientOperationId se genera al pulsar
// Revisar y se conserva en reintentos, timeout, 5xx o resultado incierto;
// solo se descarta tras éxito confirmado (también 200 yaExistia), una
// cancelación o un cambio de datos. Nunca se reintenta automáticamente y el
// doble envío está bloqueado (ref + botones deshabilitados).
//
// Accesibilidad: labels, aria-describedby/aria-invalid por campo, diálogo
// role="alertdialog" + aria-modal con focus trap, ESC = Cancelar, retorno de
// foco al botón que lo abrió y región aria-live para el estado del envío.
// Sin conexión los botones quedan deshabilitados con su aviso (no hay
// salida ni muerte offline).
import { useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { registrarMuerte, registrarSalida } from './hatoApi.js';
import { newClientOperationId } from './hatoFormModel.js';
import {
  CIERRE_CONFIG,
  MAX_OBSERVACIONES_CIERRE,
  accionesCierre,
  buildCierreBody,
  crearControlOperacion,
  etiquetaCausaCierre,
  firmaCierre,
  formInicialCierre,
  resultadoCierre,
  textoAlertaCierre,
  validarCierre,
} from './cierreModel.js';
import { formatFecha } from './pesajesModel.js';
import { fechaHoyNegocio } from '../engine/fechaNegocio.js';

const ENVIAR = Object.freeze({ SALIDA: registrarSalida, MUERTE: registrarMuerte });

function campoError(id, mensaje) {
  return mensaje ? <span id={id} className="gan-field-error" role="alert">{mensaje}</span> : null;
}

function DialogoConfirmacion({ config, texto, enviando, onCancelar, onConfirmar }) {
  const dialogRef = useRef(null);
  const cancelarRef = useRef(null);

  useEffect(() => {
    cancelarRef.current?.focus();
  }, []);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!enviando) onCancelar();
      return;
    }
    if (event.key !== 'Tab') return;
    // Focus trap: el foco nunca sale del diálogo mientras está abierto.
    const focusables = [...(dialogRef.current?.querySelectorAll('button:not([disabled])') ?? [])];
    if (!focusables.length) {
      event.preventDefault();
      return;
    }
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
        aria-labelledby="cierre-dialog-titulo"
        aria-describedby="cierre-dialog-texto"
        onKeyDown={onKeyDown}
      >
        <h3 id="cierre-dialog-titulo">{config.titulo}</h3>
        <p id="cierre-dialog-texto">{texto}</p>
        <div className="gan-hato-actions gan-cierre-dialog-acciones">
          <button ref={cancelarRef} type="button" className="gan-secondary-button" onClick={onCancelar} disabled={enviando}>
            Cancelar
          </button>
          <button type="button" className="gan-submit gan-cierre-confirmar" onClick={onConfirmar} disabled={enviando} aria-busy={enviando ? 'true' : undefined}>
            {enviando ? config.textoEnviando : config.textoConfirmar}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.animal          ficha del servidor
 * @param {string|null} props.rol        rol de la organización activa (sesión)
 * @param {boolean} props.online
 * @param {boolean} props.tieneQrActiva  el animal tiene chapeta ASIGNADO_ANIMAL
 * @param {(mensaje: string) => void} props.onCerrado  éxito confirmado (la ficha se recarga)
 * @param {() => void} props.onRecargar  la ficha cambió en el servidor (ya cerrado / anulado)
 */
export default function HatoCierreAnimal({ animal, rol, online, esLocal = false, tieneQrActiva = false, onCerrado, onRecargar }) {
  const hoy = fechaHoyNegocio();
  const [tipo, setTipo] = useState(null);
  const [paso, setPaso] = useState('form');
  const [form, setForm] = useState(() => formInicialCierre(hoy));
  const [errores, setErrores] = useState({});
  const [dialogo, setDialogo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const controlRef = useRef(null);
  if (!controlRef.current) controlRef.current = crearControlOperacion(newClientOperationId);
  const enviandoRef = useRef(false);
  const abridorRef = useRef(null);

  const acciones = accionesCierre({ animal, rol, online, esLocal });
  if (!acciones.visible && !tipo) return null;
  const config = tipo ? CIERRE_CONFIG[tipo] : null;

  function abrir(nuevoTipo) {
    controlRef.current.descartar();
    setTipo(nuevoTipo);
    setPaso('form');
    setForm(formInicialCierre(hoy));
    setErrores({});
    setMensaje(null);
  }

  function cerrarFormulario() {
    if (enviandoRef.current) return;
    controlRef.current.descartar();
    setTipo(null);
    setDialogo(false);
    setMensaje(null);
  }

  function update(campo, valor) {
    // Cambio de datos: la próxima revisión es una intención nueva.
    controlRef.current.descartar();
    setForm((actual) => ({ ...actual, [campo]: valor }));
    setErrores((actual) => (actual[campo] ? { ...actual, [campo]: undefined } : actual));
  }

  function revisar(event) {
    event.preventDefault();
    setMensaje(null);
    const { valido, errores: problemas } = validarCierre(tipo, form, { hoy, animal });
    if (!valido) {
      setErrores(problemas);
      return;
    }
    if (!controlRef.current.revisar(firmaCierre(tipo, form))) {
      setMensaje({ type: 'error', text: 'Este navegador no permite registrar de forma segura. Actualízalo e inténtalo de nuevo.' });
      return;
    }
    setPaso('revisar');
  }

  function abrirDialogo(event) {
    abridorRef.current = event.currentTarget;
    setDialogo(true);
  }

  function cancelarDialogo() {
    if (enviandoRef.current) return;
    controlRef.current.descartar();
    setDialogo(false);
    // Retorno de foco al control que abrió el diálogo (o al formulario).
    requestAnimationFrame(() => (abridorRef.current?.isConnected ? abridorRef.current : document.getElementById('cierre-fecha'))?.focus());
  }

  async function confirmar() {
    if (enviandoRef.current || !online) return;
    const clientOperationId = controlRef.current.revisar(firmaCierre(tipo, form));
    if (!clientOperationId) return;
    enviandoRef.current = true;
    setEnviando(true);
    setMensaje({ type: 'info', text: config.textoEnviando });
    let resultado;
    try {
      resultado = resultadoCierre(tipo, await ENVIAR[tipo](animal.animalId, buildCierreBody(tipo, form, clientOperationId)));
    } catch {
      resultado = resultadoCierre(tipo, null);
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
    setDialogo(false);
    if (resultado.descartarOperacion) controlRef.current.descartar();
    if (resultado.exito) {
      setTipo(null);
      setMensaje(null);
      onCerrado?.(resultado.mensaje);
      return;
    }
    if (resultado.tipo === 'CAMPO') {
      setPaso('form');
      setErrores({ [resultado.campo]: resultado.mensaje });
    }
    setMensaje({ type: 'error', text: resultado.mensaje });
    if (resultado.recargarFicha) onRecargar?.();
    requestAnimationFrame(() => abridorRef.current?.isConnected && abridorRef.current.focus());
  }

  const err = (campo) => errores[campo];
  const describedBy = (campo, extra) => [err(campo) ? `cierre-${campo}-error` : null, extra].filter(Boolean).join(' ') || undefined;
  const largoObs = form.observaciones.replace(/\r\n?/g, '\n').trim().length;

  return (
    <section className="gan-cierre" aria-labelledby="cierre-titulo">
      <h3 id="cierre-titulo" className="gan-cierre-titulo">Salida o muerte</h3>
      <div aria-live="polite" className="gan-cierre-live">
        {mensaje ? <StatusMessage type={mensaje.type}>{mensaje.text}</StatusMessage> : null}
      </div>

      {!tipo ? (
        <>
          <div className="gan-hato-actions gan-cierre-botones">
            <button type="button" className="gan-secondary-button" onClick={() => abrir('SALIDA')} disabled={!acciones.habilitado} aria-describedby={acciones.aviso ? 'cierre-aviso-offline' : undefined}>
              Registrar salida
            </button>
            <button type="button" className="gan-secondary-button" onClick={() => abrir('MUERTE')} disabled={!acciones.habilitado} aria-describedby={acciones.aviso ? 'cierre-aviso-offline' : undefined}>
              Registrar muerte
            </button>
          </div>
          {acciones.aviso ? <p id="cierre-aviso-offline" className="gan-hato-hint">{acciones.aviso}</p> : null}
        </>
      ) : null}

      {tipo && paso === 'form' ? (
        <form className="gan-form gan-cierre-form" onSubmit={revisar} noValidate aria-label={config.titulo}>
          <h4>{config.titulo}</h4>
          <label className="gan-field" htmlFor="cierre-fecha">
            <span>{config.etiquetaFecha}</span>
            <input
              id="cierre-fecha"
              type="date"
              value={form.fecha}
              max={hoy}
              required
              aria-invalid={err('fecha') ? 'true' : undefined}
              aria-describedby={describedBy('fecha')}
              onChange={(event) => update('fecha', event.target.value)}
            />
            {campoError('cierre-fecha-error', err('fecha'))}
          </label>
          <label className="gan-field" htmlFor="cierre-causa">
            <span>{config.etiquetaCausa}</span>
            <select
              id="cierre-causa"
              value={form.causa}
              required
              aria-invalid={err('causa') ? 'true' : undefined}
              aria-describedby={describedBy('causa')}
              onChange={(event) => update('causa', event.target.value)}
            >
              <option value="">Selecciona...</option>
              {config.opciones.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {campoError('cierre-causa-error', err('causa'))}
          </label>
          <label className="gan-field" htmlFor="cierre-observaciones">
            <span>Observaciones (opcional)</span>
            <textarea
              id="cierre-observaciones"
              rows={3}
              value={form.observaciones}
              aria-invalid={err('observaciones') ? 'true' : undefined}
              aria-describedby={describedBy('observaciones', 'cierre-observaciones-ayuda')}
              onChange={(event) => update('observaciones', event.target.value)}
            />
            <span id="cierre-observaciones-ayuda" className="gan-hato-hint">
              {form.causa === 'OTRA' ? 'Describe el motivo en las observaciones. ' : ''}
              {largoObs}/{MAX_OBSERVACIONES_CIERRE}
            </span>
            {campoError('cierre-observaciones-error', err('observaciones'))}
          </label>
          <div className="gan-hato-actions gan-cierre-acciones">
            <button type="submit" className="gan-submit">Revisar</button>
            <button type="button" className="gan-secondary-button" onClick={cerrarFormulario}>Cancelar</button>
          </div>
        </form>
      ) : null}

      {tipo && paso === 'revisar' ? (
        <div className="gan-cierre-revision">
          <h4>Revisa antes de confirmar</h4>
          <div className="gan-hato-ficha">
            <div className="gan-ficha-row"><span>{config.etiquetaFecha}</span><strong>{formatFecha(form.fecha)}</strong></div>
            <div className="gan-ficha-row"><span>{config.etiquetaCausa}</span><strong>{etiquetaCausaCierre(tipo, form.causa)}</strong></div>
            {form.observaciones.trim() ? <div className="gan-ficha-row"><span>Observaciones</span><strong>{form.observaciones.trim()}</strong></div> : null}
          </div>
          <div className="gan-hato-actions gan-cierre-acciones">
            <button type="button" className="gan-submit" onClick={abrirDialogo} disabled={enviando || !online}>{config.titulo}</button>
            <button type="button" className="gan-secondary-button" onClick={() => setPaso('form')} disabled={enviando}>Volver a editar</button>
            <button type="button" className="gan-secondary-button" onClick={cerrarFormulario} disabled={enviando}>Cancelar</button>
          </div>
          {!online ? <p className="gan-hato-hint">{accionesCierre({ animal, rol, online: false }).aviso}</p> : null}
        </div>
      ) : null}

      {tipo && dialogo ? (
        <DialogoConfirmacion
          config={config}
          texto={textoAlertaCierre(tipo, { tieneQrActiva })}
          enviando={enviando}
          onCancelar={cancelarDialogo}
          onConfirmar={confirmar}
        />
      ) : null}
    </section>
  );
}
