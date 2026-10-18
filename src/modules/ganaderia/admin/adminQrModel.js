// SPRINT-3D11.3 (R1): lógica pura del módulo Administración > QR Ganadería
// / Inventario de chapetas. Sin React ni red.

export const ESTADO_LOTE_LABELS = Object.freeze({
  GENERADO: 'Generado',
  EN_FABRICACION: 'En fabricación',
  EN_STOCK: 'En stock',
  CERRADO: 'Cerrado',
});

export const ASIGNACION_LABELS = Object.freeze({
  SIN_ASIGNAR: 'Sin asignar',
  PARCIAL: 'Parcialmente asignado',
  TOTAL: 'Asignado',
});

export const ESTADO_CHAPETA_ADMIN_LABELS = Object.freeze({
  EN_INVENTARIO: 'En inventario',
  ASIGNADO_ORGANIZACION: 'Asignada a organización',
  ASIGNADO_ANIMAL: 'Asociada a animal',
  REVOCADO: 'Revocada',
  DANADO: 'Dañada',
  REEMPLAZADO: 'Reemplazada',
});

const SIGUIENTE = Object.freeze({ GENERADO: 'EN_FABRICACION', EN_FABRICACION: 'EN_STOCK' });

/** Siguiente estado físico del lote (o null). CERRADO se ofrece aparte. */
export function siguienteEstadoLote(estado) {
  return SIGUIENTE[estado] ?? null;
}

/** Texto pegado (líneas, comas, espacios) -> lista de códigos sin vacíos ni repetidos. */
export function parseCodigosTexto(texto) {
  const items = String(texto ?? '')
    .split(/[\s,;]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(items)];
}

/** Consecutivos legacy AGX-000001..AGX-0000NN (solo staging/pruebas controladas). */
export function codigosLegacyConsecutivos(desde, hasta) {
  const inicio = Number(desde);
  const fin = Number(hasta);
  if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio < 1 || fin < inicio || fin - inicio >= 5000 || fin > 999999) {
    return null;
  }
  return Array.from({ length: fin - inicio + 1 }, (_, i) => `AGX-${String(inicio + i).padStart(6, '0')}`);
}

export function newOperationId() {
  return globalThis.crypto?.randomUUID?.() ?? null;
}

const ERROR_MESSAGES = Object.freeze({
  INVALID_CANTIDAD: 'La cantidad debe ser un número entre 1 y 5000.',
  INVALID_CODIGOS: 'Revisa la lista de códigos.',
  INVALID_ORGANIZACION: 'Selecciona una organización.',
  ORGANIZACION_NOT_FOUND: 'La organización no existe o no está activa.',
  LOTE_NO_EN_STOCK: 'El lote debe estar EN STOCK para asignarlo.',
  LOTE_TRANSICION_INVALIDA: 'Ese cambio de estado no está permitido.',
  STOCK_INSUFICIENTE: 'No hay suficientes chapetas disponibles en el lote.',
  QR_NO_DISPONIBLE: 'Algunas chapetas no están disponibles en este lote.',
  QR_CODIGO_YA_EXISTE: 'Algunos códigos ya existen en el inventario.',
  QR_NOT_FOUND: 'Chapeta no encontrada.',
  QR_NO_OPERATIVO: 'La chapeta ya está fuera de uso.',
  QR_NO_ACTIVO: 'Solo se reemplaza una chapeta asociada a un animal.',
  QR_YA_ASOCIADO: 'La chapeta nueva ya está asociada a otro animal.',
  INVALID_CODIGO_NUEVO: 'Revisa el código de la chapeta nueva.',
  INVALID_CODIGO: 'Revisa el código de la chapeta.',
  INVALID_MOTIVO: 'Escribe el motivo (máximo 500 caracteres).',
  CLIENT_OPERATION_ID_REUSED: 'Esta operación ya se usó. Recarga la página.',
  SUPERADMIN_REQUIRED: 'Tu cuenta no tiene permisos de administración.',
});

export function adminQrErrorMessage(data) {
  const base = ERROR_MESSAGES[data?.error] ?? 'No fue posible completar la acción. Intenta nuevamente.';
  if (Array.isArray(data?.codigos) && data.codigos.length > 0) return `${base} (${data.codigos.slice(0, 10).join(', ')})`;
  return base;
}
