import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { errorHandler, notFound } from './middleware/errors.js';
import animalesRouter from './routes/animales.js';
import healthRouter from './routes/health.js';
import potrerosRouter from './routes/potreros.js';
import prediosRouter from './routes/predios.js';
import qrRouter from './routes/qr.js';
import razasRouter from './routes/razas.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: 'server/.env' });

const app = express();
const port = Number(process.env.PORT || 3001);

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

app.use(notFound);
app.use(errorHandler);

app.listen(port, () => {
  console.log(`AgroGenomaX API escuchando en http://127.0.0.1:${port}`);
});
