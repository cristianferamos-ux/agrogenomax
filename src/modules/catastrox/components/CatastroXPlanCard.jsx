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
}) {
  return (
    <article className={`catastrox-plan is-${tone}`}>
      <span>{subtitle}</span>
      <h3>{title}</h3>
      <strong>{price}</strong>
      {description ? <p className="catastrox-copy">{description}</p> : null}
      <ul>
        {features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      {to ? (
        <Link to={to} className="catastrox-button">
          {ctaLabel} <ArrowRight size={18} />
        </Link>
      ) : null}
    </article>
  );
}
