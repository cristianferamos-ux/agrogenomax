import { ArrowLeft, Database, Wifi } from 'lucide-react';
import { Link } from 'react-router-dom';
import { isCloudflareWithoutLocalApi } from '../api/ganaderiaApi.js';
import GanaderiaTabs from './GanaderiaTabs.jsx';

export default function GanaderiaShell({ children }) {
  return (
    <main className="gan-page">
      <header className="gan-header">
        <div>
          <Link to="/" className="gan-back">
            <ArrowLeft className="h-4 w-4" />
            Volver al Home
          </Link>
          <h1>AgroGenomaX Ganadería Inteligente</h1>
          <p>Registro bovino por QR, predios, potreros y ficha animal conectada a PostgreSQL.</p>
        </div>
        <div className="gan-health-pill">
          <Database className="h-4 w-4" />
          PostgreSQL local
          <Wifi className="h-4 w-4" />
        </div>
      </header>
      {isCloudflareWithoutLocalApi() ? (
        <div className="gan-demo-banner">
          Modo demostración: la interfaz está disponible, pero la base de datos local no está conectada desde Internet.
        </div>
      ) : null}
      <div className="gan-layout">
        <GanaderiaTabs />
        <section className="gan-content">{children}</section>
      </div>
    </main>
  );
}
