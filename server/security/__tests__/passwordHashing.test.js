import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';

import {
  ARGON2_PARAMS_V1_FINAL,
  hashPassword,
  verifyPassword,
  needsPasswordRehash,
  getDummyHash,
  __resetDummyHashForTests,
} from '../passwordHashing.js';

// AUTH-001 (ADR-015, aprobado v2.2, §3; gate "ARGON2 STAGING BENCHMARK",
// aprobado): Argon2id, PHC autocontenido, NFC obligatorio, DUMMY_HASH
// perezoso/cacheado. Pruebas reales contra la librería `argon2`
// instalada -- sin mocks -- confirmando en Windows el formato PHC y el
// comportamiento de verify/needsRehash contra el perfil V1 FINAL
// (64 MiB / t=3 / p=1), congelado tras benchmark real en Railway
// staging.

describe('AUTH-001: passwordHashing.js -- Argon2id real (sin mocks)', () => {
  test('ARGON2_PARAMS_V1_FINAL -- perfil congelado (aprobado, no candidato)', () => {
    assert.equal(ARGON2_PARAMS_V1_FINAL.memoryCost, 65536);
    assert.equal(ARGON2_PARAMS_V1_FINAL.timeCost, 3);
    assert.equal(ARGON2_PARAMS_V1_FINAL.parallelism, 1);
    assert.throws(() => {
      ARGON2_PARAMS_V1_FINAL.memoryCost = 1;
    });
  });

  test('hashPassword produce un hash PHC $argon2id$ autocontenido con m=65536,t=3,p=1', async () => {
    const hash = await hashPassword('una-contrasena-larga-de-prueba');
    // La librería `argon2` codifica los parámetros en orden m,p,t (no m,t,p).
    assert.match(hash, /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
  });

  test('verifyPassword: contraseña correcta -> true; incorrecta -> false', async () => {
    const hash = await hashPassword('correcta-contrasena-valida-15');
    assert.equal(await verifyPassword(hash, 'correcta-contrasena-valida-15'), true);
    assert.equal(await verifyPassword(hash, 'otra-contrasena-distinta-000'), false);
  });

  test('dos hashes del mismo password son distintos (salt aleatorio) pero ambos verifican', async () => {
    const a = await hashPassword('misma-contrasena-repetida-xx');
    const b = await hashPassword('misma-contrasena-repetida-xx');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword(a, 'misma-contrasena-repetida-xx'), true);
    assert.equal(await verifyPassword(b, 'misma-contrasena-repetida-xx'), true);
  });

  test('normalización NFC: NFC y NFD del mismo texto verifican igual', async () => {
    // 'á' precompuesto (NFC, 1 code point) vs 'a' + acento combinante (NFD, 2 code points).
    const nfc = 'contraseña-y-también-ácida-15';
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);

    const hash = await hashPassword(nfc);
    assert.equal(await verifyPassword(hash, nfd), true);
  });

  test('verifyPassword contra un string que no es un PHC (sin "$" inicial) -- se propaga como rechazo, nunca se confunde con "password incorrecta"', async () => {
    // En el flujo real de /login nunca se le pasa un valor así (siempre el
    // hash real de la cuenta o getDummyHash(), ambos PHC válidos) -- este
    // caso documenta el comportamiento real de la librería subyacente para
    // que un futuro cambio no lo asuma silenciosamente como "retorna false".
    await assert.rejects(() => verifyPassword('no-es-un-hash-phc-valido', 'cualquier-cosa'));
  });

  // AUTH-001 (cierre "FREEZE ARGON2 + REGRESIÓN"): política MONOTÓNICA --
  // los perfiles Argon2 de AgroGenomaX solo se mantienen o se fortalecen
  // con el tiempo. needsPasswordRehash() usa el comportamiento nativo de
  // argon2.needsRehash() sin lógica propia: CUALQUIER diferencia de
  // parámetros contra el perfil activo (V1_FINAL) dispara rehash --
  // confirmado explícitamente (ver benchmark) que esto incluye el caso
  // "el hash ya es más fuerte que el target", no solo "más débil". Para
  // el camino real de este piloto (el perfil activo nunca baja) esa
  // propiedad es inofensiva; si algún día se INTRODUJERA un perfil más
  // débil como activo, este comportamiento causaría rehashes
  // innecesarios de hashes ya fuertes -- decisión arquitectónica
  // separada, no un bug de esta implementación.
  test('needsPasswordRehash: hash generado con V1_FINAL -> false', async () => {
    const hash = await hashPassword('contrasena-con-perfil-v1-final');
    assert.equal(needsPasswordRehash(hash), false);
  });

  test('needsPasswordRehash: hash del antiguo candidato A (19456/t2/p1) -> true', async () => {
    const argon2Lib = (await import('argon2')).default;
    const oldHash = await argon2Lib.hash('contrasena-perfil-candidato-a', {
      type: argon2Lib.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    assert.equal(needsPasswordRehash(oldHash), true);
  });

  test('needsPasswordRehash: hash del antiguo candidato B (32768/t2/p1) -> true', async () => {
    const argon2Lib = (await import('argon2')).default;
    const oldHash = await argon2Lib.hash('contrasena-perfil-candidato-b', {
      type: argon2Lib.argon2id,
      memoryCost: 32768,
      timeCost: 2,
      parallelism: 1,
    });
    assert.equal(needsPasswordRehash(oldHash), true);
  });

  test('needsPasswordRehash: hash con parámetros distintos cualesquiera (incluida una única diferencia en timeCost) -> true', async () => {
    const argon2Lib = (await import('argon2')).default;
    const almostFinalHash = await argon2Lib.hash('contrasena-casi-v1-final', {
      type: argon2Lib.argon2id,
      memoryCost: 65536,
      timeCost: 2, // única diferencia: timeCost 2 en vez de 3
      parallelism: 1,
    });
    assert.equal(needsPasswordRehash(almostFinalHash), true);
  });

  test('getDummyHash: perezoso (no se calcula hasta el primer uso), cacheado (mismo valor en la misma corrida), es un PHC válido', async () => {
    __resetDummyHashForTests();
    const a = await getDummyHash();
    const b = await getDummyHash();
    assert.equal(a, b);
    assert.match(a, /^\$argon2id\$/);
  });

  test('getDummyHash: nunca corresponde a una contraseña previsible/hardcodeada', async () => {
    __resetDummyHashForTests();
    const hash = await getDummyHash();
    for (const guess of ['', 'password', 'dummy', 'agrogenomax', '123456']) {
      assert.equal(await verifyPassword(hash, guess), false);
    }
  });

  test('__resetDummyHashForTests: fuerza un nuevo cálculo, produce un hash PHC distinto', async () => {
    __resetDummyHashForTests();
    const first = await getDummyHash();
    __resetDummyHashForTests();
    const second = await getDummyHash();
    assert.notEqual(first, second);
  });

  test('AUDITORÍA getDummyHash(): múltiples llamadas reutilizan el mismo PHC SIN recalcular Argon2 (espía real sobre argon2.hash)', async () => {
    __resetDummyHashForTests();
    const originalHash = argon2.hash;
    let callCount = 0;
    argon2.hash = async (...args) => {
      callCount += 1;
      return originalHash.apply(argon2, args);
    };
    try {
      const first = await getDummyHash();
      const second = await getDummyHash();
      const third = await getDummyHash();
      assert.equal(callCount, 1, 'argon2.hash debe invocarse EXACTAMENTE una vez, sin importar cuántas veces se llame getDummyHash()');
      assert.equal(first, second);
      assert.equal(second, third);
    } finally {
      argon2.hash = originalHash;
    }
  });

  test('AUDITORÍA getDummyHash(): llamadas concurrentes (antes de resolver la primera) tampoco duplican el cálculo', async () => {
    __resetDummyHashForTests();
    const originalHash = argon2.hash;
    let callCount = 0;
    argon2.hash = async (...args) => {
      callCount += 1;
      return originalHash.apply(argon2, args);
    };
    try {
      const [a, b, c] = await Promise.all([getDummyHash(), getDummyHash(), getDummyHash()]);
      assert.equal(callCount, 1, 'llamadas concurrentes antes de la primera resolución deben compartir la misma promesa en vuelo, nunca disparar cálculos paralelos');
      assert.equal(a, b);
      assert.equal(b, c);
    } finally {
      argon2.hash = originalHash;
    }
  });

  test('AUDITORÍA getDummyHash(): el hash producido usa EXACTAMENTE ACTIVE_ARGON2_PARAMS (mismo perfil que hashPassword real -- necesario para aproximar el timing de verify)', async () => {
    __resetDummyHashForTests();
    const dummy = await getDummyHash();
    const real = await hashPassword('cualquier-password-real-de-comparacion');
    // Los parámetros van embebidos en el propio string PHC -- si ambos
    // hashes se generaron con el mismo perfil, la porción
    // "$argon2id$v=19$m=...,t=...,p=..." debe coincidir carácter a
    // carácter entre ambos (el salt/hash que sigue sí difiere).
    const paramsSegment = (phc) => phc.split('$').slice(0, 4).join('$');
    assert.equal(paramsSegment(dummy), paramsSegment(real));
  });

  test('getDummyHash(): el PHC generado incorpora explícitamente m=65536,t=3,p=1 (V1_FINAL, no un perfil candidato antiguo)', async () => {
    __resetDummyHashForTests();
    const dummy = await getDummyHash();
    assert.match(dummy, /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
  });
});
