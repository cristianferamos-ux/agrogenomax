export function normalizeDateValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export function formatDateDisplay(value, fallback = 'No registrada') {
  const normalized = normalizeDateValue(value);
  if (!normalized) return fallback;

  const [year, month, day] = normalized.split('-');
  return `${day}-${month}-${year}`;
}
