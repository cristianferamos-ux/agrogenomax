import { Router } from 'express';
import { getColumns, idColumnFor, insertDynamic, pickColumn, pickPayload, query, schema, tableName } from '../db.js';
import { createRequireGanaderiaCsrf, createRequireGanaderiaIdentity } from '../security/ganaderiaSession.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: ver comentario equivalente en predios.js.
const table = 'tratamientos';

const tratamientoAliases = {
  animal_id: ['animal_id', 'id_animal'],
  fecha_inicio: ['fecha_inicio', 'fecha', 'fecha_tratamiento'],
  fecha_finalizacion: ['fecha_finalizacion', 'fecha_fin'],
  motivo: ['motivo'],
  diagnostico: ['diagnostico'],
  sintomas: ['sintomas'],
  estado_caso: ['estado_caso', 'estado'],
  nombre_comercial: ['nombre_comercial', 'medicamento'],
  principio_activo: ['principio_activo'],
  laboratorio: ['laboratorio'],
  lote: ['lote'],
  dosis: ['dosis'],
  unidad: ['unidad'],
  via_aplicacion: ['via_aplicacion'],
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
  const animalColumn = pickColumn(columns, tratamientoAliases.animal_id);
  const fechaColumn = pickColumn(columns, tratamientoAliases.fecha_inicio);
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

export default function createTratamientosRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();
  router.use(createRequireGanaderiaIdentity({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/tratamientos', async (req, res, next) => {
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

router.get('/animales/:id/tratamientos', async (req, res, next) => {
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

router.post('/tratamientos', async (req, res, next) => {
  try {
    if (!(await tableExists())) {
      res.status(501).json({ error: 'Endpoint activo, pero la tabla agx.tratamientos no está configurada.' });
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
    const payload = pickPayload(columns, req.body, tratamientoAliases);
    const row = await insertDynamic(table, payload);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
  });

  return router;
}
