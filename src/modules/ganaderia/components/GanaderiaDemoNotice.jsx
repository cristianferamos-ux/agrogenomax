import { FlaskConical } from 'lucide-react';

export default function GanaderiaDemoNotice({ compact = false }) {
  return (
    <div className={`gan-demo-notice${compact ? ' is-compact' : ''}`}>
      <FlaskConical size={compact ? 14 : 16} />
      <span>Modo Demo — datos de prueba. No corresponde a información real de clientes.</span>
    </div>
  );
}
