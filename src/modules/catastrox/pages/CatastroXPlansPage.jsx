import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXPlanCard from '../components/CatastroXPlanCard.jsx';
import {
  formatCatastroxPackagePrice,
  getCatastroxPackageRoute,
  getCatastroxPackages,
} from '../config/catastroxPackages.js';
import { getLastLookup } from '../services/catastroxApi.js';

export default function CatastroXPlansPage() {
  const lastLookup = getLastLookup();
  const activeRouteId = lastLookup?.predio?.routeId || lastLookup?.predio?.id || 'albania-demo';
  const packages = getCatastroxPackages();

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
      <div className="catastrox-grid">
        {packages.map((pkg) => (
          <CatastroXPlanCard
            key={pkg.id}
            title={pkg.title}
            subtitle={pkg.label}
            price={formatCatastroxPackagePrice(pkg.priceCop)}
            description={pkg.description}
            to={getCatastroxPackageRoute(pkg.id, activeRouteId)}
            tone={pkg.tone}
            features={pkg.features}
            ctaLabel={`Comprar ${pkg.label}`}
          />
        ))}
      </div>
    </section>
  );
}
