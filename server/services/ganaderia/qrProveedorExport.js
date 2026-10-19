// SPRINT-3D11.3 (R1) / FASE 15 -- utilidades del archivo de fabricación:
//   * qrUrl: <url_base>/qr/<token> (lo que codifica el QR; el código visible
//     NO es el token).
//   * Vista previa HTML (solo Super Admin) del FRENTE: una celda por chapeta con
//     el QR de QR_EXPORT y el código visible debajo (misma matriz que
//     el SVG maestro). NO es un archivo de fabricación: el paquete maestro es
//     qrFabricacionPaquete.js (SVG + PDF vectorial + manifest + checksums).
import { QR_EXPORT, renderQrSvg } from './qrFabricacionGeometria.js';

export function qrUrl(urlBase, token) {
  return `${urlBase}/qr/${token}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function buildProveedorHtml({ lote, chapetas }) {
  const cells = chapetas.map(
    (chapeta) =>
      `<div class="chapeta"><div class="qr">${renderQrSvg(qrUrl(lote.urlBase, chapeta.token))}</div><div class="codigo">${escapeHtml(chapeta.codigoVisible)}</div></div>`,
  );
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Lote ${escapeHtml(lote.codigoLote)} - vista previa chapetas QR AgroGenomaX</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; margin: 12mm; color: #111; background: #fff; }
  header { margin-bottom: 8mm; }
  h1 { font-size: 16pt; margin: 0 0 2mm; }
  header p { margin: 0; font-size: 9pt; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; }
  .chapeta { border: 0.3mm solid #999; border-radius: 2mm; padding: 3mm; text-align: center; break-inside: avoid; }
  .codigo { font-family: "Courier New", monospace; font-size: 11pt; font-weight: bold; margin: 2mm 0 0; }
  .qr svg { width: ${QR_EXPORT.sizeMm}mm; height: ${QR_EXPORT.sizeMm}mm; }
  @media print { body { margin: 8mm; } header { margin-bottom: 4mm; } }
</style>
</head>
<body>
<header>
  <h1>Lote ${escapeHtml(lote.codigoLote)} · vista previa</h1>
  <p>${chapetas.length} chapetas · QR ${QR_EXPORT.errorCorrectionLevel}, zona de silencio ${QR_EXPORT.margin} módulos, ${QR_EXPORT.sizeMm} mm · Documento confidencial · NO es el archivo de fabricación: usar el paquete de fabricación (SVG maestro).</p>
</header>
<main class="grid">
${cells.join('\n')}
</main>
</body>
</html>
`;
}
