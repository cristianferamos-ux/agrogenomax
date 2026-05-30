import { Router } from 'express';
import { getColumns, idColumnFor, insertDynamic, pickColumn, pickPayload, query, tableName } from '../db.js';

const router = Router();

const pesajeAliases = {
  animal_id: ['animal_id', 'id_animal'],
  fecha_pesaje: ['fecha_pesaje', 'fecha', 'weighing_date'],
  peso_kg: ['peso_kg', 'peso', 'weight_kg'],
  observaciones: ['observaciones', 'notes'],
};

function todayLocal() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

async function ensureAnimalExists(animalId) {
  const animalColumns = await getColumns('animales');
  const animalIdColumn = idColumnFor('animales', animalColumns);
  const result = await query(`select 1 from ${tableName('animales')} where "${animalIdColumn}" = $1 limit 1`, [animalId]);
  return Boolean(result.rows[0]);
}

function validatePesajePayload(payload) {
  const pesoKg = Number(payload.peso_kg);
  const fechaPesaje = String(payload.fecha_pesaje || '').slice(0, 10);

  if (!payload.animal_id) {
    throw Object.assign(new Error('El animal_id es obligatorio.'), { status: 400 });
  }

  if (!payload.fecha_pesaje) {
    throw Object.assign(new Error('La fecha de pesaje es obligatoria.'), { status: 400 });
  }

  if (fechaPesaje > todayLocal()) {
    throw Object.assign(new Error('La fecha de pesaje no puede ser futura.'), { status: 400 });
  }

  if (!Number.isFinite(pesoKg) || pesoKg <= 0) {
    throw Object.assign(new Error('El peso debe ser mayor que 0.'), { status: 400 });
  }
}

router.get('/animales/:id/pesajes', async (req, res, next) => {
  try {
    const columns = await getColumns('pesajes');
    const animalColumn = pickColumn(columns, pesajeAliases.animal_id);
    const fechaColumn = pickColumn(columns, pesajeAliases.fecha_pesaje);
    const idColumn = idColumnFor('pesajes', columns);

    if (!animalColumn) {
      throw Object.assign(new Error('La tabla agx.pesajes no tiene columna animal_id compatible.'), { status: 500 });
    }

    const exists = await ensureAnimalExists(req.params.id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    const orderParts = [];
    if (fechaColumn) orderParts.push(`"${fechaColumn}" desc`);
    if (idColumn) orderParts.push(`"${idColumn}" desc`);

    const result = await query(
      `select * from ${tableName('pesajes')} where "${animalColumn}" = $1 order by ${orderParts.join(', ') || '1 desc'}`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get('/animales/:id/pesajes/evolucion', async (req, res, next) => {
  try {
    const exists = await ensureAnimalExists(req.params.id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    const result = await query(
      `select *
         from ${tableName('v_pesajes_evolucion')}
        where animal_id = $1
        order by fecha_pesaje desc, pesaje_id desc`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/pesajes', async (req, res, next) => {
  try {
    validatePesajePayload(req.body);

    const exists = await ensureAnimalExists(req.body.animal_id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    const columns = await getColumns('pesajes');
    const payload = pickPayload(columns, req.body, pesajeAliases);
    const pesoColumn = pickColumn(columns, pesajeAliases.peso_kg);

    if (pesoColumn) {
      payload[pesoColumn] = Number(req.body.peso_kg);
    }

    const row = await insertDynamic('pesajes', payload);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

export default router;
