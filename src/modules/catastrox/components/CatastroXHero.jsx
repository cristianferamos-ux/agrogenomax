import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function CatastroXHero() {
  return (
    <section className="catastrox-hero catastrox-hero-single">
      <div className="catastrox-hero-main">
        <span className="catastrox-eyebrow">Identificación predial inteligente</span>
        <h1 className="catastrox-hero-wordmark">
          <span>Catastro</span><span className="catastrox-wordmark-x">X</span>
        </h1>
        <p>Identifique su predio y conozca su situación catastral.</p>
        <strong>
          Ubique su predio en el mapa, confirme la información básica y descubra si necesita un diagnóstico predial o acompañamiento técnico.
        </strong>
        <div className="catastrox-action-row">
          <Link className="catastrox-button" to="/catastrox/buscar">
            Ubicar mi predio <ArrowRight size={18} />
          </Link>
          <Link className="catastrox-button is-secondary" to="/catastrox/buscar">
            Conocer cómo funciona
          </Link>
        </div>
      </div>
    </section>
  );
}
