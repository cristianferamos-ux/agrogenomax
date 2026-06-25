import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXSearchForm from '../components/CatastroXSearchForm.jsx';

export default function CatastroXSearchPage() {
  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Buscar predio</span>
        <h1>Consulta por coordenadas</h1>
        <p>Ubique su predio en el mapa, capture latitud y longitud y confirme la ubicación de su consulta antes de continuar.</p>
      </div>
      <CatastroXPageActions actions={[{ label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' }]} />
      <CatastroXSearchForm />
    </section>
  );
}
