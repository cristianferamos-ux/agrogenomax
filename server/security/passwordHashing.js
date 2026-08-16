import argon2 from 'argon2';
import crypto from 'crypto';

// AUTH-001 (ADR-015, aprobado v2.2): Argon2id como único algoritmo de
// hashing de contraseñas. Nunca SHA-256, nunca bcrypt/PBKDF2 sin
// justificación, nunca cifrado reversible, nunca texto plano.
//
// ARGON2_PARAMS_V1_FINAL -- perfil APROBADO (AUTH-001, cierre de gate
// "ARGON2 STAGING BENCHMARK"), medido con benchmark real
// (.tools/argon2-staging-benchmark.mjs) contra un sandbox efímero de
// Railway staging: 64 MiB / t=3 / p=1 se mantuvo cómodamente por debajo
// de los umbrales de latencia de producto en concurrencia 1/5/10
// (peor p95 medido: 338 ms en c=10, vs. umbral de 1500 ms), con margen
// de memoria amplio (máx. 385.7 MB observados). El sandbox de benchmark
// tenía más CPU/memoria que el contenedor final del backend real --
// queda pendiente una verificación operacional una vez desplegado el
// backend real de staging (ver ADR-015); esa verificación NO reabre la
// decisión criptográfica salvo OOM, presión severa de memoria o
// degradación claramente incompatible.
//
// Los perfiles Argon2 de AgroGenomaX son MONOTÓNICOS: solo se mantienen
// o se fortalecen con el tiempo, nunca se debilitan. Si en el futuro
// fuera necesario reducir el costo, es una decisión arquitectónica
// explícita y separada -- nunca un cambio silencioso de esta constante.
//
// Parámetros como CONSTANTES VERSIONADAS EN CÓDIGO -- nunca env vars
// (evita que una variable de despliegue baje el costo por accidente).
export const ARGON2_PARAMS_V1_FINAL = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
});

// Perfil actualmente en uso -- referenciar SIEMPRE esta constante (nunca
// ARGON2_PARAMS_V1_FINAL directamente en llamadas), para que un futuro
// cambio de perfil (V2, etc.) sea un solo punto de edición.
const ACTIVE_ARGON2_PARAMS = ARGON2_PARAMS_V1_FINAL;

/**
 * Normalización Unicode obligatoria antes de hashear/verificar -- NFC
 * (canónica), nunca NFKC (de compatibilidad, puede reescribir el
 * carácter en sí). Aplicada idéntica en hash y en verify para que nunca
 * puedan desincronizarse.
 */
function normalizePasswordInput(password) {
  return String(password).normalize('NFC');
}

/**
 * @param {string} password - texto plano, nunca se loguea, nunca se
 *   persiste sin pasar por esta función.
 * @returns {Promise<string>} hash PHC autocontenido
 *   (ej. `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`).
 */
export async function hashPassword(password) {
  return argon2.hash(normalizePasswordInput(password), ACTIVE_ARGON2_PARAMS);
}

/**
 * @param {string} encodedHash - hash PHC ya almacenado.
 * @param {string} password - texto plano a verificar.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(encodedHash, password) {
  return argon2.verify(encodedHash, normalizePasswordInput(password));
}

/**
 * Compara los parámetros embebidos en el hash PHC contra
 * ACTIVE_ARGON2_PARAMS -- true si el hash fue generado con un perfil
 * distinto (más débil o simplemente diferente) del actualmente vigente,
 * señal de que debe regenerarse en el próximo login exitoso.
 * @param {string} encodedHash
 * @returns {boolean}
 */
export function needsPasswordRehash(encodedHash) {
  return argon2.needsRehash(encodedHash, ACTIVE_ARGON2_PARAMS);
}

// ---------------------------------------------------------------------
// DUMMY_HASH -- mitigación de user enumeration por timing (AUTH-001 §9).
// ---------------------------------------------------------------------
//
// Se calcula UNA sola vez, de forma perezosa, la primera vez que se
// necesita (nunca en cada request -- el costo Argon2 real, ~30-80ms, ya
// se paga UNA vez en el arranque/primer uso del proceso, no en cada
// intento de login). Nunca corresponde a una contraseña real de ningún
// usuario: es el hash de un valor aleatorio generado en memoria en este
// mismo proceso, que se descarta de inmediato -- no hay ningún secreto
// "dummy" fijo escrito en el repositorio que pudiera filtrarse ni
// reutilizarse. El propósito no es que sea indescifrable (nadie necesita
// verificarlo correctamente jamás), sino que `verifyPassword` tenga
// EXACTAMENTE el mismo costo computacional que verificar un hash real,
// para que el camino "cuenta inexistente / sin password" no sea medible
// por tiempo de respuesta frente al camino real.
let dummyHashPromise = null;

export function getDummyHash() {
  if (!dummyHashPromise) {
    const randomValueNeverLogged = crypto.randomBytes(32).toString('base64url');
    dummyHashPromise = hashPassword(randomValueNeverLogged);
  }
  return dummyHashPromise;
}

/** Exclusivamente para pruebas unitarias aisladas. */
export function __resetDummyHashForTests() {
  dummyHashPromise = null;
}
