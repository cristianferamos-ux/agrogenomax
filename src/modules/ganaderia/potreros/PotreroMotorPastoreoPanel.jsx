// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §12: decide cuál de los dos
// motores de pastoreo se muestra -- "Recomendación automática" (motor
// automático 3D7.2, PRINCIPAL, seleccionado por defecto) o "Modo técnico"
// (cálculo manual 3D7, PotreroCapacidadPastoreoPanel.jsx, SECUNDARIO --
// nunca eliminado, siempre disponible). Reemplaza el montaje directo de
// PotreroCapacidadPastoreoPanel dentro de PotreroFichaProductivaPanel.jsx.
import { useState } from 'react';
import PotreroRecomendacionPastoreoPanel from './PotreroRecomendacionPastoreoPanel.jsx';
import PotreroCapacidadPastoreoPanel from './PotreroCapacidadPastoreoPanel.jsx';

export default function PotreroMotorPastoreoPanel({ predioId, potreroId, areaHa, tieneFicha, onCrearFicha }) {
  const [modo, setModo] = useState('automatico');

  return (
    <div className="gan-motor-pastoreo-panel">
      <div className="gan-capacidad-modo-selector" role="tablist" aria-label="Motor de pastoreo">
        <button
          type="button"
          role="tab"
          aria-selected={modo === 'automatico'}
          className={`gan-secondary-button${modo === 'automatico' ? ' gan-capacidad-modo-active' : ''}`}
          onClick={() => setModo('automatico')}
        >
          Recomendación automática
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={modo === 'tecnico'}
          className={`gan-back-inline${modo === 'tecnico' ? ' gan-capacidad-modo-active' : ''}`}
          onClick={() => setModo('tecnico')}
        >
          Modo técnico
        </button>
      </div>

      {modo === 'automatico' ? (
        <PotreroRecomendacionPastoreoPanel
          predioId={predioId}
          potreroId={potreroId}
          tieneFicha={tieneFicha}
          onCrearFicha={onCrearFicha}
        />
      ) : (
        <PotreroCapacidadPastoreoPanel
          predioId={predioId}
          potreroId={potreroId}
          areaHa={areaHa}
          tieneFicha={tieneFicha}
          onCrearFicha={onCrearFicha}
        />
      )}
    </div>
  );
}
