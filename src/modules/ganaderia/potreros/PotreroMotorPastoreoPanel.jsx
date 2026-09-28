// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §12 / SPRINT-3D10.4 FASE 4:
// decide cuál de los dos motores de pastoreo se muestra -- "Recomendación
// automática" (PRINCIPAL, seleccionado por defecto) o "Modo técnico"
// (cálculo manual 3D7, PotreroCapacidadPastoreoPanel.jsx, SECUNDARIO --
// nunca eliminado, siempre disponible).
//
// FASE 4: dentro de "Recomendación automática", el motor automático de
// carga (3D10.4 Fase 3, PotreroPlanPastoreoSmart.jsx) reemplaza como
// experiencia PRINCIPAL al flujo manual anterior (PotreroRecomendacionPastoreoPanel.jsx,
// que exigía numeroAnimales como input) -- ese flujo NO se elimina ni se
// deprecia, sigue 100% operativo, pero queda detrás de "Opciones
// avanzadas" para no competir visualmente (§31 del sprint). Ambos árboles
// (smart vs manual) son MUTUAMENTE EXCLUYENTES -- nunca se montan a la
// vez, para no duplicar los paneles anidados de descanso/ciclo real que
// cada uno ya trae consigo.
import { useState } from 'react';
import PotreroPlanPastoreoSmart from './PotreroPlanPastoreoSmart.jsx';
import PotreroRecomendacionPastoreoPanel from './PotreroRecomendacionPastoreoPanel.jsx';
import PotreroCapacidadPastoreoPanel from './PotreroCapacidadPastoreoPanel.jsx';

export default function PotreroMotorPastoreoPanel({ predioId, potreroId, areaHa, tieneFicha, onCrearFicha }) {
  const [modo, setModo] = useState('automatico');
  const [opcionesAvanzadas, setOpcionesAvanzadas] = useState(false);

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
        <>
          {!opcionesAvanzadas ? (
            <PotreroPlanPastoreoSmart
              predioId={predioId}
              potreroId={potreroId}
              tieneFicha={tieneFicha}
              onCrearFicha={onCrearFicha}
            />
          ) : (
            <PotreroRecomendacionPastoreoPanel
              predioId={predioId}
              potreroId={potreroId}
              tieneFicha={tieneFicha}
              onCrearFicha={onCrearFicha}
            />
          )}
          <div className="gan-potrero-actions">
            <button type="button" className="gan-back-inline" onClick={() => setOpcionesAvanzadas((v) => !v)}>
              {opcionesAvanzadas ? 'Volver a recomendación automática' : 'Opciones avanzadas'}
            </button>
          </div>
        </>
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
