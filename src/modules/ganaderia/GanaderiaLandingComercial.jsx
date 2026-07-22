import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  Dna,
  Factory,
  FileText,
  GraduationCap,
  HeartPulse,
  Home as HomeIcon,
  LineChart,
  MapPin,
  QrCode,
  Sprout,
  TrendingUp,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import '../../styles/ganaderia-landing.css';
import ganaderiaModuleBg from '../../assets/solutions/module-bg-ganaderia.png';
import ganaderiaModuleIcon from '../../assets/solutions/module-icon-ganaderia.png';
import ruralExperienceImage from '../../assets/experiences/AV-0005-experiencia-rural.webp';

const DEMO_MAILTO =
  'mailto:contacto@agrogenomax.com?subject=Solicitud%20de%20demo%20Ganader%C3%ADa%20Inteligente';

const benefits = [
  { icon: ClipboardList, title: 'Control de inventario animal', text: 'Todo el hato organizado en un solo lugar.' },
  { icon: QrCode, title: 'Trazabilidad por animal', text: 'Historial individual accesible por código QR.' },
  { icon: MapPin, title: 'Registro de predios y potreros', text: 'Unidades productivas y potreros asociados.' },
  { icon: LineChart, title: 'Pesajes y evolución productiva', text: 'Seguimiento de peso y desempeño en el tiempo.' },
  { icon: Dna, title: 'Soporte para decisiones genéticas', text: 'Información reproductiva y genética por animal.' },
  { icon: FileText, title: 'Preparación para reportes técnicos y comerciales', text: 'Datos listos para exportar y sustentar decisiones.' },
];

const audiences = [
  { icon: HeartPulse, label: 'Ganaderos' },
  { icon: Sprout, label: 'Proyectos productivos' },
  { icon: Users, label: 'Asociaciones' },
  { icon: GraduationCap, label: 'Técnicos agropecuarios' },
  { icon: Factory, label: 'Empresas ganaderas' },
  { icon: TrendingUp, label: 'Programas de inversión rural' },
];

const included = [
  'Predios',
  'Potreros',
  'Animales',
  'QR',
  'Ficha animal',
  'Pesajes',
  'Trazabilidad básica',
  'Panel operativo',
];

function GanaderiaLandingComercial() {
  return (
    <main className="gan-landing">
      <LandingHeader />
      <Hero />
      <Problem />
      <Solution />
      <Benefits />
      <Audiences />
      <Included />
      <OperationalAccess />
      <FinalContact />
      <LandingFooter />
    </main>
  );
}

function LandingHeader() {
  return (
    <header className="gan-landing-header">
      <Link to="/" className="gan-landing-back">
        <ArrowLeft size={16} />
        Volver a AgroGenomaX
      </Link>
      <a className="gan-landing-btn is-outline" href={DEMO_MAILTO}>
        Solicitar demo <ArrowRight size={16} />
      </a>
    </header>
  );
}

function Hero() {
  return (
    <section className="gan-landing-hero">
      <div className="gan-landing-hero-visual" aria-hidden="true">
        <img src={ganaderiaModuleBg} alt="" loading="eager" decoding="async" />
      </div>
      <div className="gan-landing-hero-copy">
        <span className="gan-landing-eyebrow">Módulo comercial disponible</span>
        <h1>Ganadería Inteligente</h1>
        <p>
          Controla predios, animales, trazabilidad, genética, pesajes y decisiones productivas desde una
          plataforma diseñada para el campo.
        </p>
        <div className="gan-landing-hero-actions">
          <a className="gan-landing-btn is-primary" href={DEMO_MAILTO}>
            Solicitar demo <ArrowRight size={18} />
          </a>
          <a className="gan-landing-btn is-outline" href="#solucion">
            Ver cómo funciona
          </a>
        </div>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section className="gan-landing-section">
      <div className="gan-landing-container">
        <SectionHeading
          eyebrow="El problema"
          title="La información de la finca vive dispersa"
          text="Muchas fincas todavía toman decisiones con registros dispersos: libretas de campo, memoria, mensajes de WhatsApp o distintas hojas de Excel que no se conectan entre sí. Esto dificulta saber con certeza cuántos animales hay, cómo evolucionan y qué decisiones tomar."
        />
      </div>
    </section>
  );
}

function Solution() {
  return (
    <section id="solucion" className="gan-landing-section is-solution">
      <div className="gan-landing-container gan-landing-solution-grid">
        <img
          className="gan-landing-solution-image"
          src={ruralExperienceImage}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <SectionHeading
          eyebrow="La solución"
          title="Un sistema para organizar tu operación ganadera"
          text="AgroGenomaX Ganadería Inteligente centraliza la información productiva, sanitaria, genética y territorial de tu finca en una sola plataforma, para que cada decisión se tome con datos y no con memoria."
        />
      </div>
    </section>
  );
}

function Benefits() {
  return (
    <section className="gan-landing-section">
      <div className="gan-landing-container">
        <SectionHeading eyebrow="Beneficios" title="Qué gana tu operación con la plataforma" />
        <div className="gan-landing-benefits-grid">
          {benefits.map(({ icon: Icon, title, text }) => (
            <article key={title} className="gan-landing-benefit-card">
              <span className="gan-landing-icon">
                <Icon size={22} />
              </span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Audiences() {
  return (
    <section className="gan-landing-section is-audiences">
      <div className="gan-landing-container">
        <SectionHeading eyebrow="Para quién es" title="Diseñado para quienes toman decisiones en el campo" />
        <div className="gan-landing-audience-grid">
          {audiences.map(({ icon: Icon, label }) => (
            <div key={label} className="gan-landing-audience-chip">
              <Icon size={18} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Included() {
  return (
    <section className="gan-landing-section">
      <div className="gan-landing-container">
        <SectionHeading eyebrow="Qué incluye inicialmente" title="Lo que ya está disponible hoy" />
        <ul className="gan-landing-included-list">
          {included.map((item) => (
            <li key={item}>
              <Check size={15} strokeWidth={3} />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function OperationalAccess() {
  return (
    <section className="gan-landing-section is-access">
      <div className="gan-landing-container gan-landing-access-panel">
        <div>
          <span className="gan-landing-eyebrow">Acceso al sistema</span>
          <h2>¿Ya haces parte del piloto o del equipo CRH?</h2>
        </div>
        <Link to="/ganaderia" className="gan-landing-btn is-outline">
          <HomeIcon size={16} />
          Entrar al módulo operativo
        </Link>
      </div>
    </section>
  );
}

function FinalContact() {
  return (
    <section className="gan-landing-section is-contact">
      <div className="gan-landing-container">
        <SectionHeading
          eyebrow="Contacto"
          title="Lleva tu operación ganadera al siguiente nivel"
          text="Cuéntanos sobre tu finca o proyecto y te mostramos cómo funciona Ganadería Inteligente."
        />
        <a className="gan-landing-btn is-primary" href={DEMO_MAILTO}>
          Solicitar una demo de Ganadería Inteligente <ArrowRight size={18} />
        </a>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="gan-landing-footer">
      <img src={ganaderiaModuleIcon} alt="" loading="lazy" decoding="async" />
      <p>© 2026 AgroGenomaX by CRH. Ganadería Inteligente.</p>
    </footer>
  );
}

function SectionHeading({ eyebrow, title, text }) {
  return (
    <div className="gan-landing-heading">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
    </div>
  );
}

export default GanaderiaLandingComercial;
