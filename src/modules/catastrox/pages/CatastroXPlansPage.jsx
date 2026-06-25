import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXPlanCard from '../components/CatastroXPlanCard.jsx';
import { getLastLookup } from '../services/catastroxApi.js';

export default function CatastroXPlansPage() {
  const lastLookup = getLastLookup();
  const activeRouteId = lastLookup?.predio?.routeId || lastLookup?.predio?.id || 'albania-demo';

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Planes CatastroX</span>
        <h1>Active el nivel de detalle que necesita para su predio</h1>
        <p>
          Después del resultado gratuito, usted puede elegir el nivel de información que mejor responda a su consulta predial.
        </p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
          { label: 'Buscar predio', to: '/catastrox/buscar', tone: 'secondary' },
        ]}
      />
      <div className="catastrox-grid">
        <CatastroXPlanCard
          title="Diagnóstico Predial"
          subtitle="PLAN BÁSICO"
          price="$36.000 IVA incluido"
          description="Conozca la información esencial del predio."
          to={`/catastrox/basico/${activeRouteId}`}
          features={[
            'Código predial',
            'Código anterior',
            'Municipio',
            'Departamento',
            'Área total en hectáreas',
            'Área total en m²',
            'Perímetro',
            'Diagnóstico predial básico',
            'Informe PDF',
          ]}
          ctaLabel="Obtener Diagnóstico Predial"
        />
        <CatastroXPlanCard
          title="Plano Predial Digital"
          subtitle="PLAN PLUS"
          price="$80.000 IVA incluido"
          description="Obtenga un plano digital detallado listo para consulta."
          to={`/catastrox/plus/${activeRouteId}`}
          tone="gold"
          features={[
            'Todo el Plan Básico',
            'Plano digital detallado',
            'Plano PDF técnico',
            'Croquis predial complementario',
            'Medidas principales',
            'Área total',
            'Perímetro',
          ]}
          ctaLabel="Obtener Plano Predial"
        />
        <CatastroXPlanCard
          title="Plano Predial + GIS"
          subtitle="PLAN PREMIUM"
          price="$120.000 IVA incluido"
          description="Lleve su predio en el celular y utilícelo en Google Earth, QGIS o AutoCAD."
          to={`/catastrox/premium/${activeRouteId}`}
          tone="red"
          features={[
            'Todo el Plan Plus',
            'Archivo SHP',
            'Archivo KML',
            'Archivo KMZ',
            'Coordenadas de vértices',
            'Linderos georreferenciados',
            'Compatibilidad Google Earth',
            'Compatibilidad QGIS',
            'Compatibilidad ArcGIS',
            'Compatibilidad AutoCAD Civil 3D',
          ]}
          ctaLabel="Obtener Plan Premium"
        />
      </div>
    </section>
  );
}
