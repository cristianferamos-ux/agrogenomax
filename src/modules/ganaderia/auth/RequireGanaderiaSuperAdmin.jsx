// AGX-ADMIN-001 §7: guard de /ganaderia/admin -- PRIVATE + INTERNAL ONLY.
// Exige sesión válida Y rolInterno==='super_admin' backend-derived (nunca
// comparación de email/nombre/username, nunca flag frontend hardcoded --
// ver §3). Mismo principio anti-flash que RequireGanaderiaAuth: nunca
// renderiza contenido admin y lo oculta después.
import { Navigate } from 'react-router-dom';
import { useGanaderiaAuth } from './GanaderiaAuthContext.jsx';
import '../styles/ganaderia-login.css';

export default function RequireGanaderiaSuperAdmin({ children }) {
  const { status, rolInterno } = useGanaderiaAuth();

  if (status === 'loading') {
    return (
      <div className="gan-auth-loading" role="status" aria-live="polite">
        <span className="gan-auth-loading-spinner" aria-hidden="true" />
        <p>Verificando tu sesión...</p>
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/ganaderia/login" replace />;
  }

  // Cualquier sesión autenticada que NO sea super_admin (cliente con o sin
  // organización, u otro rol interno como soporte/operaciones) -> redirect
  // seguro al dashboard cliente, nunca un 403 que exponga contenido admin
  // primero.
  if (rolInterno !== 'super_admin') {
    return <Navigate to="/ganaderia/dashboard" replace />;
  }

  return children;
}
