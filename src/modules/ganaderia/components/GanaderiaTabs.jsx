import { NavLink, useLocation } from 'react-router-dom';
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

function getAnimalIdFromPath(pathname) {
  const match = pathname.match(/\/ganaderia\/animal\/([^/]+)/);
  return match?.[1] || '';
}

function buildTabs(animalId) {
  const animalBase = animalId ? `/ganaderia/animal/${animalId}` : '/ganaderia/animales';

  return [
    ['Inicio', '/ganaderia', LayoutDashboard],
    ['Registro de Predio', '/ganaderia/predios', Home],
    ['Registro de Potreros', '/ganaderia/potreros', Sprout],
    ['Registro de Animales', '/ganaderia/animales', QrCode],
    ['Escanear QR', '/ganaderia/escanear-qr', QrCode],
    ['Ficha Animal', animalBase, ClipboardList],
    ['Pesajes', animalId ? `${animalBase}/pesajes` : '/ganaderia/animales', Scale],
    ['Vacunaciones', animalId ? `${animalBase}/vacunaciones` : '/ganaderia/animales', ShieldPlus],
    ['Tratamientos', animalId ? `${animalBase}/tratamientos` : '/ganaderia/animales', ShieldPlus],
    ['Reproducción', animalId ? `${animalBase}/reproduccion` : '/ganaderia/animales', HeartPulse],
    ['Genética', animalId ? `${animalBase}/genetica` : '/ganaderia/animales', Dna],
    ['Reportes', '/ganaderia/proximamente/reportes', FileBarChart],
  ];
}

export default function GanaderiaTabs() {
  const location = useLocation();
  const animalId = getAnimalIdFromPath(location.pathname);
  const tabs = buildTabs(animalId);

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
