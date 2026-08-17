import { Router } from 'express';
import { getColumns, idColumnFor, insertDynamic, pickColumn, pickPayload, query, schema, tableName } from '../db.js';
import { createRequireGanaderiaCsrf, createRequireGanaderiaIdentity } from '../security/ganaderiaSession.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: ver comentario equivalente en predios.js.
const table = 'reproduccion';

const reproduccionAliases = {
  animal_id: ['animal_id', 'id_animal'],
  fecha: ['fecha', 'fecha_evento'],
  tipo_evento: ['tipo_evento', 'evento'],
  estado: ['estado'],
  diagnostico: ['diagnostico'],
  metodo: ['metodo'],
  observaciones: ['observaciones', 'notes'],
};

async function tableExists() {
  const result = await query(
    `select 1 from information_schema.tables where table_schema = $1 and table_name = $2 limit 1`,
    [schema, table],
  );
  return Boolean(result.rows[0]);
}

async function ensureAnimalExists(animalId) {
  const animalColumns = await getColumns('animales');
  const animalIdColumn = idColumnFor('animales', animalColumns);
  const result = await query(`select 1 from ${tableName('animales')} where "${animalIdColumn}" = $1 limit 1`, [animalId]);
  return Boolean(result.rows[0]);
}

async function listByAnimal(animalId) {
  if (!(await tableExists())) return [];

  const columns = await getColumns(table);
  const animalColumn = pickColumn(columns, reproduccionAliases.animal_id);
  const fechaColumn = pickColumn(columns, reproduccionAliases.fecha);
  const idColumn = idColumnFor(table, columns);

  if (!animalColumn) return [];

  const orderParts = [];
  if (fechaColumn) orderParts.push(`"${fechaColumn}" desc`);
  if (idColumn) orderParts.push(`"${idColumn}" desc`);

  const result = await query(
    `select * from ${tableName(table)} where "${animalColumn}" = $1 order by ${orderParts.join(', ') || '1 desc'}`,
    [animalId],
  );
  return result.rows;
}

export default function createReproduccionRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();
  router.use(createRequireGanaderiaIdentity({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/reproduccion', async (req, res, next) => {
  try {
    if (!req.query.animal_id) {
      res.json([]);
      return;
    }

    res.json(await listByAnimal(req.query.animal_id));
  } catch (error) {
    next(error);
  }
});

router.get('/animales/:id/reproduccion', async (req, res, next) => {
  try {
    const exists = await ensureAnimalExists(req.params.id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    res.json(await listByAnimal(req.params.id));
  } catch (error) {
    next(error);
  }
});

router.post('/reproduccion', async (req, res, next) => {
  try {
    if (!(await tableExists())) {
      res.status(501).json({ error: 'Endpoint activo, pero la tabla agx.reproduccion no está configurada.' });
      return;
    }

    if (!req.body.animal_id) {
      res.status(400).json({ error: 'El animal_id es obligatorio.' });
      return;
    }

    const exists = await ensureAnimalExists(req.body.animal_id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    const columns = await getColumns(table);
    const payload = pickPayload(columns, req.body, reproduccionAliases);
    const row = await insertDynamic(table, payload);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
  });

  return router;
}
