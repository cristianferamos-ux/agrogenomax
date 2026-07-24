import { CATASTROX_PACKAGE_IDS } from '../config/catastroxPackages.js';
import CatastroXPackagePage from './CatastroXPackagePage.jsx';

export default function CatastroXProfessionalPage() {
  return <CatastroXPackagePage packageId={CATASTROX_PACKAGE_IDS.PROFESIONAL} />;
}
