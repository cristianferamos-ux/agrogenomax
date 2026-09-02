// SPRINT-3D9.5: "Aforo de salida" -- residual real post-pastoreo de UN
// ciclo FINALIZADO (backend 3D9.4, potreroCicloResidualRealRepository.js).
// Responsabilidad exclusiva de este componente: cargar/registrar/comparar/
// actualizar comparativo/corregir/anular/aplicar-a-descanso + historial +
// detalle técnico de ESE ciclo. Nunca conoce estadoOperativo global, el
// ciclo EN_CURSO, ni el historial completo de ciclos -- eso lo resuelve
// PotreroCicloPastoreoPanel.jsx, que actúa como host/orquestador.
//
// ESTIMADO != MEDIDO -- este panel nunca presenta el remanente medido como
// "consumo real" (es un aforo residual, no una medición directa de
// ingestión). "Registrar aforo" nunca actualiza el descanso por sí solo --
// "Actualizar descanso con esta medición" es una acción separada y
// explícita, solo disponible con comparativoEstado COMPLETO.
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateTimeDisplay, isoToDatetimeLocalInput, datetimeLocalInputToIso } from '../utils/dateFormat.js';
import {
  getResidualReal,
  registrarResidualReal,
  actualizarComparativoResidualReal,
  corregirResidualReal,
  aplicarResidualRealADescanso,
  anularResidualReal,
} from './ganaderiaCicloPastoreoApi.js';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';
// Mismo máximo que el aforo de ingreso (ver PotreroFichaProductivaPanel.jsx,
// MAX_AFORO_G_M2) -- pequeña duplicación aceptada, mismo criterio que ya
// usa el dominio (ver potreroCicloResidualRealRepository.js).
const MAX_AFORO_G_M2 = 10000;

const RESIDUAL_ERROR_MESSAGES = {
  RESIDUAL_ANTERIOR_O_IGUAL_A_SALIDA: 'La fecha y hora deben ser posteriores a la salida del pastoreo.',
  RESIDUAL_FUTURO_INVALIDO: 'La fecha y hora no pueden ser posteriores al momento actual.',
  INVALID_NUMERO_MUESTRAS: 'El número de muestras debe ser un entero mayor o igual a 1.',
  INVALID_AFORO_PROMEDIO: `El aforo promedio debe ser un número entre 0 y ${MAX_AFORO_G_M2.toLocaleString('es-CO')}.`,
  INVALID_MEDICION_REAL_AT: 'La fecha y hora de la medición no son válidas.',
  INVALID_OBSERVACION: 'La observación no es válida.',
  COMPARATIVO_NO_COMPLETO: 'El comparativo todavía no está completo -- no se puede actualizar el descanso todavía.',
  RESIDUAL_NOT_FOUND: 'Este ciclo todavía no tiene un aforo de salida registrado.',
  CICLO_NO_FINALIZADO: 'Solo un ciclo finalizado puede tener aforo de salida.',
  CICLO_SIN_SALIDA_REAL: 'Este ciclo no tiene una salida real registrada todavía.',
  CICLO_NOT_FOUND: 'Este ciclo ya no está disponible.',
  DESCANSO_ORIGEN_NOT_FOUND: 'El descanso estimado de origen ya no está disponible.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
  INVALID_MOTIVO_ANULACION: 'Escribe el motivo de la anulación.',
  SIN_CAMBIOS_SOLICITADOS: 'Cambia al menos un dato antes de guardar la corrección.',
};

function resolveErrorMessage(code) {
  return RESIDUAL_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

// Copy en lenguaje llano por comparativoEstado -- nunca se imprime el
// enum backend. "Actualizar comparativo" solo tiene sentido cuando el
// estado depende de datos que SÍ pueden progresar solos (materia
// seca/estimado/desactualización); INCOMPATIBLE_TEMPORAL es un problema
// del propio hecho (la fecha), así que su única salida es corregir.
const COMPARATIVO_ESTADO_COPY = {
  PENDIENTE_MATERIA_SECA: 'Medición registrada. Todavía no se puede convertir a kilogramos de materia seca -- falta información de la pastura de este potrero.',
  PENDIENTE_ESTIMADO: 'Medición registrada y convertida a materia seca. Falta el plan de descanso estimado para poder compararlos.',
  DESACTUALIZADO_POR_CORRECCION: 'Se corrigió información del pastoreo después de esta medición -- el comparativo ya no refleja el estado actual.',
  INCOMPATIBLE_TEMPORAL: 'La fecha y hora de esta medición ya no son válidas frente al registro actual del pastoreo.',
};

const PUEDE_ACTUALIZAR_COMPARATIVO = new Set(['PENDIENTE_MATERIA_SECA', 'PENDIENTE_ESTIMADO', 'DESACTUALIZADO_POR_CORRECCION']);

const HISTORIAL_ESTADO_LABELS = {
  PENDIENTE_MATERIA_SECA: 'Falta materia seca',
  PENDIENTE_ESTIMADO: 'Falta estimado',
  DESACTUALIZADO_POR_CORRECCION: 'Desactualizado',
  INCOMPATIBLE_TEMPORAL: 'Fecha incompatible',
  COMPLETO: 'Completo',
};

function formatKgMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg MS`;
}

function formatKgMsSigned(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const signo = num > 0 ? '+' : '';
  return `${signo}${num.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`;
}

function formatAforo(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} g/m²`;
}

// Espejo client-side de assertNumeroMuestras/assertAforoPromedioGM2
// (potreroCicloResidualRealRepository.js) + validez del datetime --
// nunca la fuente de verdad, el backend sigue validando rango/temporalidad
// exacta contra el reloj de la base de datos.
function validateRegistroForm({ numeroMuestras, aforoPromedioGM2, medicionRealAtLocal }) {
  if (!Number.isInteger(numeroMuestras) || numeroMuestras < 1) return 'INVALID_NUMERO_MUESTRAS';
  if (!Number.isFinite(aforoPromedioGM2) || aforoPromedioGM2 < 0 || aforoPromedioGM2 > MAX_AFORO_G_M2) return 'INVALID_AFORO_PROMEDIO';
  if (!datetimeLocalInputToIso(medicionRealAtLocal)) return 'INVALID_MEDICION_REAL_AT';
  return null;
}

// Mismo patrón que DetalleTecnico en PotreroDescansoReentradaPanel.jsx --
// toggle cerrado por defecto, cada fila solo aparece si el dato existe
// (nunca "—" para un campo que simplemente no se resolvió, eso ya lo
// distingue el estado de arriba).
function DetalleTecnico({ residual, visible, onToggle }) {
  if (!residual) return null;
  return (
    <div className="gan-descanso-detalle-tecnico">
      <button type="button" className="gan-back-inline" onClick={onToggle}>
        {visible ? 'Ocultar detalle técnico' : 'Ver detalle técnico'}
      </button>
      {visible ? (
        <div className="gan-ficha-preview">
          {residual.materiaSecaPctAplicado !== null ? (
            <div className="gan-ficha-row"><span>% materia seca aplicado</span><strong>{residual.materiaSecaPctAplicado}%</strong></div>
          ) : null}
          {residual.materiaSecaFuente ? (
            <div className="gan-ficha-row"><span>Fuente de materia seca</span><strong>{residual.materiaSecaFuente}</strong></div>
          ) : null}
          {residual.remanenteEstimadoKgMsCongelado !== null ? (
            <div className="gan-ficha-row"><span>Remanente estimado (congelado)</span><strong>{formatKgMs(residual.remanenteEstimadoKgMsCongelado)}</strong></div>
          ) : null}
          {residual.remanenteMedidoKgMs !== null ? (
            <div className="gan-ficha-row"><span>Remanente medido</span><strong>{formatKgMs(residual.remanenteMedidoKgMs)}</strong></div>
          ) : null}
          {residual.errorAbsolutoKg !== null ? (
            <div className="gan-ficha-row"><span>Diferencia absoluta</span><strong>{formatKgMsSigned(residual.errorAbsolutoKg)}</strong></div>
          ) : null}
          {residual.errorPorcentual !== null ? (
            <div className="gan-ficha-row"><span>Diferencia porcentual</span><strong>{(residual.errorPorcentual * 100).toFixed(1)}%</strong></div>
          ) : null}
          <div className="gan-ficha-row"><span>Horas desde la salida</span><strong>{Number(residual.horasDesdeSalida).toFixed(1)} h</strong></div>
          {residual.snapshotLoteRealId !== null ? (
            <div className="gan-ficha-row"><span>Snapshot de lote real</span><strong>{residual.snapshotLoteRealId}</strong></div>
          ) : null}
          {residual.descansoEstimadoOrigenId !== null ? (
            <div className="gan-ficha-row"><span>Descanso estimado de origen</span><strong>{residual.descansoEstimadoOrigenId}</strong></div>
          ) : null}
          <div className="gan-ficha-row"><span>Versión</span><strong>{residual.version}</strong></div>
        </div>
      ) : null}
    </div>
  );
}

export default function PotreroResidualRealPanel({ predioId, potreroId, ciclo, destacado, onDescansoChange }) {
  const [expandido, setExpandido] = useState(Boolean(destacado));
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [historialResidual, setHistorialResidual] = useState([]);
  const [mostrarHistorial, setMostrarHistorial] = useState(false);
  const [mostrarDetalleTecnico, setMostrarDetalleTecnico] = useState(false);

  const [mostrarForm, setMostrarForm] = useState(false);
  const [numeroMuestras, setNumeroMuestras] = useState('');
  const [aforoPromedioGM2, setAforoPromedioGM2] = useState('');
  const [medicionRealAtLocal, setMedicionRealAtLocal] = useState('');
  const [observacion, setObservacion] = useState('');
  const [registrando, setRegistrando] = useState(false);
  const [registrarError, setRegistrarError] = useState('');

  const [actualizando, setActualizando] = useState(false);
  const [actualizarError, setActualizarError] = useState('');

  const [mostrarCorregir, setMostrarCorregir] = useState(false);
  const [corregirCampos, setCorregirCampos] = useState({ numeroMuestras: '', aforoPromedioGM2: '', medicionRealAtLocal: '', observacion: '' });
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [corregirError, setCorregirError] = useState('');

  const [mostrarAnular, setMostrarAnular] = useState(false);
  const [motivoAnular, setMotivoAnular] = useState('');
  const [anulando, setAnulando] = useState(false);
  const [anularError, setAnularError] = useState('');

  const [mostrarConfirmarAplicar, setMostrarConfirmarAplicar] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [aplicarError, setAplicarError] = useState('');
  const [aplicarExito, setAplicarExito] = useState(false);

  // SPRINT-3D9.5 §9: ninguna mutación puede solaparse con otra sobre el
  // MISMO residual (ej. corregir + anular a la vez) -- deriva un único
  // lock que deshabilita TODOS los CTAs de mutación, nunca solo el propio.
  // Lectura pura (detalle técnico/historial/expandir) queda fuera de esto.
  const mutando = registrando || actualizando || corrigiendo || anulando || aplicando;

  function loadResidual() {
    setLoading(true);
    setLoadError('');
    getResidualReal(predioId, potreroId, ciclo.cicloId).then(({ ok, data }) => {
      if (!ok) {
        setLoadError(GENERIC_ERROR);
        setLoading(false);
        return;
      }
      setActual(data?.actual ?? null);
      setHistorialResidual(Array.isArray(data?.historial) ? data.historial : []);
      setLoaded(true);
      setLoading(false);
    }).catch(() => {
      setLoadError(GENERIC_ERROR);
      setLoading(false);
    });
  }

  // Solo el ciclo destacado (cicloOrigenId) se carga automáticamente --
  // el resto del historial nunca dispara un GET hasta que el usuario
  // expande explícitamente esa fila (evita N+1 sobre ciclos antiguos).
  useEffect(() => {
    if (destacado) {
      setExpandido(true);
      loadResidual();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predioId, potreroId, ciclo.cicloId, destacado]);

  function handleToggleExpandir() {
    const abrir = !expandido;
    setExpandido(abrir);
    if (abrir && !loaded) loadResidual();
  }

  function resetForm() {
    setNumeroMuestras('');
    setAforoPromedioGM2('');
    setMedicionRealAtLocal(isoToDatetimeLocalInput(new Date().toISOString()));
    setObservacion('');
    setRegistrarError('');
  }

  function handleAbrirForm() {
    resetForm();
    setMostrarForm(true);
  }

  async function handleRegistrar() {
    if (mutando) return;
    const numMuestras = Number(numeroMuestras);
    const aforo = Number(aforoPromedioGM2);
    const codigoInvalido = validateRegistroForm({ numeroMuestras: numMuestras, aforoPromedioGM2: aforo, medicionRealAtLocal });
    if (codigoInvalido) {
      setRegistrarError(resolveErrorMessage(codigoInvalido));
      return;
    }
    setRegistrando(true);
    setRegistrarError('');
    const { ok, data } = await registrarResidualReal(predioId, potreroId, ciclo.cicloId, {
      numeroMuestras: numMuestras,
      aforoPromedioGM2: aforo,
      medicionRealAt: datetimeLocalInputToIso(medicionRealAtLocal),
      observacion: observacion.trim() ? observacion.trim() : undefined,
    });
    setRegistrando(false);
    if (!ok) {
      setRegistrarError(resolveErrorMessage(data?.error));
      return;
    }
    setMostrarForm(false);
    loadResidual();
    // No dispara onDescansoChange -- registrar nunca toca el descanso.
  }

  async function handleActualizarComparativo() {
    if (mutando) return;
    setActualizando(true);
    setActualizarError('');
    const { ok, data } = await actualizarComparativoResidualReal(predioId, potreroId, ciclo.cicloId);
    setActualizando(false);
    if (!ok) {
      setActualizarError(resolveErrorMessage(data?.error));
      return;
    }
    loadResidual();
    // No dispara onDescansoChange -- nunca toca el descanso (solo re-deriva el comparativo).
  }

  function handleAbrirCorregir() {
    if (!actual) return;
    setCorregirCampos({
      numeroMuestras: String(actual.numeroMuestras ?? ''),
      aforoPromedioGM2: String(actual.aforoPromedioGM2 ?? ''),
      medicionRealAtLocal: isoToDatetimeLocalInput(actual.medicionRealAt),
      observacion: actual.observacion || '',
    });
    setCorregirError('');
    setMostrarCorregir(true);
  }

  async function handleConfirmarCorregir() {
    if (mutando || !actual) return;
    // Solo se envían los campos que efectivamente cambiaron -- mismo
    // criterio que corregirCicloPastoreo. La fecha se compara por epoch
    // (no por string) porque el datetime-local reconstruido puede diferir
    // en formato exacto del ISO original pese a representar el mismo
    // instante.
    const cambios = {};
    if (corregirCampos.numeroMuestras !== '' && Number(corregirCampos.numeroMuestras) !== Number(actual.numeroMuestras)) {
      cambios.numeroMuestras = Number(corregirCampos.numeroMuestras);
    }
    if (corregirCampos.aforoPromedioGM2 !== '' && Number(corregirCampos.aforoPromedioGM2) !== Number(actual.aforoPromedioGM2)) {
      cambios.aforoPromedioGM2 = Number(corregirCampos.aforoPromedioGM2);
    }
    const medicionIso = corregirCampos.medicionRealAtLocal ? datetimeLocalInputToIso(corregirCampos.medicionRealAtLocal) : null;
    if (medicionIso && new Date(medicionIso).getTime() !== new Date(actual.medicionRealAt).getTime()) {
      cambios.medicionRealAt = medicionIso;
    }
    const observacionTrim = corregirCampos.observacion.trim();
    if (observacionTrim !== (actual.observacion || '')) {
      cambios.observacion = observacionTrim;
    }

    if (Object.keys(cambios).length === 0) {
      setCorregirError(resolveErrorMessage('SIN_CAMBIOS_SOLICITADOS'));
      return;
    }
    setCorrigiendo(true);
    setCorregirError('');
    const { ok, data } = await corregirResidualReal(predioId, potreroId, ciclo.cicloId, cambios);
    setCorrigiendo(false);
    if (!ok) {
      setCorregirError(resolveErrorMessage(data?.error));
      return;
    }
    setMostrarCorregir(false);
    loadResidual();
    if (onDescansoChange) onDescansoChange();
  }

  function handleAbrirAnular() {
    setMotivoAnular('');
    setAnularError('');
    setMostrarAnular(true);
  }

  async function handleConfirmarAnular() {
    if (mutando) return;
    if (motivoAnular.trim() === '') {
      setAnularError(resolveErrorMessage('INVALID_MOTIVO_ANULACION'));
      return;
    }
    setAnulando(true);
    setAnularError('');
    const { ok, data } = await anularResidualReal(predioId, potreroId, ciclo.cicloId, motivoAnular.trim());
    setAnulando(false);
    if (!ok) {
      setAnularError(resolveErrorMessage(data?.error));
      return;
    }
    setMostrarAnular(false);
    setAplicarExito(false);
    loadResidual();
    if (onDescansoChange) onDescansoChange();
  }

  async function handleConfirmarAplicar() {
    if (mutando) return;
    setAplicando(true);
    setAplicarError('');
    const { ok, data } = await aplicarResidualRealADescanso(predioId, potreroId, ciclo.cicloId);
    setAplicando(false);
    if (!ok) {
      setAplicarError(resolveErrorMessage(data?.error));
      return;
    }
    setMostrarConfirmarAplicar(false);
    setAplicarExito(true);
    loadResidual();
    if (onDescansoChange) onDescansoChange();
  }

  if (!expandido) {
    return (
      <div className="gan-potrero-actions">
        <button type="button" className="gan-back-inline" onClick={handleToggleExpandir}>
          Aforo de salida
        </button>
      </div>
    );
  }

  const comparativoEstado = actual?.comparativoEstado ?? null;

  return (
    <div className="gan-ficha-productiva-panel gan-residual-real-panel">
      <div className="gan-potrero-actions">
        <button type="button" className="gan-back-inline" onClick={handleToggleExpandir}>
          Ocultar aforo de salida
        </button>
      </div>

      {loading ? <p className="gan-potrero-points-hint">Cargando aforo de salida...</p> : null}
      {loadError ? <StatusMessage type="error">{loadError}</StatusMessage> : null}

      {!loading && !loadError && loaded && !actual && !mostrarForm ? (
        <div className="gan-ficha-productiva-empty">
          <p className="gan-capacidad-section-label">Aforo de salida</p>
          <p className="gan-potrero-points-hint">Aún no has registrado el aforo después del pastoreo.</p>
          <button type="button" className="gan-secondary-button" onClick={handleAbrirForm}>
            Registrar aforo
          </button>
        </div>
      ) : null}

      {mostrarForm ? (
        <div className="gan-stack">
          <FormField label="Número de muestras" required>
            <input
              type="number" min="1" step="1"
              value={numeroMuestras}
              onChange={(event) => setNumeroMuestras(event.target.value)}
              disabled={mutando}
            />
          </FormField>
          <FormField label="Aforo promedio (g/m² de materia fresca)" required>
            <input
              type="number" min="0" max={MAX_AFORO_G_M2} step="any"
              value={aforoPromedioGM2}
              onChange={(event) => setAforoPromedioGM2(event.target.value)}
              disabled={mutando}
            />
          </FormField>
          <FormField label="Fecha y hora de la medición" required>
            <input
              type="datetime-local"
              value={medicionRealAtLocal}
              onChange={(event) => setMedicionRealAtLocal(event.target.value)}
              disabled={mutando}
            />
          </FormField>
          <FormField label="Observación (opcional)">
            <textarea value={observacion} onChange={(event) => setObservacion(event.target.value)} disabled={mutando} />
          </FormField>
          <StatusMessage type="error">{registrarError}</StatusMessage>
          <div className="gan-potrero-actions">
            <button type="button" className="gan-submit" onClick={handleRegistrar} disabled={mutando}>
              {registrando ? 'Guardando...' : 'Guardar aforo'}
            </button>
            <button type="button" className="gan-back-inline" onClick={() => setMostrarForm(false)} disabled={mutando}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {!mostrarForm && actual ? (
        <div className="gan-stack">
          {comparativoEstado && comparativoEstado !== 'COMPLETO' ? (
            <StatusMessage type={comparativoEstado === 'INCOMPATIBLE_TEMPORAL' ? 'warning' : 'info'}>
              {COMPARATIVO_ESTADO_COPY[comparativoEstado]}
            </StatusMessage>
          ) : null}

          {comparativoEstado === 'COMPLETO' ? (
            <div className="gan-ficha-preview gan-descanso-plan-vs-real">
              <p className="gan-capacidad-section-label">Comparativo</p>
              <div className="gan-ficha-row"><span>Remanente estimado</span><strong>{formatKgMs(actual.remanenteEstimadoKgMsCongelado)}</strong></div>
              <div className="gan-ficha-row"><span>Remanente medido</span><strong>{formatKgMs(actual.remanenteMedidoKgMs)}</strong></div>
              <div className="gan-ficha-row"><span>Diferencia</span><strong>{formatKgMsSigned(actual.errorAbsolutoKg)}</strong></div>
              <p className="gan-potrero-points-hint">Aforo residual medido en campo después del pastoreo, no una medición directa de lo que comieron los animales.</p>
            </div>
          ) : null}

          {!mostrarConfirmarAplicar ? (
            <div className="gan-potrero-actions">
              {PUEDE_ACTUALIZAR_COMPARATIVO.has(comparativoEstado) ? (
                <button type="button" className="gan-secondary-button" onClick={handleActualizarComparativo} disabled={mutando}>
                  {actualizando ? 'Actualizando...' : 'Actualizar comparativo'}
                </button>
              ) : null}
              {comparativoEstado === 'INCOMPATIBLE_TEMPORAL' ? (
                <button type="button" className="gan-secondary-button" onClick={handleAbrirCorregir} disabled={mutando}>
                  Corregir medición
                </button>
              ) : null}
              {comparativoEstado === 'COMPLETO' ? (
                <button type="button" className="gan-submit" onClick={() => setMostrarConfirmarAplicar(true)} disabled={mutando}>
                  Actualizar descanso con esta medición
                </button>
              ) : null}
              {comparativoEstado !== 'INCOMPATIBLE_TEMPORAL' && !mostrarCorregir ? (
                <button type="button" className="gan-back-inline" onClick={handleAbrirCorregir} disabled={mutando}>
                  Corregir información
                </button>
              ) : null}
              {!mostrarAnular ? (
                <button type="button" className="gan-back-inline" onClick={handleAbrirAnular} disabled={mutando}>
                  Anular medición
                </button>
              ) : null}
            </div>
          ) : null}
          <StatusMessage type="error">{actualizarError}</StatusMessage>

          {aplicarExito ? <StatusMessage type="info">Descanso actualizado con la medición real.</StatusMessage> : null}

          {mostrarConfirmarAplicar ? (
            <div className="gan-stack">
              <StatusMessage type="info">
                Se creará una nueva versión del descanso usando el aforo medido. El cálculo anterior se conservará en el historial.
              </StatusMessage>
              <StatusMessage type="error">{aplicarError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-submit" onClick={handleConfirmarAplicar} disabled={mutando}>
                  {aplicando ? 'Actualizando...' : 'Actualizar descanso'}
                </button>
                <button type="button" className="gan-back-inline" onClick={() => setMostrarConfirmarAplicar(false)} disabled={mutando}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}

          {mostrarCorregir ? (
            <div className="gan-stack">
              <FormField label="Número de muestras">
                <input
                  type="number" min="1" step="1"
                  value={corregirCampos.numeroMuestras}
                  onChange={(event) => setCorregirCampos((c) => ({ ...c, numeroMuestras: event.target.value }))}
                  disabled={mutando}
                />
              </FormField>
              <FormField label="Aforo promedio (g/m²)">
                <input
                  type="number" min="0" max={MAX_AFORO_G_M2} step="any"
                  value={corregirCampos.aforoPromedioGM2}
                  onChange={(event) => setCorregirCampos((c) => ({ ...c, aforoPromedioGM2: event.target.value }))}
                  disabled={mutando}
                />
              </FormField>
              <FormField label="Fecha y hora de la medición">
                <input
                  type="datetime-local"
                  value={corregirCampos.medicionRealAtLocal}
                  onChange={(event) => setCorregirCampos((c) => ({ ...c, medicionRealAtLocal: event.target.value }))}
                  disabled={mutando}
                />
              </FormField>
              <FormField label="Observación">
                <textarea
                  value={corregirCampos.observacion}
                  onChange={(event) => setCorregirCampos((c) => ({ ...c, observacion: event.target.value }))}
                  disabled={mutando}
                />
              </FormField>
              <StatusMessage type="warning">
                Al corregir esta medición, el descanso que depende de ella puede quedar pendiente de actualización.
              </StatusMessage>
              <StatusMessage type="error">{corregirError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-secondary-button" onClick={handleConfirmarCorregir} disabled={mutando}>
                  {corrigiendo ? 'Guardando...' : 'Guardar corrección'}
                </button>
                <button type="button" className="gan-back-inline" onClick={() => setMostrarCorregir(false)} disabled={mutando}>
                  Volver
                </button>
              </div>
            </div>
          ) : null}

          {mostrarAnular ? (
            <div className="gan-stack">
              <FormField label="Motivo de la anulación" required>
                <input type="text" value={motivoAnular} onChange={(event) => setMotivoAnular(event.target.value)} disabled={mutando} />
              </FormField>
              <StatusMessage type="warning">
                Esta medición quedará anulada. Si un descanso depende de ella, también puede quedar invalidado.
              </StatusMessage>
              <StatusMessage type="error">{anularError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-secondary-button" onClick={handleConfirmarAnular} disabled={mutando}>
                  {anulando ? 'Anulando...' : 'Confirmar anulación'}
                </button>
                <button type="button" className="gan-back-inline" onClick={() => setMostrarAnular(false)} disabled={mutando}>
                  Volver
                </button>
              </div>
            </div>
          ) : null}

          <DetalleTecnico residual={actual} visible={mostrarDetalleTecnico} onToggle={() => setMostrarDetalleTecnico((v) => !v)} />
        </div>
      ) : null}

      {historialResidual.length > 0 ? (
        <>
          <button type="button" className="gan-back-inline" onClick={() => setMostrarHistorial((v) => !v)}>
            {mostrarHistorial ? 'Ocultar historial de cambios' : 'Ver historial de cambios'}
          </button>
          {mostrarHistorial ? (
            <div className="gan-ficha-historial-list">
              {historialResidual.map((residual) => (
                <div className="gan-ficha-historial-item" key={residual.residualId}>
                  <strong>{formatDateTimeDisplay(residual.medicionRealAt)}</strong>
                  <span>{formatAforo(residual.aforoPromedioGM2)}</span>
                  <span>{residual.remanenteMedidoKgMs !== null ? formatKgMs(residual.remanenteMedidoKgMs) : '—'}</span>
                  <span>
                    {HISTORIAL_ESTADO_LABELS[residual.comparativoEstado] || ''}
                    {residual.invalidado ? (
                      <span className="gan-ficha-chip gan-ficha-chip-readonly"> Invalidado</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
