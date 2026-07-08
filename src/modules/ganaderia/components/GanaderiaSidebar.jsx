import {
  Beef,
  ClipboardList,
  Dna,
  FileBarChart,
  LayoutDashboard,
  MapPin,
  QrCode,
  Scale,
  Settings,
  Sprout,
  Syringe,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/ganaderia/dashboard' },
  { label: 'Animales', icon: Beef, to: '/ganaderia/animales' },
  { label: 'Predios', icon: MapPin, to: '/ganaderia/predios' },
  { label: 'Potreros', icon: Sprout, to: '/ganaderia/potreros' },
  { label: 'QR', icon: QrCode, to: '/ganaderia/escanear-qr' },
  { label: 'Pesajes', icon: Scale, to: '/ganaderia/animales' },
  { label: 'Reproducción', icon: Dna, to: '/ganaderia/animales' },
  { label: 'Sanidad', icon: Syringe, to: '/ganaderia/animales' },
  { label: 'Reportes', icon: FileBarChart, to: '/ganaderia/animales' },
  { label: 'Configuración', icon: Settings, to: '/ganaderia/proximamente/configuracion' },
];

export default function GanaderiaSidebar() {
  const location = useLocation();

  return (
    <nav className="gan-dash-sidebar" aria-label="Navegación Ganadería Inteligente">
      <div className="gan-dash-sidebar-brand">
        <ClipboardList size={20} />
        <span>Ganadería Inteligente</span>
      </div>
      <div className="gan-dash-sidebar-links">
        {navItems.map((item) => {
          const isActive = location.pathname === item.to;
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              to={item.to}
              className={`gan-dash-sidebar-link${isActive ? ' is-active' : ''}`}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
