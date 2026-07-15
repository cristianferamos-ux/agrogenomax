import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXSearchForm from '../components/CatastroXSearchForm.jsx';

export default function CatastroXSearchPage() {
  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Buscar predio</span>
        <h1>Consulta por coordenadas o número predial</h1>
        <p>Ubique su predio en el mapa o ingrese su número predial para continuar hacia el resultado comercial protegido.</p>
      </div>
      <CatastroXPageActions actions={[{ label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' }]} />
      <CatastroXSearchForm />
    </section>
  );
}
