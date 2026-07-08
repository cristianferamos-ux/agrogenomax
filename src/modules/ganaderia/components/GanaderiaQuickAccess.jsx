import { Beef, Dna, FileBarChart, MapPin, QrCode, Scale, Sprout, Syringe } from 'lucide-react';
import { Link } from 'react-router-dom';

const quickAccessItems = [
  { label: 'Animales', text: 'Inventario y fichas del hato.', icon: Beef, to: '/ganaderia/animales' },
  { label: 'Predios', text: 'Unidades productivas registradas.', icon: MapPin, to: '/ganaderia/predios' },
  { label: 'Potreros', text: 'Distribución y carga animal.', icon: Sprout, to: '/ganaderia/potreros' },
  { label: 'QR', text: 'Escanear o generar códigos QR.', icon: QrCode, to: '/ganaderia/escanear-qr' },
  { label: 'Pesajes', text: 'Seleccione un animal para abrir este módulo.', icon: Scale, to: '/ganaderia/animales' },
  { label: 'Reproducción', text: 'Seleccione un animal para abrir este módulo.', icon: Dna, to: '/ganaderia/animales' },
  { label: 'Sanidad', text: 'Seleccione un animal para abrir este módulo.', icon: Syringe, to: '/ganaderia/animales' },
  { label: 'Reportes', text: 'Seleccione un animal para abrir este módulo.', icon: FileBarChart, to: '/ganaderia/animales' },
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
