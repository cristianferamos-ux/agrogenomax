import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXPackageCards from '../components/CatastroXPackageCards.jsx';
import CatastroXCommercialTransparency from '../components/CatastroXCommercialTransparency.jsx';
import { getLastLookup } from '../services/catastroxApi.js';

export default function CatastroXPlansPage() {
  const lastLookup = getLastLookup();
  const activeRouteId = lastLookup?.predio?.routeId || lastLookup?.predio?.id || 'albania-demo';

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Paquetes CatastroX</span>
        <h1>Seleccione el paquete que mejor responda a su consulta predial</h1>
        <p>
          Después del resultado gratuito, usted puede elegir el paquete comercial que desbloquea las descargas exactas que necesita.
        </p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
        ]}
      />
      <CatastroXPackageCards routeId={activeRouteId} />
      <CatastroXCommercialTransparency />
    </section>
  );
}
