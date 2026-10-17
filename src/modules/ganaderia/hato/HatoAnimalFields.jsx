// SPRINT-3D11.2: campos del animal compartidos por el registro y la
// corrección. Smartphone-first, revelación progresiva: lo obligatorio
// arriba; edad, raza, categoría y peso como preguntas simples; origen y
// observaciones bajo "Más datos". Nunca muestra enums técnicos.
import { FormField } from '../components/FormField.jsx';
import { categoriasParaSexo } from './categoriaSexo.js';
import {
  NACIMIENTO_MODOS,
  ORIGENES,
  PESO_METODOS,
  RAZA_MODOS,
  SEXOS,
  TIPO_PRODUCTIVO_LABELS,
} from './hatoFormModel.js';

function ChoiceGroup({ name, options, value, onChange, disabled }) {
  return (
    <div className="gan-hato-choices" role="radiogroup">
      {options.map((option) => (
        <label key={option.value} className={`gan-hato-choice${value === option.value ? ' is-selected' : ''}`}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            disabled={disabled}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function RazaSelect({ razas, value, onChange, disabled, placeholder }) {
  const grupos = Object.entries(TIPO_PRODUCTIVO_LABELS)
    .map(([tipo, label]) => ({ label, razas: razas.filter((raza) => raza.tipoProductivo === tipo) }))
    .filter((grupo) => grupo.razas.length > 0);
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value="">{placeholder}</option>
      {grupos.map((grupo) => (
        <optgroup key={grupo.label} label={grupo.label}>
          {grupo.razas.map((raza) => (
            <option key={raza.razaId} value={raza.razaId}>{raza.nombre}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function HatoAnimalFields({
  form,
  onChange,
  razas = [],
  categorias = [],
  predios = null,
  showPeso = false,
  disabled = false,
  maxFecha,
}) {
  const categoriasDisponibles = categoriasParaSexo(categorias, form.sexo);
  const nacidoEnPredio = form.origenTipo === 'NACIDO_EN_PREDIO';

  return (
    <div className="gan-hato-fields">
      {predios ? (
        <FormField label="Predio" required>
          <select value={form.predioId} onChange={(event) => onChange('predioId', event.target.value)} disabled={disabled}>
            <option value="">Selecciona el predio</option>
            {predios.map((predio) => (
              <option key={predio.predioId} value={predio.predioId}>{predio.nombrePredio}</option>
            ))}
          </select>
        </FormField>
      ) : null}

      <FormField label="Sexo" required>
        <ChoiceGroup name="sexo" options={SEXOS} value={form.sexo} onChange={(value) => onChange('sexo', value)} disabled={disabled} />
      </FormField>

      <div className="gan-hato-row">
        <FormField label="Número de chapeta">
          <input
            value={form.numeroVisual}
            maxLength={40}
            inputMode="text"
            autoComplete="off"
            onChange={(event) => onChange('numeroVisual', event.target.value)}
            disabled={disabled}
          />
        </FormField>
        <FormField label="Nombre">
          <input
            value={form.nombre}
            maxLength={120}
            autoComplete="off"
            onChange={(event) => onChange('nombre', event.target.value)}
            disabled={disabled}
          />
        </FormField>
      </div>
      <p className="gan-hato-hint">Escribe al menos el número de chapeta o el nombre.</p>

      <FormField label="¿Conoce la edad del animal?">
        <ChoiceGroup
          name="nacimientoModo"
          options={NACIMIENTO_MODOS}
          value={form.nacimientoModo}
          onChange={(value) => onChange('nacimientoModo', value)}
          disabled={disabled}
        />
      </FormField>
      {form.nacimientoModo === 'EXACTA' ? (
        <FormField label="Fecha de nacimiento" required>
          <input
            type="date"
            value={form.fechaNacimiento}
            min="1990-01-01"
            max={maxFecha}
            onChange={(event) => onChange('fechaNacimiento', event.target.value)}
            disabled={disabled}
          />
        </FormField>
      ) : null}
      {form.nacimientoModo === 'APROXIMADA' ? (
        <FormField label="Edad aproximada (meses)" required>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            max="300"
            step="1"
            value={form.edadAproximadaMeses}
            onChange={(event) => onChange('edadAproximadaMeses', event.target.value)}
            disabled={disabled}
          />
        </FormField>
      ) : null}

      <FormField label="Raza / cruce">
        <ChoiceGroup
          name="razaModo"
          options={RAZA_MODOS}
          value={form.razaModo}
          onChange={(value) => onChange('razaModo', value)}
          disabled={disabled}
        />
      </FormField>
      {form.razaModo === 'CATALOGO' ? (
        <FormField label="Raza" required>
          <RazaSelect
            razas={razas}
            value={form.razaPrincipalId}
            onChange={(value) => onChange('razaPrincipalId', value)}
            disabled={disabled}
            placeholder="Selecciona la raza"
          />
        </FormField>
      ) : null}
      {form.razaModo === 'OTRA' ? (
        <FormField label="Nombre de la raza" required>
          <input
            value={form.razaOtroNombre}
            maxLength={120}
            placeholder="Ej. Charolais"
            onChange={(event) => onChange('razaOtroNombre', event.target.value)}
            disabled={disabled}
          />
        </FormField>
      ) : null}
      {form.razaModo === 'CRUCE' ? (
        <>
          <FormField label="Describe el cruce">
            <input
              value={form.cruceDescripcion}
              maxLength={200}
              placeholder="Ej. Angus × Brahman, mestizo comercial"
              onChange={(event) => onChange('cruceDescripcion', event.target.value)}
              disabled={disabled}
            />
          </FormField>
          <FormField label="Raza predominante (opcional)">
            <RazaSelect
              razas={razas}
              value={form.razaPrincipalId}
              onChange={(value) => onChange('razaPrincipalId', value)}
              disabled={disabled}
              placeholder="No sé / no aplica"
            />
          </FormField>
        </>
      ) : null}

      <FormField label="Categoría (opcional)">
        <select
          value={form.categoriaProductivaId}
          onChange={(event) => onChange('categoriaProductivaId', event.target.value)}
          disabled={disabled || !form.sexo}
        >
          <option value="">{form.sexo ? 'Sin categoría' : 'Primero indica el sexo'}</option>
          {categoriasDisponibles.map((categoria) => (
            <option key={categoria.categoriaId} value={categoria.categoriaId}>{categoria.nombre}</option>
          ))}
        </select>
      </FormField>

      {showPeso ? (
        <>
          <FormField label="Peso (kg, opcional)">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              max="2000"
              step="0.1"
              value={form.pesoInicialKg}
              onChange={(event) => onChange('pesoInicialKg', event.target.value)}
              disabled={disabled}
            />
          </FormField>
          {String(form.pesoInicialKg).trim() !== '' ? (
            <FormField label="¿Cómo obtuvo este peso?" required>
              <ChoiceGroup
                name="pesoInicialMetodo"
                options={PESO_METODOS}
                value={form.pesoInicialMetodo}
                onChange={(value) => onChange('pesoInicialMetodo', value)}
                disabled={disabled}
              />
            </FormField>
          ) : null}
        </>
      ) : null}

      <details className="gan-hato-more">
        <summary>Más datos</summary>
        <FormField label="Origen">
          <select value={form.origenTipo} onChange={(event) => onChange('origenTipo', event.target.value)} disabled={disabled}>
            <option value="">No indicado</option>
            {ORIGENES.map((origen) => (
              <option key={origen.value} value={origen.value}>{origen.label}</option>
            ))}
          </select>
        </FormField>
        {form.origenTipo && !nacidoEnPredio ? (
          <>
            <FormField label="Procedencia">
              <input
                value={form.procedencia}
                maxLength={200}
                placeholder="Ej. Finca vecina, subasta"
                onChange={(event) => onChange('procedencia', event.target.value)}
                disabled={disabled}
              />
            </FormField>
            <FormField label="Fecha de ingreso">
              <input
                type="date"
                value={form.fechaIngreso}
                min="1990-01-01"
                max={maxFecha}
                onChange={(event) => onChange('fechaIngreso', event.target.value)}
                disabled={disabled}
              />
            </FormField>
          </>
        ) : null}
        <FormField label="Observaciones">
          <textarea
            value={form.observaciones}
            maxLength={2000}
            rows={3}
            onChange={(event) => onChange('observaciones', event.target.value)}
            disabled={disabled}
          />
        </FormField>
      </details>
    </div>
  );
}
