// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: "Recomendación automática" --
// experiencia PRINCIPAL del motor de pastoreo (§1/§12 del sprint). El
// cliente NO diligencia % materia seca/% utilización/% consumo de peso
// vivo -- selecciona una categoría productiva (selector jerárquico, §2) y
// AgroGenomaX calcula automáticamente solo ese escenario, apoyado en la
// ficha productiva vigente + contexto agroclimático más reciente.
//
// "Modo técnico" (cálculo manual, 3D7) permanece disponible por separado
// -- ver PotreroMotorPastoreoPanel.jsx, que decide cuál de los dos se
// muestra. Este componente habla EXCLUSIVAMENTE con
// ganaderiaRecomendacionPastoreoApi.js.
//
// Flujo (§7/§16 del sprint): "Calcular" llama a POST .../preview (NO
// persiste) -- el usuario puede cambiar categoría/animales/peso y
// recalcular sin ensuciar el histórico. "Guardar esta recomendación"
// llama a POST .../ (crea una fila histórica NUEVA). Ningún resultado
// mostrado se envía nunca de vuelta como valor autoritativo -- solo
// categoriaCodigo/numeroAnimales/pesoPromedioKg y los campos condicionales
// de la categoría elegida (§7).
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import { buildGruposConCategorias } from './categoriaProductivaSelector.js';
import {
  getCategoriasProductivas,
  getRecomendacionPastoreo,
  previewRecomendacionPastoreo,
  createRecomendacionPastoreo,
} from './ganaderiaRecomendacionPastoreoApi.js';
import PotreroDescansoReentradaPanel from './PotreroDescansoReentradaPanel.jsx';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';

// §18 del sprint: estados explícitos del motor -- copy por código de error
// semántico devuelto por el backend.
const RECOMENDACION_ERROR_MESSAGES = {
  INSUFFICIENT_FORAGE_DATA: 'Primero registra una ficha productiva con un aforo del potrero.',
  NO_PRODUCTIVE_PROFILE: 'Selecciona una categoría productiva válida.',
  NO_TECHNICAL_PARAMETERS: 'Esta categoría todavía no tiene parámetros técnicos configurados.',
  CALCULATION_UNAVAILABLE: 'No fue posible completar el cálculo con los datos disponibles.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
  INVALID_CATEGORIA_CODIGO: 'Selecciona una categoría productiva válida.',
  INVALID_NUMERO_ANIMALES: 'El número de animales debe ser un entero mayor o igual a 1.',
  NUMERO_ANIMALES_TOO_HIGH: 'El número de animales supera el máximo permitido (100.000).',
  INVALID_PESO_PROMEDIO: 'El peso promedio debe ser mayor que 0.',
  PESO_PROMEDIO_TOO_HIGH: 'El peso promedio supera el máximo permitido (2.000 kg).',
  INVALID_PRODUCCION_LECHE: 'Los litros promedio por vaca/día deben estar entre 0 y 60.',
  INVALID_DIAS_EN_LECHE: 'Los días en leche deben ser un número mayor que 0.',
  MISSING_PRODUCCION_LECHE: 'Esta categoría requiere el promedio de litros/vaca/día -- lo exige la ecuación de cálculo.',
  MISSING_DIAS_EN_LECHE: 'Si aportas el %grasa de la leche, también debes indicar los días en leche.',
  INVALID_GRASA_LECHE: 'El %grasa de la leche debe ser un número entre 0 y 10.',
  MISSING_TERNERO_AL_PIE: 'Indica si hay ternero al pie.',
  PESO_FUERA_DE_RANGO_CATEGORIA: 'El peso promedio ingresado está fuera del rango esperado para esta categoría.',
};

function resolveErrorMessage(code) {
  return RECOMENDACION_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

function formatKg(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
}

function formatDias(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const dias = Math.max(0, Math.round(num));
  return `${dias} ${dias === 1 ? 'día' : 'días'}`;
}

// §11 del sprint: sin fundamento técnico para una banda de peso inventada
// -- se muestra siempre el peso promedio exacto ingresado.
function formatPesoAprox(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `aprox. ${num.toLocaleString('es-CO', { maximumFractionDigits: 0 })} kg`;
}

const NIVEL_CONFIANZA_LABELS = { ALTA: 'ALTA', MEDIA: 'MEDIA', BAJA: 'BAJA' };

// §10 del sprint: copy obligatorio, exacto.
const DISCLAIMER_ESTIMACION = 'Estimación técnica basada en la información registrada del potrero, categoría productiva y fuentes agroclimáticas. Las condiciones reales del ganado y la pastura pueden variar.';
// §20 del sprint: advertencia obligatoria para vacas en producción de leche.
const DISCLAIMER_LECHE = 'La estimación de ocupación no sustituye la evaluación de energía, proteína, minerales ni suplementación requerida para la producción de leche.';

function buildBody(categoria, form) {
  const body = {
    categoriaCodigo: categoria.codigo,
    numeroAnimales: Number(form.numeroAnimales),
    pesoPromedioKg: Number(form.pesoPromedioKg),
  };
  if (categoria.requiereProduccionLeche) {
    if (form.produccionLecheLDia !== '') body.produccionLecheLDia = Number(form.produccionLecheLDia);
    if (form.grasaLechePct !== '') body.grasaLechePct = Number(form.grasaLechePct);
    // diasEnLeche solo tiene efecto si también hay %grasa (alimenta la
    // ecuación NRC 2001 completa) -- se envía igual si el usuario lo llenó,
    // el backend decide si lo usa (hardening ronda 4 §1/§2).
    if (form.diasEnLeche !== '') body.diasEnLeche = Number(form.diasEnLeche);
  }
  if (categoria.requiereTerneroAlPie) {
    body.terneroAlPie = form.terneroAlPie;
  }
  return body;
}

// Hardening ronda 4 §1/§2/§4/§5: litrosPromedioVacaDia SIEMPRE obligatorio
// para categorías lactantes. grasaLechePct SIEMPRE opcional (nunca se
// obliga al pequeño productor a conocerla). diasEnLeche es obligatorio
// SOLO si el usuario ya aportó %grasa (juntos alimentan la ecuación NRC
// 2001 real) -- sin grasa, el motor usa el perfil genérico y diasEnLeche
// no se necesita. terneroAlPie ya NO suma demanda, pero sigue siendo
// obligatorio (true/false explícito) porque degrada confianza.
function isFormComplete(categoria, form) {
  if (!categoria) return false;
  if (form.numeroAnimales === '' || form.pesoPromedioKg === '') return false;
  if (categoria.requiereProduccionLeche) {
    if (form.produccionLecheLDia === '') return false;
    if (form.grasaLechePct !== '' && form.diasEnLeche === '') return false;
  }
  return true;
}

// Hardening ronda 3 §6/§7: provenance legible -- de dónde salió cada
// ASSUMED, nunca presentado como si fuera un dato medido. dryMatterSource
// sigue la taxonomía MEASURED > PASTURE_SPECIFIC_BASELINE > BOTANICAL_TYPE
// > FALLBACK (MEASURED nunca ocurre en v1 -- sin input de %MS medido).
const DRY_MATTER_SOURCE_LABELS = {
  MEASURED: 'materia seca medida en campo',
  PASTURE_SPECIFIC_BASELINE: 'pastura específica identificada (línea base documentada)',
  BOTANICAL_TYPE: 'tipo botánico genérico',
  FALLBACK: 'estimación conservadora (sin dato específico)',
};
const CATEGORIA_FUENTE_LABELS = {
  ADAPTED: 'adaptado de NASEM/NRC',
  FALLBACK: 'estimación conservadora (sin tabla específica)',
};
// Hardening ronda 3 §4 + ronda 4 §5: limitaciones explícitas -- nunca
// fingir precisión que el motor no tiene.
const LIMITACION_LABELS = {
  TERNERO_AL_PIE_DEMANDA_NO_CUANTIFICADA: 'El consumo de forraje del ternero al pie NO está incluido en este cálculo -- sin una fuente técnica documentada suficiente para cuantificarlo en v1. El resultado puede subestimar la demanda real del sistema vaca+ternero.',
  LECHE_SIN_GRASA_PERFIL_GENERICO: 'Sin el %grasa de la leche, se usó un perfil de consumo genérico para vacas en producción -- no se ejecutó el cálculo específico por litros/días en leche. Aporta el %grasa para una estimación más precisa.',
};

// RESULTADO (§10 del sprint) -- mismo bloque para preview y para una
// recomendación ya guardada (actual/historial). `provenance` solo existe
// en un preview/create fresco (§7 hardening) -- una recomendación ya
// guardada muestra la trazabilidad completa en su historial JSON, no en
// este bloque resumido.
function ResultadoBlock({ payload }) {
  const { categoria, resultado, nivelConfianza, requiereAdvertenciaLeche, inputs, estado, provenance, limitaciones } = payload;
  // Hardening ronda 5: diasOcupacionRecomendados/consumoProyectadoKg/
  // remanenteObjetivoKg/remanenteProyectadoKg vienen SIEMPRE del backend
  // (computeRemnantDerivatives) -- nunca recalculados aquí. "Remanente
  // proyectado" NUNCA es alias de "remanente objetivo" (ver
  // recomendacionPastoreoFormulas.js para la definición de cada uno).
  const diasRecomendados = resultado.diasOcupacionRecomendados;

  return (
    <div className="gan-ficha-preview gan-recomendacion-resultado">
      <p className="gan-capacidad-section-label">Recomendación AgroGenomaX</p>
      <div className="gan-ficha-row">
        <span>Categoría</span>
        <strong>{categoria.nombre}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Cantidad</span>
        <strong>{inputs.numeroAnimales} animales</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Peso</span>
        <strong>{formatPesoAprox(inputs.pesoPromedioKg)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Permanencia estimada</span>
        <strong>{formatDias(diasRecomendados)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Materia seca utilizable</span>
        <strong>{formatKg(resultado.materiaSecaUtilizableKg)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Consumo estimado en {formatDias(diasRecomendados)}</span>
        <strong>{formatKg(resultado.consumoProyectadoKg)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Remanente estimado al retiro</span>
        <strong>{formatKg(resultado.remanenteProyectadoKg)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Remanente objetivo protegido</span>
        <strong>{formatKg(resultado.remanenteObjetivoKg)}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Confianza</span>
        <strong>{NIVEL_CONFIANZA_LABELS[nivelConfianza] || nivelConfianza}</strong>
      </div>

      {provenance ? (
        <p className="gan-potrero-points-hint gan-recomendacion-provenance">
          %MS de pastura: {DRY_MATTER_SOURCE_LABELS[provenance.dryMatterSource] || provenance.dryMatterSource}.{' '}
          %Consumo de categoría: {CATEGORIA_FUENTE_LABELS[provenance.categoriaFuenteTipo] || provenance.categoriaFuenteTipo}.
        </p>
      ) : null}

      {estado === 'PARTIAL_CONTEXT' ? (
        <StatusMessage type="warning">Sin contexto agroclimático reciente de este potrero -- estimación en modo degradado.</StatusMessage>
      ) : null}

      {(limitaciones || []).map((codigo) => (
        <StatusMessage type="warning" key={codigo}>{LIMITACION_LABELS[codigo] || codigo}</StatusMessage>
      ))}

      {requiereAdvertenciaLeche ? <StatusMessage type="warning">{DISCLAIMER_LECHE}</StatusMessage> : null}

      <p className="gan-potrero-points-hint gan-capacidad-disclaimer">{DISCLAIMER_ESTIMACION}</p>
    </div>
  );
}

const INITIAL_FORM = { numeroAnimales: '', pesoPromedioKg: '', produccionLecheLDia: '', diasEnLeche: '', grasaLechePct: '', terneroAlPie: false };

export default function PotreroRecomendacionPastoreoPanel({ predioId, potreroId, tieneFicha, onCrearFicha }) {
  const [categorias, setCategorias] = useState([]);
  const [categoriasError, setCategoriasError] = useState('');

  const [loading, setLoading] = useState(tieneFicha);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [showHistorial, setShowHistorial] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [grupoAbierto, setGrupoAbierto] = useState(null);
  const [categoriaCodigo, setCategoriaCodigo] = useState('');
  const [form, setForm] = useState(INITIAL_FORM);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let active = true;
    getCategoriasProductivas().then(({ ok, data }) => {
      if (!active) return;
      if (!ok || !Array.isArray(data?.categorias)) {
        setCategoriasError(GENERIC_ERROR);
        return;
      }
      setCategorias(data.categorias);
    }).catch(() => {
      if (active) setCategoriasError(GENERIC_ERROR);
    });
    return () => {
      active = false;
    };
  }, []);

  function loadRecomendacion() {
    let active = true;
    setLoading(true);
    setLoadError('');
    getRecomendacionPastoreo(predioId, potreroId)
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

  // Sin ficha productiva, no se permite el cálculo -- ni siquiera se
  // consulta el histórico (no puede existir uno sin ficha, §18).
  useEffect(() => {
    if (!tieneFicha) {
      setLoading(false);
      return undefined;
    }
    return loadRecomendacion();
  }, [predioId, potreroId, tieneFicha]);

  const categoriaSeleccionada = categorias.find((c) => c.codigo === categoriaCodigo) || null;

  function openForm() {
    setForm(INITIAL_FORM);
    setCategoriaCodigo('');
    setGrupoAbierto(null);
    setPreview(null);
    setPreviewError('');
    setSaveError('');
    setShowForm(true);
  }

  function selectCategoria(codigo) {
    setCategoriaCodigo(codigo);
    setForm(INITIAL_FORM);
    setPreview(null);
    setPreviewError('');
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setPreview(null);
  }

  async function handleCalcular() {
    if (previewLoading || !isFormComplete(categoriaSeleccionada, form)) return;
    setPreviewLoading(true);
    setPreviewError('');
    const { ok, data } = await previewRecomendacionPastoreo(predioId, potreroId, buildBody(categoriaSeleccionada, form));
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
    const { ok, data } = await createRecomendacionPastoreo(predioId, potreroId, buildBody(categoriaSeleccionada, form));
    setSaving(false);
    if (!ok) {
      setSaveError(resolveErrorMessage(data?.error));
      return;
    }
    setShowForm(false);
    setPreview(null);
    loadRecomendacion();
  }

  if (!tieneFicha) {
    return (
      <div className="gan-ficha-productiva-panel gan-recomendacion-panel">
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
    return <p className="gan-potrero-points-hint">Cargando recomendación de pastoreo...</p>;
  }

  if (loadError) {
    return <StatusMessage type="error">{loadError}</StatusMessage>;
  }

  const grupos = buildGruposConCategorias(categorias);

  return (
    <div className="gan-ficha-productiva-panel gan-recomendacion-panel">
      {!showForm && !actual ? (
        <div className="gan-ficha-productiva-empty">
          <button type="button" className="gan-secondary-button" onClick={openForm}>
            Recomendación automática
          </button>
        </div>
      ) : null}

      {!showForm && actual ? (
        <>
          <ResultadoBlock
            payload={{
              categoria: { nombre: actual.categoriaNombre },
              resultado: actual,
              nivelConfianza: actual.nivelConfianza,
              requiereAdvertenciaLeche: actual.requiereAdvertenciaLeche,
              inputs: { numeroAnimales: actual.numeroAnimales, pesoPromedioKg: actual.pesoPromedioKg },
              estado: actual.contextoId ? 'READY' : 'PARTIAL_CONTEXT',
            }}
          />
          <div className="gan-potrero-actions">
            <button type="button" className="gan-secondary-button" onClick={openForm}>
              Nueva recomendación
            </button>
            {historial.length > 0 ? (
              <button type="button" className="gan-back-inline" onClick={() => setShowHistorial((v) => !v)}>
                {showHistorial ? 'Ocultar historial' : 'Ver historial'}
              </button>
            ) : null}
          </div>

          {/* SPRINT-3D8-DESCANSO-REENTRADA §19: "Calcular descanso" se
              muestra únicamente después de una recomendación de pastoreo
              guardada -- nunca antes. */}
          <PotreroDescansoReentradaPanel predioId={predioId} potreroId={potreroId} />

          {showHistorial && historial.length > 0 ? (
            <div className="gan-ficha-historial-list">
              {historial.map((item) => (
                <div className="gan-ficha-historial-item gan-capacidad-historial-item" key={item.recomendacionId}>
                  <strong>{formatDateDisplay(item.createdAt)}</strong>
                  <span>{item.categoriaNombre}</span>
                  <span>{item.numeroAnimales} animales</span>
                  <span>{item.pesoPromedioKg} kg PV</span>
                  <span>{formatDias(item.diasOcupacionRecomendados)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {showForm ? (
        <div className="gan-stack">
          {categoriasError ? <StatusMessage type="error">{categoriasError}</StatusMessage> : null}

          {!categoriaSeleccionada ? (
            <div className="gan-recomendacion-selector">
              <p className="gan-capacidad-section-label">¿Qué vas a manejar en este potrero?</p>
              {grupos.map((grupoDef) => (
                <div className="gan-recomendacion-grupo" key={grupoDef.grupo}>
                  <button
                    type="button"
                    className="gan-secondary-button"
                    aria-expanded={grupoAbierto === grupoDef.grupo}
                    onClick={() => setGrupoAbierto((current) => (current === grupoDef.grupo ? null : grupoDef.grupo))}
                  >
                    {grupoDef.label}
                  </button>
                  {grupoAbierto === grupoDef.grupo ? (
                    <div className="gan-recomendacion-categorias" role="listbox" aria-label={grupoDef.label}>
                      {grupoDef.categorias.map((cat) => (
                        <button
                          type="button"
                          key={cat.codigo}
                          className="gan-back-inline"
                          onClick={() => selectCategoria(cat.codigo)}
                        >
                          {cat.nombre}
                        </button>
                      ))}
                      {grupoDef.comingSoon ? grupoDef.comingSoon.map((label) => (
                        <span className="gan-potrero-points-hint" key={label}>{label} — próximamente</span>
                      )) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="gan-ficha-row">
                <span>Categoría seleccionada</span>
                <strong>{categoriaSeleccionada.nombre}</strong>
                <button type="button" className="gan-back-inline" onClick={() => selectCategoria('')}>
                  Cambiar
                </button>
              </div>

              <FormField label="Cantidad de animales" required>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.numeroAnimales}
                  onChange={(event) => updateField('numeroAnimales', event.target.value)}
                />
              </FormField>

              <FormField label="Peso promedio (kg)" required>
                <input
                  type="number"
                  min="0"
                  max="2000"
                  step="any"
                  value={form.pesoPromedioKg}
                  onChange={(event) => updateField('pesoPromedioKg', event.target.value)}
                />
              </FormField>

              {categoriaSeleccionada.requiereProduccionLeche ? (
                <>
                  <FormField label="Litros promedio / vaca / día" required>
                    <input
                      type="number"
                      min="0"
                      max="60"
                      step="any"
                      value={form.produccionLecheLDia}
                      onChange={(event) => updateField('produccionLecheLDia', event.target.value)}
                    />
                  </FormField>
                  <FormField label="Grasa de la leche (%) — opcional">
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="any"
                      value={form.grasaLechePct}
                      onChange={(event) => updateField('grasaLechePct', event.target.value)}
                    />
                    <span className="gan-potrero-points-hint">Si cuenta con análisis o información del porcentaje de grasa de la leche, AgroGenomaX puede mejorar la estimación de consumo.</span>
                  </FormField>
                  <FormField label="Días en leche (desde el parto)" required={form.grasaLechePct !== ''}>
                    <input
                      type="number"
                      min="1"
                      max="500"
                      step="1"
                      value={form.diasEnLeche}
                      onChange={(event) => updateField('diasEnLeche', event.target.value)}
                    />
                    {form.grasaLechePct !== '' ? (
                      <span className="gan-potrero-points-hint">Necesario junto con el %grasa para el cálculo específico (NRC 2001).</span>
                    ) : null}
                  </FormField>
                </>
              ) : null}

              {categoriaSeleccionada.requiereTerneroAlPie ? (
                <FormField label="Ternero al pie">
                  <input
                    type="checkbox"
                    checked={form.terneroAlPie}
                    onChange={(event) => updateField('terneroAlPie', event.target.checked)}
                  />
                </FormField>
              ) : null}

              <StatusMessage type="error">{previewError}</StatusMessage>

              <div className="gan-potrero-actions">
                <button
                  type="button"
                  className="gan-secondary-button"
                  onClick={handleCalcular}
                  disabled={previewLoading || !isFormComplete(categoriaSeleccionada, form)}
                >
                  {previewLoading ? 'Calculando...' : 'Calcular'}
                </button>
                <button type="button" className="gan-back-inline" onClick={() => setShowForm(false)} disabled={saving}>
                  Cancelar
                </button>
              </div>

              {preview ? (
                <>
                  <ResultadoBlock payload={preview} />
                  <StatusMessage type="error">{saveError}</StatusMessage>
                  <div className="gan-potrero-actions">
                    <button type="button" className="gan-submit" onClick={handleGuardar} disabled={saving}>
                      {saving ? 'Guardando...' : 'Guardar esta recomendación'}
                    </button>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
