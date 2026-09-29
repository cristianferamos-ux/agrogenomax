import {
  Beef,
  ClipboardList,
  Dna,
  FileBarChart,
  HeartPulse,
  Home,
  LayoutDashboard,
  LogOut,
  MapPin,
  QrCode,
  Scale,
  ShieldPlus,
  Sprout,
  Stethoscope,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useGanaderiaAuthOptional } from '../auth/GanaderiaAuthContext.jsx';
import { performGanaderiaLogout } from '../auth/ganaderiaAuthedRequest.js';
import { resolveLogoutUiAction } from '../auth/ganaderiaAuthUiModel.js';

// UX-SESSION-FIX-001: labels de rol -- solo presentación, no cambia los
// valores reales del backend (agx.membresias.rol). Sin mapping centralizado
// existente en el repo todavía, se define aquí de forma mínima.
const ROL_LABELS = {
  owner: 'Propietario',
  admin: 'Administrador',
  operador: 'Operador',
  lector: 'Lector',
};

function rolLabel(rol) {
  return ROL_LABELS[rol] ?? rol ?? '';
}

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
  const navigate = useNavigate();
  // useGanaderiaAuthOptional (nunca lanza): este sidebar se monta también en
  // /qr/:codigo vía GanaderiaShell, la única ruta de GanaderiaApp fuera de
  // <GanaderiaAuthProvider> -- ahí `auth` es null y el bloque de
  // identidad/logout simplemente no se renderiza.
  const auth = useGanaderiaAuthOptional();
  const cuenta = auth?.cuenta ?? null;
  const organizacionActiva = auth?.organizacionActiva ?? null;
  const endSessionLocally = auth?.endSessionLocally;
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  // UX-SESSION-FIX-001: mismo patrón exacto que GanaderiaAdminShell.jsx
  // (handleLogout) -- reutiliza el logout ya existente, no crea un segundo
  // sistema. La cookie es HttpOnly: solo el backend puede limpiarla (nunca
  // document.cookie desde este componente).
  async function handleLogout() {
    if (loggingOut) return;
    setLogoutError('');
    setLoggingOut(true);
    // SPRINT-3D10.5 F3b: performGanaderiaLogout nunca lanza y sigue exigiendo
    // CSRF cuando la sesión existe. LOGGED_OUT/ALREADY_LOGGED_OUT terminan la
    // sesión LOCALMENTE (el Provider se reutiliza al navegar, no relee la
    // sesión) antes de ir al login; CSRF_REJECTED/NETWORK_ERROR/FAILED
    // permanecen autenticados con un mensaje, nunca navegan.
    const outcome = await performGanaderiaLogout();
    const action = resolveLogoutUiAction(outcome);
    if (!action.endSession) {
      setLogoutError(action.message);
      setLoggingOut(false);
      return;
    }
    endSessionLocally();
    navigate('/ganaderia/login', { replace: true });
  }

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

      {auth ? (
        <div className="gan-dash-sidebar-account">
          <div className="gan-dash-sidebar-account-identity">
            <strong>{cuenta?.nombre ?? cuenta?.email}</strong>
            {organizacionActiva?.rol ? <span className="gan-dash-sidebar-account-role">{rolLabel(organizacionActiva.rol)}</span> : null}
            {organizacionActiva?.nombre ? <span className="gan-dash-sidebar-account-org">{organizacionActiva.nombre}</span> : null}
          </div>
          {logoutError ? <p className="gan-dash-sidebar-account-error">{logoutError}</p> : null}
          <button type="button" className="gan-dash-sidebar-logout" onClick={handleLogout} disabled={loggingOut}>
            <LogOut size={16} />
            {loggingOut ? 'Cerrando sesión...' : 'Cerrar sesión'}
          </button>
        </div>
      ) : null}
    </nav>
  );
}
