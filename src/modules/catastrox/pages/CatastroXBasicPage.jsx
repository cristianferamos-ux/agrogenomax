import { ArrowRight } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXDownloadMock from '../components/CatastroXDownloadMock.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXResultSummary from '../components/CatastroXResultSummary.jsx';
import CatastroXWhatsAppCTA from '../components/CatastroXWhatsAppCTA.jsx';
import { CATASTROX_STATUS } from '../data/catastroxMockData.js';
import { resolveLookupForRoute } from '../services/catastroxApi.js';
import { downloadDiagnosticPdf } from '../utils/catastroxDeliverables.js';

export default function CatastroXBasicPage() {
  const { id } = useParams();
  const lookup = resolveLookupForRoute(id);

  if (!lookup) {
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>Diagnóstico Predial</span>
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
  const requiresAdvisor =
    predio.estado === CATASTROX_STATUS.FISCAL ||
    predio.estado === CATASTROX_STATUS.INCONSISTENCIA ||
    predio.estado === CATASTROX_STATUS.REVISION_ESPECIAL;

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Plan Básico — $36.000 IVA incluido</span>
        <h1>Diagnóstico Predial</h1>
        <p>Usted podrá conocer el código predial, el área total, el perímetro y un diagnóstico predial básico de su consulta.</p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver al resultado', to: `/catastrox/resultado/${routeId}`, tone: 'ghost' },
          ...(requiresAdvisor ? [] : [{ label: 'Continuar a Plan Plus', to: `/catastrox/plus/${routeId}`, tone: 'secondary' }]),
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
        ]}
      />
      <CatastroXResultSummary predio={predio} mode="basic" />
      {requiresAdvisor ? (
        <>
          <section className="catastrox-card is-danger">
            <div className="catastrox-section-heading">
              <span>Alerta técnica</span>
              <h2>Este caso requiere revisión técnica antes de continuar</h2>
            </div>
            <p className="catastrox-copy">
              La información disponible no permite emitir su diagnóstico predial como un caso estándar. Un asesor debe revisar la cobertura, la individualización o la extensión del polígono antes de avanzar.
            </p>
          </section>
          <CatastroXWhatsAppCTA
            lookup={lookup}
            status={lookup.status || predio.estado}
            municipio={predio.municipio}
            departamento={predio.departamento}
            queryPoint={lookup.queryPoint || predio.queryPoint}
            areaHa={predio.areaHa}
          />
        </>
      ) : (
        <section className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Incluye</span>
            <h2>Entregables del Plan Básico</h2>
          </div>
          <ul className="catastrox-list">
            <li>Código predial.</li>
            <li>Código anterior.</li>
            <li>Municipio y departamento.</li>
            <li>Área total en hectáreas y en m².</li>
            <li>Perímetro.</li>
            <li>Diagnóstico predial básico.</li>
            <li>Informe PDF.</li>
          </ul>
          <div className="catastrox-action-row">
            <CatastroXDownloadMock
              label="Descargar informe PDF"
              onClick={() => downloadDiagnosticPdf(lookup)}
            />
            <Link className="catastrox-button" to={`/catastrox/plus/${routeId}`}>
              Continuar a Plan Plus <ArrowRight size={18} />
            </Link>
          </div>
        </section>
      )}
      <CatastroXDisclaimer />
    </section>
  );
}
