import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'api', status: 'running' });
});

router.get('/db', async (_req, res, next) => {
  try {
    const { query, schema } = await import('../db.js');
    await query('select 1');
    res.json({ ok: true, database: 'connected', schema });
  } catch (error) {
    next(error);
  }
});

export default router;
