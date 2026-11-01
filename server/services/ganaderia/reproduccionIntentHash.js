// FASE 4A: hash canónico versionado de la intención de un evento
// reproductivo (agx.reproduccion_eventos.intent_hash, inmutable). Única
// fuente del protocolo de reintento de POST .../reproduccion/eventos y
// .../corregir (mismo criterio que animalIntentHash.js).
//
// Entrada: el valor YA normalizado por reproduccionValidation.js. Orden de
// campos fijo (v1); cambiarlo o agregar campos exige v2. `accion` separa un
// registro (REGISTRO) de una corrección (CORRECCION, que además fija el
// evento corregido y el motivo): la misma operación no puede ser ambas.
import crypto from 'crypto';
import { CAMPOS_EVENTO } from './reproduccionValidation.js';

export const REPRODUCCION_INTENT_HASH_VERSION = 'v1';

export function buildReproduccionIntentCanonical(evento, { accion = 'REGISTRO', corrigeEventoId = null, motivo = null } = {}) {
  return JSON.stringify([
    accion,
    corrigeEventoId === null ? null : String(corrigeEventoId),
    motivo,
    ...CAMPOS_EVENTO.map((campo) => (evento[campo] === undefined ? null : evento[campo])),
  ]);
}

export function computeReproduccionIntentHash(evento, opciones) {
  const digest = crypto.createHash('sha256').update(buildReproduccionIntentCanonical(evento, opciones), 'utf8').digest('hex');
  return `${REPRODUCCION_INTENT_HASH_VERSION}:${digest}`;
}
