export default function GanaderiaProductivity() {
  return (
    <section className="gan-dash-section">
      <h2>Indicadores productivos</h2>
      <div className="gan-dash-productivity-grid">
        <article className="gan-dash-productivity-card">
          <span>Indicadores reales</span>
          <strong>Sin datos registrados todavía.</strong>
          <div className="gan-dash-productivity-bar">
            <div className="gan-dash-productivity-fill" style={{ width: '0%' }} />
          </div>
          <span>Los indicadores se calcularán cuando existan datos reales suficientes.</span>
        </article>
      </div>
    </section>
  );
}
