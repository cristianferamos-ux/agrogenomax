export default function GanaderiaMetricCard({ icon: Icon, label, value }) {
  return (
    <article className="gan-dash-metric-card">
      <span className="gan-dash-metric-icon">
        <Icon size={20} />
      </span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </article>
  );
}
