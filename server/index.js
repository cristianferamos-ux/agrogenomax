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
import { createDeliveryWorker } from './services/catastrox/deliveryWorker.js';
import { findAutonomousDeliveryJobIds, processDeliveryJob } from './services/catastrox/deliveryJobService.js';
import animalesRouter from './routes/animales.js';
import catastroxRouter from './routes/catastrox.js';
import catastroxPaymentsRouter from './routes/catastroxPayments.js';
import createHealthRouter from './routes/health.js';
import pesajesRouter from './routes/pesajes.js';
import potrerosRouter from './routes/potreros.js';
import prediosRouter from './routes/predios.js';
import qrRouter from './routes/qr.js';
import razasRouter from './routes/razas.js';
import reproduccionRouter from './routes/reproduccion.js';
import tratamientosRouter from './routes/tratamientos.js';
import vacunacionesRouter from './routes/vacunaciones.js';

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
app.use('/api/catastrox', catastroxRouter);
app.use('/api/catastrox/payments', catastroxPaymentsRouter);
app.use('/api/predios', prediosRouter);
app.use('/api/potreros', potrerosRouter);
app.use('/api/qr', qrRouter);
app.use('/api/animales', animalesRouter);
app.use('/api/razas', razasRouter);
app.use('/api', razasRouter);
app.use('/api', pesajesRouter);
app.use('/api', vacunacionesRouter);
app.use('/api', tratamientosRouter);
app.use('/api', reproduccionRouter);

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
  ],
  timeoutMs: resolveShutdownTimeoutMs(),
});

process.once('SIGTERM', () => gracefulShutdown.handleSignal('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown.handleSignal('SIGINT'));

