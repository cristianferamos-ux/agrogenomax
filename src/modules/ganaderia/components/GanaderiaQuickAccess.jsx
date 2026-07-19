import { Beef, MapPin, QrCode, Sprout } from 'lucide-react';
import { Link } from 'react-router-dom';

const quickAccessItems = [
  { label: 'Predios', text: 'Registra el predio y los datos de su propietario.', icon: MapPin, to: '/ganaderia/predios' },
  { label: 'Potreros', text: 'Crea potreros asociados a un predio.', icon: Sprout, to: '/ganaderia/potreros' },
  { label: 'Mis animales', text: 'Busca animales registrados y abre su ficha.', icon: Beef, to: '/ganaderia/animales/listado' },
  { label: 'Escanear QR', text: 'Valida un QR físico o digital.', icon: QrCode, to: '/ganaderia/escanear-qr' },
  { label: 'Registrar animal con QR', text: 'Requiere predio y potrero registrados.', icon: QrCode, to: '/ganaderia/animales' },
];

export default function GanaderiaQuickAccess() {
  return (
    <section className="gan-dash-section">
      <h2>Accesos rápidos</h2>
      <div className="gan-dash-quick-grid">
        {quickAccessItems.map(({ label, text, icon: Icon, to }) => (
          <Link key={label} to={to} className="gan-dash-quick-card">
            <span className="gan-dash-quick-icon">
              <Icon size={20} />
            </span>
            <strong>{label}</strong>
            <p>{text}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
