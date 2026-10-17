// SPRINT-3D11.3 (R1): /qr/:codigo (pública, contenido impreso en la
// chapeta). Nunca consulta ninguna API ni muestra datos: si el valor es un
// token QR AGX o un código de chapeta (nuevo o legacy AGX-000003), redirige
// al resolver privado /ganaderia/qr/:valor, que exige sesión y resuelve
// bajo la organización de la sesión. Cualquier otro valor muestra la
// página estática QrNoDisponiblePage.
import { Navigate, useParams } from 'react-router-dom';
import QrNoDisponiblePage from '../qr/QrNoDisponiblePage.jsx';
import { parseQrContent, qrResolverPath } from './qrToken.js';

export default function HatoQrEntradaPublica() {
  const { codigo } = useParams();
  const parsed = parseQrContent(codigo);
  if (parsed.kind !== 'invalid') return <Navigate to={qrResolverPath(parsed)} replace />;
  return <QrNoDisponiblePage />;
}
