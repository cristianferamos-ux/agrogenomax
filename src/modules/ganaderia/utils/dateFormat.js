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

const MONTHS_ES = {
  ene: '01',
  feb: '02',
  mar: '03',
  abr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  ago: '08',
  sep: '09',
  sept: '09',
  set: '09',
  oct: '10',
  nov: '11',
  dic: '12',
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimeDisplay(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/i);
  if (!match) return '';

  let hours = Number(match[1]);
  const minutes = match[2];
  const meridian = String(match[3] || '').toLowerCase();

  if (meridian.startsWith('p') && hours < 12) hours += 12;
  if (meridian.startsWith('a') && hours === 12) hours = 0;

  return `${pad2(hours)}:${minutes}`;
}

function formatDateObject(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  return `${pad2(value.getDate())}-${pad2(value.getMonth() + 1)}-${value.getFullYear()} ${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

// SPRINT-3D9.5: <input type="datetime-local"> siempre representa hora
// LOCAL DEL DISPOSITIVO, sin zona (spec HTML) -- estos dos helpers cierran
// la conversión ida/vuelta contra un ISO backend de forma inequívoca, sin
// hardcodear ninguna zona horaria. Precisión deliberada de MINUTO (el
// propio input no admite más resolución) -- el backend/Postgres sigue
// siendo la autoridad temporal real (medicion <= db_now, medicion >
// salida); esto es solo UX.

// ISO backend -> "YYYY-MM-DDTHH:mm" en hora local, truncado a minuto.
export function isoToDatetimeLocalInput(isoValue) {
  // Guard explícito -- `new Date(null)` es epoch 0 (null se coacciona a 0),
  // NUNCA Invalid Date, así que Number.isNaN solo no basta para excluirlo.
  if (isoValue === null || isoValue === undefined || isoValue === '') return '';
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Valor de <input type="datetime-local"> -> ISO UTC del inicio exacto de
// ese minuto local. Construido por COMPONENTES explícitos (nunca parsing
// implícito de un string ensamblado) para que la interpretación como hora
// LOCAL sea inequívoca. Hardening: `Date` normaliza silenciosamente
// componentes imposibles (ej. 31 de febrero se corre a marzo) -- se
// verifica que los componentes resueltos coincidan exactamente con los
// pedidos, o se rechaza con null en vez de aceptar una fecha corrida.
export function datetimeLocalInputToIso(localValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue || '');
  if (!match) return null;
  const [, yStr, moStr, dStr, hStr, miStr] = match;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const mi = Number(miStr);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  const valido = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    && date.getHours() === h && date.getMinutes() === mi;
  return valido ? date.toISOString() : null;
}

export function formatDateTimeDisplay(value = new Date(), fallback = 'No registrada') {
  if (value === null || value === undefined || value === '') return fallback;

  if (value instanceof Date) {
    return formatDateObject(value) || fallback;
  }

  const text = String(value).trim();
  const isoDate = normalizeDateValue(text);
  if (isoDate) {
    const date = new Date(text);
    const time = text.includes('T') && !Number.isNaN(date.getTime())
      ? ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
      : '';
    return `${formatDateDisplay(isoDate)}${time}`;
  }

  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,\s*(.+))?$/);
  if (numeric) {
    const [, day, month, year, timeText] = numeric;
    const time = formatTimeDisplay(timeText);
    return `${pad2(day)}-${pad2(month)}-${year}${time ? ` ${time}` : ''}`;
  }

  const monthName = text.match(/^(\d{1,2})\s+([a-z.]+)\s+(\d{4})(?:,\s*(.+))?$/i);
  if (monthName) {
    const [, day, monthText, year, timeText] = monthName;
    const month = MONTHS_ES[monthText.replace('.', '').toLowerCase()];
    if (month) {
      const time = formatTimeDisplay(timeText);
      return `${pad2(day)}-${month}-${year}${time ? ` ${time}` : ''}`;
    }
  }

  const date = new Date(text);
  return formatDateObject(date) || fallback;
}
