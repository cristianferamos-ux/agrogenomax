import { ArrowLeft, ClipboardList, Cpu, Dna, FlaskConical, Headset, Info, QrCode, ShieldCheck, Tag, User } from 'lucide-react';
import { Link } from 'react-router-dom';
import GanaderiaAccessCard from '../components/GanaderiaAccessCard.jsx';
import heroCattleVisual from '../../../assets/ganaderia/access-hero-cattle.png';
import heroPhoneVisual from '../../../assets/ganaderia/access-hero-phone-qr.png';
import '../styles/ganaderia-access.css';

const benefitStrip = [
  { icon: QrCode, label: 'Trazabilidad QR' },
  { icon: ShieldCheck, label: 'Control sanitario' },
  { icon: ClipboardList, label: 'Pesajes e informes' },
  { icon: Dna, label: 'Gestión reproductiva' },
];

const trustStrip = [
  { icon: Info, title: 'Información confiable', text: 'para tomar mejores decisiones' },
  { icon: Cpu, title: 'Tecnología que impulsa', text: 'tu producción' },
  { icon: Headset, title: 'Siempre contigo', text: 'en cada etapa' },
];

export default function GanaderiaAccess() {
  return (
    <div className="gan-access-shell">
      <div className="gan-access-hero">
        <div className="gan-access-hero-visual is-left" aria-hidden="true">
          <img src={heroCattleVisual} alt="" loading="eager" decoding="async" />
        </div>
        <div className="gan-access-hero-visual is-right" aria-hidden="true">
          <img src={heroPhoneVisual} alt="" loading="eager" decoding="async" />
        </div>

        <div className="gan-access-hero-content">
          <Link to="/" className="gan-access-back">
            <ArrowLeft size={15} /> Volver al Home
          </Link>
          <span className="gan-access-badge">Módulo activo</span>
          <h1>
            Ganadería <span className="gan-access-title-accent">Inteligente</span>
          </h1>
          <p className="gan-access-subtitle">
            Administra tu hato con trazabilidad QR, control sanitario, reproducción, pesajes, reportes e
            inteligencia productiva.
          </p>
          <p className="gan-access-highlight">Prueba la demo, revisa los planes o ingresa si ya eres cliente.</p>

          <div className="gan-access-benefits">
            {benefitStrip.map(({ icon: Icon, label }) => (
              <div key={label} className="gan-access-benefit">
                <Icon size={16} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="gan-access-grid">
        <GanaderiaAccessCard
          icon={User}
          title="Ingreso de usuarios registrados"
          text={
            <>
              <strong>Para clientes con plan activo.</strong> Accede con tu usuario y contraseña para gestionar
              predios, animales, QR, pesajes, vacunas, tratamientos, reproducción e informes reales.
            </>
          }
          note="Tus datos son privados. Si aún no tienes plan, revisa Planes y precios o prueba la demo."
          primary={{ label: 'Ingresar a mi cuenta', to: '/ganaderia/dashboard' }}
          secondary={{ label: 'Recuperar acceso', to: '/ganaderia/proximamente/recuperar-acceso' }}
        />

        <GanaderiaAccessCard
          tone="demo"
          icon={FlaskConical}
          badge="Recomendado para nuevos clientes"
          title="Cuenta Demo"
          text={
            <>
              <strong>Pruébala sin compromiso.</strong> Explora Ganadería Inteligente: registra animales, QR,
              pesajes y vacunas de ejemplo, y descarga un informe demo.
            </>
          }
          note="Sin registro. Datos temporales de esta sesión, no afectan cuentas reales de ningún cliente."
          primary={{ label: 'Entrar a la demo', to: '/ganaderia/demo' }}
        />

        <GanaderiaAccessCard
          icon={Tag}
          title="Planes y precios"
          text={
            <>
              <strong>Elige el plan según tu hato.</strong> Todos los planes incluyen plataforma, nube, chapetas QR
              y capacitación.
            </>
          }
          note="Recomendado si ya probaste la demo. La activación de tu cuenta va acompañada por nuestro equipo."
          primary={{ label: 'Ver planes', to: '/ganaderia/planes' }}
        />
      </div>

      <div className="gan-access-trust">
        {trustStrip.map(({ icon: Icon, title, text }) => (
          <div key={title} className="gan-access-trust-item">
            <Icon size={20} />
            <div>
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
