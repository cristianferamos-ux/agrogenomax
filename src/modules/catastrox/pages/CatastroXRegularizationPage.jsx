import CatastroXLeadForm from '../components/CatastroXLeadForm.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';

export default function CatastroXRegularizationPage() {
  const outcomes = [
    'Regularizar su predio.',
    'Prepararse para acceder a créditos.',
    'Prepararse para proyectos productivos.',
    'Preparar la venta o compra del predio.',
    'Resolver inconsistencias catastrales.',
    'Resolver conflictos de linderos.',
  ];

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Regularización con asesor</span>
        <h1>Cuéntenos su caso y solicite acompañamiento técnico</h1>
        <p>Un asesor revisará su caso y le indicará la ruta técnica más conveniente para su predio.</p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
        ]}
      />
      <div className="catastrox-two-col">
        <article className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Resultados esperados</span>
            <h2>Lo que usted busca resolver</h2>
          </div>
          <ul className="catastrox-list">
            {outcomes.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <p className="catastrox-copy">
            Un asesor revisará su caso y se comunicará para explicarle los pasos, requisitos y opciones disponibles para regularizar su predio.
          </p>
        </article>
        <CatastroXLeadForm />
      </div>
    </section>
  );
}
