// FASE 1C.1 -- fecha calendario de NEGOCIO (America/Bogota) para el
// frontend. La fecha local del navegador NO sirve como referencia: un
// dispositivo con otra zona horaria (o en UTC) puede ir un día por delante o
// por detrás de Colombia (Bogotá es UTC-5 todo el año, sin horario de
// verano: entre las 19:00 y las 23:59 hora Bogotá, UTC ya es el día
// siguiente).
//
// Misma técnica que el backend (server/services/ganaderia/motorDescansoAuto/
// businessTimezone.js -> resolveFechaHoyNegocio, cota "no futura" del POST de
// pesajes): Intl.DateTimeFormat + formatToParts, nunca la posición de los
// separadores de un locale. Un test de contrato exige que ambas coincidan.
//
// Puro salvo la lectura del reloj por defecto (`ahora = new Date()`), que es
// el ÚNICO punto que lo lee; en tests se inyecta `ahora`.
export const ZONA_HORARIA_NEGOCIO = 'America/Bogota';

const formateadores = new Map();

function formateador(timeZone) {
  if (!formateadores.has(timeZone)) {
    formateadores.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }));
  }
  return formateadores.get(timeZone);
}

/**
 * Fecha calendario 'YYYY-MM-DD' en la zona del negocio para el instante
 * `ahora` (Date, epoch ms o ISO con zona). null si el instante es inválido.
 */
export function fechaHoyNegocio({ ahora = new Date(), timeZone = ZONA_HORARIA_NEGOCIO } = {}) {
  const instante = ahora instanceof Date ? ahora : new Date(ahora);
  if (Number.isNaN(instante.getTime())) return null;
  const partes = Object.fromEntries(formateador(timeZone).formatToParts(instante).map((p) => [p.type, p.value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}
