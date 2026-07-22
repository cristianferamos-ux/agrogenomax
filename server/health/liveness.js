/**
 * Liveness / health de plataforma (LOTE-005, ADR-012 §4/§5.1/§7, ADR-011).
 *
 * `GET /api/health/live` responde una única pregunta: "¿el proceso Node
 * está vivo y puede atender solicitudes HTTP?". Es el único contrato que
 * el *target group* del ALB consumirá en ECS (ADR-012 §90: health de
 * plataforma y liveness son el mismo contrato, no dos endpoints
 * distintos).
 *
 * Por diseño, este módulo NUNCA:
 * - consulta PostgreSQL/PostGIS (server/db.js, server/catastroxDb.js);
 * - contacta Cognito, Wompi, AWS ni ningún servicio externo;
 * - realiza ninguna llamada de red (`fetch`);
 * - abre ni construye ningún `pg.Pool`;
 * - depende de autenticación, organización, tenant o pagos.
 *
 * Diferencia obligatoria con readiness (no implementada en este lote,
 * reservada a LOTE-013/al lote que el Plan Maestro defina): liveness
 * responde si el PROCESO está vivo -- una base de datos caída, un
 * PostGIS inalcanzable o un dominio funcional degradado NUNCA deben
 * cambiar la respuesta de este endpoint. Readiness responderá una
 * pregunta distinta ("¿está listo para tráfico funcional?") en un
 * endpoint separado (`/api/health/ready*`), que si consulta
 * dependencias externas.
 *
 * Sin importar ningún módulo de conexión a base de datos, sin leer
 * `process.env` de forma dispersa, y sin efectos laterales al importar
 * este archivo.
 */

/**
 * Construye el payload de liveness. Puro: mismo `appEnv` de entrada,
 * mismo resultado salvo por `timestamp` (que avanza con el reloj, no con
 * ningún estado mutable del proceso). No incluye secretos, URLs de base,
 * `API_BACKEND_URL`, tokens, rutas internas, stack traces, hostname del
 * servidor, versión de Node ni ningún detalle de infraestructura.
 *
 * @param {{appEnv?: string}} [options]
 */
export function createLivenessPayload({ appEnv } = {}) {
  const payload = {
    status: 'ok',
    check: 'liveness',
    timestamp: new Date().toISOString(),
  };

  if (typeof appEnv === 'string' && appEnv.trim() !== '') {
    payload.appEnv = appEnv.trim();
  }

  return Object.freeze(payload);
}

/**
 * Handler Express. `appEnv` es la única entrada externa que consume, y
 * proviene exclusivamente de la configuración ya validada al arranque
 * (server/index.js -- `getConfig()`, LOTE-002) -- nunca se relee
 * `process.env.APP_ENV` aquí, para no reintroducir una segunda fuente de
 * verdad del ambiente.
 *
 * @param {string} appEnv
 */
export function createLivenessHandler(appEnv) {
  return function livenessHandler(_req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).json(createLivenessPayload({ appEnv }));
  };
}
