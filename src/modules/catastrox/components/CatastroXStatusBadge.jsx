import { AlertTriangle, CheckCircle2, MapPinned } from 'lucide-react';
import { CATASTROX_STATUS } from '../data/catastroxMockData.js';

const statusConfig = {
  [CATASTROX_STATUS.IDENTIFICADO]: {
    className: 'is-success',
    icon: CheckCircle2,
    label: 'Predio identificado',
  },
  [CATASTROX_STATUS.INCONSISTENCIA]: {
    className: 'is-warning',
    icon: MapPinned,
    label: 'Zona sin individualización catastral',
  },
  [CATASTROX_STATUS.FISCAL]: {
    className: 'is-danger',
    icon: AlertTriangle,
    label: 'Predio de gran extensión',
  },
  [CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO]: {
    className: 'is-warning',
    icon: AlertTriangle,
    label: 'Zona sin individualización catastral',
  },
  [CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL]: {
    className: 'is-warning',
    icon: MapPinned,
    label: 'Requiere validación técnica',
  },
  [CATASTROX_STATUS.PENDIENTE_VALIDACION]: {
    className: 'is-warning',
    icon: MapPinned,
    label: 'Cobertura pendiente de validación',
  },
  [CATASTROX_STATUS.REVISION_ESPECIAL]: {
    className: 'is-danger',
    icon: AlertTriangle,
    label: 'Revisión especial requerida',
  },
  [CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL]: {
    className: 'is-danger',
    icon: AlertTriangle,
    label: 'Predio de gran extensión',
  },
};

export default function CatastroXStatusBadge({ status, variant = 'default' }) {
  const config = statusConfig[status] || statusConfig[CATASTROX_STATUS.IDENTIFICADO];
  const Icon = config.icon;
  const isProminent = variant === 'prominent';

  return (
    <span
      className={[
        'catastrox-status',
        config.className,
        isProminent ? 'is-prominent' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="catastrox-status-icon" aria-hidden="true">
        <Icon size={isProminent ? 25 : 18} strokeWidth={2.5} />
      </span>

      {isProminent ? <span className="catastrox-status-divider" aria-hidden="true" /> : null}

      <span className="catastrox-status-label">{config.label}</span>
    </span>
  );
}
