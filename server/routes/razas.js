import { Router } from 'express';
import { getColumns, insertDynamic, pickPayload, query, tableName } from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const result = await query(`select * from ${tableName('razas')} order by 1 asc`);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/animal-razas', async (req, res, next) => {
  try {
    const columns = await getColumns('animal_razas');
    const payload = pickPayload(columns, req.body, {
      animal_id: ['animal_id', 'id_animal'],
      raza_id: ['raza_id', 'id_raza'],
      porcentaje: ['porcentaje', 'percentage'],
    });
    const row = await insertDynamic('animal_razas', payload);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

export default router;
