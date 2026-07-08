import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Beef,
  CheckCircle2,
  ClipboardList,
  Dna,
  FileBarChart,
  LayoutDashboard,
  Milk,
  QrCode,
  RotateCcw,
  Scale,
  Stethoscope,
  Syringe,
  Tag,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import GanaderiaDemoNotice from '../components/GanaderiaDemoNotice.jsx';
import { loadDemoData, resetDemoData } from '../data/ganaderiaDemoData.js';
import { aplicaProduccionLeche, aplicaComercializacion } from '../engine/categoria.js';
import { buildDemoReportPdfBlob, downloadBlob } from '../utils/demoPdf.js';
import '../styles/ganaderia-dashboard.css';
import '../styles/ganaderia-demo.css';

const tabs = [
  { id: 'resumen', label: 'Resumen', icon: LayoutDashboard },
  { id: 'animales', label: 'Animales', icon: Beef },
  { id: 'ficha', label: 'Ficha animal', icon: ClipboardList },
  { id: 'qr', label: 'QR', icon: QrCode },
  { id: 'pesajes', label: 'Pesajes', icon: Scale },
  { id: 'sanidad', label: 'Sanidad', icon: Syringe },
  { id: 'tratamientos', label: 'Tratamientos', icon: Stethoscope },
  { id: 'reproduccion', label: 'Reproducción', icon: Dna },
  { id: 'leche', label: 'Producción de leche', icon: Milk },
  { id: 'comercializacion', label: 'Comercialización', icon: Tag },
  { id: 'reportes', label: 'Reportes', icon: FileBarChart },
];

function formatKg(value) {
  return Number.isFinite(value) ? value.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

function formatFecha(iso) {
  // Extrae AAAA-MM-DD directo del string cuando es posible, para no depender
  // de cómo el navegador interprete la zona horaria al construir un Date().
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, yyyy, mm, dd] = match;
    return `${dd}-${mm}-${yyyy}`;
  }
  const date = new Date(iso);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

export default function GanaderiaDemo() {
  const [data, setData] = useState(() => loadDemoData());
  const [activeTab, setActiveTab] = useState('resumen');
  const [casoActivo, setCasoActivo] = useState('coronado');

  const handleReset = () => {
    setData(resetDemoData());
    setActiveTab('resumen');
    setCasoActivo('coronado');
  };

  const coronado = data.casos.coronado;
  const esperanza = data.casos.esperanza;
  const caso = casoActivo === 'coronado' ? coronado : esperanza;

  const verFicha = (casoId) => {
    setCasoActivo(casoId);
    setActiveTab('ficha');
  };

  return (
    <div className="gan-dash-shell">
      <nav className="gan-dash-sidebar" aria-label="Secciones de la demo">
        <div className="gan-dash-sidebar-brand">
          <QrCode size={20} />
          <span>Demo Ganadería</span>
        </div>
        <div className="gan-dash-sidebar-links">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                className={`gan-dash-sidebar-link${activeTab === tab.id ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={18} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <main className="gan-dash-main">
        <Link to="/ganaderia/acceso" className="gan-dash-back">
          ← Volver a Ganadería Inteligente
        </Link>
        <GanaderiaDemoNotice />

        <header className="gan-dash-header">
          <div>
            <span className="gan-dash-badge">Modo Demo</span>
            <h1>Cuenta Demo — Ganadería Inteligente</h1>
            <p>Dos casos completos de ejemplo: Coronado y Esperanza. Los datos son temporales y se reinician al cerrar esta pestaña.</p>
          </div>
          <div className="gan-dash-header-actions">
            <button type="button" className="gan-dash-btn is-outline" onClick={handleReset}>
              <RotateCcw size={16} /> Reiniciar demo
            </button>
          </div>
        </header>

        {activeTab !== 'resumen' && activeTab !== 'animales' && (
          <CaseSelector casoActivo={casoActivo} onChange={setCasoActivo} coronado={coronado} esperanza={esperanza} />
        )}

        {activeTab === 'resumen' && <ResumenTab coronado={coronado} esperanza={esperanza} onVerFicha={verFicha} />}
        {activeTab === 'animales' && <AnimalesTab coronado={coronado} esperanza={esperanza} onVerFicha={verFicha} />}
        {activeTab === 'ficha' && <FichaTab caso={caso} casoActivo={casoActivo} />}
        {activeTab === 'qr' && <QrTab coronado={coronado} esperanza={esperanza} onVerFicha={verFicha} />}
        {activeTab === 'pesajes' && <PesajesTab caso={caso} casoActivo={casoActivo} />}
        {activeTab === 'sanidad' && <SanidadTab caso={caso} />}
        {activeTab === 'tratamientos' && <TratamientosTab caso={caso} />}
        {activeTab === 'reproduccion' && <ReproduccionTab caso={caso} casoActivo={casoActivo} />}
        {activeTab === 'leche' && <LecheTab caso={caso} casoActivo={casoActivo} />}
        {activeTab === 'comercializacion' && <ComercializacionTab caso={caso} casoActivo={casoActivo} />}
        {activeTab === 'reportes' && <ReportesTab coronado={coronado} esperanza={esperanza} />}
      </main>
    </div>
  );
}

function CaseSelector({ casoActivo, onChange, coronado, esperanza }) {
  return (
    <div className="gan-demo-case-selector" role="tablist" aria-label="Seleccionar caso demo">
      <button
        type="button"
        role="tab"
        aria-selected={casoActivo === 'coronado'}
        className={`gan-demo-case-btn${casoActivo === 'coronado' ? ' is-active' : ''}`}
        onClick={() => onChange('coronado')}
      >
        Ver caso {coronado.identidad.nombre}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={casoActivo === 'esperanza'}
        className={`gan-demo-case-btn${casoActivo === 'esperanza' ? ' is-active' : ''}`}
        onClick={() => onChange('esperanza')}
      >
        Ver caso {esperanza.identidad.nombre}
      </button>
    </div>
  );
}

function NotApplicable({ text }) {
  return (
    <div className="gan-demo-not-applicable">
      <p>{text}</p>
    </div>
  );
}

function ResumenTab({ coronado, esperanza, onVerFicha }) {
  return (
    <section className="gan-dash-section">
      <h2>Resumen comparativo de la sesión demo</h2>
      <div className="gan-demo-summary-grid">
        <article className="gan-demo-summary-card">
          <header>
            <strong>{coronado.identidad.nombre}</strong>
            <span>{coronado.identidad.raza}</span>
          </header>
          <ul>
            <li>Peso actual: <strong>{coronado.identidad.pesoActualKg} kg</strong></li>
            <li>Categoría: <strong>{coronado.identidad.categoria}</strong></li>
            <li className="is-positive">
              <CheckCircle2 size={15} /> Alerta de crecimiento resuelta ({coronado.analisisPesajes.evidenciaRecuperacion})
            </li>
          </ul>
          <button type="button" className="gan-dash-btn is-outline" onClick={() => onVerFicha('coronado')}>
            Ver ficha de {coronado.identidad.nombre}
          </button>
        </article>

        <article className="gan-demo-summary-card">
          <header>
            <strong>{esperanza.identidad.nombre}</strong>
            <span>{esperanza.identidad.raza}</span>
          </header>
          <ul>
            <li>Producción de hoy: <strong>{esperanza.produccionLeche.litros_hoy} L</strong></li>
            <li>Días en leche: <strong>{esperanza.reproduccion.diasEnLeche}</strong></li>
            <li className={esperanza.produccionLeche.caida?.hayCaida ? 'is-alert' : 'is-positive'}>
              <AlertTriangle size={15} /> Alerta activa: {esperanza.produccionLeche.alerta_principal}
            </li>
          </ul>
          <button type="button" className="gan-dash-btn is-outline" onClick={() => onVerFicha('esperanza')}>
            Ver ficha de {esperanza.identidad.nombre}
          </button>
        </article>
      </div>
    </section>
  );
}

function AnimalesTab({ coronado, esperanza, onVerFicha }) {
  return (
    <section className="gan-dash-section">
      <h2>Animales de la sesión demo</h2>
      <p className="gan-demo-report-text">
        Esta demo trabaja con dos casos completos, no con un listado abierto de animales genéricos.
      </p>
      <div className="gan-demo-animales-grid">
        <article className="gan-demo-animal-card">
          <strong>{coronado.identidad.nombre}</strong>
          <span>{coronado.identidad.raza}</span>
          <span className="gan-demo-animal-status is-ready">{coronado.identidad.estadoComercial}</span>
          <button type="button" className="gan-dash-btn is-primary" onClick={() => onVerFicha('coronado')}>
            Ver ficha
          </button>
        </article>
        <article className="gan-demo-animal-card">
          <strong>{esperanza.identidad.nombre}</strong>
          <span>{esperanza.identidad.raza}</span>
          <span className="gan-demo-animal-status is-lactating">{esperanza.identidad.estadoProductivo}</span>
          <button type="button" className="gan-dash-btn is-primary" onClick={() => onVerFicha('esperanza')}>
            Ver ficha
          </button>
        </article>
      </div>
    </section>
  );
}

function FichaTab({ caso, casoActivo }) {
  const { identidad, genealogia } = caso;
  const isCoronado = casoActivo === 'coronado';

  return (
    <section className="gan-dash-section">
      <h2>Ficha de {identidad.nombre}</h2>

      <div className="gan-demo-ficha-head">
        <div className="gan-demo-ficha-row">
          <span>Código interno</span>
          <strong>{identidad.codigoInterno}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>QR demo</span>
          <strong>{identidad.qrCodigo}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Sexo</span>
          <strong>{identidad.sexo}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Raza / composición</span>
          <strong>{identidad.composicionRacial}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Fecha de nacimiento</span>
          <strong>{formatFecha(identidad.fechaNacimiento)}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Edad</span>
          <strong>{isCoronado ? `${identidad.edadMeses} meses` : identidad.edadAproximada}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Categoría</span>
          <strong>{identidad.categoria}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Etapa (motor común)</span>
          <strong>{isCoronado ? caso.pesajes[caso.pesajes.length - 1]?.categoria_evaluada : identidad.categoriaEtapa}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Estado productivo</span>
          <strong>{identidad.estadoProductivo}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Predio / potrero</span>
          <strong>{identidad.predioReferencia} — {identidad.potreroReferencia}</strong>
        </div>
      </div>

      <h3 className="gan-demo-list-title">Genealogía</h3>
      <div className="gan-demo-ficha-head">
        {isCoronado ? (
          <>
            <div className="gan-demo-ficha-row">
              <span>Padre</span>
              <strong>{genealogia.padre} ({genealogia.razaPadre})</strong>
            </div>
            <div className="gan-demo-ficha-row">
              <span>Madre</span>
              <strong>{genealogia.madre} ({genealogia.razaMadre})</strong>
            </div>
            <div className="gan-demo-ficha-row">
              <span>Pureza</span>
              <strong>{genealogia.pureza}</strong>
            </div>
          </>
        ) : (
          <>
            <div className="gan-demo-ficha-row">
              <span>Madre</span>
              <strong>{genealogia.madre} ({genealogia.razaMadre})</strong>
            </div>
            <div className="gan-demo-ficha-row">
              <span>Padre</span>
              <strong>{genealogia.padre} ({genealogia.razaPadre})</strong>
            </div>
            <div className="gan-demo-ficha-row">
              <span>Composición racial</span>
              <strong>{genealogia.composicionRacial}</strong>
            </div>
          </>
        )}
        <div className="gan-demo-ficha-row">
          <span>Genética avanzada</span>
          <strong>{genealogia.geneticaAvanzada}</strong>
        </div>
      </div>

      {isCoronado ? (
        <>
          <h3 className="gan-demo-list-title">Origen reproductivo</h3>
          <p className="gan-demo-report-text">
            <strong>{caso.origenReproductivo.metodo}.</strong> {caso.origenReproductivo.descripcion}
          </p>
          <p className="gan-demo-note">{caso.origenReproductivo.nota}</p>
        </>
      ) : (
        <>
          <h3 className="gan-demo-list-title">Origen (F1)</h3>
          <p className="gan-demo-report-text">{genealogia.origen} {genealogia.explicacionF1}</p>
        </>
      )}

      <h3 className="gan-demo-list-title">Alertas y recomendaciones principales</h3>
      {isCoronado ? (
        <div className="gan-demo-alert-box is-positive">
          <CheckCircle2 size={18} />
          <p>{caso.analisisPesajes.evidenciaRecuperacion}</p>
        </div>
      ) : (
        <div className={`gan-demo-alert-box ${caso.produccionLeche.caida?.hayCaida ? 'is-alert' : 'is-positive'}`}>
          <AlertTriangle size={18} />
          <div>
            <p>{caso.produccionLeche.alerta_principal}</p>
            <p className="gan-demo-note">{caso.produccionLeche.recomendacion}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function QrTab({ coronado, esperanza, onVerFicha }) {
  return (
    <section className="gan-dash-section">
      <h2>Códigos QR digitales de la demo</h2>
      <div className="gan-demo-qr-grid">
        {[coronado, esperanza].map((animalCaso) => {
          const casoId = animalCaso === coronado ? 'coronado' : 'esperanza';
          return (
            <article key={animalCaso.identidad.codigoInterno} className="gan-demo-qr-card">
              <div className="gan-demo-qr-pattern" aria-hidden="true" />
              <strong>{animalCaso.identidad.nombre}</strong>
              <code>{animalCaso.identidad.qrCodigo}</code>
              <button type="button" className="gan-dash-btn is-outline" onClick={() => onVerFicha(casoId)}>
                Ver ficha
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PesajesTab({ caso, casoActivo }) {
  if (casoActivo === 'coronado') {
    return (
      <section className="gan-dash-section">
        <h2>Pesajes de {caso.identidad.nombre} — checkpoints desde el nacimiento</h2>
        <div className="gan-demo-table gan-demo-table-checkpoints">
          {caso.pesajes.map((checkpoint) => (
            <div key={checkpoint.etapa} className="gan-demo-table-row">
              <strong>{checkpoint.etapa}</strong>
              <span>{formatFecha(checkpoint.fecha_pesaje)} — {checkpoint.categoria_evaluada}</span>
              <span>{checkpoint.peso_kg} kg</span>
              <span className={checkpoint.estado_productivo_class}>
                {checkpoint.ganancia_diaria_kg === null ? '—' : `${formatKg(checkpoint.ganancia_diaria_kg)} kg/día · ${checkpoint.estado_productivo}`}
              </span>
            </div>
          ))}
        </div>

        <div className="gan-demo-alert-box is-warning">
          <AlertTriangle size={18} />
          <div>
            <p><strong>Interpretación:</strong> {caso.analisisPesajes.interpretacion}</p>
            <p>{caso.analisisPesajes.alerta}</p>
            <p className="gan-demo-note"><strong>Recomendación:</strong> {caso.analisisPesajes.recomendacion}</p>
          </div>
        </div>
        <div className="gan-demo-alert-box is-positive">
          <CheckCircle2 size={18} />
          <p>{caso.analisisPesajes.evidenciaRecuperacion}</p>
        </div>
        <p className="gan-demo-note">Ganancia diaria promedio general (nacimiento a hoy): {formatKg(caso.analisisPesajes.gdpGeneralKgDia)} kg/día.</p>
      </section>
    );
  }

  return (
    <section className="gan-dash-section">
      <h2>Pesajes mensuales de {caso.identidad.nombre}</h2>
      <div className="gan-demo-table">
        {caso.pesajesMensuales.map((registro) => (
          <div key={registro.etapa} className="gan-demo-table-row">
            <strong>{registro.etapa}</strong>
            <span>{registro.pesoKg} kg</span>
          </div>
        ))}
      </div>
      <div className="gan-demo-alert-box is-positive">
        <TrendingUp size={18} />
        <p>{caso.condicionCorporal.interpretacion}</p>
      </div>
      <p className="gan-demo-note">Condición corporal actual: {caso.condicionCorporal.valor}.</p>
    </section>
  );
}

function SanidadTab({ caso }) {
  const esLista = Array.isArray(caso.sanidad) && caso.sanidad.length > 0 && 'etapa' in caso.sanidad[0];

  return (
    <section className="gan-dash-section">
      <h2>Plan sanitario de {caso.identidad.nombre}</h2>
      <div className="gan-demo-table">
        {esLista
          ? caso.sanidad.map((item) => (
              <div key={item.etapa} className="gan-demo-table-row">
                <strong>{item.etapa}</strong>
                <span>{item.evento}</span>
              </div>
            ))
          : caso.sanidad.map((item) => (
              <div key={item.evento} className="gan-demo-table-row">
                <strong>{item.evento}</strong>
                <span>{item.estado}</span>
              </div>
            ))}
      </div>
      <div className="gan-demo-alert-box is-positive">
        <CheckCircle2 size={18} />
        <p>Estado sanitario general: {caso.estadoSanitario}</p>
      </div>
    </section>
  );
}

function TratamientosTab({ caso }) {
  const tratamiento = caso.tratamientoDestacado;
  return (
    <section className="gan-dash-section">
      <h2>Tratamientos de {caso.identidad.nombre}</h2>
      <div className="gan-demo-ficha-head">
        {tratamiento.etapa && (
          <div className="gan-demo-ficha-row">
            <span>Etapa</span>
            <strong>{tratamiento.etapa}</strong>
          </div>
        )}
        <div className="gan-demo-ficha-row">
          <span>Descripción</span>
          <strong>{tratamiento.descripcion}</strong>
        </div>
        {tratamiento.vinculadoA && (
          <div className="gan-demo-ficha-row">
            <span>Vinculado a</span>
            <strong>{tratamiento.vinculadoA}</strong>
          </div>
        )}
      </div>
      <p className="gan-demo-note">{tratamiento.nota}</p>
    </section>
  );
}

function ReproduccionTab({ caso, casoActivo }) {
  if (casoActivo === 'coronado') {
    return (
      <section className="gan-dash-section">
        <h2>Reproducción — {caso.identidad.nombre}</h2>
        <p className="gan-demo-report-text">{caso.reproduccion.resumen}</p>
        <div className="gan-demo-ficha-head">
          <div className="gan-demo-ficha-row">
            <span>Método</span>
            <strong>{caso.origenReproductivo.metodo}</strong>
          </div>
          <div className="gan-demo-ficha-row">
            <span>Evento</span>
            <strong>{caso.origenReproductivo.descripcion}</strong>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="gan-dash-section">
      <h2>Reproducción — {caso.identidad.nombre}</h2>
      <div className="gan-demo-ficha-head">
        <div className="gan-demo-ficha-row">
          <span>Estado reproductivo actual</span>
          <strong>{caso.reproduccion.estadoActual}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Último parto</span>
          <strong>{formatFecha(caso.reproduccion.ultimoParto)}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Días en leche</span>
          <strong>{caso.reproduccion.diasEnLeche}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Edad al primer parto</span>
          <strong>{caso.reproduccion.primerPartoEdadMeses} meses</strong>
        </div>
      </div>
      <div className="gan-demo-alert-box is-warning">
        <AlertTriangle size={18} />
        <p>{caso.reproduccion.proximoEvento}</p>
      </div>
    </section>
  );
}

function LecheTab({ caso }) {
  if (!aplicaProduccionLeche(caso.identidad)) {
    return (
      <section className="gan-dash-section">
        <h2>Producción de leche</h2>
        <NotApplicable
          text={`No aplica a este caso. El propósito productivo de ${caso.identidad.nombre} es "${caso.identidad.proposito_productivo}", no leche.`}
        />
      </section>
    );
  }

  const leche = caso.produccionLeche;
  const registros = leche.registros;
  const hayCaida = Boolean(leche.caida?.hayCaida);

  return (
    <section className="gan-dash-section">
      <h2>Producción de leche — {caso.identidad.nombre}</h2>

      <div className="gan-demo-summary-grid gan-demo-summary-grid-compact">
        <div className="gan-dash-metric-card">
          <div>
            <strong>{leche.litros_hoy} L</strong>
            <span>Producción de hoy</span>
          </div>
        </div>
        <div className="gan-dash-metric-card">
          <div>
            <strong>{leche.promedio_semanal} L</strong>
            <span>Promedio últimos 7 días</span>
          </div>
        </div>
        <div className="gan-dash-metric-card">
          <div>
            <strong>{leche.promedio_historico} L</strong>
            <span>Promedio de los registros disponibles</span>
          </div>
        </div>
        <div className="gan-dash-metric-card">
          <div>
            <strong>{leche.produccion_acumulada} L</strong>
            <span>Acumulado ({registros.length} días registrados)</span>
          </div>
        </div>
      </div>
      <p className="gan-demo-note">
        Días en leche: {leche.dias_en_leche} — Etapa de lactancia: {leche.etapa_lactancia}.
      </p>

      <h3 className="gan-demo-list-title">Registro diario (últimos {registros.length} días)</h3>
      <div className="gan-demo-table gan-demo-table-milk">
        {registros.map((registro) => (
          <div key={registro.fecha} className="gan-demo-table-row">
            <span>{formatFecha(registro.fecha)}</span>
            <strong className={registro.litros_dia < 16 ? 'is-alert-value' : ''}>{registro.litros_dia} L</strong>
          </div>
        ))}
      </div>

      <div className={`gan-demo-alert-box ${hayCaida ? 'is-alert' : 'is-positive'}`}>
        {hayCaida ? <TrendingDown size={18} /> : <CheckCircle2 size={18} />}
        <div>
          <p>{leche.alerta_principal}</p>
          <p className="gan-demo-note">{leche.interpretacion}</p>
          <p className="gan-demo-note"><strong>Recomendación:</strong> {leche.recomendacion}</p>
        </div>
      </div>
    </section>
  );
}

function ComercializacionTab({ caso }) {
  if (!aplicaComercializacion(caso.identidad)) {
    return (
      <section className="gan-dash-section">
        <h2>Comercialización</h2>
        <NotApplicable
          text={`No aplica a este caso. El propósito productivo de ${caso.identidad.nombre} es "${caso.identidad.proposito_productivo}".`}
        />
      </section>
    );
  }

  const { comercializacion } = caso;

  return (
    <section className="gan-dash-section">
      <h2>Comercialización — {caso.identidad.nombre}</h2>
      <div className="gan-demo-ficha-head">
        <div className="gan-demo-ficha-row">
          <span>Peso objetivo</span>
          <strong>{comercializacion.pesoObjetivoMinKg}–{comercializacion.pesoObjetivoMaxKg} kg</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Peso actual</span>
          <strong>{comercializacion.pesoActualKg} kg</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Categoría</span>
          <strong>{comercializacion.categoria}</strong>
        </div>
        <div className="gan-demo-ficha-row">
          <span>Estado</span>
          <strong>{comercializacion.estado}</strong>
        </div>
      </div>

      <h3 className="gan-demo-list-title">Rutas de decisión</h3>
      <div className="gan-demo-decision-grid">
        {comercializacion.rutas.map((ruta) => (
          <article key={ruta.titulo} className="gan-demo-decision-card">
            <strong>{ruta.titulo}</strong>
            <p>{ruta.detalle}</p>
          </article>
        ))}
      </div>

      <h3 className="gan-demo-list-title">Indicadores que soportan la decisión</h3>
      <ul className="gan-demo-indicator-list">
        {comercializacion.indicadores.map((indicador) => (
          <li key={indicador}>{indicador}</li>
        ))}
      </ul>
    </section>
  );
}

function ReportesTab({ coronado, esperanza }) {
  const handleDescargar = (caso) => {
    const lines = [
      `${caso.identidad.nombre} — ${caso.identidad.raza}`,
      `Código interno: ${caso.identidad.codigoInterno}`,
      `QR demo: ${caso.identidad.qrCodigo}`,
      `Estado productivo: ${caso.identidad.estadoProductivo}`,
      '',
      'Este informe fue generado en Modo Demo con datos de prueba.',
      'No corresponde a informacion real de clientes de AgroGenomaX.',
    ];
    const blob = buildDemoReportPdfBlob(`Informe demo - ${caso.identidad.nombre}`, lines);
    downloadBlob(blob, `informe-demo-${caso.identidad.codigoInterno.toLowerCase()}.pdf`);
  };

  return (
    <section className="gan-dash-section">
      <h2>Reportes de la demo</h2>
      <p className="gan-demo-report-text">
        Estructura preparada para los reportes PDF completos de cada caso (informe productivo, historial sanitario,
        reporte genético y reporte comercial o reproductivo). En esta fase se puede descargar un informe demo básico
        por animal.
      </p>
      <div className="gan-demo-report-actions">
        <button type="button" className="gan-dash-btn is-primary" onClick={() => handleDescargar(coronado)}>
          Descargar informe demo de {coronado.identidad.nombre}
        </button>
        <button type="button" className="gan-dash-btn is-primary" onClick={() => handleDescargar(esperanza)}>
          Descargar informe demo de {esperanza.identidad.nombre}
        </button>
      </div>
    </section>
  );
}
