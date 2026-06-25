import { Link } from 'react-router-dom';

export default function CatastroXPageActions({ actions }) {
  return (
    <nav className="catastrox-page-actions" aria-label="Acciones de la página">
      {actions.map((action) => {
        if (action.href) {
          return (
            <a
              key={action.label}
              className={`catastrox-button ${action.tone ? `is-${action.tone}` : ''}`.trim()}
              href={action.href}
              target={action.external ? '_blank' : undefined}
              rel={action.external ? 'noreferrer' : undefined}
            >
              {action.label}
            </a>
          );
        }

        return (
          <Link key={action.label} className={`catastrox-button ${action.tone ? `is-${action.tone}` : ''}`.trim()} to={action.to}>
            {action.label}
          </Link>
        );
      })}
    </nav>
  );
}
