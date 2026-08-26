// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico): "Calcular descanso"
// -- se muestra dentro del flujo de recomendación automática de pastoreo,
// después de que exista una recomendación de pastoreo guardada (`actual`
// en PotreroRecomendacionPastoreoPanel.jsx). Único input del cliente:
// fecha prevista de ingreso -- el resto (ficha, contexto, recomendación de
// pastoreo, pastura, ajuste agroclimático) se resuelve SIEMPRE
// server-side.
//
// §21/§28 del hardening: el motor es RECALCULABLE -- "Actualizar
// estimación" reutiliza la MISMA fecha de ingreso ya registrada y vuelve a
// consultar las condiciones agroclimáticas actuales, nunca edita
// silenciosamente el histórico (siempre crea una fila nueva al guardar).
import { useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import {
  getDescansoReentrada,
  previewDescansoReentrada,
  createDescansoReentrada,
} from './ganaderiaDescansoReentradaApi.js';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';

const DESCANSO_ERROR_MESSAGES = {
  NO_GRAZING_RECOMMENDATION: 'Primero guarda una recomendación de pastoreo para este potrero.',
  NO_PASTURE_PROFILE: 'Esta pastura todavía no tiene un perfil de descanso con evidencia técnica suficiente. Preferimos no recomendar automáticamente antes que inventar un descanso genérico.',
  REST_UNAVAILABLE: 'No fue posible completar el cálculo de descanso con los datos disponibles.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
  INVALID_FECHA_INICIO_PASTOREO: 'Ingresa una fecha de ingreso válida.',
};

function resolveErrorMessage(code) {
  return DESCANSO_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

function formatDiasRango(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '—';
  if (min === max) return `${min} días`;
  return `${min}–${max} días`;
}

const NIVEL_CONFIANZA_LABELS = { ALTA: 'ALTA', MEDIA: 'MEDIA', BAJA: 'BAJA' };

// Condición agroclimática -- copy legible del status determinístico
// (agroClimateAssessment.js). Nunca "listo/no listo", siempre una
// clasificación de condiciones.
const AGROCLIMATE_STATUS_LABELS = {
  FAVORABLE: 'Favorable',
  NORMAL: 'Normal',
  RESTRICTIVE: 'Restrictiva',
  SEVERELY_RESTRICTIVE: 'Severamente restrictiva',
  INSUFFICIENT_DATA: 'Datos insuficientes',
};

const CONDICION_REENTRADA_LABELS = {
  CONFIRMAR_NUEVO_AFORO: 'Confirmar recuperación con un nuevo aforo antes del reingreso.',
};

function condicionReentradaLabel(condicion) {
  if (condicion.codigo === 'ALTURA_ENTRADA_REFERENCIA' && condicion.detalle?.referenceEntryHeightCm) {
    return `Referencia técnica regional de entrada: ~${condicion.detalle.referenceEntryHeightCm} cm (confirmar con altura y/o nuevo aforo, no un umbral exacto obligatorio).`;
  }
  return CONDICION_REENTRADA_LABELS[condicion.codigo] || condicion.codigo;
}

const DISCLAIMER_DESCANSO = 'Ventana ESTIMADA con las condiciones disponibles a la fecha -- no es una fecha fija ni una garantía de recuperación. Reingresar solo tras confirmar la condición real del potrero.';

// §30 del hardening territorial: "POR QUÉ" -- bullets simples en lenguaje
// llano, NUNCA percentiles/jerga técnica por defecto. Solo las reglas que
// realmente DECIDEN la clasificación (nunca los marcadores informativos
// de "sin dato", que no aportan nada al productor).
//
// SPRINT 3D8 (semantic final fix) -- VARIABLE SIGNAL vs OVERALL ASSESSMENT:
// una señal secundaria (p.ej. "lluvia reciente por debajo de lo habitual")
// NUNCA se presenta como si fuera la conclusión general cuando el status
// real es NORMAL -- su copy reconoce explícitamente ambas cosas en una
// sola oración ("las condiciones generales... aunque..."). Nunca se repite
// texto de regla técnica cruda.
const WHY_BULLET_LABELS = {
  RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT: 'Lluvia acumulada por debajo de lo habitual para este potrero en esta época del año.',
  RULE_LOCAL_RECENT_PRECIP_DEFICIT: 'Las condiciones generales se mantienen dentro del rango normal, aunque la lluvia reciente está por debajo de lo habitual.',
  RULE_LOCAL_SOIL_MOISTURE_DEFICIT: 'Humedad del suelo por debajo de lo normal para este potrero en esta época del año.',
  RULE_RECENT_RAIN_AFTER_LOCAL_DROUGHT: 'Llovió recientemente, pero el potrero viene de un período seco -- la recuperación puede ser más lenta de lo habitual.',
  RULE_LOCAL_ABOVE_NORMAL_PRECIP: 'Lluvia acumulada por encima de lo normal para este potrero en esta época del año.',
  RULE_LOCAL_ABOVE_NORMAL_MOISTURE: 'Humedad del suelo por encima de lo normal para esta época del año.',
  RULE_SPECIES_HIGH_HEAT: 'Temperatura por encima del rango favorable para la recuperación de la pastura.',
  RULE_SPECIES_TEMPERATURE_BELOW_COMPATIBLE: 'Temperatura por debajo del rango favorable para la recuperación de la pastura.',
  RULE_ABSOLUTE_GUARDRAIL_DROUGHT_PERSISTENT: 'Lluvia reciente y acumulada por debajo de un umbral conservador (todavía sin referencia histórica propia de este potrero).',
  RULE_ABSOLUTE_GUARDRAIL_SOIL_MOISTURE_LOW: 'Humedad de suelo por debajo de un umbral conservador (todavía sin referencia histórica propia de este potrero).',
};

// Frase introductoria por STATUS GENERAL -- antepuesta a las razones
// específicas, nunca las sustituye ni las duplica.
const STATUS_INTRO_BULLET = {
  RESTRICTIVE: 'La recuperación puede ser más lenta de lo habitual porque:',
  SEVERELY_RESTRICTIVE: 'Las condiciones actuales pueden limitar de forma importante la recuperación porque:',
};

const NORMAL_BASELINE_BULLET = 'Las condiciones generales se mantienen dentro del comportamiento esperado para este potrero.';

function resolveWhyBullets(appliedRules, status) {
  const codigos = new Set(appliedRules || []);
  const bullets = Object.keys(WHY_BULLET_LABELS).filter((codigo) => codigos.has(codigo)).map((codigo) => WHY_BULLET_LABELS[codigo]);

  // NORMAL sin ninguna señal secundaria que comentar -- reassurance
  // explícita en vez de una sección "Por qué" vacía/ausente.
  if (status === 'NORMAL' && bullets.length === 0) {
    return [NORMAL_BASELINE_BULLET];
  }

  const intro = STATUS_INTRO_BULLET[status];
  return intro ? [intro, ...bullets] : bullets;
}

const SIGNAL_LABELS = { FAVORABLE: 'Favorable', NORMAL: 'Normal', RESTRICTIVE: 'Restrictiva', INSUFFICIENT_DATA: 'Sin dato', RECORDED: 'Registrada' };
const LEVEL_LABELS = {
  VERY_LOW: 'muy por debajo de lo normal', LOW: 'por debajo de lo normal', NORMAL: 'dentro de lo normal', HIGH: 'por encima de lo normal', VERY_HIGH: 'muy por encima de lo normal',
};

function DetalleTecnico({ agroClimate }) {
  const [visible, setVisible] = useState(false);
  if (!agroClimate) return null;
  return (
    <div className="gan-descanso-detalle-tecnico">
      <button type="button" className="gan-back-inline" onClick={() => setVisible((v) => !v)}>
        {visible ? 'Ocultar detalle técnico' : 'Ver detalle técnico'}
      </button>
      {visible ? (
        <div className="gan-ficha-preview">
          <div className="gan-ficha-row"><span>Precipitación</span><strong>{SIGNAL_LABELS[agroClimate.precipitationSignal] || agroClimate.precipitationSignal}</strong></div>
          <div className="gan-ficha-row"><span>Humedad de suelo</span><strong>{SIGNAL_LABELS[agroClimate.soilMoistureSignal] || agroClimate.soilMoistureSignal}</strong></div>
          <div className="gan-ficha-row"><span>Temperatura</span><strong>{SIGNAL_LABELS[agroClimate.temperatureSignal] || agroClimate.temperatureSignal}</strong></div>
          <div className="gan-ficha-row">
            <span>Climatología local</span>
            <strong>{agroClimate.localClimatologyStatus === 'AVAILABLE' ? 'Disponible' : 'No disponible todavía'}</strong>
          </div>
          {agroClimate.localAnomalies?.precipitacion7dNivel ? (
            <div className="gan-ficha-row">
              <span>Precipitación 7d vs. histórico local</span>
              <strong>{LEVEL_LABELS[agroClimate.localAnomalies.precipitacion7dNivel] || agroClimate.localAnomalies.precipitacion7dNivel}</strong>
            </div>
          ) : null}
          {agroClimate.localAnomalies?.precipitacion15dNivel ? (
            <div className="gan-ficha-row">
              <span>Precipitación 15d vs. histórico local</span>
              <strong>{LEVEL_LABELS[agroClimate.localAnomalies.precipitacion15dNivel] || agroClimate.localAnomalies.precipitacion15dNivel}</strong>
            </div>
          ) : null}
          {agroClimate.localAnomalies?.precipitacion30dNivel ? (
            <div className="gan-ficha-row">
              <span>Precipitación 30d vs. histórico local</span>
              <strong>{LEVEL_LABELS[agroClimate.localAnomalies.precipitacion30dNivel] || agroClimate.localAnomalies.precipitacion30dNivel}</strong>
            </div>
          ) : null}
          <p className="gan-potrero-points-hint">Reglas aplicadas: {(agroClimate.appliedRules || []).join(', ')}</p>
        </div>
      ) : null}
    </div>
  );
}

function ResultadoDescansoBlock({ payload }) {
  const { resultado, fechaSalidaEstimada, nivelConfianza, estado, condicionesReentrada, agroClimate, windowConditions } = payload;
  const reassessment = (windowConditions || []).includes('REASSESSMENT_RECOMMENDED');
  const whyBullets = resolveWhyBullets(agroClimate?.appliedRules, agroClimate?.status);

  return (
    <div className="gan-ficha-preview gan-recomendacion-resultado">
      <p className="gan-capacidad-section-label">Descanso estimado</p>

      {reassessment ? (
        <StatusMessage type="warning">Las condiciones agroclimáticas han cambiado desde la última estimación.</StatusMessage>
      ) : null}

      <div className="gan-ficha-row">
        <span>Descanso estimado</span>
        <strong>{formatDiasRango(resultado.diasDescansoMin, resultado.diasDescansoMax)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Salida estimada</span>
        <strong>{formatDateDisplay(fechaSalidaEstimada)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Ventana estimada de reentrada</span>
        <strong>{formatDateDisplay(resultado.fechaReingresoMin)} – {formatDateDisplay(resultado.fechaReingresoMax)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Recomendación central</span>
        <strong>{formatDateDisplay(resultado.fechaReingresoRecomendada)}</strong>
      </div>
      {agroClimate ? (
        <div className="gan-ficha-row">
          <span>Condiciones actuales</span>
          <strong>{AGROCLIMATE_STATUS_LABELS[agroClimate.status] || agroClimate.status}</strong>
        </div>
      ) : null}
      <div className="gan-ficha-row">
        <span>Confianza</span>
        <strong>{NIVEL_CONFIANZA_LABELS[nivelConfianza] || nivelConfianza}</strong>
      </div>

      {whyBullets.length > 0 ? (
        <div className="gan-descanso-por-que">
          <p className="gan-capacidad-section-label">Por qué</p>
          <ul>
            {whyBullets.map((texto) => <li key={texto}>{texto}</li>)}
          </ul>
        </div>
      ) : null}

      {(condicionesReentrada || []).map((condicion) => (
        <StatusMessage type="info" key={condicion.codigo}>{condicionReentradaLabel(condicion)}</StatusMessage>
      ))}

      {estado === 'PARTIAL_CONTEXT' ? (
        <StatusMessage type="warning">Contexto agroclimático incompleto -- estimación en modo degradado.</StatusMessage>
      ) : null}
      {estado === 'NO_AGROCLIMATE_CONTEXT' ? (
        <StatusMessage type="warning">Sin contexto agroclimático de este potrero -- estimación en modo degradado.</StatusMessage>
      ) : null}
      {estado === 'STALE_AGROCLIMATE_CONTEXT' ? (
        <StatusMessage type="warning">El contexto agroclimático de este potrero ya no es reciente -- la estimación no sostiene confianza alta.</StatusMessage>
      ) : null}

      <DetalleTecnico agroClimate={agroClimate} />

      <p className="gan-potrero-points-hint gan-capacidad-disclaimer">{DISCLAIMER_DESCANSO}</p>
    </div>
  );
}

export default function PotreroDescansoReentradaPanel({ predioId, potreroId }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [fechaInicioPastoreo, setFechaInicioPastoreo] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // HARDENING OPERACIONAL §9 (round 5): preview/create ahora pueden
  // construir la referencia climática local la PRIMERA vez que se
  // calculan para este potrero -- copy simple, NUNCA jerga técnica
  // (ERA5/años/percentiles/grid). `climatologyGenerated` viaja en la
  // respuesta (potreroDescansoRepository.js); nunca se dispara un paso
  // aparte, esto solo cambia el copy mientras el MISMO cálculo está en
  // curso/terminó.
  const [climatologiaRecienGenerada, setClimatologiaRecienGenerada] = useState(false);

  function loadDescanso() {
    setLoading(true);
    setLoadError('');
    getDescansoReentrada(predioId, potreroId)
      .then(({ ok, data }) => {
        if (!ok) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
          return;
        }
        setActual(data?.actual ?? null);
        setLoaded(true);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(GENERIC_ERROR);
        setLoading(false);
      });
  }

  function handleAbrir() {
    setExpanded(true);
    if (!loaded) loadDescanso();
  }

  function handleNuevoCalculo() {
    setFechaInicioPastoreo('');
    setPreview(null);
    setPreviewError('');
    setSaveError('');
    setShowForm(true);
  }

  async function calcularPreview(fecha) {
    setPreviewLoading(true);
    setPreviewError('');
    setClimatologiaRecienGenerada(false);
    const { ok, data } = await previewDescansoReentrada(predioId, potreroId, { fechaInicioPastoreo: fecha });
    setPreviewLoading(false);
    if (!ok) {
      setPreviewError(resolveErrorMessage(data?.error));
      return;
    }
    setFechaInicioPastoreo(fecha);
    setPreview(data.preview);
    setClimatologiaRecienGenerada(Boolean(data.preview?.climatologyGenerated));
  }

  function handleCalcular() {
    if (previewLoading || !fechaInicioPastoreo) return;
    calcularPreview(fechaInicioPastoreo);
  }

  // §21/§28 del hardening: reutiliza la MISMA fecha de ingreso ya
  // registrada -- vuelve a consultar las condiciones agroclimáticas
  // actuales, nunca pide de nuevo un dato que el cliente ya aportó.
  function handleActualizarEstimacion() {
    if (!actual || previewLoading) return;
    setShowForm(true);
    calcularPreview(actual.fechaInicioPastoreo);
  }

  async function handleGuardar() {
    if (saving || !preview) return;
    setSaving(true);
    setSaveError('');
    const { ok, data } = await createDescansoReentrada(predioId, potreroId, { fechaInicioPastoreo });
    setSaving(false);
    if (!ok) {
      setSaveError(resolveErrorMessage(data?.error));
      return;
    }
    setShowForm(false);
    setPreview(null);
    loadDescanso();
  }

  if (!expanded) {
    return (
      <div className="gan-potrero-actions">
        <button type="button" className="gan-secondary-button" onClick={handleAbrir}>
          Calcular descanso
        </button>
      </div>
    );
  }

  return (
    <div className="gan-ficha-productiva-panel gan-descanso-panel">
      {loading ? <p className="gan-potrero-points-hint">Cargando descanso estimado...</p> : null}
      {loadError ? <StatusMessage type="error">{loadError}</StatusMessage> : null}

      {!loading && !loadError && !showForm && actual ? (
        <>
          <ResultadoDescansoBlock
            payload={{
              resultado: actual,
              fechaSalidaEstimada: actual.fechaSalidaEstimada,
              nivelConfianza: actual.nivelConfianza,
              estado: actual.contextoId ? 'READY' : 'NO_AGROCLIMATE_CONTEXT',
              condicionesReentrada: actual.condicionesReentrada,
              agroClimate: { status: actual.agroclimateStatus, ...actual.parametrosFuente?.agroClimate },
              windowConditions: [],
            }}
          />
          <div className="gan-potrero-actions">
            <button type="button" className="gan-secondary-button" onClick={handleActualizarEstimacion} disabled={previewLoading}>
              {previewLoading ? 'Actualizando...' : 'Actualizar estimación'}
            </button>
            <button type="button" className="gan-back-inline" onClick={handleNuevoCalculo}>
              Nuevo cálculo de descanso
            </button>
          </div>
        </>
      ) : null}

      {!loading && !loadError && !showForm && !actual ? (
        <div className="gan-ficha-productiva-empty">
          <button type="button" className="gan-secondary-button" onClick={handleNuevoCalculo}>
            Calcular descanso
          </button>
        </div>
      ) : null}

      {showForm ? (
        <div className="gan-stack">
          <FormField label="Fecha prevista de ingreso" required>
            <input
              type="date"
              value={fechaInicioPastoreo}
              onChange={(event) => { setFechaInicioPastoreo(event.target.value); setPreview(null); }}
            />
          </FormField>

          <StatusMessage type="error">{previewError}</StatusMessage>

          <div className="gan-potrero-actions">
            <button
              type="button"
              className="gan-secondary-button"
              onClick={handleCalcular}
              disabled={previewLoading || !fechaInicioPastoreo}
            >
              {previewLoading ? (actual ? 'Calculando...' : 'Construyendo referencia climática local...') : 'Calcular'}
            </button>
            <button type="button" className="gan-back-inline" onClick={() => setShowForm(false)} disabled={saving}>
              Cancelar
            </button>
          </div>

          {preview ? (
            <>
              {climatologiaRecienGenerada ? (
                <StatusMessage type="info">Referencia climática local disponible.</StatusMessage>
              ) : null}
              <ResultadoDescansoBlock payload={preview} />
              <StatusMessage type="error">{saveError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-submit" onClick={handleGuardar} disabled={saving}>
                  {saving ? 'Guardando...' : 'Guardar esta estimación'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
