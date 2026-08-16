// AUTH-FRONT-001 §10: la sesión backend puede estar autenticada pero sin
// organizacionActiva (identidad válida, sin tenant fijado todavía).
// Auditado: el backend (server/routes/ganaderiaAuth.js) NO auto-selecciona
// una organización aunque la cuenta tenga una sola membresía activa --
// SIEMPRE requiere POST /api/ganaderia/auth/organizacion explícito. No se
// inventa aquí una UI compleja (multi-paso, búsqueda, etc.) -- solo la
// lista mínima ya devuelta por GET /session (organizacionesDisponibles),
// cada una con una acción para fijarla.
import { useState } from 'react';
import { fetchCsrfToken, useGanaderiaAuth } from './GanaderiaAuthContext.jsx';

export default function OrganizacionRequerida() {
  const { organizacionesDisponibles, refresh } = useGanaderiaAuth();
  const [selectingId, setSelectingId] = useState(null);
  const [error, setError] = useState('');

  async function seleccionarOrganizacion(organizacionId) {
    setSelectingId(organizacionId);
    setError('');
    try {
      // POST /organizacion exige X-CSRF-Token (requireCsrf, contrato real
      // auditado en server/security/ganaderiaSession.js) -- token fresco
      // en cada intento, nunca cacheado.
      const csrfToken = await fetchCsrfToken();
      const response = await fetch('/api/ganaderia/auth/organizacion', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ organizacionId }),
      });
      if (!response.ok) {
        setError('No fue posible seleccionar esa organización. Intenta nuevamente.');
        setSelectingId(null);
        return;
      }
      await refresh();
    } catch {
      setError('No fue posible conectar con el servicio. Intenta nuevamente.');
      setSelectingId(null);
    }
  }

  return (
    <div className="gan-org-required">
      <h1>Selecciona una organización</h1>
      <p>Tu cuenta no tiene una organización activa en esta sesión.</p>
      {organizacionesDisponibles.length === 0 ? (
        <p className="gan-org-required-empty">
          Tu cuenta no tiene ninguna organización asignada todavía. Contacta a AgroGenomaX para activarla.
        </p>
      ) : (
        <ul className="gan-org-required-list">
          {organizacionesDisponibles.map((org) => (
            <li key={org.organizacionId}>
              <button
                type="button"
                onClick={() => seleccionarOrganizacion(org.organizacionId)}
                disabled={selectingId === org.organizacionId}
              >
                {org.nombre ?? org.organizacionId}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="gan-org-required-error">{error}</p> : null}
    </div>
  );
}
