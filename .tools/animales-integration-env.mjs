import pg from 'pg';

const APP = 'AGX_BUSINESS_DATABASE_URL_TEST';
const ADMIN = 'AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL';
const TABLES = ['predios', 'catalogo_categorias_productivas', 'catalogo_razas', 'animales', 'animal_pesajes', 'animal_eventos'];

export function validateAnimalesIntegrationEnv(env) {
  if (env.AGX_ALLOW_DISPOSABLE_DB_TESTS !== 'yes') {
    throw new Error('AGX_ALLOW_DISPOSABLE_DB_TESTS=yes es obligatorio.');
  }
  const expectedDb = env.AGX_DISPOSABLE_TEST_DB_NAME?.trim();
  if (!expectedDb || !/^[a-z][a-z0-9_]*_test$/.test(expectedDb)) {
    throw new Error('AGX_DISPOSABLE_TEST_DB_NAME debe identificar una base de pruebas terminada en _test.');
  }
  const endpoints = [APP, ADMIN].map((name) => {
    if (!env[name]?.trim()) throw new Error(`${name} es obligatoria para la integración real de animales.`);
    let endpoint;
    try {
      const url = new URL(env[name]);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
      endpoint = new pg.Client({ connectionString: env[name] }).connectionParameters;
    } catch {
      throw new Error(`${name} debe ser una URL PostgreSQL válida.`);
    }
    // This dedicated command is restricted to disposable local databases.
    if (!['localhost', '127.0.0.1', '::1'].includes(endpoint.host)) {
      throw new Error(`${name} debe apuntar a una base desechable local (loopback).`);
    }
    return endpoint;
  });
  if (endpoints[0].port !== endpoints[1].port || endpoints[0].database !== endpoints[1].database) {
    throw new Error('Las conexiones app y admin deben apuntar a la misma base desechable y puerto.');
  }
  if (endpoints.some((endpoint) => endpoint.database !== expectedDb)) {
    throw new Error('La base conectada no coincide con AGX_DISPOSABLE_TEST_DB_NAME.');
  }
  if (endpoints[0].user !== 'agx_app') throw new Error(`${APP} debe usar el rol agx_app para comprobar RLS.`);
  return { app: env[APP], admin: env[ADMIN] };
}

export async function requireAnimalesIntegrationEnv(env = process.env, createPool = (options) => new pg.Pool(options)) {
  const connections = validateAnimalesIntegrationEnv(env);
  const pools = [];
  try {
    for (const [kind, connectionString] of Object.entries(connections)) {
      const pool = createPool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
      pools.push(pool);
      let rows;
      try {
        ({ rows } = await pool.query(
          'select name, to_regclass($1 || name) as relation from unnest($2::text[]) as name',
          ['agx.', TABLES],
        ));
      } catch {
        throw new Error(`No se pudo consultar la base de pruebas con la conexión ${kind}; revise conexión, autenticación y permisos.`);
      }
      const missing = TABLES.filter((name) => !rows.some((row) => row.name === name && row.relation));
      if (missing.length) {
        throw new Error(`Faltan tablas requeridas en la conexión ${kind}: ${missing.join(', ')}. Verifique las migraciones hasta 0022; este comando no las ejecuta.`);
      }
    }
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}
