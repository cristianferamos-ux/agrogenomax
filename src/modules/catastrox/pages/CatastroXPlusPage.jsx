import { ArrowRight } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXDownloadMock from '../components/CatastroXDownloadMock.jsx';
import CatastroXMockMap from '../components/CatastroXMockMap.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXResultSummary from '../components/CatastroXResultSummary.jsx';
import { resolveLookupForRoute } from '../services/catastroxApi.js';
import { downloadPlanPdf } from '../utils/catastroxDeliverables.js';

export default function CatastroXPlusPage() {
  const { id } = useParams();
  const lookup = resolveLookupForRoute(id);

  if (!lookup) {
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>Plan Plus</span>
          <h1>No hay una consulta activa para este predio</h1>
          <p>Vuelva a buscar su predio para habilitar la información del plan.</p>
        </div>
        <CatastroXPageActions
          actions={[
            { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
            { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          ]}
        />
      </section>
    );
  }

  const predio = lookup.predio;
  const routeId = predio.routeId || predio.id;

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Plan Plus — $80.000 IVA incluido</span>
        <h1>Plano Predial Digital</h1>
        <p>Obtenga un plano digital detallado listo para consulta y revisión técnica de su predio.</p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver al resultado', to: `/catastrox/resultado/${routeId}`, tone: 'ghost' },
          { label: 'Continuar a Premium', to: `/catastrox/premium/${routeId}`, tone: 'secondary' },
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
        ]}
      />
      <div className="catastrox-two-col">
        <CatastroXResultSummary predio={predio} mode="plus" />
        <CatastroXMockMap predio={predio} />
      </div>
      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Incluye</span>
          <h2>Entregables del Plan Plus</h2>
        </div>
        <ul className="catastrox-list">
          <li><strong>Plano digital detallado</strong> listo para consulta.</li>
          <li>Plano PDF técnico.</li>
          <li>Croquis predial complementario.</li>
          <li>Medidas principales.</li>
          <li>Área total y perímetro.</li>
        </ul>
        <div className="catastrox-action-row">
          <CatastroXDownloadMock
            label="Descargar plano PDF"
            onClick={() => downloadPlanPdf(lookup)}
          />
        </div>
        <p className="catastrox-copy">
          Si usted necesita archivos GIS, coordenadas de vértices o compatibilidad con software especializado, puede continuar al Plan Premium.
        </p>
        <div className="catastrox-action-row">
          <Link className="catastrox-button" to={`/catastrox/premium/${routeId}`}>
            Continuar al Plan Premium <ArrowRight size={18} />
          </Link>
        </div>
      </section>
      <CatastroXDisclaimer />
    </section>
  );
}
