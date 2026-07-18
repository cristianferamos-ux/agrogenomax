import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigurationError, getConfig } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import animalesRouter from './routes/animales.js';
import catastroxRouter from './routes/catastrox.js';
import catastroxPaymentsRouter from './routes/catastroxPayments.js';
import healthRouter from './routes/health.js';
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
const localOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const configuredOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];
const allowedOrigins = [...new Set([...localOrigins, ...configuredOrigins])];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origen no permitido por CORS.'));
    },
  }),
);
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'AgroGenomaX API' });
});

app.use('/api/health', healthRouter);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AgroGenomaX API running on port ${PORT} [APP_ENV=${appConfig.appEnv}]`);
});

