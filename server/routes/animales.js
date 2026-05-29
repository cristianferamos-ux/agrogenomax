import { Router } from 'express';
import {
  getColumns,
  idColumnFor,
  insertDynamic,
  pickColumn,
  pickPayload,
  pool,
  query,
  tableName,
  updateDynamic,
} from '../db.js';
import { findAnimalForQr, findQrByCode } from './qr.js';

const router = Router();

const animalAliases = {
  predio_id: ['predio_id', 'id_predio', 'farm_id'],
  potrero_id: ['potrero_id', 'id_potrero', 'paddock_id'],
  qr_id: ['qr_id', 'qr_code_id', 'id_qr'],
  codigo_qr: ['codigo_qr', 'qr_codigo', 'qr_payload'],
  codigo_interno: ['codigo_interno', 'codigo', 'internal_code', 'code'],
  nombre: ['nombre', 'name'],
  sexo: ['sexo', 'sex'],
  fecha_nacimiento: ['fecha_nacimiento', 'birth_date'],
  peso_nacimiento: ['peso_nacimiento', 'peso_nacimiento_kg', 'birth_weight_kg'],
  color: ['color'],
  numero_arete: ['numero_arete', 'arete', 'tag_number'],
  estado: ['estado', 'status'],
  observaciones: ['observaciones', 'notes'],
};

function validateBreedPayload(tipoRaza, razas = []) {
  if (tipoRaza === 'cruzado') {
    const total = razas.reduce((sum, item) => sum + Number(item.porcentaje || 0), 0);
    if (Math.round(total * 100) / 100 !== 100) {
      throw Object.assign(new Error('La suma de porcentajes raciales debe ser 100%.'), { status: 400 });
    }
  }

  if (tipoRaza === 'puro' && (!razas.length || !razas[0].raza_id)) {
    throw Object.assign(new Error('Selecciona una raza para animal puro.'), { status: 400 });
  }
}

async function insertAnimalBreeds(client, animalId, razas, tipoRaza) {
  const columns = await getColumns('animal_razas');
  const animalColumn = pickColumn(columns, ['animal_id', 'id_animal']);
  const razaColumn = pickColumn(columns, ['raza_id', 'id_raza']);
  const porcentajeColumn = pickColumn(columns, ['porcentaje', 'percentage']);

  if (!animalColumn || !razaColumn) return [];

  const items = tipoRaza === 'puro' ? [{ raza_id: razas[0].raza_id, porcentaje: 100 }] : razas;
  const inserted = [];

  for (const item of items) {
    const row = await insertDynamic(
      'animal_razas',
      {
        [animalColumn]: animalId,
        [razaColumn]: item.raza_id,
        ...(porcentajeColumn ? { [porcentajeColumn]: item.porcentaje } : {}),
      },
      client,
    );
    inserted.push(row);
  }

  return inserted;
}

async function hydrateBreedSummary(client, animalColumns, payload, razas, tipoRaza) {
  const ids = razas.map((item) => item.raza_id).filter(Boolean).slice(0, 3);
  if (!ids.length) return;

  const result = await client.query(
    `select raza_id, nombre_raza from ${tableName('razas')} where raza_id = any($1::bigint[])`,
    [ids],
  );
  const namesById = new Map(result.rows.map((row) => [String(row.raza_id), row.nombre_raza]));

  if (animalColumns.has('es_puro')) payload.es_puro = tipoRaza === 'puro';

  ids.forEach((id, index) => {
    const razaColumn = ['raza_principal', 'raza_secundaria', 'raza_terciaria'][index];
    const porcentajeColumn = ['porcentaje_raza_1', 'porcentaje_raza_2', 'porcentaje_raza_3'][index];
    if (animalColumns.has(razaColumn)) payload[razaColumn] = namesById.get(String(id)) || String(id);
    if (animalColumns.has(porcentajeColumn)) {
      payload[porcentajeColumn] = tipoRaza === 'puro' ? 100 : razas[index]?.porcentaje;
    }
  });
}

router.get('/', async (_req, res, next) => {
  try {
    const result = await query(`select * from ${tableName('animales')} order by 1 desc`);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const columns = await getColumns('animales');
    const idColumn = idColumnFor('animales', columns);
    const result = await query(`select * from ${tableName('animales')} where "${idColumn}" = $1 limit 1`, [req.params.id]);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { codigo_qr, predio_id, potrero_id, sexo, tipo_raza = 'puro', razas = [] } = req.body;

    if (!codigo_qr) throw Object.assign(new Error('El código QR es obligatorio.'), { status: 400 });
    if (!predio_id) throw Object.assign(new Error('El predio es obligatorio.'), { status: 400 });
    if (!potrero_id) throw Object.assign(new Error('El potrero es obligatorio.'), { status: 400 });
    if (!['Macho', 'Hembra'].includes(sexo)) {
      throw Object.assign(new Error('El sexo debe ser Macho o Hembra.'), { status: 400 });
    }

    validateBreedPayload(tipo_raza, razas);

    await client.query('begin');

    const { qr, columns: qrColumns } = await findQrByCode(codigo_qr, client);
    if (!qr) throw Object.assign(new Error('QR no registrado en AgroGenomaX.'), { status: 404 });

    const existingAnimal = await findAnimalForQr(qr, qrColumns, client);
    if (existingAnimal) {
      throw Object.assign(new Error('Este QR ya está asociado a un animal activo.'), { status: 409 });
    }

    const animalColumns = await getColumns('animales');
    const payload = pickPayload(animalColumns, req.body, animalAliases);
    const animalQrColumn = pickColumn(animalColumns, ['qr_id', 'qr_code_id', 'id_qr']);
    const qrIdColumn = idColumnFor('qr_codes', qrColumns);
    if (animalQrColumn && qrIdColumn && qr[qrIdColumn]) payload[animalQrColumn] = qr[qrIdColumn];
    await hydrateBreedSummary(client, animalColumns, payload, razas, tipo_raza);

    const animal = await insertDynamic('animales', payload, client);
    const animalIdColumn = idColumnFor('animales', animalColumns);
    const animalId = animal[animalIdColumn];

    await insertAnimalBreeds(client, animalId, razas, tipo_raza);

    const qrAnimalColumn = pickColumn(qrColumns, ['animal_id', 'id_animal']);
    const qrStatusColumn = pickColumn(qrColumns, ['estado', 'status']);
    const qrUpdates = {};
    if (qrAnimalColumn) qrUpdates[qrAnimalColumn] = animalId;
    if (qrStatusColumn) qrUpdates[qrStatusColumn] = 'asignado';

    if (Object.keys(qrUpdates).length) {
      const setClause = Object.keys(qrUpdates)
        .map((column, index) => `"${column}" = $${index + 1}`)
        .join(', ');
      const params = Object.values(qrUpdates);
      params.push(qr[qrIdColumn]);
      await client.query(`update ${tableName('qr_codes')} set ${setClause} where "${qrIdColumn}" = $${params.length}`, params);
    }

    await client.query('commit');
    res.status(201).json(animal);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const columns = await getColumns('animales');
    const payload = pickPayload(columns, req.body, animalAliases);
    const row = await updateDynamic('animales', req.params.id, payload);

    if (!row) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    res.json(row);
  } catch (error) {
    next(error);
  }
});

export default router;
