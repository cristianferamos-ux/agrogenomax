import { useState } from 'react';
import { Link } from 'react-router-dom';
import GanaderiaPlanCard from '../components/GanaderiaPlanCard.jsx';
import GanaderiaDeliveryInfo from '../components/GanaderiaDeliveryInfo.jsx';
import GanaderiaPricingRules, { GanaderiaCommercialConditions } from '../components/GanaderiaPricingRules.jsx';
import { ganaderiaPlans } from '../data/ganaderiaPlans.js';
import '../styles/ganaderia-access.css';

// Flujo comercial preparado para integracion futura de pagos, sin acoplar este modulo a otros productos.
function handleComprarPlan(plan) {
  const subject = encodeURIComponent(`Quiero contratar ${plan.nombre}`);
  const body = encodeURIComponent(
    `Hola, quiero contratar ${plan.nombre} (${plan.rango}).\nActivación: ${plan.activacion}\nMensualidad: ${plan.mensualidad}`,
  );
  window.location.href = `mailto:contacto@agrogenomax.com?subject=${subject}&body=${body}`;
}

export default function GanaderiaPlans() {
  const [selectedPlan, setSelectedPlan] = useState(null);

  const handleClick = (plan) => {
    setSelectedPlan(plan.id);
    handleComprarPlan(plan);
  };

  return (
    <div className="gan-access-shell">
      <header className="gan-access-header">
        <Link to="/ganaderia/acceso" className="gan-access-back">
          ← Volver a Ganadería Inteligente
        </Link>
        <span className="gan-access-badge">Planes y precios</span>
        <h1>Elige el plan para tu hato</h1>
        <p>Todos los planes incluyen plataforma, nube, chapetas QR y capacitación.</p>
      </header>

      <div className="gan-plans-grid">
        {ganaderiaPlans.map((plan) => (
          <GanaderiaPlanCard key={plan.id} plan={plan} onComprar={handleClick} />
        ))}
      </div>

      {selectedPlan ? (
        <p className="gan-plan-selected-note">
          Abrimos tu correo con la solicitud del plan seleccionado. Si no se abrió automáticamente, escríbenos a{' '}
          <a href="mailto:contacto@agrogenomax.com">contacto@agrogenomax.com</a>.
        </p>
      ) : null}

      <section className="gan-access-section">
        <GanaderiaPricingRules />
      </section>

      <section className="gan-access-section">
        <GanaderiaDeliveryInfo />
      </section>

      <section className="gan-access-section">
        <GanaderiaCommercialConditions />
      </section>
    </div>
  );
}
