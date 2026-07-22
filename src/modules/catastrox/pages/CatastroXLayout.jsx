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
          <span className="catastrox-brand-mark">CX</span>
          <strong className="catastrox-wordmark">
            <span>Catastro</span><span className="catastrox-wordmark-x">X</span>
          </strong>
        </Link>
      </header>
      <Outlet />
    </main>
  );
}
