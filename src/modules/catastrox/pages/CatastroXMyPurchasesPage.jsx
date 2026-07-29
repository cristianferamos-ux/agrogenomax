import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXMyPurchases from '../components/CatastroXMyPurchases.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';

const NAVIGATION_ACTIONS = [
  { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
  { label: 'Ver planes', to: '/catastrox/planes', tone: 'ghost' },
];

export default function CatastroXMyPurchasesPage() {
  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>CatastroX</span>
        <h1>Mis compras en este navegador</h1>
        <p>Historial de órdenes asociadas a la sesión de este navegador.</p>
      </div>
      <CatastroXPageActions actions={NAVIGATION_ACTIONS} />
      <CatastroXMyPurchases />
      <CatastroXDisclaimer />
    </section>
  );
}
