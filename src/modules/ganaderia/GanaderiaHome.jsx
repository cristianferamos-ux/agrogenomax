import { ArrowRight, ClipboardList, Home, QrCode, ShieldPlus, Sprout } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function GanaderiaHome() {
  return (
    <div className="gan-stack">
      <div className="gan-panel gan-hero-panel">
        <div>
          <span className="gan-eyebrow">Módulo cerrado</span>
          <h2>Operación ganadera por QR desde campo.</h2>
          <p>
            Primero registra predios y potreros. Luego escanea o ingresa un QR para crear o abrir la ficha del animal.
          </p>
        </div>
        <Link to="/ganaderia/escanear-qr" className="gan-primary-action">
          Empezar con QR
          <ArrowRight className="h-5 w-5" />
        </Link>
      </div>
      <div className="gan-card-grid">
        <Link to="/ganaderia/predios" className="gan-card">
          <Home className="h-6 w-6" />
          <strong>Registro de Predio</strong>
          <span>Crear la unidad productiva base.</span>
        </Link>
        <Link to="/ganaderia/potreros" className="gan-card">
          <Sprout className="h-6 w-6" />
          <strong>Registro de Potreros</strong>
          <span>Asociar potreros a un predio.</span>
        </Link>
        <Link to="/ganaderia/animales" className="gan-card">
          <ClipboardList className="h-6 w-6" />
          <strong>Registro de Animales</strong>
          <span>Validar QR antes de registrar.</span>
        </Link>
        <Link to="/ganaderia/escanear-qr" className="gan-card">
          <QrCode className="h-6 w-6" />
          <strong>Escanear QR</strong>
          <span>Abrir cámara o ingresar código.</span>
        </Link>
        <Link to="/ganaderia/animales" className="gan-card">
          <ShieldPlus className="h-6 w-6" />
          <strong>Ficha Animal</strong>
          <span>Buscar QR para abrir la ficha.</span>
        </Link>
      </div>
    </div>
  );
}
