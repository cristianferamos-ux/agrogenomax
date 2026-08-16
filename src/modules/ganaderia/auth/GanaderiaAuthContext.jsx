// AUTH-FRONT-001: fuente de verdad de sesión para el frontend de
// Ganadería -- SIEMPRE consulta el backend (GET /api/ganaderia/auth/session,
// same-origin, cookie HttpOnly) al montarse. Nunca asume autenticación por
// localStorage/sessionStorage/estado viejo del navegador -- ver requisito
// §8/§11.
//
// Contrato real auditado en server/routes/ganaderiaAuth.js (AUTH-001/
// BFF-001/AGX-ADMIN-001):
//   { authenticated: false }
//   { authenticated: true, cuenta, tipoAcceso:'interno', rolInterno:'super_admin', organizacionActiva: null, organizacionesDisponibles: [] }
//   { authenticated: true, cuenta, tipoAcceso:'cliente', rolInterno: null, organizacionActiva: null, organizacionesDisponibles }
//   { authenticated: true, cuenta, tipoAcceso:'cliente', rolInterno: null, organizacionActiva: {...}, organizacionesDisponibles }
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const GanaderiaAuthContext = createContext(null);

// Mismo relay same-origin ya usado por functions/api/ganaderia/[[path]].js
// (BFF-001, gate ya superado) -- nunca una URL absoluta de Railway.
const AUTH_BASE = '/api/ganaderia/auth';

async function fetchSession() {
  const response = await fetch(`${AUTH_BASE}/session`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!response.ok) {
    // GET /session del backend real siempre responde 200 con
    // {authenticated:false} para el caso anónimo -- un status distinto es
    // un fallo operativo, no una respuesta de sesión válida.
    throw new Error(`SESSION_CHECK_FAILED_${response.status}`);
  }
  return response.json();
}

// AUTH-FRONT-001 STAGING GATE §1: contrato real auditado en
// server/security/ganaderiaSession.js (createRequireGanaderiaCsrf) --
// toda mutación (POST/PUT/PATCH/DELETE) sobre una ruta ya autenticada
// exige la cabecera `X-CSRF-Token`, obtenida vía GET /csrf (requiere
// identidad/sesión ya válida). POST /login y POST /password/set quedan
// EXPLÍCITAMENTE fuera de este requisito (no hay sesión todavía) --
// validan origen/Content-Type en su lugar (rejectIfPreSessionRequestInvalid),
// nunca CSRF. Se pide un token fresco en cada mutación en vez de
// cachearlo -- más simple y evita servir un token obsoleto tras rotación
// de sesión (login/logout), sin ningún costo real (GET /csrf es barato).
export async function fetchCsrfToken() {
  const response = await fetch(`${AUTH_BASE}/csrf`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`CSRF_FETCH_FAILED_${response.status}`);
  }
  const payload = await response.json();
  return payload.csrfToken;
}

// AGX-ADMIN-001: una cuenta interna (staff_crh, tipoAcceso:'interno') NUNCA
// se asigna automáticamente una organización tenant -- el estado
// 'authenticated_without_org' (que renderiza OrganizacionRequerida) es
// exclusivo del flujo cliente. Un super_admin resuelve directo a
// 'authenticated'; el ruteo hacia /ganaderia/admin lo decide cada guard
// leyendo rolInterno, no un 5to status nuevo (mantiene el contrato de 4
// estados ya aprobado en AUTH-FRONT-001).
function deriveStatus(sessionPayload) {
  if (!sessionPayload?.authenticated) return 'anonymous';
  if (sessionPayload.rolInterno === 'super_admin') return 'authenticated';
  if (!sessionPayload.organizacionActiva) return 'authenticated_without_org';
  return 'authenticated';
}

export function GanaderiaAuthProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [session, setSession] = useState(null);

  // Devuelve el payload recién resuelto -- un caller inmediatamente
  // posterior (p. ej. GanaderiaLogin decidiendo a dónde navegar tras un
  // login exitoso) no puede confiar en el `rolInterno`/`status` del
  // closure capturado en el render anterior, ya que `setState` no
  // actualiza sincrónicamente esa variable ya capturada.
  const refresh = useCallback(async () => {
    setStatus('loading');
    try {
      const payload = await fetchSession();
      setSession(payload);
      setStatus(deriveStatus(payload));
      return payload;
    } catch {
      // Fallo de red/backend al consultar sesión -- nunca se asume
      // autenticado ante un error; se trata como anónimo (fail-closed).
      setSession(null);
      setStatus('anonymous');
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const payload = await fetchSession();
        if (!active) return;
        setSession(payload);
        setStatus(deriveStatus(payload));
      } catch {
        if (!active) return;
        setSession(null);
        setStatus('anonymous');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(
    () => ({
      status, // 'loading' | 'anonymous' | 'authenticated_without_org' | 'authenticated'
      cuenta: session?.cuenta ?? null,
      tipoAcceso: session?.tipoAcceso ?? null, // 'cliente' | 'interno' | null (backend-derived, ver staff_crh)
      rolInterno: session?.rolInterno ?? null, // 'super_admin' | otro rol interno | null
      organizacionActiva: session?.organizacionActiva ?? null,
      organizacionesDisponibles: session?.organizacionesDisponibles ?? [],
      refresh,
    }),
    [status, session, refresh],
  );

  return <GanaderiaAuthContext.Provider value={value}>{children}</GanaderiaAuthContext.Provider>;
}

export function useGanaderiaAuth() {
  const ctx = useContext(GanaderiaAuthContext);
  if (!ctx) {
    throw new Error('useGanaderiaAuth debe usarse dentro de <GanaderiaAuthProvider>.');
  }
  return ctx;
}
