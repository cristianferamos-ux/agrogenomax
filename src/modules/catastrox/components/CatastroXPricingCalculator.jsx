import { useMemo, useState } from 'react';
import { calculateRegularizationCost } from '../services/catastroxMockService.js';
import { formatCurrency, formatNumber } from '../utils/catastroxCalculations.js';

export default function CatastroXPricingCalculator() {
  const [areaHa, setAreaHa] = useState('20');
  const result = useMemo(() => calculateRegularizationCost(areaHa), [areaHa]);

  return (
    <section className="catastrox-card">
      <div className="catastrox-section-heading">
        <span>Calculadora CRH</span>
        <h2>Costo estimado de regularización</h2>
      </div>
      <label className="catastrox-field">
        <span>Área estimada en hectáreas</span>
        <input value={areaHa} onChange={(event) => setAreaHa(event.target.value)} type="number" min="0" step="0.1" />
      </label>
      <div className="catastrox-summary-grid">
        <div>
          <span>Subtotal</span>
          <strong>{formatCurrency(result.subtotal)}</strong>
        </div>
        <div>
          <span>IVA 19%</span>
          <strong>{formatCurrency(result.iva)}</strong>
        </div>
        <div>
          <span>Total estimado</span>
          <strong>{formatCurrency(result.total)}</strong>
        </div>
      </div>
      <article className="catastrox-inline-panel">
        <strong>Fórmula aplicada</strong>
        <p className="catastrox-copy">
          Para {formatNumber(result.area)} ha, la calculadora aplica estas reglas: hasta 20 ha la base es
          $3.000.000; de 20 a 100 ha suma $50.000 por hectárea adicional; y por encima de 100 ha parte
          de $7.000.000 y agrega $30.000 por hectárea adicional.
        </p>
        <p className="catastrox-copy">{result.formula}</p>
        <p className="catastrox-note">Valor informativo. No constituye cotización definitiva.</p>
      </article>
    </section>
  );
}
