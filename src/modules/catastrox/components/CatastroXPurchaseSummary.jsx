import { useState } from 'react';
import { maskDocumentNumber, maskEmail } from '../utils/piiMasking.js';

/**
 * Resumen previo a la compra (Bloque 10 del pedido) -- último paso antes de
 * abrir Wompi. Documento y correo se muestran SIEMPRE enmascarados aquí; el
 * checkbox de confirmación es obligatorio para continuar.
 */
export default function CatastroXPurchaseSummary({
  buyerInput,
  packageLabel,
  packagePriceLabel,
  predioLabel,
  onConfirm,
  onCancel,
  isSubmitting = false,
  errorMessage = null,
}) {
  const [confirmed, setConfirmed] = useState(false);

  const billingName =
    buyerInput?.customerType === 'natural'
      ? `${buyerInput?.firstName || ''} ${buyerInput?.lastName || ''}`.trim()
      : buyerInput?.legalName || '';

  return (
    <section className="catastrox-card catastrox-form">
      <div className="catastrox-section-heading">
        <span>Confirmar compra</span>
        <h2>Revise los datos antes de continuar a Wompi</h2>
      </div>

      <div className="catastrox-summary-grid is-full">
        <div>
          <span>Comprador</span>
          <strong>{billingName || '—'}</strong>
        </div>
        <div>
          <span>Documento</span>
          <strong>{maskDocumentNumber(buyerInput?.documentNumber)}</strong>
        </div>
        <div>
          <span>Correo</span>
          <strong>{maskEmail(buyerInput?.email)}</strong>
        </div>
        <div>
          <span>Paquete</span>
          <strong>{packageLabel}</strong>
        </div>
        <div>
          <span>Predio</span>
          <strong>{predioLabel || '—'}</strong>
        </div>
        <div>
          <span>Valor</span>
          <strong>{packagePriceLabel}</strong>
        </div>
      </div>

      <p className="catastrox-copy is-full">
        Estos datos serán utilizados para la entrega de los archivos y para el proceso de facturación electrónica.
      </p>

      <label className="catastrox-checkbox-row is-full">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>Confirmo que los datos de correo y facturación son correctos.</span>
      </label>

      {errorMessage ? (
        <div className="catastrox-inline-panel is-full">
          <strong>No fue posible completar la compra</strong>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="catastrox-action-row is-full">
        {/* El handler (onConfirm) vuelve a verificar `confirmed` por su
            cuenta -- el atributo disabled es defensa de UX, no la única
            barrera (Bloque 4, revisión de seguridad). */}
        <button
          type="button"
          className="catastrox-button"
          onClick={() => {
            if (!confirmed || isSubmitting) return;
            onConfirm();
          }}
          disabled={!confirmed || isSubmitting}
        >
          {isSubmitting ? 'Procesando...' : errorMessage ? 'Reintentar compra' : 'Confirmar compra'}
        </button>
        <button type="button" className="catastrox-button is-ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancelar
        </button>
      </div>
    </section>
  );
}
