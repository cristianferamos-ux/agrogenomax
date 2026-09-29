// AGX-ADMIN-001 §8/§9: shell administrativo mínimo -- layout PROPIO, nunca
// el sidebar operativo de cliente (Predios/Potreros/Animales/Pesajes/...).
// Mismo branding AgroGenomaX. SPRINT-2-CLIENT-PROVISIONING: "Crear cuenta"
// deja de ser placeholder -- navega a /ganaderia/admin/crear-cuenta. Los
// otros 3 módulos (clientes/organizaciones, activaciones pendientes,
// cuentas existentes) siguen fuera de alcance, sin lógica todavía.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, LogOut, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useGanaderiaAuth } from '../auth/GanaderiaAuthContext.jsx';
import { performGanaderiaLogout } from '../auth/ganaderiaAuthedRequest.js';
import { resolveLogoutUiAction } from '../auth/ganaderiaAuthUiModel.js';
import '../styles/ganaderia-admin.css';

const adminModules = [
  {
    label: 'Clientes / organizaciones',
    text: 'Consulta y gestión de organizaciones cliente.',
    icon: Building2,
  },
  {
    label: 'Crear cuenta',
    text: 'Provisionar una nueva cuenta cliente.',
    icon: UserPlus,
    to: '/ganaderia/admin/crear-cuenta',
  },
  {
    label: 'Activaciones pendientes',
    text: 'Cuentas creadas a la espera de activación.',
    icon: ShieldCheck,
  },
  {
    label: 'Cuentas existentes',
    text: 'Listado de cuentas ya provisionadas.',
    icon: Users,
  },
];

export default function GanaderiaAdminShell() {
  const { cuenta, endSessionLocally } = useGanaderiaAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');

  async function handleLogout() {
    if (loggingOut) return;
    setError('');
    setLoggingOut(true);
    // SPRINT-3D10.5 F3b: performGanaderiaLogout nunca lanza y sigue exigiendo
    // CSRF cuando la sesión existe. LOGGED_OUT/ALREADY_LOGGED_OUT terminan la
    // sesión LOCALMENTE (el Provider se reutiliza al navegar, no relee la
    // sesión) antes de ir al login; CSRF_REJECTED/NETWORK_ERROR/FAILED
    // permanecen autenticados con un mensaje, nunca navegan.
    const outcome = await performGanaderiaLogout();
    const action = resolveLogoutUiAction(outcome);
    if (!action.endSession) {
      setError(action.message);
      setLoggingOut(false);
      return;
    }
    endSessionLocally();
    navigate('/ganaderia/login', { replace: true });
  }

  return (
    <div className="gan-admin-shell">
      <header className="gan-admin-topbar">
        <div>
          <span className="gan-admin-eyebrow">AgroGenomaX</span>
          <h1>Administración</h1>
        </div>
        <div className="gan-admin-account">
          <span>{cuenta?.email}</span>
          <button type="button" className="gan-admin-logout" onClick={handleLogout} disabled={loggingOut}>
            <LogOut size={16} />
            {loggingOut ? 'Cerrando...' : 'Cerrar sesión'}
          </button>
        </div>
      </header>

      {error ? <p className="gan-admin-error">{error}</p> : null}

      <main className="gan-admin-main">
        <div className="gan-admin-grid">
          {adminModules.map(({ label, text, icon: Icon, to }) =>
            to ? (
              <button
                key={label}
                type="button"
                className="gan-admin-card gan-admin-card-active"
                onClick={() => navigate(to)}
              >
                <Icon size={22} />
                <strong>{label}</strong>
                <p>{text}</p>
              </button>
            ) : (
              <article key={label} className="gan-admin-card" aria-disabled="true">
                <Icon size={22} />
                <strong>{label}</strong>
                <p>{text}</p>
                <span className="gan-admin-card-badge">Próximamente</span>
              </article>
            ),
          )}
        </div>
      </main>
    </div>
  );
}
