import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { normalizeEmail, normalizeIp, computeFingerprint } from '../authFingerprint.js';

const SECRET_A = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs='; // 32 bytes base64, sintético
const SECRET_B = 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc='; // distinto, sintético

describe('AUTH-001: authFingerprint.js -- normalizeEmail', () => {
  test('trim + lowercase, misma normalización que la columna generada email_normalizado', () => {
    assert.equal(normalizeEmail('  Operador@FincaA.Test  '), 'operador@fincaa.test');
  });

  test('ya normalizado -> idéntico', () => {
    assert.equal(normalizeEmail('a@b.com'), 'a@b.com');
  });
});

describe('AUTH-001: authFingerprint.js -- normalizeIp (condición final B, ipv6Subnet=64 explícito)', () => {
  test('IPv4 pura y su forma IPv4-mapeada-en-IPv6 producen el MISMO resultado', () => {
    const pure = normalizeIp('192.0.2.10');
    const mapped = normalizeIp('::ffff:192.0.2.10');
    assert.equal(pure, mapped);
  });

  test('otra pareja IPv4/IPv4-mapeada -- misma propiedad', () => {
    assert.equal(normalizeIp('203.0.113.55'), normalizeIp('::ffff:203.0.113.55'));
  });

  test('dos IPv6 reales en el MISMO bloque /64 -> misma clave', () => {
    const a = normalizeIp('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = normalizeIp('2001:db8:1234:5678:1111:2222:3333:4444');
    assert.equal(a, b);
  });

  test('dos IPv6 reales en bloques /64 DISTINTOS -> claves distintas', () => {
    const a = normalizeIp('2001:db8:1234:5678::1');
    const b = normalizeIp('2001:db8:1234:9999::1');
    assert.notEqual(a, b);
  });

  test('IPv4 distintas -> resultados distintos', () => {
    assert.notEqual(normalizeIp('192.0.2.10'), normalizeIp('192.0.2.11'));
  });
});

describe('AUTH-001: authFingerprint.js -- computeFingerprint (HMAC-SHA256 con separación de dominio)', () => {
  test('determinista: mismo dominio+valor+secreto -> mismo fingerprint', () => {
    const a = computeFingerprint('email', 'a@b.com', SECRET_A);
    const b = computeFingerprint('email', 'a@b.com', SECRET_A);
    assert.equal(a, b);
  });

  test('formato: hex minúsculas, 64 caracteres (SHA-256)', () => {
    const fp = computeFingerprint('email', 'a@b.com', SECRET_A);
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  test('separación de dominio: mismo valor normalizado, dominios "email" vs "ip" -> fingerprints DISTINTOS', () => {
    const emailFp = computeFingerprint('email', '203.0.113.1', SECRET_A);
    const ipFp = computeFingerprint('ip', '203.0.113.1', SECRET_A);
    assert.notEqual(emailFp, ipFp);
  });

  test('secretos distintos -> fingerprints distintos para el mismo valor', () => {
    const withA = computeFingerprint('email', 'a@b.com', SECRET_A);
    const withB = computeFingerprint('email', 'a@b.com', SECRET_B);
    assert.notEqual(withA, withB);
  });

  test('valores normalizados distintos -> fingerprints distintos', () => {
    const fp1 = computeFingerprint('email', 'a@b.com', SECRET_A);
    const fp2 = computeFingerprint('email', 'c@d.com', SECRET_A);
    assert.notEqual(fp1, fp2);
  });

  test('coincide con el cálculo manual HMAC-SHA256(secreto, `${domain}\\0${valor}`)', () => {
    const expected = crypto
      .createHmac('sha256', Buffer.from(SECRET_A, 'base64'))
      .update('email\0a@b.com', 'utf8')
      .digest('hex');
    assert.equal(computeFingerprint('email', 'a@b.com', SECRET_A), expected);
  });

  test('el byte nulo de separación de dominio evita la colisión "emailx"+"" vs "email"+"x"', () => {
    // Sin el separador \0, computeFingerprint('emailx', '', secret) y
    // computeFingerprint('email', 'x', secret) concatenarían al MISMO
    // mensaje ("emailx"). Con el separador, los mensajes son
    // "emailx\0" y "email\0x" respectivamente -- distintos.
    const concatenatedDomain = computeFingerprint('emailx', '', SECRET_A);
    const splitDomainValue = computeFingerprint('email', 'x', SECRET_A);
    assert.notEqual(concatenatedDomain, splitDomainValue);
  });
});
