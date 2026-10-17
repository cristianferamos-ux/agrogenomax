// SPRINT-3D11.3 (R1) -- archivos de fabricación para el proveedor de
// chapetas (solo Super Admin):
//   * CSV: codigo_lote, codigo_visible, url_qr (datos variables estándar
//     de impresión: el proveedor genera el QR desde url_qr).
//   * HTML imprimible: una celda por chapeta con "AGROGENOMAX", el código
//     visible y el QR ya renderizado (SVG, corrección de errores M);
//     "Imprimir -> Guardar como PDF" desde el navegador.
// El QR contiene <url_base>/qr/<token>; el código visible NO es el token.
import QRCode from 'qrcode';

export function qrUrl(urlBase, token) {
  return `${urlBase}/qr/${token}`;
}

function csvField(value) {
  const text = String(value ?? '');
  // Nunca empieza por = + - @ (inyección de fórmulas): los valores son
  // AGX-..., LQR-... y http(s)://... -- se entrecomillan igualmente.
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildProveedorCsv({ lote, chapetas }) {
  const lines = ['codigo_lote,codigo_visible,url_qr'];
  for (const chapeta of chapetas) {
    lines.push([lote.codigoLote, chapeta.codigoVisible, qrUrl(lote.urlBase, chapeta.token)].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function buildProveedorHtml({ lote, chapetas }) {
  const cells = [];
  for (const chapeta of chapetas) {
    const svg = await QRCode.toString(qrUrl(lote.urlBase, chapeta.token), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
    });
    cells.push(
      `<div class="chapeta"><div class="marca">AGROGENOMAX</div><div class="codigo">${escapeHtml(chapeta.codigoVisible)}</div><div class="qr">${svg}</div></div>`,
    );
  }
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Lote ${escapeHtml(lote.codigoLote)} - chapetas QR AgroGenomaX</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; margin: 12mm; color: #111; background: #fff; }
  header { margin-bottom: 8mm; }
  h1 { font-size: 16pt; margin: 0 0 2mm; }
  header p { margin: 0; font-size: 9pt; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; }
  .chapeta { border: 0.3mm solid #999; border-radius: 2mm; padding: 3mm; text-align: center; break-inside: avoid; }
  .marca { font-size: 8pt; font-weight: bold; letter-spacing: 0.5mm; }
  .codigo { font-family: "Courier New", monospace; font-size: 11pt; font-weight: bold; margin: 1mm 0 2mm; }
  .qr svg { width: 32mm; height: 32mm; }
  @media print { body { margin: 8mm; } header { margin-bottom: 4mm; } }
</style>
</head>
<body>
<header>
  <h1>Lote ${escapeHtml(lote.codigoLote)}</h1>
  <p>${chapetas.length} chapetas · QR: ${escapeHtml(lote.urlBase)}/qr/&lt;token&gt; · Documento confidencial para fabricación</p>
</header>
<main class="grid">
${cells.join('\n')}
</main>
</body>
</html>
`;
}
