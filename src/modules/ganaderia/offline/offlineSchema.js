// SPRINT-3D11.3 (R1) -- esquema IndexedDB versionado de Ganadería offline.
//
// Una base POR ORGANIZACIÓN (namespace): 'agx-ganaderia-org-v1-<organizacionId>'.
// Los datos de una organización nunca comparten base con otra; al cambiar de
// organización la anterior se purga (ver offlineSession.js).
//
// Una base del DISPOSITIVO (sin datos de negocio): 'agx-ganaderia-dispositivo-v1'
//   dispositivo { key:'dispositivo', deviceId }
//   perfil      { key:'perfil', organizacionId, cuentaId, email, nombre,
//                 validadoAt, offlineHasta }   -- última sesión validada online
//
// Ningún store guarda secretos del backend (ni cookie de sesión, ni CSRF, ni
// tokens QR en claro: las chapetas se buscan offline por SHA-256 del token).
export const ORG_DB_VERSION = 1;
export const DEVICE_DB_NAME = 'agx-ganaderia-dispositivo-v1';
export const DEVICE_DB_VERSION = 1;
export const ORG_DB_PREFIX = 'agx-ganaderia-org-v1-';

export function orgDbName(organizacionId) {
  if (typeof organizacionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(organizacionId)) {
    throw new Error('ORGANIZACION_ID_INVALIDO');
  }
  return `${ORG_DB_PREFIX}${organizacionId.toLowerCase()}`;
}

/**
 * Stores de la base de la organización. keyPath + índices.
 *   meta       { key:'sync', organizacionId, cursor, ultimaSyncAt, ultimaSyncOk, ultimoError, preparadoAt }
 *   animales   key = 'srv:<animalId>' (conocido por el servidor) | 'loc:<localUuid>' (solo local)
 *              + datos de ficha (mismo formato que la API) + localUuid, clientOperationId,
 *              estadoSync ('SINCRONIZADO'|'PENDIENTE'|'CONFLICTO'|'RECHAZADO'), creadoLocalAt,
 *              chapetaCodigo, conflicto
 *   chapetas   key = codigoVisible; tokenHash, estado, animalId, reservaLocalUuid (asociación local pendiente)
 *   predios, potreros, razas, categorias -- copia de lectura
 *   outbox     operaciones pendientes (ver outbox.js)
 *   aliases    localUuid -> animalId (redirige rutas /animales/local/:uuid)
 */
export const ORG_STORES = Object.freeze({
  meta: { keyPath: 'key', indexes: [] },
  animales: {
    keyPath: 'key',
    indexes: [
      ['animalId', 'animalId', false],
      ['localUuid', 'localUuid', false],
      ['clientOperationId', 'clientOperationId', false],
      ['estadoSync', 'estadoSync', false],
    ],
  },
  chapetas: {
    keyPath: 'codigoVisible',
    indexes: [
      ['tokenHash', 'tokenHash', false],
      ['animalId', 'animalId', false],
      ['estado', 'estado', false],
    ],
  },
  predios: { keyPath: 'predioId', indexes: [] },
  potreros: { keyPath: 'potreroId', indexes: [['predioId', 'predioId', false]] },
  razas: { keyPath: 'razaId', indexes: [] },
  categorias: { keyPath: 'categoriaId', indexes: [] },
  outbox: {
    keyPath: 'operationId',
    indexes: [
      ['estado', 'estado', false],
      ['createdAt', 'createdAt', false],
      ['localUuid', 'localUuid', false],
    ],
  },
  aliases: { keyPath: 'localUuid', indexes: [] },
});

export const DEVICE_STORES = Object.freeze({
  dispositivo: { keyPath: 'key', indexes: [] },
});
