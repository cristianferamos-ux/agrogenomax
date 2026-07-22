import CatastroXPlanCard from './CatastroXPlanCard.jsx';
import {
  formatCatastroxPackagePrice,
  getCatastroxPackageRoute,
  getCatastroxPackages,
} from '../config/catastroxPackages.js';

export default function CatastroXPackageCards({ routeId, className = '' }) {
  const packages = getCatastroxPackages();
  const classNames = ['catastrox-grid', className].filter(Boolean).join(' ');

  return (
    <div className={classNames}>
      {packages.map((pkg) => (
        <CatastroXPlanCard
          key={pkg.id}
          title={pkg.title}
          subtitle={pkg.label}
          price={formatCatastroxPackagePrice(pkg.priceCop)}
          description={pkg.description}
          to={getCatastroxPackageRoute(pkg.id, routeId)}
          tone={pkg.tone}
          features={pkg.features}
          ctaLabel={pkg.buttonLabel}
          recommended={pkg.recommended}
        />
      ))}
    </div>
  );
}
