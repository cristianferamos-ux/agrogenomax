// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico) + HOTFIX 3D8.1
// (AUTOMATIC GRAZING START): "Calcular descanso" -- se muestra dentro del
// flujo de recomendación automática de pastoreo, después de que exista
// una recomendación de pastoreo guardada (`actual` en
// PotreroRecomendacionPastoreoPanel.jsx).
//
// HOTFIX 3D8.1: YA NO existe un input de "fecha prevista de ingreso" --
// UN CLIC en "Calcular descanso" construye el plan completo asumiendo que
// el pastoreo inicia HOY (fecha del negocio, resuelta server-side --
// nunca la fecha del navegador). Ficha, contexto, recomendación de
// pastoreo, pastura y ajuste agroclimático se resuelven SIEMPRE
// server-side, igual que antes.
//
// §21/§28 del hardening (preservado): el motor es RECALCULABLE --
// "Actualizar estimación" refresca el descanso/reentrada con el clima
// ACTUAL sin pretender que el lote entra de nuevo hoy (ancla a la fecha
// de ingreso YA GUARDADA, §15 del hotfix) -- nunca edita silenciosamente
// el histórico (siempre crea una fila nueva al guardar).
import { useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
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
};

function resolveErrorMessage(code) {
  return DESCANSO_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

function formatDiasRango(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '—';
  if (min === max) return `${min} días`;
  return `${min}–${max} días`;
}

// HOTFIX 3D8.1 §3/§4: permanencia recomendada -- derivada de las dos
// fechas YA RESUELTAS server-side (nunca un nuevo campo persistido), para
// que tanto el preview/create recién calculado como una recomendación YA
// GUARDADA (`actual`, que solo trae fechaInicioPastoreo/fechaSalidaEstimada
// como columnas) puedan mostrar la misma fila "Permanencia recomendada".
function diffDiasIso(fechaFinIso, fechaInicioIso) {
  if (typeof fechaFinIso !== 'string' || typeof fechaInicioIso !== 'string') return null;
  const [a1, m1, d1] = fechaInicioIso.split('-').map(Number);
  const [a2, m2, d2] = fechaFinIso.split('-').map(Number);
  const inicio = Date.UTC(a1, m1 - 1, d1);
  const fin = Date.UTC(a2, m2 - 1, d2);
  if (!Number.isFinite(inicio) || !Number.isFinite(fin)) return null;
  return Math.round((fin - inicio) / (24 * 60 * 60 * 1000));
}

const NIVEL_CONFIANZA_LABELS = { ALTA: 'Alta', MEDIA: 'Media', BAJA: 'Baja' };

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

const NORMAL_BASELINE_BULLET = 'Las condiciones generales se mantienen dentro del comportamiento esperado para este potrero y esta época del año.';

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

// HOTFIX 3D8.1 §8/§9/§10: "PLAN DE PASTOREO AGROGENOMAX" -- reporte
// integrado único (lote -> pastoreo -> disponibilidad -> descanso ->
// reentrada -> condiciones -> por qué -> condición de reingreso), nunca
// bloques separados que obliguen a releer. Recibe la MISMA `payload` para
// un preview recién calculado o para `actual` (recomendación guardada).
function PlanPastoreoReport({ payload }) {
  const {
    lote, fechaInicioPastoreo, fechaSalidaEstimada, resultado, nivelConfianza, estado,
    condicionesReentrada, agroClimate, windowConditions,
  } = payload;
  const reassessment = (windowConditions || []).includes('REASSESSMENT_RECOMMENDED');
  const whyBullets = resolveWhyBullets(agroClimate?.appliedRules, agroClimate?.status);
  const permanenciaDias = diffDiasIso(fechaSalidaEstimada, fechaInicioPastoreo);

  return (
    <div className="gan-ficha-preview gan-recomendacion-resultado">
      <p className="gan-capacidad-section-label">Plan de pastoreo AgroGenomaX</p>

      {reassessment ? (
        <StatusMessage type="warning">Las condiciones agroclimáticas han cambiado desde la última estimación.</StatusMessage>
      ) : null}

      {/* LOTE + PASTOREO -- entro hoy, cuántos animales, cuántos días. */}
      {lote ? (
        <div className="gan-ficha-row"><span>Lote</span><strong>{lote.numeroAnimales} {lote.categoria} ({lote.pesoPromedioKg} kg prom.)</strong></div>
      ) : null}
      <div className="gan-ficha-row">
        <span>Ingreso</span>
        <strong>{formatDateDisplay(fechaInicioPastoreo)}</strong>
      </div>
      {Number.isFinite(permanenciaDias) ? (
        <div className="gan-ficha-row">
          <span>Permanencia recomendada</span>
          <strong>{permanenciaDias} días</strong>
        </div>
      ) : null}
      <div className="gan-ficha-row">
        <span>Salida estimada</span>
        <strong>{formatDateDisplay(fechaSalidaEstimada)}</strong>
      </div>

      {/* DESCANSO + REENTRADA -- cuánto descansa, cuándo puedo volver. */}
      <div className="gan-ficha-row">
        <span>Descanso estimado</span>
        <strong>{formatDiasRango(resultado.diasDescansoMin, resultado.diasDescansoMax)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Próxima ventana estimada de ingreso</span>
        <strong>{formatDateDisplay(resultado.fechaReingresoMin)} – {formatDateDisplay(resultado.fechaReingresoMax)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Fecha central recomendada</span>
        <strong>{formatDateDisplay(resultado.fechaReingresoRecomendada)}</strong>
      </div>

      {/* CONDICIONES */}
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

      {/* CONDICIÓN DE REINGRESO */}
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

  const [preview, setPreview] = useState(null);
  const [previewAnclado, setPreviewAnclado] = useState(false);
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

  // HOTFIX 3D8.2 (SINGLE CLICK REST CALCULATION): la causa raíz del "doble
  // clic" NO estaba en el backend (previewDescansoReentrada/resolveDescanso/
  // getOrGenerateClimatologia ya resolvían todo en UNA sola respuesta,
  // verificado con tests dedicados) -- estaba aquí: el botón "Calcular
  // descanso" del estado COLAPSADO (`handleAbrir`) solo expandía el panel y
  // hacía un GET (`loadDescanso`) para ver si ya existía una recomendación.
  // Si NO existía ninguna, el usuario veía un SEGUNDO botón "Calcular
  // descanso" que recién ahí disparaba el preview real -- dos clics para
  // lo que el usuario percibía como una sola acción. `autoCalcularSiVacio`
  // encadena el preview automáticamente EN LA MISMA acción cuando el GET
  // confirma que no hay nada que mostrar todavía -- nunca se usa en el
  // refresh posterior a un guardado exitoso (ahí sí queremos mostrar el
  // plan recién guardado, no disparar otro cálculo).
  function loadDescanso({ autoCalcularSiVacio = false } = {}) {
    setLoading(true);
    setLoadError('');
    getDescansoReentrada(predioId, potreroId)
      .then(({ ok, data }) => {
        if (!ok) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
          return;
        }
        const actualCargado = data?.actual ?? null;
        setActual(actualCargado);
        setLoaded(true);
        setLoading(false);
        if (autoCalcularSiVacio && !actualCargado) {
          calcularPreview(false);
        }
      })
      .catch(() => {
        setLoadError(GENERIC_ERROR);
        setLoading(false);
      });
  }

  function handleAbrir() {
    setExpanded(true);
    if (!loaded) loadDescanso({ autoCalcularSiVacio: true });
  }

  // HOTFIX 3D8.1 §1/§7: UN CLIC -- "Calcular descanso" ejecuta el preview
  // DIRECTAMENTE, sin pedir ninguna fecha. `anclado=true` es el modo
  // "Actualizar estimación" (§15): ancla a la fecha de ingreso YA
  // GUARDADA en vez de asumir que el lote entra hoy.
  async function calcularPreview(anclado) {
    setPreviewLoading(true);
    setPreviewError('');
    setClimatologiaRecienGenerada(false);
    const { ok, data } = await previewDescansoReentrada(predioId, potreroId, { anclarAFechaExistente: anclado });
    setPreviewLoading(false);
    if (!ok) {
      setPreviewError(resolveErrorMessage(data?.error));
      return;
    }
    setPreviewAnclado(anclado);
    setPreview(data.preview);
    setClimatologiaRecienGenerada(Boolean(data.preview?.climatologyGenerated));
    // HOTFIX 3D8.1 §14: si este recálculo vino de un intento de guardado
    // con día vencido (STALE_PREVIEW_DATE_CHANGED), el mensaje ya cumplió
    // su propósito -- el nuevo preview reemplaza al anterior.
    setSaveError('');
  }

  function handleCalcular() {
    if (previewLoading) return;
    setSaveError('');
    calcularPreview(false);
  }

  function handleActualizarEstimacion() {
    if (!actual || previewLoading) return;
    setSaveError('');
    calcularPreview(true);
  }

  function handleCancelar() {
    setPreview(null);
    setPreviewError('');
    setSaveError('');
  }

  // HOTFIX 3D8.1 §14: envía `confirmedFechaInicioPastoreo` (la fecha que
  // el usuario VIO en este preview) como eco -- si el servidor resuelve
  // una fecha distinta (cambió el día), rechaza con
  // STALE_PREVIEW_DATE_CHANGED en vez de guardar bajo otra fecha; en ese
  // caso se recalcula automáticamente y se muestra el preview nuevo.
  async function handleGuardar() {
    if (saving || !preview) return;
    setSaving(true);
    setSaveError('');
    const { ok, data } = await createDescansoReentrada(predioId, potreroId, {
      anclarAFechaExistente: previewAnclado,
      confirmedFechaInicioPastoreo: preview.fechaInicioPastoreo,
    });
    setSaving(false);
    if (!ok) {
      if (data?.error === 'STALE_PREVIEW_DATE_CHANGED') {
        setSaveError('Las condiciones cambiaron de día desde el último cálculo -- recalculando...');
        calcularPreview(previewAnclado);
        return;
      }
      setSaveError(resolveErrorMessage(data?.error));
      return;
    }
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

      {!loading && !loadError && !preview && actual ? (
        <>
          <PlanPastoreoReport
            payload={{
              lote: actual.parametrosFuente?.lote ?? null,
              fechaInicioPastoreo: actual.fechaInicioPastoreo,
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
            <button type="button" className="gan-back-inline" onClick={handleCalcular} disabled={previewLoading}>
              Nuevo cálculo de descanso
            </button>
          </div>
        </>
      ) : null}

      {!loading && !loadError && !preview && !actual ? (
        <div className="gan-ficha-productiva-empty">
          <button type="button" className="gan-secondary-button" onClick={handleCalcular} disabled={previewLoading}>
            {previewLoading ? 'Construyendo referencia climática local...' : 'Calcular descanso'}
          </button>
          <StatusMessage type="error">{previewError}</StatusMessage>
        </div>
      ) : null}

      {!loading && !loadError && previewLoading && actual ? (
        <p className="gan-potrero-points-hint">Calculando...</p>
      ) : null}

      {!loading && !loadError && preview ? (
        <div className="gan-stack">
          <StatusMessage type="error">{previewError}</StatusMessage>
          {climatologiaRecienGenerada ? (
            <StatusMessage type="info">Referencia climática local disponible.</StatusMessage>
          ) : null}
          <PlanPastoreoReport payload={preview} />
          <StatusMessage type="error">{saveError}</StatusMessage>
          <div className="gan-potrero-actions">
            <button type="button" className="gan-submit" onClick={handleGuardar} disabled={saving}>
              {saving ? 'Guardando...' : 'Guardar esta estimación'}
            </button>
            <button type="button" className="gan-back-inline" onClick={handleCancelar} disabled={saving}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
