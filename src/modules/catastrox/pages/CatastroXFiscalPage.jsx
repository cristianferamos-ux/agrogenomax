import { useParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXFiscalAlert from '../components/CatastroXFiscalAlert.jsx';
import CatastroXMockMap from '../components/CatastroXMockMap.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import { buildCatastroXWhatsAppUrl } from '../config/catastroxContact.js';
import { resolveLookupForRoute } from '../services/catastroxApi.js';

export default function CatastroXFiscalPage() {
  const { id } = useParams();
  const lookup = resolveLookupForRoute(id);

  if (!lookup) {
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>Predio fiscal</span>
          <h1>No hay una consulta activa para este predio</h1>
          <p>Vuelva a buscar el predio para cargar nuevamente el resultado.</p>
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
  const whatsappUrl = buildCatastroXWhatsAppUrl({
    status: 'POSIBLE_PREDIO_FISCAL',
    municipio: predio.municipio,
    departamento: predio.departamento,
    lat: lookup.queryPoint?.lat || predio.queryPoint?.lat,
    lng: lookup.queryPoint?.lng || predio.queryPoint?.lng,
    areaHa: predio.areaHa,
  });

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Predio fiscal</span>
        <h1>ALERTA CATASTRAL</h1>
        <p>Revise el alcance del hallazgo y active una conversación con asesoría técnica.</p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver al resultado', to: `/catastrox/resultado/${routeId}`, tone: 'ghost' },
          { label: 'Solicitar asesoría', to: '/catastrox/regularizacion', tone: 'secondary' },
          { label: 'Hablar con un asesor', href: whatsappUrl, external: true, tone: 'danger' },
        ]}
      />
      <div className="catastrox-two-col">
        <CatastroXFiscalAlert predio={predio} />
        <CatastroXMockMap predio={predio} />
      </div>
      <CatastroXDisclaimer />
    </section>
  );
}
