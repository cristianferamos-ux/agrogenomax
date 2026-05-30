import { Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';

function todayLocal() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function isCommaDecimalInput(value) {
  return /^\d*(,\d{0,2})?$/.test(value);
}

function isValidCommaDecimal(value) {
  return /^\d+(,\d{1,2})?$/.test(value);
}

function toApiDecimal(value) {
  return value.replace(',', '.');
}

function valueOf(row, aliases) {
  return aliases.map((key) => row?.[key]).find((value) => value !== undefined && value !== null) || '';
}

function getFecha(row) {
  return valueOf(row, ['fecha_pesaje', 'fecha', 'weighing_date']);
}

function getPeso(row, aliases = ['peso_kg', 'peso', 'weight_kg']) {
  const value = valueOf(row, aliases);
  return value === '' ? null : Number(value);
}

function getPesoNacimiento(animal) {
  const value = valueOf(animal, ['peso_nacimiento', 'peso_nacimiento_kg', 'birth_weight_kg']);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getFechaNacimiento(animal) {
  return valueOf(animal, ['fecha_nacimiento', 'birth_date']);
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : '';
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)
    : null;
}

function formatMetric(value, suffix = '') {
  const formatted = formatNumber(value);
  return formatted ? `${formatted}${suffix}` : '—';
}

function formatDays(value) {
  if (value === undefined || value === null || value === '') return '—';
  const days = Number(value);
  return Number.isFinite(days) ? `${days} días` : '—';
}

function sortByDateAsc(rows) {
  return [...rows].sort((a, b) => {
    const dateA = new Date(getFecha(a)).getTime() || 0;
    const dateB = new Date(getFecha(b)).getTime() || 0;
    const idA = a.es_peso_nacimiento ? -1 : Number(a.pesaje_id || 0);
    const idB = b.es_peso_nacimiento ? -1 : Number(b.pesaje_id || 0);
    return dateA - dateB || idA - idB;
  });
}

export default function AnimalPesajesTab({ animalId }) {
  const params = useParams();
  const resolvedAnimalId = animalId || params.id;
  const [animal, setAnimal] = useState(null);
  const [pesajes, setPesajes] = useState([]);
  const [form, setForm] = useState({ fecha_pesaje: todayLocal(), peso_kg: '', observaciones: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const loadPesajes = async () => {
    if (!resolvedAnimalId) return;
    setLoading(true);
    setError('');
    try {
      const [animalRow, rows] = await Promise.all([
        ganaderiaApi.getAnimal(resolvedAnimalId),
        ganaderiaApi.listAnimalPesajesEvolucion(resolvedAnimalId),
      ]);
      setAnimal(animalRow);
      setPesajes(rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPesajes();
  }, [resolvedAnimalId]);

  const pesoNacimientoRow = useMemo(() => {
    const pesoNacimiento = getPesoNacimiento(animal);
    if (!Number.isFinite(pesoNacimiento)) return null;

    const fechaNacimiento = formatDate(getFechaNacimiento(animal)) || formatDate(getFecha(sortByDateAsc(pesajes)[0])) || todayLocal();
    const alreadyExists = pesajes.some((pesaje) => {
      const peso = getPeso(pesaje);
      return formatDate(getFecha(pesaje)) === fechaNacimiento && Number.isFinite(peso) && Math.abs(peso - pesoNacimiento) < 0.001;
    });

    if (alreadyExists) return null;

    return {
      pesaje_id: 'peso-nacimiento',
      fecha_pesaje: fechaNacimiento,
      peso_kg: pesoNacimiento,
      observaciones: 'Peso al nacimiento registrado en ficha animal',
      peso_anterior: null,
      diferencia_kg: null,
      dias_entre_pesajes: null,
      ganancia_diaria_kg: null,
      es_peso_nacimiento: true,
    };
  }, [animal, pesajes]);

  const pesajesConPesoInicial = useMemo(
    () => (pesoNacimientoRow ? [pesoNacimientoRow, ...pesajes] : pesajes),
    [pesoNacimientoRow, pesajes],
  );

  const summary = useMemo(() => {
    const ordered = sortByDateAsc(pesajesConPesoInicial).filter((row) => Number.isFinite(getPeso(row)));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const firstWeight = first ? getPeso(first) : null;
    const lastWeight = last ? getPeso(last) : null;
    const difference = Number.isFinite(firstWeight) && Number.isFinite(lastWeight) && ordered.length >= 2 ? lastWeight - firstWeight : null;
    const firstDate = first ? new Date(getFecha(first)).getTime() : null;
    const lastDate = last ? new Date(getFecha(last)).getTime() : null;
    const daysBetween =
      Number.isFinite(firstDate) && Number.isFinite(lastDate) && ordered.length >= 2 ? Math.round((lastDate - firstDate) / 86400000) : null;
    const dailyAverage = Number.isFinite(difference) && daysBetween > 0 ? difference / daysBetween : null;

    return {
      total: pesajesConPesoInicial.length,
      primerPeso: firstWeight,
      ultimoPeso: lastWeight,
      diferencia: difference,
      promedioDiario: dailyAverage,
    };
  }, [pesajesConPesoInicial]);

  const chartData = useMemo(
    () =>
      sortByDateAsc(pesajesConPesoInicial)
        .filter((row) => Number.isFinite(getPeso(row)))
        .map((row) => ({
          fecha: formatDate(getFecha(row)),
          peso: getPeso(row),
        })),
    [pesajesConPesoInicial],
  );

  const historyRows = useMemo(() => [...pesajesConPesoInicial].sort((a, b) => {
    const dateA = new Date(getFecha(a)).getTime() || 0;
    const dateB = new Date(getFecha(b)).getTime() || 0;
    const idA = a.es_peso_nacimiento ? -1 : Number(a.pesaje_id || 0);
    const idB = b.es_peso_nacimiento ? -1 : Number(b.pesaje_id || 0);
    return dateB - dateA || idB - idA;
  }), [pesajesConPesoInicial]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const updateWeight = (value) => {
    if (isCommaDecimalInput(value)) update('peso_kg', value);
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (!resolvedAnimalId) {
      setError('No hay animal valido para registrar pesaje.');
      return;
    }

    if (!form.fecha_pesaje) {
      setError('La fecha de pesaje es obligatoria.');
      return;
    }

    if (form.fecha_pesaje > todayLocal()) {
      setError('La fecha de pesaje no puede ser futura.');
      return;
    }

    if (!isValidCommaDecimal(form.peso_kg)) {
      setError('Ingresa el peso con coma y maximo dos decimales. Ejemplo: 56,45.');
      return;
    }

    const nextWeight = Number(toApiDecimal(form.peso_kg));
    if (!Number.isFinite(nextWeight) || nextWeight <= 0) {
      setError('El peso debe ser mayor que 0.');
      return;
    }

    if (Number.isFinite(summary.ultimoPeso)) {
      const percentDifference = Math.abs(nextWeight - summary.ultimoPeso) / summary.ultimoPeso;
      if (percentDifference > 0.3) {
        const confirmed = window.confirm('El nuevo peso difiere mas del 30% respecto al ultimo peso registrado. Confirma si deseas guardarlo.');
        if (!confirmed) return;
      }
    }

    try {
      await ganaderiaApi.createPesaje({
        animal_id: resolvedAnimalId,
        fecha_pesaje: form.fecha_pesaje,
        peso_kg: toApiDecimal(form.peso_kg),
        observaciones: form.observaciones,
      });
      setForm({ fecha_pesaje: todayLocal(), peso_kg: '', observaciones: '' });
      setStatus('Pesaje registrado en PostgreSQL');
      await loadPesajes();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="gan-stack">
      <div className="gan-metric-grid">
        <article className="gan-metric">
          <span>Peso al nacer</span>
          <strong>{formatMetric(summary.primerPeso, ' kg')}</strong>
        </article>
        <article className="gan-metric">
          <span>Peso actual</span>
          <strong>{formatMetric(summary.ultimoPeso, ' kg')}</strong>
        </article>
        <article className="gan-metric">
          <span>Ganancia acumulada</span>
          <strong>{formatMetric(summary.diferencia, ' kg')}</strong>
        </article>
        <article className="gan-metric">
          <span>Promedio diario</span>
          <strong>{formatMetric(summary.promedioDiario, ' kg/día')}</strong>
        </article>
        <article className="gan-metric">
          <span>Total pesajes</span>
          <strong>{summary.total}</strong>
        </article>
      </div>

      <form className="gan-form" onSubmit={submit}>
        <FormField label="Fecha">
          <input
            max={todayLocal()}
            type="date"
            value={form.fecha_pesaje}
            onChange={(event) => update('fecha_pesaje', event.target.value)}
            required
          />
        </FormField>
        <FormField label="Peso kg">
          <input
            inputMode="decimal"
            pattern="[0-9]+(,[0-9]{1,2})?"
            placeholder="56,45"
            value={form.peso_kg}
            onChange={(event) => updateWeight(event.target.value)}
            required
          />
        </FormField>
        <FormField label="Observaciones">
          <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
        </FormField>
        <button className="gan-submit" type="submit">
          <Save className="h-5 w-5" />
          Guardar pesaje
        </button>
      </form>

      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Crecimiento</span>
          <h3>Evolución del peso</h3>
        </div>
        {chartData.length ? (
          <div className="gan-weight-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="fecha" stroke="#a7b3c2" tick={{ fill: '#a7b3c2', fontSize: 12 }} tickMargin={10} />
                <YAxis
                  stroke="#a7b3c2"
                  tick={{ fill: '#a7b3c2', fontSize: 12 }}
                  tickFormatter={(value) => `${value} kg`}
                  width={58}
                />
                <Tooltip
                  contentStyle={{
                    background: '#081017',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '0.6rem',
                    color: '#f6f8fb',
                  }}
                  formatter={(value) => [`${formatNumber(Number(value))} kg`, 'Peso']}
                  labelFormatter={(label) => `Fecha: ${label}`}
                />
                <Line dataKey="peso" name="Peso" stroke="#9cff1a" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} type="monotone" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="gan-empty-text">Sin datos suficientes para graficar.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Histórico</span>
          <h3>Pesajes registrados</h3>
        </div>
        {loading ? (
          <p className="gan-empty-text">Cargando pesajes...</p>
        ) : historyRows.length ? (
          <div className="gan-pesajes-table">
            <div className="gan-pesajes-head">
              <span>Fecha</span>
              <span>Peso</span>
              <span>Peso anterior</span>
              <span>Diferencia</span>
              <span>Días</span>
              <span>Ganancia diaria de peso</span>
            </div>
            {historyRows.map((pesaje) => (
              <article className="gan-pesajes-row" key={pesaje.pesaje_id || `${getFecha(pesaje)}-${getPeso(pesaje)}`}>
                <span>{formatDate(getFecha(pesaje))}</span>
                <strong>{formatMetric(getPeso(pesaje), ' kg')}</strong>
                <span>{formatMetric(getPeso(pesaje, ['peso_anterior']), ' kg')}</span>
                <span>{formatMetric(getPeso(pesaje, ['diferencia_kg']), ' kg')}</span>
                <span>{formatDays(valueOf(pesaje, ['dias_entre_pesajes']))}</span>
                <span>{formatMetric(getPeso(pesaje, ['ganancia_diaria_kg']), ' kg/día')}</span>
                {valueOf(pesaje, ['observaciones', 'notes']) ? <small>{valueOf(pesaje, ['observaciones', 'notes'])}</small> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="gan-empty-text">Sin pesajes registrados.</p>
        )}
      </div>
    </div>
  );
}
