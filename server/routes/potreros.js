import { Router } from 'express';
import { getColumns, insertDynamic, pickPayload, query, tableName } from '../db.js';
import { createRequireGanaderiaCsrf, createRequireGanaderiaIdentity } from '../security/ganaderiaSession.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: ver comentario equivalente en predios.js.
const aliases = {
  predio_id: ['predio_id', 'id_predio', 'farm_id'],
  nombre: ['nombre', 'name'],
  codigo: ['codigo', 'codigo_interno', 'internal_code'],
  area: ['area_ha', 'area'],
  capacidad: ['capacidad', 'capacidad_animales', 'animal_capacity'],
  estado: ['estado', 'status'],
  observaciones: ['observaciones', 'notes'],
};

export default function createPotrerosRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();
  router.use(createRequireGanaderiaIdentity({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', async (req, res, next) => {
    try {
      const columns = await getColumns('potreros');
      const predioColumn = ['predio_id', 'id_predio', 'farm_id'].find((column) => columns.has(column));

      if (req.query.predio_id && predioColumn) {
        const result = await query(
          `select * from ${tableName('potreros')} where "${predioColumn}" = $1 order by 1 desc`,
          [req.query.predio_id],
        );
        res.json(result.rows);
        return;
      }

      const result = await query(`select * from ${tableName('potreros')} order by 1 desc`);
      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      if (!req.body.predio_id) {
        throw Object.assign(new Error('El predio es obligatorio para crear un potrero.'), { status: 400 });
      }
      if (!req.body.nombre) {
        throw Object.assign(new Error('El nombre del potrero es obligatorio.'), { status: 400 });
      }

      const columns = await getColumns('potreros');
      const payload = pickPayload(columns, req.body, aliases);
      const row = await insertDynamic('potreros', payload);
      res.status(201).json(row);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
