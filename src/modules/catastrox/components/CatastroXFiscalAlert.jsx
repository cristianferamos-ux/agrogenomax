import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buildCatastroXWhatsAppUrl } from '../config/catastroxContact.js';

export default function CatastroXFiscalAlert({ predio }) {
  const whatsappUrl = buildCatastroXWhatsAppUrl({
    status: 'POSIBLE_PREDIO_FISCAL',
    municipio: predio.municipio,
    departamento: predio.departamento,
    lat: predio.queryPoint?.lat,
    lng: predio.queryPoint?.lng,
    areaHa: predio.areaHa,
  });

  return (
    <section className="catastrox-fiscal-alert">
      <div>
        <AlertTriangle size={28} />
        <span>ALERTA CATASTRAL</span>
        <h2>La ubicación consultada se encuentra dentro de un predio fiscal o no presenta delimitación predial individualizada.</h2>
      </div>
      <p>
        Un predio fiscal corresponde a un terreno que no presenta delimitación predial individualizada dentro de la
        cartografía catastral disponible o que forma parte de un polígono de mayor extensión administrado por el
        Estado.
      </p>
      <div className="catastrox-summary-grid">
        <div>
          <span>Municipio</span>
          <strong>{predio.municipio}</strong>
        </div>
        <div>
          <span>Departamento</span>
          <strong>{predio.departamento}</strong>
        </div>
        <div>
          <span>Área aproximada</span>
          <strong>{predio.areaHa} ha</strong>
        </div>
      </div>
      <ul>
        {predio.recomendaciones.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="catastrox-action-row">
        <Link className="catastrox-button" to="/catastrox/regularizacion">Hablar con un asesor</Link>
        <a className="catastrox-button is-secondary" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
          Hablar con un asesor
        </a>
      </div>
    </section>
  );
}
