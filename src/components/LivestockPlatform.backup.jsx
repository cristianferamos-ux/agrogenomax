import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  CalendarClock,
  Database,
  Download,
  Dna,
  FileCheck2,
  Fingerprint,
  HeartPulse,
  Layers3,
  LockKeyhole,
  Map,
  QrCode,
  ShieldCheck,
  Sprout,
  Syringe,
  Trees,
  Users,
  WifiOff,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  animalStatuses,
  cattleBreeds,
  exploitationTypes,
  infrastructureOptions,
  livestockModules,
  pastureOptions,
  silvopastoralOptions,
  tenantRoles,
} from '../data/livestockCatalogs.js';
import { enqueueOfflineMutation, getOfflineCapability } from '../lib/offlineStore.js';
import { agxApi, supabaseConfig } from '../lib/supabaseClient.js';

const demoAnimals = [
  {
    code: 'BOV-AX-901',
    tag: 'AGX-901',
    name: 'Genesis FIV 901',
    sex: 'Hembra',
    status: 'Donadora',
    breed: 'Brahman Rojo x Gyr',
    farm: 'Genesis Norte',
    weight: 486,
    reproductive: 'Apta TE',
  },
  {
    code: 'BOV-AX-118',
    tag: 'AGX-118',
    name: 'Norte IAFT 118',
    sex: 'Hembra',
    status: 'Receptora',
    breed: 'Girolando',
    farm: 'Genesis Norte',
    weight: 412,
    reproductive: 'Gestante 74 dias',
  },
  {
    code: 'BOV-AX-044',
    tag: 'AGX-044',
    name: 'Toro Carbono 44',
    sex: 'Macho',
    status: 'Toro',
    breed: 'Brahman Gris',
    farm: 'Genesis Norte',
    weight: 742,
    reproductive: 'Semen activo',
  },
];

const kpis = [
  ['1,284', 'Animales', Fingerprint, 'text-neon'],
  ['812', 'Hembras', HeartPulse, 'text-aqua'],
  ['326', 'Gestantes', BadgeCheck, 'text-neon'],
  ['18,420 L', 'Leche mes', BarChart3, 'text-aqua'],
  ['37', 'Vacunas proximas', Syringe, 'text-neon'],
  ['14', 'Partos 30 dias', CalendarClock, 'text-aqua'],
];

const moduleIcons = {
  'Predios / Fincas': Trees,
  Animales: Fingerprint,
  Reproduccion: Dna,
  Sanidad: HeartPulse,
  Produccion: BarChart3,
  Nutricion: Sprout,
  Potreros: Map,
  Pesajes: Activity,
  Genetica: Dna,
  Reportes: FileCheck2,
  'QR y Trazabilidad': QrCode,
  'Transferencia de Embriones': Layers3,
  'IA e IAFT': Activity,
  'Dashboard Inteligente': BarChart3,
  Administracion: ShieldCheck,
  Usuarios: Users,
  Configuracion: LockKeyhole,
};

function buildQrCells(payload) {
  const seed = [...payload].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const cells = [];
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 21; x += 1) {
      const finder =
        (x < 7 && y < 7) ||
        (x > 13 && y < 7) ||
        (x < 7 && y > 13);
      const finderInner =
        ((x > 1 && x < 5 && y > 1 && y < 5) ||
          (x > 15 && x < 19 && y > 1 && y < 5) ||
          (x > 1 && x < 5 && y > 15 && y < 19));
      const data = ((x * 17 + y * 31 + seed) % 7) < 3 || ((x + y + seed) % 11) === 0;
      cells.push({ x, y, on: finder ? true : finderInner || data });
    }
  }
  return cells;
}

function QrPreview({ payload }) {
  const cells = useMemo(() => buildQrCells(payload), [payload]);
  const downloadSvg = () => {
    const svg = document.getElementById('agx-qr-preview')?.outerHTML;
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${payload.replace(/[^a-z0-9-]/gi, '-')}.svg`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="agx-qr-panel">
      <svg id="agx-qr-preview" viewBox="0 0 252 252" role="img" aria-label={`QR ${payload}`}>
        <rect width="252" height="252" rx="22" fill="#020508" />
        <rect x="8" y="8" width="236" height="236" rx="18" fill="none" stroke="#9cff1a" strokeWidth="3" />
        <rect x="13" y="13" width="226" height="226" rx="15" fill="none" stroke="#00d8ff" strokeWidth="2" opacity="0.75" />
        {cells.map((cell) => (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={cell.x * 10 + 21}
            y={cell.y * 10 + 21}
            width="8"
            height="8"
            rx="1.5"
            fill={cell.on ? (cell.x > 10 ? '#00d8ff' : '#9cff1a') : 'transparent'}
          />
        ))}
      </svg>
      <div>
        <strong>{payload}</strong>
        <span>Ficha animal segura / offline-ready</span>
      </div>
      <button type="button" onClick={downloadSvg}>
        <Download className="h-4 w-4" />
        Descargar QR
      </button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="agx-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextInput({ label, ...props }) {
  return (
    <Field label={label}>
      <input {...props} />
    </Field>
  );
}

function MultiSelectChips({ options, selected, setSelected }) {
  const toggle = (value) => {
    setSelected((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  return (
    <div className="agx-chip-grid">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => toggle(option)}
          className={selected.includes(option) ? 'is-selected' : ''}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export default function LivestockPlatform() {
  const [activeModule, setActiveModule] = useState('Dashboard Inteligente');
  const [farmSelections, setFarmSelections] = useState({
    exploitation: ['Doble proposito', 'Genetica'],
    infrastructure: ['Corrales', 'Bretes', 'Bascula', 'Agua'],
    pastures: ['Brachiaria brizantha'],
    silvopastoral: ['Leucaena', 'Boton de oro'],
  });
  const [animalDraft, setAnimalDraft] = useState({
    code: 'BOV-AX-NEW',
    tag: '',
    name: '',
    sex: 'Hembra',
    status: 'Novilla',
    breedMode: 'pure',
    breed1: 'Brahman Gris',
    breed1Pct: 50,
    breed2: 'Gyr',
    breed2Pct: 50,
    breed3: '',
    breed3Pct: 0,
    birthDate: '',
    bodyCondition: '',
  });
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const capability = getOfflineCapability();

  const qrPayload = `${import.meta.env.VITE_AGX_PUBLIC_APP_URL || window.location.origin}/animal/${animalDraft.code}`;

  const handleOfflineSave = async () => {
    if (!acceptedLegal) {
      setSaveState('legal');
      return;
    }

    const payload = {
      code: animalDraft.code,
      tag_number: animalDraft.tag,
      name: animalDraft.name,
      sex: animalDraft.sex,
      status: animalDraft.status,
      breed_mode: animalDraft.breedMode,
      qr_payload: qrPayload,
      offline_created_at: new Date().toISOString(),
    };

    try {
      if (supabaseConfig.isConfigured && navigator.onLine) {
        await agxApi.insert('animals', payload);
        setSaveState('synced');
      } else {
        await enqueueOfflineMutation('animals', payload);
        setSaveState('queued');
      }
    } catch {
      await enqueueOfflineMutation('animals', payload);
      setSaveState('queued');
    }
  };

  return (
    <section id="gestion-ganadera" className="px-5 py-28 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-10 grid gap-8 lg:grid-cols-[0.78fr_1.22fr] lg:items-end">
          <div>
            <p className="eyebrow text-neon">Gestion Ganadera SaaS</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Nucleo operativo para trazabilidad bovina, genetica y reproduccion avanzada.
            </h2>
          </div>
          <div className="agx-architecture-strip">
            {[
              ['Supabase', Database],
              ['RLS multi-tenant', ShieldCheck],
              ['Offline-first', WifiOff],
              ['QR trazable', QrCode],
            ].map(([label, Icon]) => (
              <div key={label}>
                <Icon className="h-5 w-5" />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="agx-saas-shell">
          <aside className="agx-module-rail">
            <div className="agx-tenant-card">
              <span>Tenant activo</span>
              <strong>AgroGenomaX Demo</strong>
              <small>{supabaseConfig.isConfigured ? 'Supabase conectado' : 'Modo demo / offline'}</small>
            </div>
            <div className="agx-module-list">
              {livestockModules.map((module) => {
                const Icon = moduleIcons[module] || Layers3;
                return (
                  <button
                    key={module}
                    type="button"
                    onClick={() => setActiveModule(module)}
                    className={activeModule === module ? 'is-active' : ''}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{module}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="agx-workspace">
            <div className="agx-workspace-top">
              <div>
                <span>Modulo activo</span>
                <strong>{activeModule}</strong>
              </div>
              <div className={capability.online ? 'agx-sync-pill is-online' : 'agx-sync-pill'}>
                <span />
                {capability.online ? 'Online' : 'Offline'}
              </div>
            </div>

            <div className="agx-kpi-grid">
              {kpis.map(([value, label, Icon, tone]) => (
                <div key={label} className="agx-kpi">
                  <Icon className={`h-5 w-5 ${tone}`} />
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>

            <div className="agx-panels">
              <div className="agx-panel">
                <div className="agx-panel-heading">
                  <div>
                    <span>Predios / Fincas</span>
                    <strong>Registro operativo</strong>
                  </div>
                  <Trees className="h-5 w-5 text-neon" />
                </div>
                <div className="agx-form-grid">
                  <TextInput label="Nombre predio" placeholder="Genesis Norte" />
                  <TextInput label="Codigo interno" placeholder="AGX-04" />
                  <TextInput label="Propietario" placeholder="Nombre propietario" />
                  <TextInput label="Documento / NIT" placeholder="900000000-0" />
                  <TextInput label="Telefono" placeholder="+57" />
                  <TextInput label="Correo" placeholder="correo@empresa.com" />
                  <TextInput label="Departamento" placeholder="Caqueta" />
                  <TextInput label="Municipio" placeholder="Florencia" />
                  <TextInput label="Vereda" placeholder="Vereda" />
                  <TextInput label="Coordenadas GPS" placeholder="1.614, -75.613" />
                  <TextInput label="Area total ha" placeholder="2140" />
                  <TextInput label="Area productiva ha" placeholder="1380" />
                </div>
                <div className="agx-selector-block">
                  <span>Tipo de explotacion</span>
                  <MultiSelectChips
                    options={exploitationTypes}
                    selected={farmSelections.exploitation}
                    setSelected={(updater) =>
                      setFarmSelections((current) => ({ ...current, exploitation: updater(current.exploitation) }))
                    }
                  />
                </div>
                <div className="agx-selector-block">
                  <span>Infraestructura</span>
                  <MultiSelectChips
                    options={infrastructureOptions}
                    selected={farmSelections.infrastructure}
                    setSelected={(updater) =>
                      setFarmSelections((current) => ({ ...current, infrastructure: updater(current.infrastructure) }))
                    }
                  />
                </div>
                <div className="agx-selector-block">
                  <span>Pasturas</span>
                  <MultiSelectChips
                    options={pastureOptions}
                    selected={farmSelections.pastures}
                    setSelected={(updater) =>
                      setFarmSelections((current) => ({ ...current, pastures: updater(current.pastures) }))
                    }
                  />
                </div>
                <div className="agx-selector-block">
                  <span>Sistemas silvopastoriles</span>
                  <MultiSelectChips
                    options={silvopastoralOptions}
                    selected={farmSelections.silvopastoral}
                    setSelected={(updater) =>
                      setFarmSelections((current) => ({ ...current, silvopastoral: updater(current.silvopastoral) }))
                    }
                  />
                </div>
              </div>

              <div className="agx-panel">
                <div className="agx-panel-heading">
                  <div>
                    <span>Animales</span>
                    <strong>Registro individual</strong>
                  </div>
                  <Fingerprint className="h-5 w-5 text-aqua" />
                </div>
                <div className="agx-form-grid">
                  <TextInput
                    label="Codigo unico"
                    value={animalDraft.code}
                    onChange={(event) => setAnimalDraft({ ...animalDraft, code: event.target.value })}
                  />
                  <TextInput
                    label="Numero chapeta"
                    value={animalDraft.tag}
                    onChange={(event) => setAnimalDraft({ ...animalDraft, tag: event.target.value })}
                  />
                  <TextInput
                    label="Nombre"
                    value={animalDraft.name}
                    onChange={(event) => setAnimalDraft({ ...animalDraft, name: event.target.value })}
                  />
                  <Field label="Sexo">
                    <select
                      value={animalDraft.sex}
                      onChange={(event) => setAnimalDraft({ ...animalDraft, sex: event.target.value })}
                    >
                      <option>Macho</option>
                      <option>Hembra</option>
                    </select>
                  </Field>
                  <Field label="Estado">
                    <select
                      value={animalDraft.status}
                      onChange={(event) => setAnimalDraft({ ...animalDraft, status: event.target.value })}
                    >
                      {animalStatuses.map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tipo genetico">
                    <select
                      value={animalDraft.breedMode}
                      onChange={(event) => setAnimalDraft({ ...animalDraft, breedMode: event.target.value })}
                    >
                      <option value="pure">Raza pura</option>
                      <option value="cross">Cruce multiple</option>
                    </select>
                  </Field>
                  <Field label="Raza 1">
                    <select
                      value={animalDraft.breed1}
                      onChange={(event) => setAnimalDraft({ ...animalDraft, breed1: event.target.value })}
                    >
                      {cattleBreeds.map((breed) => (
                        <option key={breed}>{breed}</option>
                      ))}
                    </select>
                  </Field>
                  <TextInput
                    label="% raza 1"
                    type="number"
                    value={animalDraft.breed1Pct}
                    onChange={(event) => setAnimalDraft({ ...animalDraft, breed1Pct: event.target.value })}
                  />
                  <Field label="Raza 2">
                    <select
                      value={animalDraft.breed2}
                      onChange={(event) => setAnimalDraft({ ...animalDraft, breed2: event.target.value })}
                    >
                      {cattleBreeds.map((breed) => (
                        <option key={breed}>{breed}</option>
                      ))}
                    </select>
                  </Field>
                  <TextInput
                    label="% raza 2"
                    type="number"
                    value={animalDraft.breed2Pct}
                    onChange={(event) => setAnimalDraft({ ...animalDraft, breed2Pct: event.target.value })}
                  />
                  <TextInput label="Fecha nacimiento" type="date" />
                  <TextInput label="Peso nacimiento kg" type="number" placeholder="32" />
                  <TextInput label="Color" placeholder="Rojo cereza" />
                  <TextInput
                    label="Estado corporal"
                    value={animalDraft.bodyCondition}
                    onChange={(event) => setAnimalDraft({ ...animalDraft, bodyCondition: event.target.value })}
                    placeholder="3.5"
                  />
                  <TextInput label="Madre" placeholder="BOV-AX-001" />
                  <TextInput label="Padre" placeholder="Toro / pajilla" />
                  <TextInput label="Linea genetica" placeholder="FIV / TE / IAFT" />
                  <TextInput label="Procedencia" placeholder="Predio origen" />
                </div>
                <QrPreview payload={animalDraft.code || 'BOV-AX-NEW'} />
                <label className="agx-legal-check">
                  <input
                    type="checkbox"
                    checked={acceptedLegal}
                    onChange={(event) => setAcceptedLegal(event.target.checked)}
                  />
                  <span>
                    Acepto politica de privacidad, tratamiento de datos personales, terminos y consentimiento de Habeas Data.
                  </span>
                </label>
                <div className="agx-action-row">
                  <button type="button" onClick={handleOfflineSave}>
                    <Database className="h-4 w-4" />
                    Guardar animal
                  </button>
                  {saveState === 'queued' && <span>Guardado offline. Se sincronizara al volver la conexion.</span>}
                  {saveState === 'synced' && <span>Registro enviado a Supabase.</span>}
                  {saveState === 'legal' && <span>Acepta Habeas Data para continuar.</span>}
                </div>
              </div>
            </div>

            <div className="agx-panels agx-panels-compact">
              <div className="agx-panel">
                <div className="agx-panel-heading">
                  <div>
                    <span>Reproduccion avanzada</span>
                    <strong>IA, IAFT y transferencia de embriones</strong>
                  </div>
                  <Dna className="h-5 w-5 text-neon" />
                </div>
                <div className="agx-timeline">
                  {[
                    ['Celo', '2026-05-24', 'Observacion positiva / protocolo iniciado'],
                    ['IAFT', '2026-05-27', 'Tecnico asignado, pajilla registrada'],
                    ['Diagnostico', '2026-06-26', 'Ecografia programada'],
                    ['Parto probable', '2027-02-04', 'Alerta automatica'],
                  ].map(([title, date, text]) => (
                    <div key={title}>
                      <span />
                      <strong>{title}</strong>
                      <small>{date}</small>
                      <p>{text}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="agx-panel">
                <div className="agx-panel-heading">
                  <div>
                    <span>Super Admin</span>
                    <strong>Control global AgroGenomaX</strong>
                  </div>
                  <ShieldCheck className="h-5 w-5 text-aqua" />
                </div>
                <div className="agx-admin-grid">
                  {[
                    ['Usuarios', '42'],
                    ['Organizaciones', '8'],
                    ['Hectareas', '12,840'],
                    ['Auditorias', '1,920'],
                    ['Roles', tenantRoles.length],
                    ['Logs 24h', '318'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <strong>{value}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                <div className="agx-alert-box">
                  <AlertTriangle className="h-5 w-5 text-neon" />
                  <p>
                    Las politicas RLS incluidas separan datos por empresa. El rol SUPER_ADMIN puede auditar todos los tenants.
                  </p>
                </div>
              </div>
            </div>

            <div className="agx-table-panel">
              <div className="agx-panel-heading">
                <div>
                  <span>Trazabilidad animal</span>
                  <strong>Ficha rapida y rendimiento</strong>
                </div>
                <QrCode className="h-5 w-5 text-neon" />
              </div>
              <div className="agx-animal-table">
                {demoAnimals.map((animal) => (
                  <div key={animal.code}>
                    <span>{animal.code}</span>
                    <strong>{animal.name}</strong>
                    <small>{animal.breed}</small>
                    <em>{animal.status}</em>
                    <b>{animal.weight} kg</b>
                    <p>{animal.reproductive}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
