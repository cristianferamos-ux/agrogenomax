import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, validatePasswordPolicy } from '../passwordPolicy.js';
import { COMMON_PASSWORD_BLOCKLIST, COMMON_PASSWORD_BLOCKLIST_SET } from '../data/passwordBlocklist.js';

// AUTH-001 (aprobado v2.2, §1/§2): política moderna -- longitud
// 15-128, sin reglas de composición, blocklist EXACTO (nunca substring),
// passphrases largas siempre permitidas, sin truncamiento.

describe('AUTH-001: passwordPolicy.js', () => {
  test('constantes de longitud', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 15);
    assert.equal(PASSWORD_MAX_LENGTH, 128);
  });

  test('vacío/ausente -> PASSWORD_REQUIRED', () => {
    assert.deepEqual(validatePasswordPolicy(''), { ok: false, code: 'PASSWORD_REQUIRED' });
    assert.deepEqual(validatePasswordPolicy(undefined), { ok: false, code: 'PASSWORD_REQUIRED' });
    assert.deepEqual(validatePasswordPolicy('   '), { ok: false, code: 'PASSWORD_REQUIRED' });
  });

  test('menor al mínimo (14 chars) -> PASSWORD_TOO_SHORT', () => {
    const result = validatePasswordPolicy('a'.repeat(14));
    assert.deepEqual(result, { ok: false, code: 'PASSWORD_TOO_SHORT' });
  });

  test('exactamente el mínimo (15 chars, no blocklisted) -> ok', () => {
    const result = validatePasswordPolicy('correcto-mate15');
    assert.deepEqual(result, { ok: true });
  });

  test('mayor al máximo (129 chars) -> PASSWORD_TOO_LONG, nunca trunca', () => {
    const result = validatePasswordPolicy('a'.repeat(129));
    assert.deepEqual(result, { ok: false, code: 'PASSWORD_TOO_LONG' });
  });

  test('exactamente el máximo (128 chars) -> ok', () => {
    const result = validatePasswordPolicy('a'.repeat(128));
    assert.deepEqual(result, { ok: true });
  });

  test('longitud cuenta code points Unicode, no unidades UTF-16 (emoji fuera del BMP)', () => {
    // '🐄' es un solo code point mas ocupa 2 unidades UTF-16 -- 14 emojis
    // deben contar como 14 caracteres (por debajo del mínimo), no 28.
    const password = '🐄'.repeat(14);
    assert.equal(password.length, 28); // longitud UTF-16 (lo que NO debe usarse)
    assert.deepEqual(validatePasswordPolicy(password), { ok: false, code: 'PASSWORD_TOO_SHORT' });

    const passwordValido = '🐄'.repeat(15);
    assert.deepEqual(validatePasswordPolicy(passwordValido), { ok: true });
  });

  test('sin reglas de composición: passphrase de solo minúsculas y espacios, 15+ chars -> ok', () => {
    const result = validatePasswordPolicy('vaca marrón feliz en el potrero');
    assert.deepEqual(result, { ok: true });
  });

  test('coincidencia EXACTA con una entrada del blocklist (tras normalizar) -> PASSWORD_BLOCKLISTED', () => {
    const entry = COMMON_PASSWORD_BLOCKLIST.find((candidate) => Array.from(candidate).length >= PASSWORD_MIN_LENGTH);
    assert.ok(entry, 'fixture: debe existir al menos una entrada que por sí sola cumpla el largo mínimo');
    assert.equal(COMMON_PASSWORD_BLOCKLIST_SET.has(entry.toLowerCase().trim()), true);
    const result = validatePasswordPolicy(entry.toUpperCase());
    assert.deepEqual(result, { ok: false, code: 'PASSWORD_BLOCKLISTED' });
  });

  test('blocklist NUNCA es substring: una entrada bloqueada incrustada en una passphrase más larga -> ok', () => {
    const entry = COMMON_PASSWORD_BLOCKLIST.find((candidate) => Array.from(candidate).length >= PASSWORD_MIN_LENGTH);
    const password = `prefijo-largo-${entry}-sufijo-largo`;
    assert.ok(Array.from(password).length >= PASSWORD_MIN_LENGTH);
    const result = validatePasswordPolicy(password);
    assert.deepEqual(result, { ok: true });
  });

  test('marca trivial (agrogenomax + sufijo corto de <=4 dígitos, whole-string) -> PASSWORD_BLOCKLISTED', () => {
    for (const candidate of ['agrogenomax2026', 'AgroGenomax2026!', 'agr0gen0max2026']) {
      assert.ok(Array.from(candidate).length >= PASSWORD_MIN_LENGTH, `fixture: "${candidate}" debe cumplir el largo mínimo por sí sola`);
      const result = validatePasswordPolicy(candidate);
      assert.equal(result.ok, false, `"${candidate}" debía bloquearse por marca trivial`);
      assert.equal(result.code, 'PASSWORD_BLOCKLISTED');
    }
  });

  test('marca trivial: el bug autodetectado NO reaparece -- sufijo de 4 dígitos que contiene un dígito con sustituto leet (0/1) sigue bloqueando', () => {
    // Antes del fix, sustituir TODO el string (incluido el sufijo) convertía
    // "2026" en "2o26", rompiendo el match \d{0,4} y dejando pasar el
    // password. Ahora el sufijo se compara siempre en dígitos literales.
    const result = validatePasswordPolicy('agrogenomax2026!');
    assert.deepEqual(result, { ok: false, code: 'PASSWORD_BLOCKLISTED' });
  });

  test('marca trivial: sufijo de 5+ dígitos NO matchea (fuera del acotado \\d{0,4}) -- no es un falso positivo, es simplemente otro caso', () => {
    const result = validatePasswordPolicy('agrogenomax202601');
    assert.deepEqual(result, { ok: true });
  });

  test('passphrase legítima que CONTIENE la marca como texto normal -> ok (nunca análisis de substring libre)', () => {
    const password = 'trabajoenagrogenomaxtodoslosdias';
    assert.ok(Array.from(password).length >= PASSWORD_MIN_LENGTH);
    const result = validatePasswordPolicy(password);
    assert.deepEqual(result, { ok: true });
  });

  test('coincide exactamente con el email normalizado -> PASSWORD_BLOCKLISTED', () => {
    const result = validatePasswordPolicy('Operador@FincaA.Test  ', { emailNormalizado: 'operador@fincaa.test' });
    assert.deepEqual(result, { ok: false, code: 'PASSWORD_BLOCKLISTED' });
  });

  test('coincide exactamente con el nombre (>=4 chars normalizados) -> PASSWORD_BLOCKLISTED', () => {
    const result = validatePasswordPolicy('Juan Carlos Pérez', { nombre: 'juan carlos pérez' });
    assert.deepEqual(result, { ok: false, code: 'PASSWORD_BLOCKLISTED' });
  });

  test('nombre corto (<4 chars normalizados) NUNCA dispara el bloqueo por nombre, incluso si coincide', () => {
    const result = validatePasswordPolicy('Ana Ana Ana Ana', { nombre: 'ana' });
    assert.deepEqual(result, { ok: true });
  });

  test('password que solo contiene el email/nombre como SUBSTRING, no coincidencia exacta -> ok', () => {
    const result = validatePasswordPolicy('operador@fincaa.test-y-mucho-mas-texto', {
      emailNormalizado: 'operador@fincaa.test',
    });
    assert.deepEqual(result, { ok: true });
  });
});
