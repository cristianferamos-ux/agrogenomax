// FASE 1C.2: botón "Descargar reporte productivo" de la pestaña Pesajes. El
// PDF lo genera el SERVIDOR (GET /api/ganaderia/animales/:id/
// reporte-productivo.pdf, pdfkit); el navegador solo guarda el archivo
// recibido. Mientras descarga solo se deshabilita este botón (no bloquea el
// resto de la ficha); un segundo clic no lanza otra descarga.
import { useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { descargarReporteProductivo } from './hatoApi.js';
import {
  AVISO_REPORTE_SIN_CONEXION,
  TEXTO_BOTON_REPORTE,
  TEXTO_BOTON_REPORTE_CARGANDO,
  mensajeErrorReporte,
} from './reporteProductivoModel.js';

function guardarArchivo(blob, filename) {
  const href = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = href;
  enlace.download = filename;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export default function HatoReporteProductivoBoton({ animalId, online = true }) {
  const [descargando, setDescargando] = useState(false);
  const [error, setError] = useState(null);
  const enCursoRef = useRef(false);

  async function descargar() {
    if (enCursoRef.current) return;
    enCursoRef.current = true;
    setDescargando(true);
    setError(null);
    try {
      const resultado = await descargarReporteProductivo(animalId);
      if (resultado.ok) guardarArchivo(resultado.blob, resultado.filename);
      else setError(mensajeErrorReporte(resultado));
    } catch {
      setError(mensajeErrorReporte(null));
    } finally {
      enCursoRef.current = false;
      setDescargando(false);
    }
  }

  return (
    <div className="gan-pesajes-reporte">
      <button
        type="button"
        className="gan-secondary-button"
        onClick={descargar}
        disabled={descargando || !online}
        aria-busy={descargando ? 'true' : undefined}
        aria-describedby={!online ? 'pesajes-reporte-aviso' : undefined}
      >
        {descargando ? TEXTO_BOTON_REPORTE_CARGANDO : TEXTO_BOTON_REPORTE}
      </button>
      {!online ? <p id="pesajes-reporte-aviso" className="gan-hato-hint">{AVISO_REPORTE_SIN_CONEXION}</p> : null}
      <div aria-live="polite">{error ? <StatusMessage type="error">{error}</StatusMessage> : null}</div>
    </div>
  );
}
