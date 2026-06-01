export function normalizeQrCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const decoded = decodeURIComponent(raw);
  const match = decoded.match(/AGX-\d{1,}/i);
  return match ? match[0].toUpperCase() : decoded.toUpperCase();
}
