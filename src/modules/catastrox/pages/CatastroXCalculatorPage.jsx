import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import { buildCatastroXWhatsAppUrl } from '../config/catastroxContact.js';

export default function CatastroXCalculatorPage() {
  const whatsappUrl = buildCatastroXWhatsAppUrl({
    status: 'REVISION_ESPECIAL',
    municipio: 'Sin dato',
    departamento: 'Caquetá',
    lat: 'Sin dato',
    lng: 'Sin dato',
    areaHa: null,
  });

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Orientación técnica</span>
        <h1>La ruta técnica se revisa con un asesor</h1>
        <p>
          En esta fase no mostramos cálculos automáticos ni valores de levantamiento. Un asesor revisará su caso y le
          indicará la opción más conveniente.
        </p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          { label: 'Regularización', to: '/catastrox/regularizacion', tone: 'secondary' },
          { label: 'Hablar con un asesor', href: whatsappUrl, external: true, tone: 'danger' },
        ]}
      />
      <article className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Asesoría personalizada</span>
          <h2>Primero entendemos el caso, luego definimos la ruta</h2>
        </div>
        <p className="catastrox-copy">
          Si el predio presenta inconsistencia catastral, falta de individualización o requiere regularización, la
          recomendación es conversar con un asesor antes de avanzar.
        </p>
        <p className="catastrox-copy">
          Así evitamos mostrar valores automáticos fuera de contexto y priorizamos claridad, orientación y
          acompañamiento técnico.
        </p>
      </article>
    </section>
  );
}
