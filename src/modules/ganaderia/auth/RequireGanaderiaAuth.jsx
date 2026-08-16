// AUTH-FRONT-001 §9: guard de rutas privadas. Mientras la sesión está en
// resolución muestra un loading -- NUNCA renderiza contenido privado
// primero y redirige después (evita el flash de contenido privado, §9).
import { Navigate } from 'react-router-dom';
import { useGanaderiaAuth } from './GanaderiaAuthContext.jsx';
import OrganizacionRequerida from './OrganizacionRequerida.jsx';
import '../styles/ganaderia-login.css';

export default function RequireGanaderiaAuth({ children }) {
  const { status, rolInterno } = useGanaderiaAuth();

  // Orden de las ramas: loading primero -- ninguna rama posterior puede
  // ejecutarse antes de que esta retorne, así que el contenido privado
  // (última rama) nunca se evalúa mientras la sesión sigue sin resolver.
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

  if (status === 'authenticated_without_org') {
    return <OrganizacionRequerida />;
  }

  // AGX-ADMIN-001 §6/§10: un super_admin nunca se trata como tenant
  // cliente -- cualquier ruta cliente protegida por este guard (dashboard,
  // predios, potreros, etc.) lo redirige a su propio shell administrativo.
  if (rolInterno === 'super_admin') {
    return <Navigate to="/ganaderia/admin" replace />;
  }

  return children;
}
