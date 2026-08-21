// SPRINT-3D7-CAPACIDAD-PASTOREO: primera capa de decisión ganadera del
// potrero -- a partir de la ficha productiva vigente (área + aforo +
// biomasa fresca), calcula materia seca total/utilizable, demanda diaria
// del lote y, según el modo elegido, días de ocupación estimados o
// capacidad de animales para un período objetivo (§1-§20 del sprint).
//
// Solo se monta cuando ya existe una ficha productiva vigente (ver
// PotreroFichaProductivaPanel.jsx -- §26 del sprint: sin ficha, no hay
// botón de cálculo). Habla EXCLUSIVAMENTE con
// ganaderiaCapacidadPastoreoApi.js (/api/ganaderia/predios/:predioId/
// potreros/:potreroId/capacidad-pastoreo[/preview]).
//
// Flujo (§21/§22 del sprint): "Calcular" llama a POST .../preview
// (backend recalcula sobre la ficha real, NO persiste) -- el usuario
// puede ajustar parámetros y recalcular tantas veces como quiera sin
// ensuciar el histórico. "Guardar este cálculo" llama a POST .../ (crea
// una fila histórica NUEVA). Ningún resultado mostrado en pantalla se
// envía nunca de vuelta al backend como valor autoritativo -- solo los
// parámetros de entrada (§22).
//
// NO calcula todavía descanso recomendado, reentrada, rotación ni
// semáforo -- eso es SPRINT 3D8+ (§38 del sprint).
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import {
  getCapacidadPastoreo,
  previewCapacidadPastoreo,
  createCapacidadPastoreo,
} from './ganaderiaCapacidadPastoreoApi.js';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';

const CALCULO_ERROR_MESSAGES = {
  FICHA_NOT_FOUND: 'Primero registra una ficha productiva con un aforo del potrero.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
  INVALID_MODO: 'Selecciona un modo de cálculo válido.',
  INVALID_PESO_VIVO: 'El peso vivo promedio debe ser mayor que 0.',
  PESO_VIVO_TOO_HIGH: 'El peso vivo promedio supera el máximo permitido (2.000 kg).',
  INVALID_MATERIA_SECA: 'El porcentaje de materia seca debe estar entre 0 y 100.',
  INVALID_UTILIZACION: 'El porcentaje de utilización debe estar entre 0 y 100.',
  INVALID_CONSUMO: 'El consumo diario debe ser mayor que 0.',
  CONSUMO_TOO_HIGH: 'El consumo diario supera el máximo permitido (10% del peso vivo).',
  INVALID_NUMERO_ANIMALES: 'El número de animales debe ser un entero mayor o igual a 1.',
  NUMERO_ANIMALES_TOO_HIGH: 'El número de animales supera el máximo permitido (100.000).',
  INVALID_PERIODO_OBJETIVO: 'El período objetivo debe ser mayor que 0.',
  PERIODO_OBJETIVO_TOO_HIGH: 'El período objetivo supera el máximo permitido (365 días).',
  INVALID_OBSERVACIONES: 'Las observaciones son demasiado extensas.',
};

function resolveErrorMessage(code) {
  return CALCULO_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

function formatKg(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
}

function formatDias(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} días`;
}

function formatAreaHa(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha · ${(num * 10000).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`;
}

const MODO_LABELS = {
  dias_ocupacion: 'Días de ocupación',
  capacidad_animales: 'Cantidad de animales',
};

function buildBody(modo, form) {
  const body = {
    modo,
    pesoVivoPromedioKg: Number(form.pesoVivoPromedioKg),
    porcentajeMateriaSeca: Number(form.porcentajeMateriaSeca),
    porcentajeUtilizacion: Number(form.porcentajeUtilizacion),
    consumoPctPesoVivo: Number(form.consumoPctPesoVivo),
  };
  if (modo === 'dias_ocupacion') {
    body.numeroAnimales = Number(form.numeroAnimales);
  } else {
    body.periodoObjetivoDias = Number(form.periodoObjetivoDias);
  }
  return body;
}

function isFormComplete(modo, form) {
  const commonComplete = form.pesoVivoPromedioKg !== '' && form.porcentajeMateriaSeca !== ''
    && form.porcentajeUtilizacion !== '' && form.consumoPctPesoVivo !== '';
  if (!commonComplete) return false;
  return modo === 'dias_ocupacion' ? form.numeroAnimales !== '' : form.periodoObjetivoDias !== '';
}

// RESULTADOS (§19 del sprint) -- reutilizado tanto para el preview como
// para un cálculo ya guardado (actual/historial).
function ResultadoBlock({ ficha, areaHa, parametros, resultado, modo, resultadoExtremo }) {
  const areaTexto = formatAreaHa(areaHa);
  return (
    <div className="gan-ficha-preview gan-capacidad-resultado">
      {ficha ? (
        <>
          <div className="gan-ficha-row">
            <span>Basado en aforo del</span>
            <strong>{formatDateDisplay(ficha.fechaAforo || ficha.fichaCreatedAt)}</strong>
          </div>
          {areaTexto ? (
            <div className="gan-ficha-row">
              <span>Área del potrero</span>
              <strong>{areaTexto}</strong>
            </div>
          ) : null}
          <div className="gan-ficha-row">
            <span>Biomasa fresca estimada</span>
            <strong>{formatKg(ficha.biomasaFrescaKg)}</strong>
          </div>
        </>
      ) : null}

      <p className="gan-capacidad-section-label">Parámetros técnicos</p>
      <div className="gan-ficha-row">
        <span>Materia seca</span>
        <strong>{parametros.porcentajeMateriaSeca}%</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Utilización</span>
        <strong>{parametros.porcentajeUtilizacion}%</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Consumo</span>
        <strong>{parametros.consumoPctPesoVivo}% PV/día</strong>
      </div>

      <p className="gan-capacidad-section-label">Resultados</p>
      <div className="gan-ficha-row">
        <span>Materia seca total</span>
        <strong>{formatKg(resultado.materiaSecaTotalKg)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Materia seca utilizable</span>
        <strong>{formatKg(resultado.materiaSecaUtilizableKg)}</strong>
      </div>

      {modo === 'dias_ocupacion' ? (
        <>
          <div className="gan-ficha-row">
            <span>Demanda del lote</span>
            <strong>{formatKg(resultado.demandaDiariaLoteKgMs)} MS/día</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Días estimados</span>
            <strong>{formatDias(resultado.diasOcupacionEstimados)}</strong>
          </div>
        </>
      ) : (
        <div className="gan-ficha-row">
          <span>Capacidad estimada</span>
          <strong>{resultado.capacidadAnimalesPeriodo === null ? '—' : `${resultado.capacidadAnimalesPeriodo} animales`}</strong>
        </div>
      )}

      {resultadoExtremo ? (
        <StatusMessage type="warning">Revisa los parámetros ingresados; el resultado es muy bajo/alto.</StatusMessage>
      ) : null}

      <p className="gan-potrero-points-hint gan-capacidad-disclaimer">
        Estimación técnica basada en los datos y parámetros registrados. Las condiciones reales del potrero y del ganado pueden variar.
      </p>
    </div>
  );
}

const INITIAL_FORM = {
  numeroAnimales: '',
  pesoVivoPromedioKg: '',
  porcentajeMateriaSeca: '',
  porcentajeUtilizacion: '',
  consumoPctPesoVivo: '',
  periodoObjetivoDias: '',
};

export default function PotreroCapacidadPastoreoPanel({ predioId, potreroId, areaHa, tieneFicha, onCrearFicha }) {
  const [loading, setLoading] = useState(tieneFicha);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [showHistorial, setShowHistorial] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [modo, setModo] = useState('dias_ocupacion');
  const [form, setForm] = useState(INITIAL_FORM);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  function loadCalculo() {
    let active = true;
    setLoading(true);
    setLoadError('');
    getCapacidadPastoreo(predioId, potreroId)
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
          return;
        }
        setActual(data?.actual ?? null);
        setHistorial(Array.isArray(data?.historial) ? data.historial : []);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }

  // §26 del sprint: sin ficha productiva, no se permite el cálculo -- ni
  // siquiera se consulta el histórico (no puede existir uno sin ficha).
  useEffect(() => {
    if (!tieneFicha) {
      setLoading(false);
      return undefined;
    }
    return loadCalculo();
  }, [predioId, potreroId, tieneFicha]);

  function openForm() {
    setForm(INITIAL_FORM);
    setModo('dias_ocupacion');
    setPreview(null);
    setPreviewError('');
    setSaveError('');
    setShowForm(true);
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setPreview(null);
  }

  function changeModo(nextModo) {
    setModo(nextModo);
    setPreview(null);
    setPreviewError('');
  }

  async function handleCalcular() {
    if (previewLoading || !isFormComplete(modo, form)) return;
    setPreviewLoading(true);
    setPreviewError('');
    const { ok, data } = await previewCapacidadPastoreo(predioId, potreroId, buildBody(modo, form));
    setPreviewLoading(false);
    if (!ok) {
      setPreviewError(resolveErrorMessage(data?.error));
      return;
    }
    setPreview(data.preview);
  }

  async function handleGuardar() {
    if (saving || !preview) return;
    setSaving(true);
    setSaveError('');
    const { ok, data } = await createCapacidadPastoreo(predioId, potreroId, buildBody(modo, form));
    setSaving(false);
    if (!ok) {
      setSaveError(resolveErrorMessage(data?.error));
      return;
    }
    setShowForm(false);
    setPreview(null);
    loadCalculo();
  }

  // §26 del sprint: copy y botón exactos, nunca un cálculo sin ficha.
  if (!tieneFicha) {
    return (
      <div className="gan-ficha-productiva-panel gan-capacidad-panel">
        <div className="gan-ficha-productiva-empty">
          <p className="gan-potrero-points-hint">Primero registra una ficha productiva con un aforo del potrero.</p>
          <button type="button" className="gan-secondary-button" onClick={onCrearFicha}>
            Crear ficha productiva
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <p className="gan-potrero-points-hint">Cargando capacidad de pastoreo...</p>;
  }

  if (loadError) {
    return <StatusMessage type="error">{loadError}</StatusMessage>;
  }

  return (
    <div className="gan-ficha-productiva-panel gan-capacidad-panel">
      {!showForm && !actual ? (
        <div className="gan-ficha-productiva-empty">
          <button type="button" className="gan-secondary-button" onClick={openForm}>
            Calcular capacidad de pastoreo
          </button>
        </div>
      ) : null}

      {!showForm && actual ? (
        <>
          <ResultadoBlock
            ficha={{ fechaAforo: actual.fichaFechaAforo, biomasaFrescaKg: actual.fichaBiomasaFrescaKg }}
            areaHa={areaHa}
            parametros={actual}
            resultado={actual}
            modo={actual.modo}
            resultadoExtremo={actual.resultadoExtremo}
          />
          <div className="gan-potrero-actions">
            <button type="button" className="gan-secondary-button" onClick={openForm}>
              Nuevo cálculo
            </button>
            {historial.length > 0 ? (
              <button type="button" className="gan-back-inline" onClick={() => setShowHistorial((v) => !v)}>
                {showHistorial ? 'Ocultar historial' : 'Ver historial'}
              </button>
            ) : null}
          </div>
          {showHistorial && historial.length > 0 ? (
            <div className="gan-ficha-historial-list">
              {historial.map((item) => (
                <div className="gan-ficha-historial-item gan-capacidad-historial-item" key={item.calculoId}>
                  <strong>{formatDateDisplay(item.createdAt)}</strong>
                  <span>{MODO_LABELS[item.modo]}</span>
                  <span>
                    {item.modo === 'dias_ocupacion'
                      ? `${item.numeroAnimales} animales`
                      : `${item.periodoObjetivoDias} días objetivo`}
                  </span>
                  <span>{item.pesoVivoPromedioKg} kg PV</span>
                  <span>
                    {item.modo === 'dias_ocupacion'
                      ? formatDias(item.diasOcupacionEstimados)
                      : `${item.capacidadAnimalesPeriodo ?? '—'} animales`}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {showForm ? (
        <div className="gan-stack">
          <div className="gan-capacidad-modo-selector" role="radiogroup" aria-label="¿Qué quieres calcular?">
            <button
              type="button"
              className={`gan-secondary-button${modo === 'dias_ocupacion' ? ' gan-capacidad-modo-active' : ''}`}
              aria-pressed={modo === 'dias_ocupacion'}
              onClick={() => changeModo('dias_ocupacion')}
            >
              Días de ocupación
            </button>
            <button
              type="button"
              className={`gan-secondary-button${modo === 'capacidad_animales' ? ' gan-capacidad-modo-active' : ''}`}
              aria-pressed={modo === 'capacidad_animales'}
              onClick={() => changeModo('capacidad_animales')}
            >
              Cantidad de animales
            </button>
          </div>

          {modo === 'dias_ocupacion' ? (
            <FormField label="Número de animales" required>
              <input
                type="number"
                min="1"
                step="1"
                value={form.numeroAnimales}
                onChange={(event) => updateField('numeroAnimales', event.target.value)}
              />
            </FormField>
          ) : (
            <FormField label="Período objetivo (días)" required>
              <input
                type="number"
                min="0"
                max="365"
                step="any"
                value={form.periodoObjetivoDias}
                onChange={(event) => updateField('periodoObjetivoDias', event.target.value)}
              />
            </FormField>
          )}

          <FormField label="Peso vivo promedio (kg)" required>
            <input
              type="number"
              min="0"
              max="2000"
              step="any"
              value={form.pesoVivoPromedioKg}
              onChange={(event) => updateField('pesoVivoPromedioKg', event.target.value)}
            />
          </FormField>

          <FormField label="Materia seca (%)" required>
            <input
              type="number"
              min="0"
              max="100"
              step="any"
              value={form.porcentajeMateriaSeca}
              onChange={(event) => updateField('porcentajeMateriaSeca', event.target.value)}
            />
            <span className="gan-potrero-points-hint">Porcentaje estimado de materia seca del forraje al momento del aforo.</span>
          </FormField>

          <FormField label="Porcentaje de utilización (%)" required>
            <input
              type="number"
              min="0"
              max="100"
              step="any"
              value={form.porcentajeUtilizacion}
              onChange={(event) => updateField('porcentajeUtilizacion', event.target.value)}
            />
            <span className="gan-potrero-points-hint">Proporción de la materia seca que se planea aprovechar, dejando el remanente necesario en el potrero.</span>
          </FormField>

          <FormField label="Consumo diario (% del peso vivo)" required>
            <input
              type="number"
              min="0"
              max="10"
              step="any"
              value={form.consumoPctPesoVivo}
              onChange={(event) => updateField('consumoPctPesoVivo', event.target.value)}
            />
          </FormField>

          <StatusMessage type="error">{previewError}</StatusMessage>

          <div className="gan-potrero-actions">
            <button
              type="button"
              className="gan-secondary-button"
              onClick={handleCalcular}
              disabled={previewLoading || !isFormComplete(modo, form)}
            >
              {previewLoading ? 'Calculando...' : 'Calcular'}
            </button>
            <button type="button" className="gan-back-inline" onClick={() => setShowForm(false)} disabled={saving}>
              Cancelar
            </button>
          </div>

          {preview ? (
            <>
              <ResultadoBlock
                ficha={preview.ficha}
                areaHa={areaHa}
                parametros={preview.parametros}
                resultado={preview.resultado}
                modo={preview.modo}
                resultadoExtremo={preview.resultadoExtremo}
              />
              <StatusMessage type="error">{saveError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-submit" onClick={handleGuardar} disabled={saving}>
                  {saving ? 'Guardando...' : 'Guardar este cálculo'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
