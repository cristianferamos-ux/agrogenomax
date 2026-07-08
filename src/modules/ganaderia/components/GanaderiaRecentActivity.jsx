import { Activity } from 'lucide-react';

export default function GanaderiaRecentActivity() {
  return (
    <section className="gan-dash-section">
      <h2>Actividad reciente</h2>
      <ul className="gan-dash-activity-list">
        <li className="gan-dash-activity-item">
          <span className="gan-dash-activity-icon">
            <Activity size={16} />
          </span>
          <div>
            <strong>Sin actividad registrada todavía.</strong>
            <span>La actividad aparecerá cuando existan eventos reales del hato.</span>
          </div>
        </li>
      </ul>
    </section>
  );
}
