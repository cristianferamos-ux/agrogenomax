// AUTH-001 (aprobado v2.2, §4): lista LOCAL, curada y pequeña -- suficiente
// para demostrar correctamente el mecanismo de bloqueo, NO un volcado de
// una lista externa masiva (esa decisión de fuente/licencia/tamaño queda
// pendiente y requiere autorización explícita antes de incorporarse, tal
// como se pidió). Todas las entradas son valores de conocimiento público
// (patrones de contraseña comunes ampliamente documentados, no datos
// extraídos de ninguna filtración con licencia propia).
//
// Coincidencia SIEMPRE exacta (tras normalizar: NFC, minúsculas, trim) --
// server/security/passwordPolicy.js nunca hace `includes()` sobre esta
// lista. Se mantiene separada del código lógico a propósito, para poder
// swap-earla o crecerla sin tocar la validación.
//
// Todas las entradas de 15+ caracteres son intencionales: el mínimo de
// política ya descarta "123456"/"password" por longitud, pero patrones
// igual de predecibles alargados con un sufijo trivial ("password123456",
// "qwertyuiopasdfgh") siguen siendo débiles y merecen bloquearse.
export const COMMON_PASSWORD_BLOCKLIST = Object.freeze([
  // Patrones clásicos alargados con sufijos triviales (>=15 caracteres).
  'password123456',
  'password1234567',
  'contraseña123456',
  'contrasena123456',
  'letmein123456789',
  'iloveyou12345678',
  'qwertyuiopasdfgh',
  'qwertyuiop123456',
  'admin1234567890',
  'welcome123456789',
  '123456789012345',
  '1234567890123456',
  'abcdefghijklmnop',
  'trustno1trustno1',
  'superman12345678',
  'football12345678',
  'baseball12345678',
  'dragon1234567890',
  'monkey1234567890',
  'sunshine12345678',
  'princess12345678',
  'starwars12345678',
  'passw0rd12345678',
  'changeme12345678',
  // Genéricas cortas (quedan por debajo del mínimo de política hoy, pero
  // se conservan por si la longitud mínima cambiara en el futuro).
  '123456',
  'password',
  'qwerty',
  'letmein',
  'welcome',
  'admin123',
  'iloveyou',
]);

export const COMMON_PASSWORD_BLOCKLIST_SET = new Set(COMMON_PASSWORD_BLOCKLIST);
