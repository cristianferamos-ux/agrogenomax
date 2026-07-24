export const CATASTROX_PACKAGE_IDS = {
  BASICO: 'basico',
  PLUS: 'plus',
  PROFESIONAL: 'profesional',
};

const PACKAGE_ORDER = [
  CATASTROX_PACKAGE_IDS.BASICO,
  CATASTROX_PACKAGE_IDS.PLUS,
  CATASTROX_PACKAGE_IDS.PROFESIONAL,
];

const PACKAGES_BY_ID = {
  [CATASTROX_PACKAGE_IDS.BASICO]: {
    id: CATASTROX_PACKAGE_IDS.BASICO,
    routeSlug: 'basico',
    label: 'PAQUETE BÁSICO',
    title: 'Plano predial digital',
    priceCop: 39900,
    buttonLabel: 'Comprar PAQUETE BÁSICO',
    recommended: false,
    description: 'PDF con plano predial e información del predio.',
    tone: 'green',
    downloads: ['pdf'],
    features: [
      'PDF con plano predial validado comercialmente',
      'Información base del predio identificada por CatastroX',
      'Descarga habilitada solo después del pago aprobado',
    ],
  },
  [CATASTROX_PACKAGE_IDS.PLUS]: {
    id: CATASTROX_PACKAGE_IDS.PLUS,
    routeSlug: 'plus',
    label: 'PAQUETE PLUS',
    title: 'Plano predial + Google Earth',
    priceCop: 49900,
    buttonLabel: 'Comprar PAQUETE PLUS',
    recommended: true,
    description: 'PDF + KML + KMZ para Google Earth y celular.',
    tone: 'gold',
    downloads: ['pdf', 'kml', 'kmz'],
    features: [
      'Todo el contenido del PDF comercial',
      'Archivo KML para visualización rápida',
      'Archivo KMZ para Google Earth y celular',
    ],
  },
  [CATASTROX_PACKAGE_IDS.PROFESIONAL]: {
    id: CATASTROX_PACKAGE_IDS.PROFESIONAL,
    routeSlug: 'profesional',
    label: 'PAQUETE PROFESIONAL',
    title: 'Plano predial + archivos técnicos',
    priceCop: 59900,
    buttonLabel: 'Comprar PAQUETE PROFESIONAL',
    recommended: false,
    description: 'PDF, GIS, CAD y tabla completa de coordenadas técnicas del predio.',
    tone: 'red',
    downloads: ['pdf', 'kml', 'kmz', 'shp', 'dxf', 'coords9377'],
    features: [
      'PDF comercial aprobado',
      'KML y KMZ para Google Earth',
      'SHP para GIS',
      'DXF compatible con AutoCAD/Civil 3D',
      'CSV de coordenadas Este/Norte en EPSG:9377',
    ],
  },
};

export function formatCatastroxPackagePrice(priceCop) {
  return `$${new Intl.NumberFormat('es-CO').format(priceCop)} COP`;
}

export function getCatastroxPackages() {
  return PACKAGE_ORDER.map((packageId) => PACKAGES_BY_ID[packageId]);
}

export function getCatastroxPackage(packageId) {
  return PACKAGES_BY_ID[packageId] || null;
}

export function getCatastroxPackageRank(packageId) {
  return PACKAGE_ORDER.indexOf(packageId);
}

export function routeSlugToCatastroxPackageId(routeSlug) {
  const normalizedRouteSlug = routeSlug === 'premium' ? 'profesional' : routeSlug;
  const match = Object.values(PACKAGES_BY_ID).find(
    (pkg) => pkg.routeSlug === normalizedRouteSlug || pkg.id === normalizedRouteSlug,
  );
  return match?.id || null;
}

export function getCatastroxPackageRoute(packageId, routeId) {
  const pkg = getCatastroxPackage(packageId);
  if (!pkg) return '/catastrox/planes';
  return routeId ? `/catastrox/${pkg.routeSlug}/${routeId}` : `/catastrox/${pkg.routeSlug}`;
}

export function doesCatastroxPackageSatisfy(requiredPackageId, ownedPackageId) {
  const requiredRank = getCatastroxPackageRank(requiredPackageId);
  const ownedRank = getCatastroxPackageRank(ownedPackageId);

  if (requiredRank < 0 || ownedRank < 0) return false;
  return ownedRank >= requiredRank;
}
