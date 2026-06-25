import { Link, useParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXDownloadMock from '../components/CatastroXDownloadMock.jsx';
import CatastroXMockMap from '../components/CatastroXMockMap.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXResultSummary from '../components/CatastroXResultSummary.jsx';
import { resolveLookupForRoute } from '../services/catastroxApi.js';
import { downloadKml, downloadKmz, downloadShpZip } from '../utils/catastroxDeliverables.js';

const PREMIUM_USAGE = [
  'Lleve su predio en el celular.',
  'Visualice su predio sobre imágenes satelitales.',
  'Recorra los linderos en campo.',
  'Identifique puntos estratégicos.',
  'Comparta la información con familiares, compradores, socios o asesores.',
  'Mantenga una copia digital lista para futuras gestiones.',
];

const PREMIUM_TOOLS = [
  'Google Earth',
  'Celular Android',
  'Celular iPhone',
  'QGIS',
  'ArcGIS',
  'AutoCAD Civil 3D',
];

export default function CatastroXPremiumPage() {
  const { id } = useParams();
  const lookup = resolveLookupForRoute(id);

  if (!lookup) {
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>Plan Premium</span>
          <h1>No hay una consulta activa para este predio</h1>
          <p>Vuelva a buscar su predio para habilitar la información del plan.</p>
        </div>
        <CatastroXPageActions
          actions={[
            { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
            { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          ]}
        />
      </section>
    );
  }

  const predio = lookup.predio;
  const routeId = predio.routeId || predio.id;

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Plan Premium — $120.000 IVA incluido</span>
        <h1>PLANO PREDIAL + GIS</h1>
        <p>Obtenga archivos georreferenciados para visualizar el predio, recorrer linderos e integrarlo a software técnico.</p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver al Plan Plus', to: `/catastrox/plus/${routeId}`, tone: 'ghost' },
          { label: 'Volver al resultado', to: `/catastrox/resultado/${routeId}`, tone: 'secondary' },
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
        ]}
      />
      <div className="catastrox-two-col">
        <CatastroXResultSummary predio={predio} mode="premium" />
        <CatastroXMockMap predio={predio} />
      </div>
      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Valor del plan</span>
          <h2>Lleve su predio en el celular</h2>
        </div>
        <ul className="catastrox-list">
          {PREMIUM_USAGE.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Compatibilidad</span>
          <h2>¿Dónde puede utilizar los archivos?</h2>
        </div>
        <ul className="catastrox-list">
          {PREMIUM_TOOLS.map((item) => (
            <li key={item}>✓ {item}</li>
          ))}
        </ul>
      </section>
      <section className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Incluye</span>
          <h2>Entregables del Plan Premium</h2>
        </div>
        <ul className="catastrox-list">
          <li>Todo el Plan Plus.</li>
          <li>Archivo SHP.</li>
          <li>Archivo KML.</li>
          <li>Archivo KMZ.</li>
          <li>Coordenadas de vértices.</li>
          <li>Linderos georreferenciados.</li>
          <li>Compatibilidad con Google Earth, QGIS, ArcGIS y AutoCAD Civil 3D.</li>
        </ul>
        <p className="catastrox-copy">
          Usted podrá abrir el archivo en Google Earth desde su celular, visualizar el predio sobre imágenes satelitales, recorrer los linderos e identificar puntos estratégicos en campo.
        </p>
        <div className="catastrox-action-row">
          <CatastroXDownloadMock
            label="Descargar paquete SHP completo"
            onClick={() => downloadShpZip(lookup)}
          />
          <CatastroXDownloadMock
            label="Descargar KML"
            onClick={() => downloadKml(lookup)}
          />
          <CatastroXDownloadMock
            label="Descargar KMZ"
            onClick={() => downloadKmz(lookup)}
          />
        </div>
        <div className="catastrox-action-row">
          <Link className="catastrox-button is-secondary" to="/catastrox/regularizacion">
            Solicitar acompañamiento técnico
          </Link>
        </div>
      </section>
      <CatastroXDisclaimer />
    </section>
  );
}
