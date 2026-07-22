import {
  ArrowDownToLine,
  ArrowRight,
  Beef,
  ChartNoAxesCombined,
  Check,
  Cloud,
  Facebook,
  Headphones,
  Instagram,
  Lock,
  Mail,
  MapPin,
  Menu,
  ShieldCheck,
  X,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import '../../styles/agrogenomax-home.css';
import headerSymbolLogo from '../../assets/branding/corporate/agrogenomax-symbol.webp';
import headerWordmarkLogo from '../../assets/branding/corporate/agrogenomax-wordmark.webp';
import heroSceneImage from '../../assets/hero/AV-0001-hero-main-optimized.webp';
import ganaderiaModuleBg from '../../assets/solutions/module-bg-ganaderia.png';
import catastroxModuleBg from '../../assets/solutions/module-bg-catastrox.webp';
import territorioModuleBg from '../../assets/solutions/module-bg-territorio.webp';
import ganaderiaModuleIcon from '../../assets/solutions/module-icon-ganaderia.png';
import catastroxModuleIcon from '../../assets/solutions/module-icon-catastrox.webp';
import territorioModuleIcon from '../../assets/solutions/module-icon-territorio.webp';
import contactDatosVisual from '../../assets/contact/contact-visual-datos.webp';
import contactCatastroVisual from '../../assets/contact/contact-visual-catastro.webp';
import contactGanaderiaVisual from '../../assets/contact/contact-visual-ganaderia.webp';
import contactSeguridadVisual from '../../assets/contact/contact-visual-seguridad.webp';

const navItems = [
  { label: 'Inicio', kind: 'anchor', target: 'inicio' },
  { label: 'Módulos', kind: 'anchor', target: 'modulos' },
  { label: 'Ganadería Inteligente', kind: 'route', to: '/ganaderia/acceso' },
  { label: 'CatastroX', kind: 'route', to: '/catastrox' },
  { label: 'Contacto', kind: 'anchor', target: 'contacto' },
];

const heroBenefits = [
  {
    icon: ShieldCheck,
    title: 'Arquitectura orientada a seguridad',
    text: 'Plataforma diseñada para evolucionar con controles de acceso, trazabilidad y operación segura por módulos.',
  },
  {
    icon: Cloud,
    title: 'Acceso en la nube',
    text: 'Disponible desde cualquier lugar y dispositivo',
  },
  {
    icon: ChartNoAxesCombined,
    title: 'Análisis inteligente',
    text: 'IA y datos para decisiones más acertadas',
  },
  {
    icon: Headphones,
    title: 'Soporte especializado',
    text: 'Nuestro equipo te acompaña en cada paso',
  },
];

const solutions = [
  {
    id: 'ganaderia-inteligente',
    iconImage: ganaderiaModuleIcon,
    title: 'Ganadería Inteligente',
    text: 'Gestión completa de tu hato con genética, sanidad, producción y trazabilidad.',
    items: ['Registro animal con QR', 'Control reproductivo y genético', 'Producción y sanidad', 'Reportes inteligentes'],
    action: 'Ingresar',
    to: '/ganaderia/acceso',
    tone: 'rural',
    badge: 'Disponible',
    image: ganaderiaModuleBg,
  },
  {
    id: 'catastrox-home',
    iconImage: catastroxModuleIcon,
    title: 'CatastroX',
    text: 'Información catastral inteligente para municipios habilitados, con cobertura en expansión progresiva.',
    items: ['Consulta predial inteligente', 'Información catastral disponible según cobertura', 'Planos y descargas SIG', 'Análisis territorial y fiscal'],
    action: 'Ingresar',
    to: '/catastrox',
    tone: 'catastrox',
    badge: 'Disponible',
    image: catastroxModuleBg,
  },
  {
    id: 'agx-territorio',
    iconImage: territorioModuleIcon,
    title: 'AGX Territorio',
    text: 'Análisis territorial avanzado para proyectos productivos y sostenibles, como próxima capa de inteligencia de AgroGenomaX.',
    items: ['Hoja de ruta territorial', 'Mapas temáticos planificados', 'Análisis ambiental proyectado', 'Inteligencia territorial en evolución'],
    action: 'Ser notificado',
    target: '#contacto',
    tone: 'territorio',
    badge: 'En desarrollo estratégico',
    image: territorioModuleBg,
  },
];

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.18 },
  transition: { duration: 0.68, ease: [0.22, 1, 0.36, 1] },
};

function scrollToSection(target) {
  const element = document.getElementById(target);
  if (!element) return;

  const headerHeight = document.querySelector('header')?.getBoundingClientRect().height || 0;
  const top = element.getBoundingClientRect().top + window.scrollY - headerHeight - 14;
  window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
}

function AgroGenomaXHome() {
  useEffect(() => {
    const syncHashScroll = () => {
      const target = window.location.hash.replace('#', '');
      if (!target) return;
      window.setTimeout(() => scrollToSection(target), 120);
    };

    syncHashScroll();
    window.addEventListener('hashchange', syncHashScroll);
    return () => window.removeEventListener('hashchange', syncHashScroll);
  }, []);

  return (
    <main className="agx-approved-home">
      <Header />
      <Hero />
      <Solutions />
      <Contact />
      <Footer />
    </main>
  );
}

function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);

  useEffect(() => {
    const isInstalled = () =>
      window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

    const handleBeforeInstallPrompt = (event) => {
      if (isInstalled()) return;
      event.preventDefault();
      setInstallPrompt(event);
    };

    const handleAppInstalled = () => {
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (!isMenuOpen) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isMenuOpen]);

  const handleNavClick = (event, target) => {
    event.preventDefault();
    setIsMenuOpen(false);
    window.setTimeout(() => scrollToSection(target), 0);
  };

  const handleDemoClick = (event) => {
    event.preventDefault();
    setIsMenuOpen(false);
    window.setTimeout(() => scrollToSection('contacto'), 0);
  };

  const handleInstallClick = async () => {
    if (!installPrompt) return;

    const promptEvent = installPrompt;
    setInstallPrompt(null);
    setIsMenuOpen(false);
    await promptEvent.prompt();
    await promptEvent.userChoice.catch(() => null);
  };

  return (
    <header className={`agx-approved-header${isMenuOpen ? ' is-menu-open' : ''}`}>
      <nav className="agx-approved-nav" aria-label="Navegación principal">
        <a
          className="agx-approved-brand"
          href="#inicio"
          aria-label="AgroGenomaX inicio"
          onClick={(event) => {
            event.preventDefault();
            setIsMenuOpen(false);
            window.setTimeout(() => scrollToSection('inicio'), 0);
          }}
        >
          <span className="agx-approved-brand-mark">
            <img src={headerSymbolLogo} alt="" decoding="async" />
          </span>
          <span className="agx-approved-brand-wordmark" aria-hidden="true">
            <img src={headerWordmarkLogo} alt="" decoding="async" />
          </span>
        </a>

        <button
          className="agx-approved-menu-toggle"
          type="button"
          aria-controls="agx-approved-navigation-links"
          aria-expanded={isMenuOpen}
          aria-label={isMenuOpen ? 'Cerrar menú' : 'Abrir menú'}
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          {isMenuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>

        <div id="agx-approved-navigation-links" className={`agx-approved-links${isMenuOpen ? ' is-open' : ''}`}>
          {navItems.map((item) =>
            item.kind === 'route' ? (
              <Link key={item.label} to={item.to} onClick={() => setIsMenuOpen(false)}>
                {item.label}
              </Link>
            ) : (
              <a
                key={item.label}
                href={`#${item.target}`}
                onClick={(event) => handleNavClick(event, item.target)}
              >
                {item.label}
              </a>
            ),
          )}
        </div>

        <div className={`agx-approved-actions${isMenuOpen ? ' is-open' : ''}`}>
          <a href="#contacto" onClick={handleDemoClick} className="agx-approved-btn is-outline-blue">
            Solicitar demo <ArrowRight size={16} />
          </a>
          {/*
            "Instalar app" solo se muestra si el navegador dispara el evento nativo
            `beforeinstallprompt` (requiere HTTPS, manifest y service worker activos).
            En localhost/desarrollo el service worker se desregistra a propósito
            (ver src/registerServiceWorker.js), por lo que este botón normalmente
            no aparece en pruebas locales; es funcional y solo verificable en producción.
          */}
          {installPrompt ? (
            <button className="agx-approved-btn is-outline-green" type="button" onClick={handleInstallClick}>
              Instalar app <ArrowDownToLine size={16} />
            </button>
          ) : null}
        </div>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section id="inicio" className="agx-approved-hero">
      <div className="agx-approved-hero-inner">
        <motion.div
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
          className="agx-approved-hero-copy"
        >
          <span className="agx-approved-eyebrow">Plataforma de inteligencia agropecuaria y territorial</span>
          <h1>
            <span>Inteligencia que</span>
            <span>
              transforma <strong>decisiones</strong>
            </span>
            <span>
              en <em>resultados</em>
            </span>
          </h1>
          <p>
            AgroGenomaX integra genética, territorio y datos para que tomes mejores decisiones, aumentes tu
            productividad y generes valor sostenible en el campo y en la ciudad.
          </p>
          <div className="agx-approved-hero-actions">
            <a
              href="#modulos"
              onClick={(event) => {
                event.preventDefault();
                scrollToSection('modulos');
              }}
              className="agx-approved-primary"
            >
              Ver módulos <ArrowRight size={18} />
            </a>
          </div>
        </motion.div>

        <HeroGraphic />
      </div>

      <div className="agx-approved-benefits">
        {heroBenefits.map(({ icon: Icon, title, text }) => (
          <article key={title}>
            <span>
              <Icon size={24} />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function HeroGraphic() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 24 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      className="agx-approved-hero-graphic"
      aria-hidden="true"
    >
      <div className="agx-approved-hero-main-visual" aria-hidden="true">
        <img
          className="agx-approved-hero-scene"
          src={heroSceneImage}
          alt=""
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </div>
    </motion.div>
  );
}

function Solutions() {
  return (
    <section id="modulos" className="agx-approved-section">
      <motion.div {...fadeUp} className="agx-approved-container">
        <SectionHeading
          eyebrow="Nuestros módulos"
          title="Soluciones especializadas para cada necesidad"
          text="Una plataforma integrada que conecta genética, territorio y gestión inteligente."
        />
        <div className="agx-approved-solution-grid">
          {solutions.map((solution) => (
            <SolutionCard key={solution.title} solution={solution} />
          ))}
        </div>
      </motion.div>
    </section>
  );
}

function SolutionCard({ solution }) {
  const content = (
    <>
      {solution.badge ? <span className="agx-approved-badge">{solution.badge}</span> : null}
      <div className={`agx-approved-card-visual is-${solution.tone}`} aria-hidden="true">
        <img src={solution.image} alt="" loading="lazy" decoding="async" />
      </div>
      <div className="agx-approved-card-content">
        <div className="agx-approved-icon">
          <img src={solution.iconImage} alt="" loading="lazy" decoding="async" />
        </div>
        <h3>{solution.title}</h3>
        <p>{solution.text}</p>
        <ul>
          {solution.items.map((item) => (
            <li key={item}>
              <Check size={15} strokeWidth={3} />
              {item}
            </li>
          ))}
        </ul>
        <span className="agx-approved-card-action">
          {solution.action} {solution.to ? <ArrowRight size={16} /> : null}
        </span>
      </div>
    </>
  );

  const className = `agx-approved-solution-card is-${solution.tone}`;

  if (solution.to) {
    return (
      <Link id={solution.id} to={solution.to} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <a
      id={solution.id}
      href={solution.target}
      onClick={(event) => {
        if (!solution.target?.startsWith('#')) return;
        event.preventDefault();
        scrollToSection(solution.target.replace('#', ''));
      }}
      className={className}
    >
      {content}
    </a>
  );
}

function Contact() {
  return (
    <section id="contacto" className="agx-approved-section is-contact">
      <motion.div {...fadeUp} className="agx-approved-container agx-approved-contact-layout">
        <div className="agx-approved-contact-side is-left">
          <ContactHighlightCard
            icon={ChartNoAxesCombined}
            title="Decisiones basadas en datos"
            text="Transformamos información en decisiones estratégicas para tu ganadería."
          >
            <div className="agx-mini-visual-panel is-chart">
              <img src={contactDatosVisual} alt="" loading="lazy" decoding="async" />
              <div className="agx-mini-visual-overlay">
                <MiniQualitativeList
                  items={['Indicadores productivos', 'Seguimiento del desempeño', 'Análisis para mejores decisiones']}
                />
              </div>
            </div>
          </ContactHighlightCard>

          <ContactHighlightCard
            icon={MapPin}
            title="Catastro y georreferenciación"
            text="Mapas precisos y actualizados para el control total de tu territorio y activos."
          >
            <div className="agx-mini-visual-panel is-map">
              <img src={contactCatastroVisual} alt="" loading="lazy" decoding="async" />
              <div className="agx-mini-visual-overlay">
                <div className="agx-mini-map-label">
                  <small>Gestión territorial</small>
                  <strong>Predios georreferenciados</strong>
                </div>
              </div>
            </div>
          </ContactHighlightCard>
        </div>

        <div className="agx-approved-contact-main">
          <SectionHeading
            eyebrow="Contacto"
            title="Solicita una demo de AgroGenomaX"
            text="Conoce Ganadería Inteligente o CatastroX con nuestro equipo."
          />
          <div className="agx-approved-contact-actions">
            <a
              className="agx-approved-primary"
              href="mailto:contact@agrogenomax.com?subject=Solicitud%20de%20demo%20AgroGenomaX"
            >
              Solicitar demo <ArrowRight size={18} />
            </a>
            <a
              className="agx-approved-secondary"
              href="mailto:soporte@agrogenomax.com?subject=Soporte%20AgroGenomaX"
            >
              Soporte
            </a>
          </div>
          <div className="agx-approved-official-channels">
            <div className="agx-approved-official-channel">
              <span className="agx-approved-official-channel-icon">
                <Mail size={18} />
              </span>
              <div>
                <em>Ventas y demos</em>
                <a href="mailto:contact@agrogenomax.com">contact@agrogenomax.com</a>
              </div>
            </div>
            <div className="agx-approved-official-channel">
              <span className="agx-approved-official-channel-icon">
                <Headphones size={18} />
              </span>
              <div>
                <em>Soporte</em>
                <a href="mailto:soporte@agrogenomax.com">soporte@agrogenomax.com</a>
              </div>
            </div>
          </div>
        </div>

        <div className="agx-approved-contact-side is-right">
          <ContactHighlightCard
            icon={Beef}
            title="Ganadería inteligente"
            text="Monitorea tu rodeo en tiempo real y optimiza la productividad con tecnología avanzada."
          >
            <div className="agx-mini-visual-panel is-herd">
              <img src={contactGanaderiaVisual} alt="" loading="lazy" decoding="async" />
              <div className="agx-mini-visual-overlay">
                <MiniQualitativeList
                  tone="cyan"
                  items={['Inventario del hato', 'Control animal organizado', 'Productividad monitoreada']}
                />
              </div>
            </div>
          </ContactHighlightCard>

          <ContactHighlightCard
            icon={ShieldCheck}
            title="Seguridad y confiabilidad"
            text="Diseñada para operar con trazabilidad, control de acceso y gestión responsable de la información."
          >
            <div className="agx-mini-visual-panel is-security">
              <img src={contactSeguridadVisual} alt="" loading="lazy" decoding="async" />
              <div className="agx-mini-visual-overlay">
                <div className="agx-mini-security">
                  <span className="agx-mini-security-dot" aria-hidden="true" />
                  <Lock size={18} />
                  <div>
                    <strong>Gestión responsable</strong>
                    <small>Acceso organizado por módulos</small>
                  </div>
                </div>
              </div>
            </div>
          </ContactHighlightCard>
        </div>
      </motion.div>
    </section>
  );
}

function ContactHighlightCard({ icon: Icon, title, text, children }) {
  return (
    <article className="agx-approved-contact-card">
      <div className="agx-approved-contact-card-head">
        <span className="agx-approved-contact-card-icon">
          <Icon size={20} />
        </span>
        <div>
          <h3>{title}</h3>
          <p>{text}</p>
        </div>
      </div>
      {children}
    </article>
  );
}

function MiniQualitativeList({ items, tone = 'lime' }) {
  return (
    <ul className={`agx-mini-list is-${tone}`}>
      {items.map((item) => (
        <li key={item}>
          <Check size={13} strokeWidth={3} />
          {item}
        </li>
      ))}
    </ul>
  );
}

function Footer() {
  return (
    <footer className="agx-approved-footer">
      <div className="agx-approved-footer-social">
        {/* Facebook: URL oficial pendiente de confirmar; se deja sin enlace hasta tenerla para no publicar un link roto. */}
        <span className="is-pending" title="Enlace pendiente: falta URL oficial de Facebook">
          <Facebook size={14} /> Facebook: Agrogenomax by CRH
        </span>
        <a href="https://www.instagram.com/agrogenomax/" target="_blank" rel="noopener noreferrer">
          <Instagram size={14} /> Instagram: @agrogenomax
        </a>
      </div>
      <p className="agx-approved-copyright">© 2026 AgroGenomaX by CRH. Todos los derechos reservados.</p>
    </footer>
  );
}

function SectionHeading({ eyebrow, title, text }) {
  return (
    <div className="agx-approved-heading">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
    </div>
  );
}

export default AgroGenomaXHome;
