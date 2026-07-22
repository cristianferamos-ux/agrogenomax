import { Link } from 'react-router-dom';

export default function GanaderiaAccessCard({ icon: Icon, badge, tone = 'green', title, text, note, primary, secondary }) {
  return (
    <article className={`gan-access-card is-${tone}`}>
      {badge ? <span className="gan-access-card-badge">{badge}</span> : null}
      <span className="gan-access-card-icon">
        <Icon size={26} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {note ? <span className="gan-access-card-note">{note}</span> : null}
      <div className="gan-access-card-actions">
        <Link to={primary.to} className={`gan-access-btn is-primary is-${tone}`}>
          {primary.label}
        </Link>
        {secondary ? (
          <Link to={secondary.to} className="gan-access-btn is-outline">
            {secondary.label}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
