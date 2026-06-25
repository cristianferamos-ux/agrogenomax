import { CATASTROX_LEGAL_NOTICE } from '../data/catastroxMockData.js';

export default function CatastroXDisclaimer({ children }) {
  return <div className="catastrox-disclaimer">{children || CATASTROX_LEGAL_NOTICE}</div>;
}
