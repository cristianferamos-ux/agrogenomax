import { Check, ShieldCheck } from 'lucide-react';

export default function GanaderiaPlanCard({ plan, onComprar }) {
  return (
    <article className={`gan-plan-card${plan.destacado ? ' is-featured' : ''}`}>
      {plan.badge ? <span className="gan-plan-badge">{plan.badge}</span> : null}
      <h3>{plan.nombre}</h3>
      <span className="gan-plan-range">{plan.rango}</span>

      <div className="gan-plan-pricing">
        <div>
          <span>Activación</span>
          <strong>{plan.activacion}</strong>
        </div>
        <div>
          <span>Mensualidad</span>
          <strong>{plan.mensualidad}</strong>
        </div>
      </div>

      <span className="gan-plan-chapetas">{plan.chapetas} chapetas físicas con código QR incluidas</span>

      <ul className="gan-plan-benefits">
        {plan.beneficios.map((item) => (
          <li key={item}>
            <Check size={14} strokeWidth={3} />
            {item}
          </li>
        ))}
      </ul>

      <button type="button" className="gan-plan-buy-btn" onClick={() => onComprar(plan)}>
        Solicitar activación
      </button>
      <span className="gan-plan-wompi-note">
        <ShieldCheck size={13} /> Activación acompañada
      </span>
    </article>
  );
}
