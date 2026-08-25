// SPRINT-3D6-FICHA-PRODUCTIVA: ficha productiva de un potrero ya
// registrado -- especie/mezcla de pastura, aforo promedio, número de
// muestras, fecha del aforo, observaciones y biomasa fresca estimada
// (§20/§21/§22/§23/§24 del sprint). Habla EXCLUSIVAMENTE con
// ganaderiaFichaProductivaApi.js (/api/ganaderia/predios/:predioId/
// potreros/:potreroId/ficha-productiva + /api/ganaderia/catalogo-pasturas).
//
// NO calcula todavía capacidad animal recomendada, días de ocupación,
// descanso ni rotación -- eso es SPRINT 3D7 (§16/§29 del sprint).
//
// Historial (§4/§23): cada envío crea una ficha NUEVA -- nunca edita la
// anterior. `areaHa` llega como prop desde PotrerosByPredioPanel.jsx (ya
// resuelta por el listado de potreros) exclusivamente para el preview
// visual de biomasa (§22) -- el valor PERSISTIDO siempre lo calcula el
// backend a partir de agx.potreros.area_ha, nunca de este cálculo local.
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import {
  getFichaProductiva,
  createFichaProductiva,
  listCatalogoPasturas,
  createPasturaPersonalizada,
} from './ganaderiaFichaProductivaApi.js';
import PotreroMotorPastoreoPanel from './PotreroMotorPastoreoPanel.jsx';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';
const MAX_AFORO_G_M2 = 10000;

const CREATE_ERROR_MESSAGES = {
  EMPTY_ESPECIES: 'Selecciona al menos una especie de pastura.',
  INVALID_ESPECIES: 'Revisa las especies seleccionadas.',
  ESPECIE_NOT_FOUND: 'Una de las especies seleccionadas ya no está disponible. Quítala e intenta de nuevo.',
  INVALID_PORCENTAJE: 'El porcentaje estimado debe estar entre 0 y 100.',
  INVALID_AFORO: 'El aforo promedio debe ser mayor que 0.',
  AFORO_TOO_HIGH: `El aforo promedio supera el máximo permitido (${MAX_AFORO_G_M2.toLocaleString('es-CO')} g/m²).`,
  INVALID_NUMERO_MUESTRAS: 'El número de muestras debe ser un entero mayor o igual a 1.',
  INVALID_FECHA_AFORO: 'La fecha del aforo no es válida.',
  INVALID_OBSERVACIONES: 'Las observaciones son demasiado extensas.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
};

const PASTURA_CREATE_ERROR_MESSAGES = {
  INVALID_NOMBRE_COMUN: 'Escribe un nombre para la nueva pastura.',
  INVALID_TIPO: 'Selecciona un tipo válido de pastura.',
};

function resolveCreateErrorMessage(code) {
  return CREATE_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

function formatNumber(value, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2, ...options });
}

function computeBiomasaPreviewKg(areaHa, aforoPromedioGM2) {
  const area = Number(areaHa);
  const aforo = Number(aforoPromedioGM2);
  if (!Number.isFinite(area) || !Number.isFinite(aforo) || area <= 0 || aforo <= 0) return null;
  return (area * 10000 * aforo) / 1000;
}

function FichaSummary({ ficha, areaHa }) {
  return (
    <div className="gan-ficha-productiva-summary">
      <div className="gan-ficha-row">
        <span>Especie / mezcla</span>
        <strong>{ficha.nombrePersonalizado || ficha.nombrePrincipal}</strong>
      </div>
      {ficha.especies.length > 1 ? (
        <div className="gan-ficha-especie-chips">
          {ficha.especies.map((especie) => (
            <span className="gan-ficha-chip gan-ficha-chip-readonly" key={especie.pasturaId}>
              {especie.nombreComun}
              {especie.porcentajeEstimado !== null ? ` · ${especie.porcentajeEstimado}%` : ''}
            </span>
          ))}
        </div>
      ) : null}
      <div className="gan-ficha-row">
        <span>Aforo promedio (materia fresca)</span>
        <strong>{formatNumber(ficha.aforoPromedioGM2)} g/m²</strong>
      </div>
      <div className="gan-ficha-row">
        <span>Biomasa fresca estimada</span>
        <strong>{formatNumber(ficha.biomasaTotalKg)} kg</strong>
      </div>
      {ficha.numeroMuestras !== null ? (
        <div className="gan-ficha-row">
          <span>Número de muestras</span>
          <strong>{ficha.numeroMuestras}</strong>
        </div>
      ) : null}
      <div className="gan-ficha-row">
        <span>Fecha del aforo</span>
        <strong>{ficha.fechaAforo ? formatDateDisplay(ficha.fechaAforo) : formatDateDisplay(ficha.createdAt)}</strong>
      </div>
      {ficha.observaciones ? (
        <div className="gan-ficha-row">
          <span>Observaciones</span>
          <strong>{ficha.observaciones}</strong>
        </div>
      ) : null}
    </div>
  );
}

// §21: selector searchable + chips de mezcla + "Otra pastura". `search`
// filtra client-side sobre el catálogo ya cargado (sistema + propio, RLS
// server-side) -- catálogo pequeño/mediano, sin necesidad de debounce por
// request.
function EspecieSelector({ especiesSeleccionadas, onAdd, onRemove, onPorcentajeChange }) {
  const [catalogo, setCatalogo] = useState([]);
  const [catalogoLoading, setCatalogoLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showOtra, setShowOtra] = useState(false);
  const [otraNombre, setOtraNombre] = useState('');
  const [otraTipo, setOtraTipo] = useState('graminea');
  const [otraCreating, setOtraCreating] = useState(false);
  const [otraError, setOtraError] = useState('');

  useEffect(() => {
    let active = true;
    listCatalogoPasturas().then(({ ok, data }) => {
      if (!active) return;
      setCatalogo(ok && Array.isArray(data?.pasturas) ? data.pasturas : []);
      setCatalogoLoading(false);
    }).catch(() => {
      if (active) setCatalogoLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const seleccionadosIds = new Set(especiesSeleccionadas.map((e) => e.pasturaId));
  const term = search.trim().toLowerCase();
  const resultados = term
    ? catalogo.filter(
        (p) => !seleccionadosIds.has(p.pasturaId)
          && (p.nombreComun.toLowerCase().includes(term) || (p.nombreCientifico || '').toLowerCase().includes(term)),
      )
    : [];

  async function handleAgregarOtra() {
    if (otraCreating || !otraNombre.trim()) return;
    setOtraCreating(true);
    setOtraError('');
    const { ok, data } = await createPasturaPersonalizada({ nombreComun: otraNombre.trim(), tipo: otraTipo });
    setOtraCreating(false);
    if (!ok) {
      setOtraError(PASTURA_CREATE_ERROR_MESSAGES[data?.error] || GENERIC_ERROR);
      return;
    }
    onAdd(data.pastura);
    setOtraNombre('');
    setShowOtra(false);
  }

  return (
    <div className="gan-ficha-especie-selector">
      {especiesSeleccionadas.length > 0 ? (
        <div className="gan-ficha-especie-chips">
          {especiesSeleccionadas.map((especie) => (
            <span className="gan-ficha-chip" key={especie.pasturaId}>
              {especie.nombreComun}
              <input
                type="number"
                className="gan-ficha-chip-porcentaje"
                placeholder="%"
                min="0"
                max="100"
                value={especie.porcentajeEstimado ?? ''}
                onChange={(event) => onPorcentajeChange(especie.pasturaId, event.target.value)}
              />
              <button type="button" onClick={() => onRemove(especie.pasturaId)} aria-label={`Quitar ${especie.nombreComun}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <FormField label="Buscar especie de pastura">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Ej. Brachiaria, Maní forrajero..."
          disabled={catalogoLoading}
        />
      </FormField>

      {term && resultados.length > 0 ? (
        <div className="gan-ficha-especie-results">
          {resultados.slice(0, 12).map((pastura) => (
            <button
              type="button"
              key={pastura.pasturaId}
              className="gan-ficha-especie-result"
              onClick={() => {
                onAdd(pastura);
                setSearch('');
              }}
            >
              <strong>{pastura.nombreComun}</strong>
              {pastura.nombreCientifico ? <em>{pastura.nombreCientifico}</em> : null}
            </button>
          ))}
        </div>
      ) : null}
      {term && !catalogoLoading && resultados.length === 0 ? (
        <p className="gan-potrero-points-hint">Sin resultados para "{search}".</p>
      ) : null}

      {!showOtra ? (
        <button type="button" className="gan-secondary-button" onClick={() => setShowOtra(true)}>
          + Otra pastura
        </button>
      ) : (
        <div className="gan-ficha-otra-form">
          <FormField label="Nombre de la nueva pastura" required>
            <input value={otraNombre} onChange={(event) => setOtraNombre(event.target.value)} />
          </FormField>
          <FormField label="Tipo">
            <select value={otraTipo} onChange={(event) => setOtraTipo(event.target.value)}>
              <option value="graminea">Gramínea</option>
              <option value="leguminosa">Leguminosa</option>
              <option value="mezcla">Mezcla</option>
              <option value="otra">Otra</option>
            </select>
          </FormField>
          <StatusMessage type="error">{otraError}</StatusMessage>
          <div className="gan-potrero-actions">
            <button type="button" className="gan-submit" onClick={handleAgregarOtra} disabled={otraCreating || !otraNombre.trim()}>
              {otraCreating ? 'Agregando...' : 'Agregar'}
            </button>
            <button type="button" className="gan-back-inline" onClick={() => setShowOtra(false)} disabled={otraCreating}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// onFichaCreated: callback síncrono invocado tras un POST exitoso -- este
// panel refresca su propio estado (mismo criterio determinístico que
// PotreroRegistrationPanel -- el GET real es la fuente de verdad, nunca
// una inserción optimista del body enviado).
export default function PotreroFichaProductivaPanel({ predioId, potreroId, areaHa }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [showHistorial, setShowHistorial] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [especies, setEspecies] = useState([]); // [{ pasturaId, nombreComun, porcentajeEstimado }]
  const [aforo, setAforo] = useState('');
  const [numeroMuestras, setNumeroMuestras] = useState('');
  const [fechaAforo, setFechaAforo] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  function loadFicha() {
    let active = true;
    setLoading(true);
    setLoadError('');
    getFichaProductiva(predioId, potreroId)
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

  useEffect(loadFicha, [predioId, potreroId]);

  function resetForm() {
    setEspecies([]);
    setAforo('');
    setNumeroMuestras('');
    setFechaAforo('');
    setObservaciones('');
    setSaveError('');
  }

  function openForm() {
    resetForm();
    setShowForm(true);
  }

  function addEspecie(pastura) {
    setEspecies((current) => {
      if (current.some((e) => e.pasturaId === pastura.pasturaId)) return current;
      return [...current, { pasturaId: pastura.pasturaId, nombreComun: pastura.nombreComun, porcentajeEstimado: null }];
    });
  }

  function removeEspecie(pasturaId) {
    setEspecies((current) => current.filter((e) => e.pasturaId !== pasturaId));
  }

  function changePorcentaje(pasturaId, rawValue) {
    setEspecies((current) => current.map((e) => (
      e.pasturaId === pasturaId ? { ...e, porcentajeEstimado: rawValue === '' ? null : Number(rawValue) } : e
    )));
  }

  async function handleSubmit() {
    if (saving || especies.length === 0 || !aforo) return;
    setSaving(true);
    setSaveError('');

    const body = {
      especies: especies.map((e) => ({
        pasturaId: e.pasturaId,
        ...(e.porcentajeEstimado !== null && e.porcentajeEstimado !== '' ? { porcentajeEstimado: e.porcentajeEstimado } : {}),
      })),
      aforoPromedioGM2: Number(aforo),
      ...(numeroMuestras !== '' ? { numeroMuestras: Number(numeroMuestras) } : {}),
      ...(fechaAforo ? { fechaAforo } : {}),
      ...(observaciones.trim() ? { observaciones: observaciones.trim() } : {}),
    };

    const { ok, data } = await createFichaProductiva(predioId, potreroId, body);
    setSaving(false);
    if (!ok) {
      setSaveError(resolveCreateErrorMessage(data?.error));
      return;
    }
    setShowForm(false);
    loadFicha();
  }

  const biomasaPreview = computeBiomasaPreviewKg(areaHa, aforo);

  if (loading) {
    return <p className="gan-potrero-points-hint">Cargando ficha productiva...</p>;
  }

  if (loadError) {
    return <StatusMessage type="error">{loadError}</StatusMessage>;
  }

  return (
    <div className="gan-ficha-productiva-panel">
      {!showForm && !actual ? (
        <div className="gan-ficha-productiva-empty">
          <p className="gan-potrero-points-hint">Aún no has registrado información productiva para este potrero.</p>
          <button type="button" className="gan-secondary-button" onClick={openForm}>
            Crear ficha productiva
          </button>
        </div>
      ) : null}

      {!showForm && actual ? (
        <>
          <FichaSummary ficha={actual} areaHa={areaHa} />
          <div className="gan-potrero-actions">
            <button type="button" className="gan-secondary-button" onClick={openForm}>
              Registrar nuevo aforo
            </button>
            {historial.length > 0 ? (
              <button type="button" className="gan-back-inline" onClick={() => setShowHistorial((v) => !v)}>
                {showHistorial ? 'Ocultar historial' : 'Ver historial'}
              </button>
            ) : null}
          </div>
          {showHistorial && historial.length > 0 ? (
            <div className="gan-ficha-historial-list">
              {historial.map((ficha) => (
                <div className="gan-ficha-historial-item" key={ficha.fichaId}>
                  <strong>{ficha.nombrePersonalizado || ficha.nombrePrincipal}</strong>
                  <span>{ficha.fechaAforo ? formatDateDisplay(ficha.fechaAforo) : formatDateDisplay(ficha.createdAt)}</span>
                  <span>{formatNumber(ficha.aforoPromedioGM2)} g/m²</span>
                  <span>{formatNumber(ficha.biomasaTotalKg)} kg</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {/* SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: debajo de la ficha
          productiva (§25 del sprint 3D7, §12 del sprint 3D7.2) -- siempre
          visible salvo mientras se está registrando un aforo nuevo
          (showForm). Sin ficha vigente (tieneFicha=false), el propio
          panel muestra su estado vacío (§26 del sprint 3D7), nunca un
          flujo global desconectado. PotreroMotorPastoreoPanel decide
          entre "Recomendación automática" (principal) y "Modo técnico"
          (PotreroCapacidadPastoreoPanel, intacto). */}
      {!showForm ? (
        <PotreroMotorPastoreoPanel
          predioId={predioId}
          potreroId={potreroId}
          areaHa={areaHa}
          tieneFicha={Boolean(actual)}
          onCrearFicha={openForm}
        />
      ) : null}

      {showForm ? (
        <div className="gan-stack">
          <EspecieSelector
            especiesSeleccionadas={especies}
            onAdd={addEspecie}
            onRemove={removeEspecie}
            onPorcentajeChange={changePorcentaje}
          />

          <FormField label="Aforo promedio (g/m² de materia fresca)" required>
            <input
              type="number"
              min="0"
              max={MAX_AFORO_G_M2}
              step="any"
              value={aforo}
              onChange={(event) => setAforo(event.target.value)}
            />
          </FormField>
          <FormField label="Número de muestras (opcional)">
            <input
              type="number"
              min="1"
              step="1"
              value={numeroMuestras}
              onChange={(event) => setNumeroMuestras(event.target.value)}
            />
            <span className="gan-potrero-points-hint">Número de cuadrantes o muestras utilizados para obtener el promedio.</span>
          </FormField>
          <FormField label="Fecha del aforo (opcional)">
            <input type="date" value={fechaAforo} onChange={(event) => setFechaAforo(event.target.value)} />
          </FormField>
          <FormField label="Observaciones (opcional)">
            <textarea value={observaciones} onChange={(event) => setObservaciones(event.target.value)} />
          </FormField>

          {biomasaPreview !== null ? (
            <div className="gan-ficha-preview">
              <div className="gan-ficha-row">
                <span>Área del potrero</span>
                <strong>{formatNumber(areaHa)} ha · {formatNumber(Number(areaHa) * 10000)} m²</strong>
              </div>
              <div className="gan-ficha-row">
                <span>Biomasa fresca estimada (vista previa)</span>
                <strong>{formatNumber(biomasaPreview)} kg</strong>
              </div>
            </div>
          ) : null}

          <StatusMessage type="error">{saveError}</StatusMessage>

          <div className="gan-potrero-actions">
            <button
              type="button"
              className="gan-submit"
              onClick={handleSubmit}
              disabled={saving || especies.length === 0 || !aforo}
            >
              {saving ? 'Guardando...' : 'Guardar ficha productiva'}
            </button>
            <button type="button" className="gan-back-inline" onClick={() => setShowForm(false)} disabled={saving}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
