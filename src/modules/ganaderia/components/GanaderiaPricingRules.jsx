import { GraduationCap, PawPrint, QrCode } from 'lucide-react';
import {
  animalesAdicionalesTexto,
  capacitacionCondicionesTexto,
  capacitacionEspecializadaTexto,
  chapetaAdicionalCosto,
  chapetaPersonalizacionCosto,
  chapetaPersonalizadaTotal,
  chapetasAdicionalesTexto,
  condicionesComercialesGenerales,
} from '../data/ganaderiaPlans.js';

export default function GanaderiaPricingRules() {
  return (
    <div className="gan-rules-grid">
      <article className="gan-rules-card">
        <span className="gan-rules-icon">
          <GraduationCap size={20} />
        </span>
        <h3>Capacitación</h3>
        <p>Todos los planes incluyen videos de capacitación, material básico de uso de la plataforma y guía inicial de navegación.</p>
        <p className="gan-rules-highlight">Capacitación especializada presencial (Hato Empresarial y Hato Élite)</p>
        <p>{capacitacionEspecializadaTexto}</p>
        <p className="gan-rules-note">{capacitacionCondicionesTexto}</p>
      </article>

      <article className="gan-rules-card">
        <span className="gan-rules-icon">
          <PawPrint size={20} />
        </span>
        <h3>Animales adicionales</h3>
        <p>{animalesAdicionalesTexto}</p>
        <ul>
          <li>Hato Inicial, Hato Productivo y Hato Empresarial: $2.000 mensuales por animal adicional.</li>
          <li>Hato Élite: $1.000 mensual por animal adicional.</li>
          <li>El valor de animales adicionales se suma a la mensualidad base contratada.</li>
        </ul>
      </article>

      <article className="gan-rules-card">
        <span className="gan-rules-icon">
          <QrCode size={20} />
        </span>
        <h3>Chapetas QR adicionales y personalizadas</h3>
        <p>{chapetasAdicionalesTexto}</p>
        <ul>
          <li>Chapeta adicional: {chapetaAdicionalCosto}.</li>
          <li>Personalización (logo, nombre del predio o distintivo): {chapetaPersonalizacionCosto}.</li>
          <li>Chapeta adicional personalizada: {chapetaPersonalizadaTotal}.</li>
        </ul>
      </article>
    </div>
  );
}

export function GanaderiaCommercialConditions() {
  return (
    <div className="gan-conditions">
      <h3>Condiciones comerciales generales</h3>
      <ul>
        {condicionesComercialesGenerales.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
