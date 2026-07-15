import CatastroXSearchForm from '../components/CatastroXSearchForm.jsx';

export default function CatastroXSearchPage() {
  return (
    <section className="catastrox-page catastrox-page-search">
      <div className="catastrox-page-title">
        <span>Identificación predial</span>
        <h1>Identifique su predio</h1>
        <p>Consulte mediante coordenadas o número predial. Recibirá gratuitamente municipio, departamento, zona y estado predial.</p>
      </div>
      <CatastroXSearchForm />
    </section>
  );
}
