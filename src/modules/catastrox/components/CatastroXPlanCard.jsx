import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function CatastroXPlanCard({
  title,
  price,
  subtitle,
  description,
  features,
  to,
  tone = 'green',
  ctaLabel = 'Continuar',
  recommended = false,
}) {
  return (
    <article className={`catastrox-plan is-${tone}${recommended ? ' is-recommended' : ''}`}>
      {recommended ? <span className="catastrox-plan-badge">RECOMENDADO</span> : null}
      <span>{subtitle}</span>
      <h3>{title}</h3>
      {recommended ? <p className="catastrox-plan-reason">Incluye plano y archivos para Google Earth.</p> : null}
      <strong>{price}</strong>
      {description ? <p className="catastrox-copy">{description}</p> : null}
      <ul>
        {features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      {to ? (
        <Link to={to} className={`catastrox-button${recommended ? ' is-featured' : ''}`}>
          {ctaLabel} <ArrowRight size={18} />
        </Link>
      ) : null}
    </article>
  );
}
