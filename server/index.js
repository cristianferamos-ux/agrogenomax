import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { errorHandler, notFound } from './middleware/errors.js';
import animalesRouter from './routes/animales.js';
import healthRouter from './routes/health.js';
import pesajesRouter from './routes/pesajes.js';
import potrerosRouter from './routes/potreros.js';
import prediosRouter from './routes/predios.js';
import qrRouter from './routes/qr.js';
import razasRouter from './routes/razas.js';
import vacunacionesRouter from './routes/vacunaciones.js';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') || true,
  }),
);
app.use(express.json({ limit: '2mb' }));

app.use('/api/health', healthRouter);
app.use('/api/predios', prediosRouter);
app.use('/api/potreros', potrerosRouter);
app.use('/api/qr', qrRouter);
app.use('/api/animales', animalesRouter);
app.use('/api/razas', razasRouter);
app.use('/api', razasRouter);
app.use('/api', pesajesRouter);
app.use('/api', vacunacionesRouter);

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'AgroGenomaX API' });
});

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AgroGenomaX API running on port ${PORT}`);
});
