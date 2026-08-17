// AGX-ADMIN-001 §8/§9: shell administrativo mínimo -- layout PROPIO, nunca
// el sidebar operativo de cliente (Predios/Potreros/Animales/Pesajes/...).
// Mismo branding AgroGenomaX. SPRINT-2-CLIENT-PROVISIONING: "Crear cuenta"
// deja de ser placeholder -- navega a /ganaderia/admin/crear-cuenta. Los
// otros 3 módulos (clientes/organizaciones, activaciones pendientes,
// cuentas existentes) siguen fuera de alcance, sin lógica todavía.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, LogOut, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { fetchCsrfToken, useGanaderiaAuth } from '../auth/GanaderiaAuthContext.jsx';
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
  const { cuenta, refresh } = useGanaderiaAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');

  async function handleLogout() {
    if (loggingOut) return;
    setError('');
    setLoggingOut(true);
    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch('/api/ganaderia/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!response.ok) {
        setError('No fue posible cerrar la sesión. Intenta nuevamente.');
        setLoggingOut(false);
        return;
      }
      await refresh();
      navigate('/ganaderia/login', { replace: true });
    } catch {
      setError('No fue posible conectar con el servicio. Intenta nuevamente.');
      setLoggingOut(false);
    }
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
