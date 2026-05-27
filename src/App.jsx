import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Binary,
  BrainCircuit,
  CalendarClock,
  Cloud,
  ChevronRight,
  CircleDot,
  Dna,
  FileCheck2,
  Fingerprint,
  Globe2,
  HeartPulse,
  Layers3,
  Leaf,
  LockKeyhole,
  Map,
  Network,
  Radar,
  Satellite,
  ShieldCheck,
  Sprout,
  Trees,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import GisMap from './components/GisMap.jsx';

// Version de despliegue 2026-05-26
const navItems = [
  ['Plataforma', 'sobre'],
  ['Servicios', 'servicios'],
  ['GIS', 'gis'],
  ['Regenerativa', 'ganaderia-regenerativa'],
  ['IA', 'analitica'],
  ['Contacto', 'contacto'],
];

const services = [
  {
    icon: Satellite,
    title: 'Observacion satelital',
    text: 'Lectura de cobertura, agua, bosque, infraestructura y riesgo territorial con capas GIS operativas.',
    code: 'SAT-OPS',
  },
  {
    icon: Trees,
    title: 'Ganaderia regenerativa',
    text: 'Planeacion silvopastoril, restauracion productiva y medicion de impacto en predios tropicales.',
    code: 'REGEN',
  },
  {
    icon: ShieldCheck,
    title: 'Cumplimiento ambiental',
    text: 'Evidencia tecnica para auditorias, debida diligencia y cadenas ganaderas libres de deforestacion.',
    code: 'COMPLY',
  },
  {
    icon: BrainCircuit,
    title: 'IA agroterritorial',
    text: 'Modelos predictivos para priorizar acciones, reducir riesgo y mejorar rentabilidad por hectarea.',
    code: 'AI-MODEL',
  },
];

const metrics = [
  ['99.8%', 'integridad de datos'],
  ['12+', 'capas geoespaciales'],
  ['24/7', 'monitoreo operativo'],
  ['0 def.', 'cadena verificable'],
];

const capabilities = [
  'Trazabilidad bovina por predio, lote, movimiento y cadena de suministro',
  'Analisis de bosque, agua, suelo, conectividad y riesgo ambiental',
  'Diagnostico de sistemas silvopastoriles y regenerativos',
  'Tableros ejecutivos para decisiones tecnicas, financieras y comerciales',
  'Estandares para mercados premium, auditoria y cumplimiento normativo',
  'Modelos de productividad, carbono y rentabilidad por metro cuadrado',
];

const intelligenceRows = [
  ['Cobertura arborea', '88%', 'stable'],
  ['Riesgo deforestacion', '04%', 'low'],
  ['Indice regenerativo', '76%', 'rising'],
  ['Trazabilidad lote', '100%', 'verified'],
];

const dashboardMetrics = [
  { label: 'Riesgo ambiental', value: '04%', delta: '-12%', icon: ShieldCheck, tone: 'text-neon' },
  { label: 'Cobertura arborea', value: '38.7%', delta: '+6.4%', icon: Trees, tone: 'text-neon' },
  { label: 'Trazabilidad bovina', value: '1,284', delta: '100%', icon: Fingerprint, tone: 'text-aqua' },
  { label: 'Indice regenerativo', value: '81', delta: '+9 pts', icon: Leaf, tone: 'text-aqua' },
];

const coverageSeries = [34, 36, 35, 39, 42, 41, 45, 47, 46, 49, 52, 55];
const riskSeries = [62, 54, 49, 44, 31, 28, 22, 18, 15, 12, 8, 4];

const alertFeed = [
  ['Cambio de cobertura', 'Predio Genesis Norte', 'Resuelto', 'text-neon'],
  ['Movimiento bovino', 'Lote BOV-AX-901', 'Verificado', 'text-aqua'],
  ['Riesgo hidrico', 'Corredor Sur', 'Observacion', 'text-white'],
];

const timelineFrames = [
  {
    year: '2019',
    title: 'Linea base territorial',
    coverage: 31,
    regeneration: 18,
    alerts: 6,
    risk: 'Alto',
    note: 'Fragmentacion de cobertura y presion sobre rondas hidricas.',
  },
  {
    year: '2020',
    title: 'Deteccion de cambios',
    coverage: 29,
    regeneration: 22,
    alerts: 9,
    risk: 'Critico',
    note: 'Alertas satelitales por perdida puntual de cobertura arborea.',
  },
  {
    year: '2021',
    title: 'Intervencion silvopastoril',
    coverage: 33,
    regeneration: 38,
    alerts: 4,
    risk: 'Medio',
    note: 'Inicio de corredores biologicos y proteccion de areas sensibles.',
  },
  {
    year: '2023',
    title: 'Recuperacion verificable',
    coverage: 36,
    regeneration: 61,
    alerts: 2,
    risk: 'Bajo',
    note: 'Aumento sostenido de NDVI y consolidacion de nucleos regenerativos.',
  },
  {
    year: '2026',
    title: 'Territorio monitoreado',
    coverage: 39,
    regeneration: 81,
    alerts: 0,
    risk: 'Minimo',
    note: 'Cadena con evidencia temporal para trazabilidad libre de deforestacion.',
  },
];

const carbonMetrics = [
  ['Carbono capturado', '4,820 tCO2e', '+18.4%'],
  ['Biomasa estimada', '12,760 t', '+9.7%'],
  ['Cobertura arborea', '38.7%', '+6.4%'],
  ['Suelo regenerativo', '71/100', '+11 pts'],
];

const carbonEquivalences = [
  ['1,047', 'vehiculos fuera de circulacion por un ano'],
  ['79,700', 'arboles equivalentes en captura anual'],
  ['2,140 ha', 'territorio bajo monitoreo regenerativo'],
];

const cattleTrace = {
  id: 'BOV-AX-901',
  origin: 'Lote Genesis Norte / Predio AGX-04',
  breed: 'Brahman x Angus tropical',
  status: 'Cumplimiento verificado',
  health: 'Sanidad optima',
};

const cattleMovements = [
  ['Nacimiento', 'Predio AGX-04', '2023-02-18', 'Origen validado'],
  ['Levante', 'Unidad Silvopastoril X-12', '2024-01-09', 'Movilizacion registrada'],
  ['Revision sanitaria', 'Modulo Bioseguridad', '2025-08-14', 'Vacunacion al dia'],
  ['Auditoria ambiental', 'Cadena premium', '2026-05-11', 'Libre de deforestacion'],
];

const cattleIndicators = [
  ['Vacunacion', '100%', HeartPulse, 'text-neon'],
  ['Movilizaciones', '4', Map, 'text-aqua'],
  ['Cumplimiento', 'A+', FileCheck2, 'text-neon'],
  ['Riesgo sanitario', 'Bajo', ShieldCheck, 'text-aqua'],
];

const fieldPhotos = [
  {
    src: '/field/operacion-campo-04.jpeg',
    title: 'Trabajo tecnico en territorio',
    tag: 'Field intelligence',
    text: 'Lectura directa del paisaje ganadero, movilidad animal y condiciones regenerativas.',
  },
  {
    src: '/field/operacion-campo-05.jpeg',
    title: 'Trazabilidad en movimiento',
    tag: 'Bovine route',
    text: 'Seguimiento de lotes y movilizacion bajo condiciones reales de ladera tropical.',
  },
  {
    src: '/field/operacion-campo-02.jpeg',
    title: 'Sistemas silvopastoriles',
    tag: 'Regeneration',
    text: 'Ganaderia integrada con cobertura arborea, bosque y corredores biologicos.',
  },
  {
    src: '/field/operacion-campo-06.jpeg',
    title: 'Monitoreo productivo',
    tag: 'Ground truth',
    text: 'Validacion en campo para alimentar modelos GIS, carbono y cumplimiento ambiental.',
  },
  {
    src: '/field/operacion-campo-01.jpeg',
    title: 'Predios vivos',
    tag: 'Territory',
    text: 'Lectura territorial de potreros, topografia y biodiversidad asociada.',
  },
  {
    src: '/field/operacion-campo-07.jpeg',
    title: 'Operacion sostenible',
    tag: 'Premium chain',
    text: 'Evidencia real de sostenibilidad, bienestar y decision tecnica en campo.',
  },
];

const fadeUp = {
  initial: { opacity: 0, y: 28 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.72, ease: [0.22, 1, 0.36, 1] },
};

function App() {
  return (
    <main className="min-h-screen overflow-hidden bg-void text-white">
      <div className="fixed inset-0 -z-10 bg-[linear-gradient(180deg,rgba(2,5,8,0.34),#020508_48%,#020508)]" />
      <Header />
      <Hero />
      <About />
      <FieldOperations />
      <Services />
      <Intelligence />
      <SatelliteTimeline />
      <CarbonIntelligence />
      <Regenerative />
      <Analytics />
      <BovineTraceability />
      <Traceability />
      <Contact />
      </main>
  );
}

function Header() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-void/70 backdrop-blur-2xl">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
        <a href="#inicio" className="group flex items-center gap-3" aria-label="AgroGenomaX inicio">
          <span className="grid h-10 w-10 place-items-center rounded-md border border-neon/35 bg-neon/[0.08] shadow-neon transition group-hover:border-aqua/60">
            <Dna className="h-5 w-5 text-neon" />
          </span>
          <span className="font-display text-lg font-bold tracking-[0.08em]">
            Agro<span className="text-neon">Genoma</span><span className="text-aqua">X</span>
          </span>
        </a>
        <div className="hidden items-center gap-7 text-sm font-medium text-steel lg:flex">
          {navItems.map(([label, target]) => (
            <a key={target} href={`#${target}`} className="transition hover:text-white">
              {label}
            </a>
          ))}
        </div>
        <a
          href="#contacto"
          className="hidden items-center gap-2 rounded-full border border-aqua/35 bg-aqua/[0.06] px-5 py-2 text-sm font-semibold text-aqua shadow-aqua transition hover:border-neon/60 hover:text-neon sm:inline-flex"
        >
          Solicitar demo <ArrowRight className="h-4 w-4" />
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section id="inicio" className="relative min-h-screen px-5 pt-28 lg:px-8">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="data-beam left-[12%] top-[-8%] h-[120%] rotate-[22deg] bg-neon/25" />
        <div className="data-beam right-[18%] top-[-6%] h-[112%] -rotate-[18deg] bg-aqua/25" />
      </div>
      <div className="mx-auto grid min-h-[calc(100vh-7rem)] max-w-7xl items-center gap-12 py-10 lg:grid-cols-[0.88fr_1.12fr]">
        <motion.div
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
          className="order-2 lg:order-1"
        >
          <div className="mb-6 inline-flex items-center gap-3 rounded-full border border-neon/30 bg-neon/[0.08] px-4 py-2 text-xs font-bold uppercase tracking-[0.24em] text-neon shadow-neon">
            <Activity className="h-4 w-4" />
            Territorial intelligence OS
          </div>
          <h1 className="font-display text-5xl font-bold leading-[0.98] text-white sm:text-6xl lg:text-7xl">
            AgroGenoma<span className="metal-text">X</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-steel sm:text-xl">
            Plataforma de inteligencia territorial ganadera para operar trazabilidad,
            regeneracion, monitoreo satelital, cumplimiento ambiental e IA sobre sistemas
            tropicales de alto valor.
          </p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row">
            <a
              href="#servicios"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-neon px-6 py-3 font-bold text-void shadow-neon transition hover:scale-[1.02]"
            >
              Ver plataforma <ArrowRight className="h-5 w-5" />
            </a>
            <a
              href="#gis"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/18 bg-white/[0.03] px-6 py-3 font-bold text-white transition hover:border-aqua/60 hover:text-aqua"
            >
              Explorar GIS <ChevronRight className="h-5 w-5" />
            </a>
          </div>
          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map(([value, label]) => (
              <div key={label} className="border-l border-white/12 pl-4">
                <div className="font-display text-2xl font-bold text-white">{value}</div>
                <div className="mt-1 text-xs uppercase tracking-[0.16em] text-steel">{label}</div>
              </div>
            ))}
          </div>
        </motion.div>
        <HeroLogoShowcase className="order-1 lg:order-2" />
      </div>
      <div className="mx-auto max-w-7xl pb-14">
        <PlatformConsole />
      </div>
    </section>
  );
}

function HeroLogoShowcase({ className = '' }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.88, y: 28 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
      className={`brand-showcase ${className}`}
    >
      <div className="brand-orbit brand-orbit-a" />
      <div className="brand-orbit brand-orbit-b" />
      <div className="brand-scanline" />
      <div className="brand-glow brand-glow-green" />
      <div className="brand-glow brand-glow-blue" />
      <img src="/agrogenomax-brand.jpeg" alt="Logo AgroGenomaX" className="brand-logo-hero" />
      <div className="brand-status">
        <span>AgroGenomaX identity</span>
        <strong>Inteligencia que garantiza resultados eficientes</strong>
      </div>
    </motion.div>
  );
}

function PlatformConsole() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 22 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      className="relative"
    >
      <div className="console-shell relative overflow-hidden rounded-xl border border-white/14 bg-[#050b10]/92 shadow-[0_34px_120px_rgba(0,0,0,0.58)]">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-neon shadow-neon" />
            <span className="text-xs font-bold uppercase tracking-[0.24em] text-steel">AgroGenomaX command layer</span>
          </div>
          <span className="rounded-full border border-aqua/30 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-aqua">Live</span>
        </div>
        
        {/* Contenedor principal de la consola */}
        <div className="grid gap-4 p-4 lg:grid-cols-[1.05fr_0.95fr]">
          
          {/* Columna Izquierda: Mapa */}
          <div className="agrogenomax-map min-h-[300px] h-[300px] lg:min-h-[430px] lg:h-auto overflow-hidden rounded-lg border border-white/10 relative">
            <GisMap /> 
            <div className="scan-sweep" />
            <div className="map-polygon map-polygon-a" />
            <div className="map-polygon map-polygon-b" />
            <div className="map-polygon map-polygon-c" />
            {/* ... resto de divs internos del mapa ... */}
          </div>

          {/* Columna Derecha: Métricas y Paneles */}
          <div className="grid gap-4 content-start">
            <div className="grid grid-cols-2 gap-3">
              {dashboardMetrics.map((metric, index) => (
                ))}
            </div>
            <CoverageMonitor />
            <RiskPanel />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function SparklineChart({ data, color = '#9cff1a' }) {
  const width = 220;
  const height = 76;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - ((value - min) / (max - min || 1)) * (height - 14) - 7;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg className="h-20 w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Grafico dinamico">
      <defs>
        <linearGradient id={`spark-${color.replace('#', '')}`} x1="0" x2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.1" />
          <stop offset="100%" stopColor={color} stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <polyline points={points} fill="none" stroke={`url(#spark-${color.replace('#', '')})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((value, index) => {
        const x = (index / (data.length - 1)) * width;
        const y = height - ((value - min) / (max - min || 1)) * (height - 14) - 7;
        return <circle key={`${value}-${index}`} cx={x} cy={y} r="2.5" fill={index === data.length - 1 ? color : 'rgba(255,255,255,0.38)'} />;
      })}
    </svg>
  );
}

function CoverageMonitor() {
  return (
    <div className="dashboard-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.2em] text-steel">Cobertura arborea</span>
        <TrendingUp className="h-5 w-5 text-neon" />
      </div>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          <div className="font-display text-3xl font-bold">38.7%</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-neon">+6.4% anual</div>
        </div>
        <div className="text-right text-xs text-steel">
          NDVI<br />
          <span className="font-bold text-white">0.72</span>
        </div>
      </div>
      <div className="mt-4">
        <SparklineChart data={coverageSeries} color="#9cff1a" />
      </div>
    </div>
  );
}

function RiskPanel() {
  return (
    <div className="dashboard-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.2em] text-steel">Panel de riesgo</span>
        <AlertTriangle className="h-5 w-5 text-aqua" />
      </div>
      <div className="mt-4 grid place-items-center">
        <div className="risk-orbit">
          <span>04%</span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-white/10 bg-white/[0.04] p-2 text-steel">Deforestacion <strong className="block text-neon">Baja</strong></div>
        <div className="rounded-md border border-white/10 bg-white/[0.04] p-2 text-steel">Agua <strong className="block text-aqua">Estable</strong></div>
      </div>
    </div>
  );
}

function TraceabilityFlow() {
  return (
    <div className="dashboard-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.2em] text-steel">Trazabilidad bovina</span>
        <LockKeyhole className="h-5 w-5 text-neon" />
      </div>
      <div className="mt-5 space-y-3">
        {['Predio', 'Lote', 'Movimiento', 'Auditoria'].map((step, index) => (
          <div key={step} className="trace-step">
            <span>{index + 1}</span>
            <div>
              <strong>{step}</strong>
              <small>{index === 3 ? 'Verificado' : 'Sincronizado'}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AlertFeed() {
  return (
    <div className="dashboard-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.2em] text-steel">Alertas ambientales</span>
        <Zap className="h-5 w-5 text-aqua" />
      </div>
      <div className="mt-5 space-y-3">
        {alertFeed.map(([title, area, status, color]) => (
          <div key={title} className="alert-row">
            <span className={`mt-1 h-2 w-2 rounded-full ${color === 'text-neon' ? 'bg-neon' : color === 'text-aqua' ? 'bg-aqua' : 'bg-white'}`} />
            <div>
              <strong>{title}</strong>
              <small>{area}</small>
            </div>
            <em className={color}>{status}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function About() {
  return (
    <section id="sobre" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="eyebrow text-aqua">Sobre AgroGenomaX</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Una capa de mando para territorios ganaderos verificables.
            </h2>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            {[
              ['Inteligencia territorial', 'Integra satelite, GIS, trazabilidad animal y desempeno productivo en una sola vista ejecutiva.'],
              ['Mercados premium', 'Convierte cumplimiento ambiental y mejora regenerativa en evidencia comercializable.'],
              ['Operacion tropical', 'Modelos pensados para predios, paisajes y cadenas ganaderas de alta complejidad.'],
              ['Decision aumentada', 'IA aplicada a priorizacion de intervenciones, alertas y retornos por metro cuadrado.'],
            ].map(([title, text]) => (
              <article key={title} className="platform-card p-6">
                <CircleDot className="h-5 w-5 text-neon" />
                <h3 className="mt-6 font-display text-xl font-bold">{title}</h3>
                <p className="mt-3 leading-7 text-steel">{text}</p>
              </article>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function FieldOperations() {
  return (
    <section id="operacion-campo" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="mb-12 grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
          <div>
            <p className="eyebrow text-neon">Operacion en Campo</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Tecnologia territorial operando sobre paisajes ganaderos reales.
            </h2>
          </div>
          <p className="text-lg leading-8 text-steel">
            AgroGenomaX combina datos satelitales, modelos de IA y verificacion en campo para
            entender el territorio donde ocurre la ganaderia regenerativa.
          </p>
        </div>

        <div className="field-cinema">
          <div className="field-hero">
            <img src="/field/operacion-campo-03.jpeg" alt="Equipo tecnico AgroGenomaX en operacion de campo" />
            <div className="field-hero-content">
              <span>Ground truth layer</span>
              <h3>Inteligencia territorial validada en el predio.</h3>
              <p>
                La plataforma conecta lo que ve el satelite con lo que ocurre en la finca:
                animales, cobertura, movilidad, regeneracion y cumplimiento ambiental.
              </p>
            </div>
            <div className="field-hud">
              {[
                ['GIS', 'validado'],
                ['NDVI', '0.72'],
                ['Lote', 'activo'],
                ['Carbono', '+18%'],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="field-gallery">
            {fieldPhotos.map((photo, index) => (
              <motion.article
                key={photo.src}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ duration: 0.65, delay: index * 0.05 }}
                className={index === 0 ? 'field-card field-card-large' : 'field-card'}
              >
                <img src={photo.src} alt={photo.title} />
                <div className="field-card-overlay">
                  <span>{photo.tag}</span>
                  <h3>{photo.title}</h3>
                  <p>{photo.text}</p>
                </div>
              </motion.article>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function Services() {
  return (
    <section id="servicios" className="px-5 py-28 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <motion.div {...fadeUp} className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="eyebrow text-neon">Servicios</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Modulos de inteligencia para una ganaderia medible y exportable.
            </h2>
          </div>
          <div className="hidden text-right text-xs uppercase tracking-[0.24em] text-steel lg:block">
            Platform stack<br />
            GIS + Compliance + AI
          </div>
        </motion.div>
        <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {services.map(({ icon: Icon, title, text, code }, index) => (
            <motion.article
              key={title}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: index * 0.07 }}
              className="platform-card group p-6"
            >
              <div className="flex items-center justify-between">
                <Icon className="h-9 w-9 text-aqua transition group-hover:text-neon" />
                <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-steel">
                  {code}
                </span>
              </div>
              <h3 className="mt-10 font-display text-xl font-bold">{title}</h3>
              <p className="mt-4 leading-7 text-steel">{text}</p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Intelligence() {
  return (
    <section id="gis" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[1.15fr_0.85fr]">
        <GisMap />
        <div>
          <p className="eyebrow text-aqua">GIS y monitoreo satelital</p>
          <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
            Geointeligencia para saber que ocurre en cada hectarea.
          </h2>
          <p className="mt-6 text-lg leading-8 text-steel">
            Capas satelitales, cartografia productiva, alertas ambientales y evidencia historica
            para operar predios como activos territoriales auditables.
          </p>
          <div className="mt-8 space-y-4">
            {['Alertas de cambio de cobertura', 'Cruce predial con trazabilidad bovina', 'Reportes para auditoria y mercado'].map((item) => (
              <div key={item} className="flex items-center gap-3 text-steel">
                <BadgeCheck className="h-5 w-5 text-neon" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function SatelliteTimeline() {
  const [activeIndex, setActiveIndex] = useState(timelineFrames.length - 1);
  const frame = timelineFrames[activeIndex];
  const previous = timelineFrames[Math.max(0, activeIndex - 1)];
  const coverageDelta = frame.coverage - previous.coverage;
  const regenerationDelta = frame.regeneration - previous.regeneration;

  return (
    <section id="timeline" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="mb-12 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="eyebrow text-neon">Linea de tiempo satelital</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Analisis temporal del predio con inteligencia geoespacial.
            </h2>
          </div>
          <div className="rounded-full border border-aqua/25 bg-aqua/[0.06] px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-aqua shadow-aqua">
            Historical satellite stack
          </div>
        </div>

        <div className="timeline-console overflow-hidden rounded-xl border border-white/12 bg-[#050b10]">
          <div className="grid lg:grid-cols-[1.1fr_0.9fr]">
            <div className="relative min-h-[560px] border-b border-white/10 p-5 lg:border-b-0 lg:border-r">
              <div className="temporal-viewer h-full min-h-[520px] overflow-hidden rounded-lg border border-white/10">
                <div className="absolute inset-x-6 top-6 z-10 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-aqua">
                  <span>{frame.year} / temporal scene</span>
                  <span>Risk: {frame.risk}</span>
                </div>
                <div className="scan-sweep" />
                <motion.div
                  key={`forest-${frame.year}`}
                  initial={{ opacity: 0.24, scale: 0.88 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.7 }}
                  className="temporal-canopy"
                  style={{
                    width: `${42 + frame.coverage}%`,
                    height: `${30 + frame.coverage / 2}%`,
                    left: `${10 + activeIndex * 2}%`,
                    top: `${18 + activeIndex}%`,
                  }}
                />
                <motion.div
                  key={`regen-${frame.year}`}
                  initial={{ opacity: 0.2, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.75 }}
                  className="temporal-regeneration"
                  style={{
                    width: `${26 + frame.regeneration / 2}%`,
                    height: `${18 + frame.regeneration / 4}%`,
                    right: `${12 + activeIndex}%`,
                    bottom: `${18 + activeIndex * 2}%`,
                  }}
                />
                {Array.from({ length: frame.alerts }).map((_, index) => (
                  <motion.span
                    key={`${frame.year}-alert-${index}`}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: index * 0.06 }}
                    className="temporal-alert"
                    style={{
                      left: `${18 + ((index * 17) % 62)}%`,
                      top: `${24 + ((index * 23) % 48)}%`,
                    }}
                  />
                ))}
                <div className="absolute bottom-5 left-5 right-5 grid gap-3 sm:grid-cols-3">
                  <TemporalMetric label="Cobertura" value={`${frame.coverage}%`} delta={coverageDelta} />
                  <TemporalMetric label="Regeneracion" value={`${frame.regeneration}`} delta={regenerationDelta} />
                  <TemporalMetric label="Alertas" value={frame.alerts} delta={frame.alerts} inverse />
                </div>
              </div>
            </div>

            <div className="p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <CalendarClock className="h-6 w-6 text-aqua" />
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-steel">Analisis temporal</div>
                  <h3 className="font-display text-3xl font-bold">{frame.year}</h3>
                </div>
              </div>
              <h4 className="mt-8 font-display text-2xl font-bold">{frame.title}</h4>
              <p className="mt-4 leading-7 text-steel">{frame.note}</p>

              <div className="mt-8 space-y-5">
                <TemporalBar label="Cambio de cobertura" value={frame.coverage} color="bg-neon" />
                <TemporalBar label="Evolucion regenerativa" value={frame.regeneration} color="bg-aqua" />
                <TemporalBar label="Confianza de cumplimiento" value={Math.max(55, 100 - frame.alerts * 9)} color="bg-white" />
              </div>

              <div className="mt-10">
                <div className="mb-4 text-xs uppercase tracking-[0.2em] text-steel">Seleccionar periodo</div>
                <div className="timeline-track">
                  {timelineFrames.map((item, index) => (
                    <button
                      key={item.year}
                      type="button"
                      onClick={() => setActiveIndex(index)}
                      className={index === activeIndex ? 'is-active' : ''}
                    >
                      <span />
                      {item.year}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-8 rounded-lg border border-white/10 bg-white/[0.035] p-4">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-steel">
                  <span>Deforestation alerts</span>
                  <strong className={frame.alerts === 0 ? 'text-neon' : 'text-aqua'}>{frame.alerts} eventos</strong>
                </div>
                <p className="mt-3 text-sm leading-6 text-steel">
                  {frame.alerts === 0
                    ? 'Sin alertas activas en el periodo seleccionado. Evidencia favorable para cadena libre de deforestacion.'
                    : 'Eventos detectados por contraste multitemporal. Requiere revision de campo y cierre documental.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function TemporalMetric({ label, value, delta, inverse = false }) {
  const positive = inverse ? delta <= 0 : delta >= 0;

  return (
    <div className="rounded-md border border-white/10 bg-void/72 p-4 backdrop-blur-md">
      <span className="text-xs uppercase tracking-[0.18em] text-steel">{label}</span>
      <strong className="mt-2 block font-display text-2xl text-white">{value}</strong>
      <em className={`mt-1 block text-[10px] font-bold not-italic uppercase tracking-[0.16em] ${positive ? 'text-neon' : 'text-aqua'}`}>
        {delta > 0 ? '+' : ''}{delta}
      </em>
    </div>
  );
}

function TemporalBar({ label, value, color }) {
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-steel">{label}</span>
        <span className="font-bold text-white">{value}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
        <motion.div
          key={`${label}-${value}`}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.75, ease: 'easeOut' }}
          className={`h-full rounded-full ${color}`}
        />
      </div>
    </div>
  );
}

function CarbonIntelligence() {
  return (
    <section id="carbono" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="grid gap-10 lg:grid-cols-[0.86fr_1.14fr]">
          <div>
            <p className="eyebrow text-aqua">Inteligencia de carbono</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Captura, biomasa y regeneracion convertidas en indicadores verificables.
            </h2>
            <p className="mt-6 text-lg leading-8 text-steel">
              AgroGenomaX estima carbono capturado, biomasa arborea, cobertura y desempeno
              regenerativo para apoyar decisiones productivas, ambientales y comerciales.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {carbonMetrics.map(([label, value, delta]) => (
                <div key={label} className="carbon-stat">
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <em>{delta}</em>
                </div>
              ))}
            </div>
          </div>

          <div className="carbon-console">
            <div className="carbon-orbit-panel">
              <div className="carbon-orbit">
                <Cloud className="h-10 w-10 text-aqua" />
                <strong>4,820</strong>
                <span>tCO2e</span>
              </div>
              <div className="carbon-ring carbon-ring-a" />
              <div className="carbon-ring carbon-ring-b" />
              <div className="absolute left-6 top-6 rounded-full border border-neon/25 bg-neon/[0.06] px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-neon">
                Carbon sink model
              </div>
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-lg border border-white/10 bg-void/70 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-steel">Metricas regenerativas</span>
                  <Leaf className="h-5 w-5 text-neon" />
                </div>
                <div className="mt-6 space-y-5">
                  <TemporalBar label="Carbono suelo" value={68} color="bg-neon" />
                  <TemporalBar label="Biomasa arborea" value={74} color="bg-aqua" />
                  <TemporalBar label="Conectividad ecologica" value={59} color="bg-white" />
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-void/70 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-steel">Equivalencias ambientales</span>
                  <BarChart3 className="h-5 w-5 text-aqua" />
                </div>
                <div className="mt-5 space-y-4">
                  {carbonEquivalences.map(([value, label]) => (
                    <div key={label} className="carbon-equivalence">
                      <strong>{value}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function Regenerative() {
  const pillars = [
    { icon: Leaf, label: 'Cobertura viva', value: 'suelo protegido' },
    { icon: Trees, label: 'Sombra funcional', value: 'bienestar animal' },
    { icon: Sprout, label: 'Carbono y agua', value: 'resiliencia climatica' },
  ];

  return (
    <section id="ganaderia-regenerativa" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="eyebrow text-neon">Ganaderia regenerativa</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Regeneracion convertida en datos, evidencia y retorno.
            </h2>
            <p className="mt-6 text-lg leading-8 text-steel">
              Planifica corredores biologicos, arboles, potreros, agua y cargas animales con
              indicadores que conectan impacto ambiental y productividad.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {pillars.map(({ icon: Icon, label, value }) => (
              <div key={label} className="platform-card p-6">
                <Icon className="h-8 w-8 text-neon" />
                <h3 className="mt-10 font-display text-xl font-bold">{label}</h3>
                <p className="mt-2 text-sm uppercase tracking-[0.18em] text-steel">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function Analytics() {
  return (
    <section id="analitica" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="overflow-hidden rounded-xl border border-white/12 bg-white/[0.035]">
          <div className="grid lg:grid-cols-[0.85fr_1.15fr]">
            <div className="p-8 sm:p-12">
              <p className="eyebrow text-aqua">Analitica e inteligencia artificial</p>
              <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
                Modelos predictivos para dirigir inversion territorial.
              </h2>
              <p className="mt-6 text-lg leading-8 text-steel">
                Fusiona trazabilidad, ambiente, productividad y mercado para anticipar riesgo,
                priorizar intervenciones y sostener valor premium.
              </p>
            </div>
            <div className="ai-matrix min-h-[430px] border-t border-white/10 p-6 lg:border-l lg:border-t-0">
              <div className="grid gap-4 md:grid-cols-3">
                {[
                  ['Riesgo ambiental', '92', BarChart3],
                  ['Elegibilidad premium', '76', Layers3],
                  ['Decision AI', '41k', Binary],
                ].map(([label, value, Icon]) => (
                  <div key={label} className="rounded-lg border border-white/10 bg-void/72 p-5 backdrop-blur-md">
                    <Icon className="h-6 w-6 text-aqua" />
                    <div className="mt-8 font-display text-4xl font-bold">{value}</div>
                    <div className="mt-2 text-xs uppercase tracking-[0.18em] text-steel">{label}</div>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-lg border border-white/10 bg-void/72 p-5 backdrop-blur-md">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-steel">
                  <span>Prediction stream</span>
                  <span className="text-neon">online</span>
                </div>
                <div className="mt-5 space-y-3">
                  {['Carbon capture potential', 'Herd mobility risk', 'Forest compliance confidence'].map((label, index) => (
                    <div key={label} className="grid grid-cols-[1fr_auto] gap-4 text-sm text-steel">
                      <span>{label}</span>
                      <span className={index === 1 ? 'text-aqua' : 'text-neon'}>{index === 1 ? 'medium' : 'high'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function BovineTraceability() {
  return (
    <section id="trazabilidad-bovina" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="mb-12 grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
          <div>
            <p className="eyebrow text-neon">Trazabilidad bovina</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Identidad animal conectada al territorio, la sanidad y el cumplimiento ambiental.
            </h2>
          </div>
          <p className="text-lg leading-8 text-steel">
            Cada animal se visualiza como un activo trazable: origen, lote, movilizaciones,
            certificaciones sanitarias y evidencia ambiental en una interfaz de inteligencia territorial.
          </p>
        </div>

        <div className="bovine-console">
          <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
            <div className="bovine-id-panel border-b border-white/10 p-6 sm:p-8 lg:border-b-0 lg:border-r">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="text-xs uppercase tracking-[0.2em] text-steel">Animal identity</span>
                  <h3 className="mt-3 font-display text-4xl font-bold">{cattleTrace.id}</h3>
                </div>
                <div className="grid h-14 w-14 place-items-center rounded-md border border-neon/35 bg-neon/[0.08] shadow-neon">
                  <Fingerprint className="h-7 w-7 text-neon" />
                </div>
              </div>

              <div className="bovine-scan mt-8">
                <div className="bovine-chip">
                  <Dna className="h-10 w-10 text-aqua" />
                  <span>RFID / DNA PROFILE</span>
                </div>
              </div>

              <div className="mt-8 space-y-4">
                {[
                  ['Lote de origen', cattleTrace.origin],
                  ['Linea genetica', cattleTrace.breed],
                  ['Ambiental', cattleTrace.status],
                  ['Sanidad', cattleTrace.health],
                ].map(([label, value]) => (
                  <div key={label} className="bovine-detail">
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-6 sm:p-8">
              <div className="grid gap-4 sm:grid-cols-4">
                {cattleIndicators.map(([label, value, Icon, tone]) => (
                  <div key={label} className="bovine-indicator">
                    <Icon className={`h-5 w-5 ${tone}`} />
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>

              <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_0.86fr]">
                <div className="rounded-lg border border-white/10 bg-void/70 p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-[0.2em] text-steel">Historial de movilizacion</span>
                    <Map className="h-5 w-5 text-aqua" />
                  </div>
                  <div className="bovine-route mt-6">
                    {cattleMovements.map(([event, place, date, status], index) => (
                      <div key={`${event}-${date}`} className="bovine-route-step">
                        <span>{index + 1}</span>
                        <div>
                          <strong>{event}</strong>
                          <small>{place}</small>
                        </div>
                        <em>{date}</em>
                        <b>{status}</b>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-white/10 bg-void/70 p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-[0.2em] text-steel">Cumplimiento ambiental</span>
                    <BadgeCheck className="h-5 w-5 text-neon" />
                  </div>
                  <div className="mt-6 space-y-5">
                    <TemporalBar label="Libre de deforestacion" value={100} color="bg-neon" />
                    <TemporalBar label="Trazabilidad documental" value={96} color="bg-aqua" />
                    <TemporalBar label="Elegibilidad mercado premium" value={88} color="bg-white" />
                  </div>
                  <div className="mt-6 rounded-md border border-neon/20 bg-neon/[0.06] p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-neon">Estado de cadena</div>
                    <p className="mt-2 text-sm leading-6 text-steel">
                      Animal asociado a predio sin alertas activas de deforestacion y con historial sanitario completo.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function Traceability() {
  return (
    <section id="trazabilidad" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl">
        <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr]">
          <div>
            <p className="eyebrow text-neon">Trazabilidad y cumplimiento</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Cadena ganadera libre de deforestacion, verificable por diseno.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {capabilities.map((item) => (
              <div key={item} className="flex gap-4 rounded-lg border border-white/10 bg-white/[0.035] p-5 transition hover:border-neon/35 hover:bg-neon/[0.04]">
                <BadgeCheck className="mt-1 h-5 w-5 shrink-0 text-neon" />
                <p className="leading-7 text-steel">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function Contact() {
  return (
    <section id="contacto" className="px-5 py-28 lg:px-8">
      <motion.div {...fadeUp} className="mx-auto max-w-7xl overflow-hidden rounded-xl border border-aqua/18 bg-[#050b10] shadow-aqua">
        <div className="grid items-stretch lg:grid-cols-[1.05fr_0.95fr]">
          <div className="p-8 sm:p-12 lg:p-16">
            <p className="eyebrow text-aqua">Contacto</p>
            <h2 className="mt-4 font-display text-3xl font-bold sm:text-5xl">
              Activa una capa de inteligencia sobre tu territorio ganadero.
            </h2>
            <p className="mt-6 text-lg leading-8 text-steel">
              Agenda una conversacion para implementar trazabilidad, regeneracion, GIS e IA
              en una operacion preparada para mercados exigentes.
            </p>
          </div>
          <form className="border-t border-white/10 bg-white/[0.035] p-8 sm:p-12 lg:border-l lg:border-t-0">
            <div className="space-y-4">
              {['Nombre', 'Correo', 'Empresa'].map((label) => (
                <label key={label} className="block">
                  <span className="sr-only">{label}</span>
                  <input
                    type={label === 'Correo' ? 'email' : 'text'}
                    placeholder={label}
                    className="w-full rounded-md border border-white/12 bg-void/70 px-4 py-3 text-white outline-none transition placeholder:text-steel/70 focus:border-aqua"
                  />
                </label>
              ))}
              <textarea
                placeholder="Mensaje"
                rows="4"
                className="w-full resize-none rounded-md border border-white/12 bg-void/70 px-4 py-3 text-white outline-none transition placeholder:text-steel/70 focus:border-aqua"
              />
              <button className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-aqua px-6 py-3 font-bold text-void shadow-aqua transition hover:scale-[1.01]">
                Enviar solicitud <ArrowRight className="h-5 w-5" />
              </button>
            </div>
          </form>
        </div>
      </motion.div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10 px-5 py-10 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 text-sm text-steel md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Network className="h-5 w-5 text-neon" />
          <span>AgroGenomaX</span>
          <span className="hidden text-white/20 sm:inline">|</span>
          <span>Territorial intelligence for regenerative cattle systems.</span>
        </div>
        <div className="flex gap-5">
          <a href="#sobre" className="hover:text-white">Plataforma</a>
          <a href="#servicios" className="hover:text-white">Servicios</a>
          <a href="#contacto" className="hover:text-white">Contacto</a>
        </div>
      </div>
    </footer>
  );
}

export default App;
