import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigurationError, getConfig } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { buildExpressCorsPolicy, createCorsMiddleware } from './security/corsPolicy.js';
import { createPermissionsPolicyMiddleware, createSecurityHeadersMiddleware } from './security/securityHeaders.js';
import { createLivenessHandler } from './health/liveness.js';
import { createGracefulShutdown, resolveShutdownTimeoutMs } from './lifecycle/gracefulShutdown.js';
import { createRequestLogging } from './observability/requestLogging.js';
import { closeMainDbPool } from './db.js';
import { closeCatastroxDbPool } from './catastroxDb.js';
import { closeAgxAuthPool } from './db/agxAuthPool.js';
import { createDeliveryWorker } from './services/catastrox/deliveryWorker.js';
import { findAutonomousDeliveryJobIds, processDeliveryJob } from './services/catastrox/deliveryJobService.js';
import createAnimalesRouter from './routes/animales.js';
import catastroxRouter from './routes/catastrox.js';
import catastroxPaymentsRouter from './routes/catastroxPayments.js';
import createGanaderiaAdminRouter from './routes/ganaderiaAdmin.js';
import createGanaderiaAuthRouter from './routes/ganaderiaAuth.js';
import createHealthRouter from './routes/health.js';
import createPesajesRouter from './routes/pesajes.js';
import createPotrerosRouter from './routes/potreros.js';
import createPrediosRouter from './routes/predios.js';
import createQrRouter from './routes/qr.js';
import createRazasRouter from './routes/razas.js';
import createReproduccionRouter from './routes/reproduccion.js';
import createTratamientosRouter from './routes/tratamientos.js';
import createVacunacionesRouter from './routes/vacunaciones.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

// Fail-fast (ADR-014 §13/§21): ningún puerto se abre ni se procesa
// tráfico si APP_ENV no puede resolverse o la configuración es inválida.
// CORRECCIÓN LOTE-002: server/db.js y server/catastroxDb.js ya no
// construyen su pg.Pool como efecto colateral de importarse -- lo hacen
// de forma perezosa (getDbPool()/getCatastroxDbPool()), y exigen que
// getConfig() ya se haya ejecutado con éxito (assertConfigValidated()).
// Ningún Pool existe todavía en este punto del arranque.
let appConfig;
try {
  appConfig = getConfig();
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(`[config] ${error.code}: ${error.message}`);
  } else {
    console.error('[config] Error inesperado validando la configuración del ambiente.', error);
  }
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// TRUST_PROXY_HOPS (server/config/env.js, default 0 = no confiar en ningún
// proxy): número exacto de saltos de reverse proxy confiables delante de
// este backend. Con 0 (default), Express nunca lee X-Forwarded-For y
// req.ip es siempre el socket TCP real -- restrictivo por diseño. Solo
// cuando se configura explícitamente con la topología real (p. ej.
// Cloudflare + ALB) req.ip empieza a resolverse desde X-Forwarded-For, y
// únicamente respetando ese número exacto de saltos.
app.set('trust proxy', appConfig.trustProxyHops);

// Correlation ID / logging estructurado (LOTE-010, ADR-012 §25): montado
// inmediatamente después de crear `app`, antes de CORS, express.json,
// health y cualquier ruta de negocio -- correlationId debe existir durante
// todo el ciclo de vida de la solicitud. X-Request-ID ya está permitido
// por CORS (server/security/corsPolicy.js -- DEFAULT_CORS_HEADERS).
app.use(createRequestLogging());

// Cabeceras de seguridad HTTP (server/security/securityHeaders.js):
// montadas antes de CORS y de cualquier ruta de negocio, igual que el
// resto de middleware transversal. Este backend nunca sirve el SPA (ver
// comentario en securityHeaders.js) -- CSP estricta por diseño.
app.use(createSecurityHeadersMiddleware({ appEnv: appConfig.appEnv }));
app.use(createPermissionsPolicyMiddleware());

// CORS (LOTE-004, ADR-014 §7 Barrera 4/§21): allowlist explícita derivada
// de APP_ENV (server/config/env.js -- appConfig.cors.allowedOrigins), sin
// reflejo de Origin, sin comodines, sin `CORS_ORIGIN` heredada. Montado
// antes de cualquier ruta de negocio.
const corsPolicy = buildExpressCorsPolicy({
  appEnv: appConfig.appEnv,
  allowedOrigins: appConfig.cors.allowedOrigins,
});
app.use(createCorsMiddleware(corsPolicy));
app.use(express.json({ limit: '2mb' }));

// Liveness / health de plataforma (LOTE-005, ADR-012 §5.1/§90): registrado
// antes de cualquier ruta de negocio, sin abrir pools ni depender de
// dependencias funcionales pesadas -- es el único contrato que el target
// group del ALB consumirá en ECS.
app.get('/api/health/live', createLivenessHandler(appConfig.appEnv));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'AgroGenomaX API' });
});

// Readiness por dominio (LOTE-007, ADR-012 §7/§35.A): el token nunca se
// guarda en appConfig (server/config/env.js jamás expone secretos) -- se
// lee directamente de process.env, igual que DATABASE_URL en server/db.js.
app.use('/api/health', createHealthRouter({ healthMonitorToken: process.env.HEALTH_MONITOR_TOKEN }));
// BFF-001 (ADR-009, aprobado v3): sesión segura de Ganadería -- aislado
// de cualquier router de negocio, pool propio (agx_auth, ver
// server/db/agxAuthPool.js), nunca responde en demo. AGX-SUPERADMIN-AUTH-005:
// deploy mínimo -- solo auth/admin/recovery, sin AGX_BUSINESS_DATABASE_URL.
app.use(
  '/api/ganaderia/auth',
  createGanaderiaAuthRouter({
    appEnv: appConfig.appEnv,
    csrfServerSecret: process.env.AGX_CSRF_SERVER_SECRET,
    fingerprintSecret: process.env.AGX_AUTH_FINGERPRINT_SECRET,
    allowedOrigins: appConfig.cors.allowedOrigins,
  }),
);
app.use('/api/catastrox', catastroxRouter);
app.use('/api/catastrox/payments', catastroxPaymentsRouter);

// SPRINT-2-CLIENT-PROVISIONING: router administrativo AISLADO de
// /api/ganaderia/auth -- exige identidad + rol interno super_admin (nunca
// solo sesión). Ver server/routes/ganaderiaAdmin.js para el detalle de
// la precondición de grants de producción todavía pendiente (informe
// Sprint 2, sección N) -- este mount es código, no implica que el
// endpoint pueda escribir hoy en Postgres-AGX producción.
app.use(
  '/api/ganaderia/admin',
  createGanaderiaAdminRouter({
    appEnv: appConfig.appEnv,
    csrfServerSecret: process.env.AGX_CSRF_SERVER_SECRET,
    allowedOrigins: appConfig.cors.allowedOrigins,
  }),
);

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: hallazgo crítico de la auditoría
// "Organizaciones y QR" -- estas rutas de negocio legacy estaban montadas
// sin ningún middleware de autenticación (predios/potreros/qr/animales/
// pesajes/vacunaciones/tratamientos/reproduccion/razas, en especial
// POST /api/qr/asociar, que permitía reasignar cualquier QR a cualquier
// animal sin sesión). Cada router ahora es una fábrica que exige sesión
// Ganadería real (createRequireGanaderiaIdentity -- SOLO agx.sesiones/
// agx.cuentas, nunca agx.organizaciones/membresias: esas tablas todavía
// no existen en producción) + CSRF (createRequireGanaderiaCsrf, se
// auto-omite en GET/HEAD/OPTIONS) en mutaciones. GET /api/qr/:codigo es
// la única excepción deliberada, gateada dentro de qr.js -- ver su
// comentario de cabecera. NO se agrega scoping por organización todavía
// (Sprint 1+, cuando esas tablas existan en producción).
const ganaderiaBusinessRouterConfig = {
  appEnv: appConfig.appEnv,
  csrfServerSecret: process.env.AGX_CSRF_SERVER_SECRET,
  allowedOrigins: appConfig.cors.allowedOrigins,
};
const razasRouterInstance = createRazasRouter(ganaderiaBusinessRouterConfig);
app.use('/api/predios', createPrediosRouter(ganaderiaBusinessRouterConfig));
app.use('/api/potreros', createPotrerosRouter(ganaderiaBusinessRouterConfig));
app.use('/api/qr', createQrRouter(ganaderiaBusinessRouterConfig));
app.use('/api/animales', createAnimalesRouter(ganaderiaBusinessRouterConfig));
app.use('/api/razas', razasRouterInstance);
app.use('/api', razasRouterInstance);
app.use('/api', createPesajesRouter(ganaderiaBusinessRouterConfig));
app.use('/api', createVacunacionesRouter(ganaderiaBusinessRouterConfig));
app.use('/api', createTratamientosRouter(ganaderiaBusinessRouterConfig));
app.use('/api', createReproduccionRouter(ganaderiaBusinessRouterConfig));

app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AgroGenomaX API running on port ${PORT} [APP_ENV=${appConfig.appEnv}]`);
});

// R4/B5-03 (durable autonomous delivery worker): arranca solo después de
// que la configuración ya fue validada y la app está lista para aceptar
// tráfico. Procesa QUEUED/FAILED-vencido/GENERATING-READY-stale sin
// depender de ninguna request HTTP -- NUNCA reclama SENDING de forma
// autónoma (política de seguridad obligatoria, ver
// server/services/catastrox/deliveryWorker.js y
// deliveryJobService.js#findAutonomousDeliveryJobIds).
const deliveryWorker = createDeliveryWorker({
  findJobIds: findAutonomousDeliveryJobIds,
  processJob: processDeliveryJob,
});
deliveryWorker.start();

// Graceful shutdown (LOTE-007, ADR-012 §21): señales registradas
// exclusivamente aquí, en el entrypoint real -- server/lifecycle/
// gracefulShutdown.js nunca las registra por sí mismo. Cierra el
// servidor HTTP antes que los pools (nunca al revés), respeta la
// inicialización perezosa (un pool nunca creado no se crea solo para
// cerrarlo) y nunca ejecuta process.exit() fuera de este único punto.
// El delivery worker se registra ANTES que los pools: su close() detiene
// el scheduling de inmediato y drena el batch en curso con un presupuesto
// acotado (deliveryWorker.js, drainBudgetMs) -- debe terminar (o ceder)
// antes de que los pools de Postgres se cierren debajo de él.
const gracefulShutdown = createGracefulShutdown({
  server,
  resources: [
    { name: 'catastrox_delivery_worker', close: deliveryWorker.stop },
    { name: 'agx_pg_pool', close: closeMainDbPool },
    { name: 'catastrox_pg_pool', close: closeCatastroxDbPool },
    { name: 'agx_auth_pg_pool', close: closeAgxAuthPool },
  ],
  timeoutMs: resolveShutdownTimeoutMs(),
});

process.once('SIGTERM', () => gracefulShutdown.handleSignal('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown.handleSignal('SIGINT'));

