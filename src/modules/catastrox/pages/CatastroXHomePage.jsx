import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import CatastroXHero from '../components/CatastroXHero.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';

export default function CatastroXHomePage() {
  return (
    <>
      <CatastroXHero />
      <section className="catastrox-page catastrox-page-actions-shell">
        <CatastroXPageActions
          actions={[
            { label: 'Buscar predio', to: '/catastrox/buscar' },
            { label: 'Paquetes', to: '/catastrox/planes', tone: 'secondary' },
            { label: 'Regularización', to: '/catastrox/regularizacion', tone: 'danger' },
            { label: 'Volver a AgroGenomaX', to: '/', tone: 'ghost' },
          ]}
        />
      </section>
      <section className="catastrox-grid">
        <article className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Resultado gratuito</span>
            <h2>Primero identifique su predio y confirme la información básica</h2>
          </div>
          <ul className="catastrox-list">
            <li>Ubique su predio.</li>
            <li>Conozca municipio, departamento y estado predial.</li>
            <li>Descubra si su consulta puede continuar como diagnóstico predial o si requiere revisión técnica.</li>
          </ul>
          <Link className="catastrox-button" to="/catastrox/buscar">
            Ubicar mi predio <ArrowRight size={18} />
          </Link>
        </article>
        <article className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Cómo funciona</span>
            <h2>Conozca cómo funciona antes de elegir un paquete</h2>
          </div>
          <p className="catastrox-copy">
            CatastroX primero le muestra un resultado gratuito. Después, si usted necesita mayor detalle, puede desbloquear la información predial con el paquete básico, el paquete plus o el paquete profesional.
          </p>
          <ul className="catastrox-list">
            <li>Sin mostrar paquetes como acción principal en casos especiales.</li>
            <li>Con información sensible bloqueada hasta aprobar el pago del paquete.</li>
            <li>Con acompañamiento técnico cuando la situación requiera revisión especializada.</li>
          </ul>
          <Link className="catastrox-button is-secondary" to="/catastrox/buscar">
            Conocer cómo funciona <ArrowRight size={18} />
          </Link>
        </article>
      </section>
    </>
  );
}
