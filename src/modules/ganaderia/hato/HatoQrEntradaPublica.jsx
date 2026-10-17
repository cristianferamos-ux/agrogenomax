// SPRINT-3D11.3 (R1): /qr/:codigo (pública, contenido impreso en el QR).
// Nunca consulta ninguna API ni muestra datos: si el código tiene forma de
// token QR AGX, redirige al resolver privado /ganaderia/qr/:token (que
// exige sesión y resuelve bajo la organización de la sesión); cualquier
// otro código -- incluidos los legacy AGX-000001, ... -- muestra la página
// estática QrNoDisponiblePage.
import { Navigate, useParams } from 'react-router-dom';
import QrNoDisponiblePage from '../qr/QrNoDisponiblePage.jsx';
import { isQrToken, qrResolverPath } from './qrToken.js';

export default function HatoQrEntradaPublica() {
  const { codigo } = useParams();
  if (isQrToken(codigo)) return <Navigate to={qrResolverPath(codigo)} replace />;
  return <QrNoDisponiblePage />;
}
