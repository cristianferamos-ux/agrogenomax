import { Link } from 'react-router-dom';
import '../styles/ganaderia-login.css';

// SPRINT-3D11.SECURITY-LEGACY: /qr/:codigo es pública y antes resolvía el
// código contra GET /api/qr/:codigo legacy (ya desmontado). Esta página es
// estática a propósito: no lee el código de la URL, no hace ninguna
// consulta y no muestra datos de QR ni de animales. La identidad QR AGX
// segura llega en 3D11.3.
export default function QrNoDisponiblePage() {
  return (
    <div className="gan-login-shell">
      <div className="gan-login-card">
        <h1 className="gan-login-title">Código QR no disponible</h1>
        <p className="gan-login-subtitle">
          Este código QR ya no está disponible. Si eres productor de AgroGenomaX, inicia sesión para consultar tus animales.
        </p>
        <div className="gan-login-links">
          <Link to="/ganaderia/login">Iniciar sesión</Link>
          <Link to="/">Ir al inicio</Link>
        </div>
      </div>
    </div>
  );
}
