import { ArrowRight, Lock } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import CatastroXDisclaimer from '../components/CatastroXDisclaimer.jsx';
import CatastroXMockMap from '../components/CatastroXMockMap.jsx';
import CatastroXPageActions from '../components/CatastroXPageActions.jsx';
import CatastroXResultSummary from '../components/CatastroXResultSummary.jsx';
import CatastroXWhatsAppCTA from '../components/CatastroXWhatsAppCTA.jsx';
import { getCatastroXCommercialStatus } from '../config/catastroxContact.js';
import { CATASTROX_STATUS } from '../data/catastroxMockData.js';
import { resolveLookupForRoute } from '../services/catastroxApi.js';

const LOCKED_ITEMS = [
  'Área total',
  'Perímetro',
  'Código predial',
  'Código anterior',
  'Plano digital',
  'Archivos GIS',
];

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const nextValue = String(value).trim();
  return nextValue || null;
}

function isTechnicalReviewStatus(status) {
  return [
    'SIN_COBERTURA_CATASTRAL',
    'SIN_INDIVIDUALIZACION_CATASTRAL',
    'PENDIENTE_VALIDACION',
    'REVISION_ESPECIAL',
    'POSIBLE_PREDIO_FISCAL',
    CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL,
    CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO,
    CATASTROX_STATUS.PENDIENTE_VALIDACION,
    CATASTROX_STATUS.INCONSISTENCIA,
    CATASTROX_STATUS.FISCAL,
    CATASTROX_STATUS.REVISION_ESPECIAL,
    CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL,
  ].includes(status);
}

function buildSpecialCopy({ status, municipio, departamento, found }) {
  if (found && status === CATASTROX_STATUS.REVISION_ESPECIAL) {
    return {
      title: 'REVISIÓN ESPECIAL REQUERIDA',
      description:
        'Se identificó un polígono predial de gran extensión. Por su tamaño, este caso requiere revisión técnica especializada antes de emitir un diagnóstico predial, plano o recomendación jurídica.',
      tag: 'Revisión especial requerida',
      detail:
        'Por su tamaño, este caso requiere revisión técnica especializada antes de continuar con un diagnóstico predial o una entrega cartográfica.',
    };
  }

  if (status === 'SIN_COBERTURA_CATASTRAL') {
    return {
      title: 'Requiere validación técnica',
      description:
        'No se encontró información predial individualizada para esta ubicación dentro de la cobertura catastral actualmente cargada.',
      tag: 'Requiere validación técnica',
      detail:
        municipio && departamento
          ? `Municipio identificado: ${municipio} – ${departamento}. Puede existir información catastral administrada por un gestor diferente al incluido actualmente en la plataforma.`
          : 'Puede existir información catastral administrada por un gestor diferente al incluido actualmente en la plataforma.',
    };
  }

  if (status === 'PENDIENTE_VALIDACION') {
    return {
      title: 'Cobertura pendiente de validación',
      description:
        'La cobertura municipal de esta coordenada debe validarse antes de clasificar su caso y emitir un diagnóstico predial.',
      tag: 'Cobertura pendiente de validación',
      detail:
        'Antes de clasificar su caso, conviene validar el municipio y la cobertura disponible con apoyo técnico.',
    };
  }

  return {
    title: 'Zona sin individualización catastral',
    description:
      'La coordenada consultada no devolvió un predio individualizado dentro de una zona con cobertura disponible.',
    tag: getCatastroXCommercialStatus(status),
    detail:
      'Este caso requiere revisión técnica antes de emitir un diagnóstico predial. Un asesor puede validar la cobertura catastral, la ubicación y la ruta técnica más conveniente.',
  };
}

export default function CatastroXResultPage() {
  const { id } = useParams();
  const lookup = resolveLookupForRoute(id);

  console.log('lookup result', lookup);

  if (!lookup) {
    return (
      <section className="catastrox-page">
        <div className="catastrox-page-title">
          <span>Consulta no disponible</span>
          <h1>La consulta ya no está disponible en esta sesión</h1>
          <p>Vuelva a buscar su predio para cargar nuevamente el resultado real.</p>
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

  const found = lookup.found;
  const status = lookup.status || lookup.predio?.estado || 'SIN_DATO';
  const municipio = cleanText(lookup?.predio?.municipio) || cleanText(lookup?.municipio) || 'Sin dato';
  const departamento = cleanText(lookup?.predio?.departamento) || cleanText(lookup?.departamento) || 'Sin dato';
  const areaHa = Number(lookup?.predio?.areaHa);
  const isSpecialReview = found && Number.isFinite(areaHa) && areaHa >= 5000;
  const effectiveStatus = isSpecialReview ? CATASTROX_STATUS.REVISION_ESPECIAL : status;
  const predio = {
    ...lookup.predio,
    estado: isSpecialReview ? CATASTROX_STATUS.REVISION_ESPECIAL : lookup?.predio?.estado,
    municipio,
    departamento,
    queryPoint: lookup?.queryPoint || lookup?.predio?.queryPoint || null,
  };
  const routeId = predio.routeId || predio.id;
  const isTechnicalReview =
    !found || isTechnicalReviewStatus(effectiveStatus) || isTechnicalReviewStatus(predio.estado);
  const specialCopy = buildSpecialCopy({ status: effectiveStatus, municipio, departamento, found });

  return (
    <section className="catastrox-page">
      <div className="catastrox-page-title">
        <span>Resultado gratuito</span>
        <h1>{found && !isTechnicalReview ? 'Predio identificado' : specialCopy.title}</h1>
        <p>
          {found && !isTechnicalReview
            ? 'Su consulta gratuita confirma la ubicación básica del predio. Si desea conocer el número de hectáreas, el perímetro y los códigos prediales, puede desbloquear la información predial.'
            : specialCopy.description}
        </p>
      </div>
      <CatastroXPageActions
        actions={[
          { label: 'Volver a buscar', to: '/catastrox/buscar', tone: 'ghost' },
          ...(found && !isTechnicalReview ? [{ label: 'Ver planes', to: '/catastrox/planes', tone: 'secondary' }] : []),
          { label: 'Volver a CatastroX', to: '/catastrox', tone: 'ghost' },
        ]}
      />
      <div className="catastrox-two-col">
        {found && !isTechnicalReview ? (
          <section className="catastrox-page" style={{ padding: 0 }}>
            <CatastroXResultSummary predio={predio} mode="free" />
            <article className="catastrox-card">
              <div className="catastrox-section-heading">
                <span>Información bloqueada</span>
                <h2>Datos disponibles al activar un plan</h2>
              </div>
              <p className="catastrox-copy">Información disponible al activar un plan.</p>
              <div className="catastrox-summary-grid">
                {LOCKED_ITEMS.map((item) => (
                  <div key={item} className="catastrox-summary-item">
                    <span>
                      <Lock size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                      Bloqueado
                    </span>
                    <strong>{item}</strong>
                  </div>
                ))}
              </div>
            </article>
          </section>
        ) : (
          <section className="catastrox-card is-danger">
            <div className="catastrox-section-heading">
              <span>{specialCopy.tag}</span>
              <h2>{specialCopy.title}</h2>
            </div>
            <CatastroXResultSummary predio={predio} mode="free" />
            {lookup.message ? <p className="catastrox-copy">{lookup.message}</p> : null}
            <p className="catastrox-copy">{specialCopy.detail}</p>
            {predio.gestorCatastral || lookup?.gestor ? (
              <p className="catastrox-copy">
                Gestor catastral estimado para validación: <strong>{predio.gestorCatastral || lookup.gestor}</strong>.
              </p>
            ) : null}
          </section>
        )}
        <CatastroXMockMap predio={predio} />
      </div>

      {found && !isTechnicalReview ? (
        <article className="catastrox-card">
          <div className="catastrox-section-heading">
            <span>Desbloquear información</span>
            <h2>¿Desea conocer el número de hectáreas del predio?</h2>
          </div>
          <p className="catastrox-copy">
            Usted puede desbloquear el área total, el perímetro, el código predial, el código anterior y las entregas digitales disponibles para su consulta.
          </p>
          <div className="catastrox-action-row">
            <Link className="catastrox-button" to={`/catastrox/basico/${routeId}`}>
              Desbloquear información predial <ArrowRight size={18} />
            </Link>
            <Link className="catastrox-button is-secondary" to="/catastrox/planes">
              Comparar planes
            </Link>
          </div>
        </article>
      ) : (
        <CatastroXWhatsAppCTA
          lookup={lookup}
          status={effectiveStatus}
          municipio={municipio}
          departamento={departamento}
          queryPoint={predio.queryPoint}
          areaHa={predio.areaHa}
        />
      )}
      <CatastroXDisclaimer />
    </section>
  );
}
