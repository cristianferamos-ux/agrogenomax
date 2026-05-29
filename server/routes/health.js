import { Router } from 'express';
import { query, schema } from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    await query('select 1');
    res.json({ ok: true, database: 'connected', schema });
  } catch (error) {
    next(error);
  }
});

export default router;
