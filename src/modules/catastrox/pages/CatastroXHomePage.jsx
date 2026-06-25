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
            { label: 'Planes', to: '/catastrox/planes', tone: 'secondary' },
            { label: 'Regularización', to: '/catastrox/regularizacion', tone: 'danger' },
            { label: 'Volver a AgroGenomaX', to: '/', tone: 'ghost' },
          ]}
        />
      </section>
      <section className="catastrox-grid">
        <article className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Resultado gratuito</span>
            <h2>Primero ubique su predio y confirme la información básica</h2>
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
            <h2>El resultado gratuito abre la ruta correcta para su predio</h2>
          </div>
          <p className="catastrox-copy">
            CatastroX primero le muestra un resultado gratuito. Después, si usted necesita mayor detalle, puede desbloquear la información predial con el Plan Básico, el Plan Plus o el Plan Premium.
          </p>
          <ul className="catastrox-list">
            <li>Sin mostrar planes como acción principal en casos especiales.</li>
            <li>Con información sensible bloqueada hasta activar un plan.</li>
            <li>Con acompañamiento técnico cuando la situación requiera revisión especializada.</li>
          </ul>
          <Link className="catastrox-button is-secondary" to="/catastrox/buscar">
            Conocer cómo funciona <ArrowRight size={18} />
          </Link>
        </article>
        <article className="catastrox-card is-danger">
          <div className="catastrox-section-heading">
            <span>Acompañamiento técnico</span>
            <h2>Si su caso requiere revisión, un asesor le orienta</h2>
          </div>
          <p className="catastrox-copy">
            Cuando el predio presente cobertura incompleta, falta de individualización o una revisión especial por gran extensión, la ruta recomendada es conversar con un asesor.
          </p>
          <Link className="catastrox-button is-danger" to="/catastrox/regularizacion">
            Solicitar orientación <ArrowRight size={18} />
          </Link>
        </article>
      </section>
    </>
  );
}
