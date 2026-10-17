// SPRINT-3D11.3 (R1): destino post-login para el flujo QR. Una chapeta
// escaneada sin sesión pasa por /ganaderia/login y, tras autenticarse,
// vuelve a resolverse bajo la organización de la sesión. Lista blanca
// estricta: solo el resolver /ganaderia/qr/<token | código canónico> y el
// escáner. Cualquier otro valor -- URL absoluta, //host, otra ruta -- se
// ignora (sin open redirect).
const QR_RESOLVER_PATH = /^\/ganaderia\/qr\/(?:[A-Za-z0-9_-]{32}|AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]|AGX-[0-9]{6})$/;
const QR_SCANNER_PATH = '/ganaderia/escanear-qr';

export function safeLoginReturnPath(value) {
  if (typeof value !== 'string') return null;
  if (value === QR_SCANNER_PATH || QR_RESOLVER_PATH.test(value)) return value;
  return null;
}

/** state para <Navigate to="/ganaderia/login">: solo rutas de la lista blanca. */
export function loginReturnState(pathname) {
  const from = safeLoginReturnPath(pathname);
  return from ? { from } : undefined;
}
