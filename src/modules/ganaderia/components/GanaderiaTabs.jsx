import { NavLink } from 'react-router-dom';
import {
  ClipboardList,
  Dna,
  FileBarChart,
  HeartPulse,
  Home,
  LayoutDashboard,
  QrCode,
  Scale,
  ShieldPlus,
  Sprout,
} from 'lucide-react';

const tabs = [
  ['Inicio', '/ganaderia', LayoutDashboard],
  ['Registro de Predio', '/ganaderia/predios', Home],
  ['Registro de Potreros', '/ganaderia/potreros', Sprout],
  ['Registro de Animales', '/ganaderia/animales', QrCode],
  ['Escanear QR', '/ganaderia/escanear-qr', QrCode],
  ['Ficha Animal', '/ganaderia/animales', ClipboardList],
  ['Pesajes', '/ganaderia/proximamente/pesajes', Scale],
  ['Sanidad', '/ganaderia/proximamente/sanidad', ShieldPlus],
  ['Reproducción', '/ganaderia/proximamente/reproduccion', HeartPulse],
  ['Genética', '/ganaderia/proximamente/genetica', Dna],
  ['Reportes', '/ganaderia/proximamente/reportes', FileBarChart],
];

export default function GanaderiaTabs() {
  return (
    <nav className="gan-tabs" aria-label="Módulos de ganadería">
      {tabs.map(([label, to, Icon]) => (
        <NavLink key={label} to={to} end={to === '/ganaderia'}>
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
