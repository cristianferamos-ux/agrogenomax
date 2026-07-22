import {
  Beef,
  ClipboardList,
  Dna,
  FileBarChart,
  HeartPulse,
  Home,
  LayoutDashboard,
  MapPin,
  QrCode,
  Scale,
  ShieldPlus,
  Sprout,
  Stethoscope,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

const navItems = [
  { label: 'Home comercial', icon: Home, to: '/' },
  { label: 'Inicio', icon: LayoutDashboard, to: '/ganaderia/dashboard' },
  { label: 'Registro de Predio', icon: MapPin, to: '/ganaderia/predios' },
  { label: 'Registro de Potreros', icon: Sprout, to: '/ganaderia/potreros' },
  { label: 'Mis animales', icon: Beef, to: '/ganaderia/animales/listado' },
  { label: 'Registro de Animales', icon: ClipboardList, to: '/ganaderia/animales' },
  { label: 'Escanear QR', icon: QrCode, to: '/ganaderia/escanear-qr' },
  { label: 'Ficha Animal', icon: ShieldPlus, to: '/ganaderia/animales/listado?modulo=ficha' },
  { label: 'Pesajes', icon: Scale, to: '/ganaderia/animales/listado?modulo=pesajes' },
  { label: 'Vacunaciones', icon: HeartPulse, to: '/ganaderia/animales/listado?modulo=vacunaciones' },
  { label: 'Tratamientos', icon: Stethoscope, to: '/ganaderia/animales/listado?modulo=tratamientos' },
  { label: 'Reproducción', icon: Sprout, to: '/ganaderia/animales/listado?modulo=reproduccion' },
  { label: 'Genética', icon: Dna, to: '/ganaderia/animales/listado?modulo=genetica' },
  { label: 'Reportes', icon: FileBarChart, to: '/ganaderia/proximamente/reportes' },
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
          const itemPath = item.to.split('?')[0];
          const isActive = location.pathname === itemPath && (!item.to.includes('?') || location.search === `?${item.to.split('?')[1]}`);
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
