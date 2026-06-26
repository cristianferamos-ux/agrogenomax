import { ArrowLeft } from 'lucide-react';
import { Link, Outlet } from 'react-router-dom';

export default function CatastroXLayout() {
  return (
    <main className="catastrox-shell">
      <header className="catastrox-header">
        <Link to="/" className="catastrox-back">
          <ArrowLeft size={18} /> Volver a AgroGenomaX
        </Link>
        <Link to="/catastrox" className="catastrox-brand">
          <span>CX</span>
          <strong className="catastrox-wordmark">
            <span>Catastro</span><span className="catastrox-wordmark-x">X</span>
          </strong>
        </Link>
        <nav>
          <Link to="/catastrox">Volver a CatastroX</Link>
          <Link to="/catastrox/buscar">Buscar predio</Link>
          <Link to="/catastrox/planes">Paquetes</Link>
          <Link to="/catastrox/regularizacion">Regularización</Link>
          <Link to="/">Volver a AgroGenomaX</Link>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
