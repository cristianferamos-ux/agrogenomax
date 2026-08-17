// AUTH-FRONT-001 §10: la sesión backend puede estar autenticada pero sin
// organizacionActiva (identidad válida, sin tenant fijado todavía).
// Auditado: el backend (server/routes/ganaderiaAuth.js) NO auto-selecciona
// una organización aunque la cuenta tenga una sola membresía activa --
// SIEMPRE requiere POST /api/ganaderia/auth/organizacion explícito. No se
// inventa aquí una UI compleja (multi-paso, búsqueda, etc.) -- solo la
// lista mínima ya devuelta por GET /session (organizacionesDisponibles),
// cada una con una acción para fijarla.
//
// UX-TENANT-AUTOSELECT-001: con exactamente 1 organización disponible, este
// componente dispara automáticamente esa misma acción (seleccionarOrganizacion)
// una sola vez al montar -- reutiliza el mismo POST /organizacion, el mismo
// CSRF y el mismo refresh() del flujo manual, sin backend nuevo. Con 0 o 2+
// organizaciones el comportamiento no cambia.
import { useEffect, useRef, useState } from 'react';
import { fetchCsrfToken, useGanaderiaAuth } from './GanaderiaAuthContext.jsx';

export default function OrganizacionRequerida() {
  const { organizacionesDisponibles, refresh } = useGanaderiaAuth();
  const [selectingId, setSelectingId] = useState(null);
  const [error, setError] = useState('');
  // Guarda contra loop: el auto-select solo puede dispararse UNA vez por
  // montaje, sin importar cuántas veces se re-renderice el componente
  // mientras tanto (p. ej. por el propio setSelectingId/setError del intento
  // en curso). Si falla, cae al selector manual de abajo -- nunca reintenta
  // solo.
  const autoSelectAttemptedRef = useRef(false);

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

  const isSingleOrg = organizacionesDisponibles.length === 1;

  useEffect(() => {
    if (!isSingleOrg) return;
    if (autoSelectAttemptedRef.current) return;
    autoSelectAttemptedRef.current = true;
    seleccionarOrganizacion(organizacionesDisponibles[0].organizacionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleOrg]);

  // Mientras dura el único intento de auto-selección, se oculta el selector
  // (que con 1 sola opción se vería como un parpadeo de UI innecesario) --
  // si falla, `error` queda fijado y este bloque deja de renderizarse,
  // cayendo al selector manual normal (con el mismo error visible ahí).
  if (isSingleOrg && !error) {
    return (
      <div className="gan-org-required">
        <p className="gan-org-required-autoselecting" role="status" aria-live="polite">
          Preparando tu cuenta...
        </p>
      </div>
    );
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
