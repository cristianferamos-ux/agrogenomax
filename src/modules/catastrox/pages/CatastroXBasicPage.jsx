import { CATASTROX_PACKAGE_IDS } from '../config/catastroxPackages.js';
import CatastroXPackagePage from './CatastroXPackagePage.jsx';

export default function CatastroXBasicPage() {
  return <CatastroXPackagePage packageId={CATASTROX_PACKAGE_IDS.BASICO} />;
}
