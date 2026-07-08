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
  if (!['puro', 'cruzado'].includes(tipoRaza)) {
    throw Object.assign(new Error('Selecciona si el animal es puro o cruzado.'), { status: 400 });
  }

  if (tipoRaza === 'cruzado') {
    const total = razas.reduce((sum, item) => sum + Number(item.porcentaje || 0), 0);
    if (Math.round(total * 100) / 100 !== 100) {
      throw Object.assign(new Error('La suma de porcentajes raciales debe ser 100%.'), { status: 400 });
    }

    if (!razas.length || razas.some((item) => !item.raza_id || Number(item.porcentaje || 0) <= 0)) {
      throw Object.assign(new Error('Selecciona cada raza e ingresa porcentajes mayores a cero.'), { status: 400 });
    }
  }

  if (tipoRaza === 'puro' && (!razas.length || !razas[0].raza_id)) {
    throw Object.assign(new Error('Selecciona una raza para animal puro.'), { status: 400 });
  }
}

function parseDecimal(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function todayLocal() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
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

router.get('/:id/razas', async (req, res, next) => {
  try {
    const result = await query(
      `select ar.*, r.nombre_raza, r.aptitud, r.origen
         from ${tableName('animal_razas')} ar
         left join ${tableName('razas')} r on r.raza_id = ar.raza_id
        where ar.animal_id = $1
        order by ar.porcentaje desc, r.nombre_raza asc`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const columns = await getColumns('animales');
    const idColumn = idColumnFor('animales', columns);
    const result = await query(
      `select
          a.*,
          p.nombre_predio,
          po.nombre as nombre_potrero
         from ${tableName('animales')} a
         left join ${tableName('predios')} p on p.predio_id = a.predio_id
         left join ${tableName('potreros')} po on po.potrero_id = a.potrero_id
        where a."${idColumn}" = $1
        limit 1`,
      [req.params.id],
    );
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
    const { codigo_qr, predio_id, potrero_id, sexo, tipo_raza, razas = [] } = req.body;

    if (!codigo_qr) throw Object.assign(new Error('El código QR es obligatorio.'), { status: 400 });
    if (!predio_id) throw Object.assign(new Error('El predio es obligatorio.'), { status: 400 });
    if (!potrero_id) throw Object.assign(new Error('El potrero es obligatorio.'), { status: 400 });
    if (!['Macho', 'Hembra'].includes(sexo)) {
      throw Object.assign(new Error('El sexo debe ser Macho o Hembra.'), { status: 400 });
    }

    if (req.body.peso_nacimiento && (!parseDecimal(req.body.peso_nacimiento) || parseDecimal(req.body.peso_nacimiento) <= 0)) {
      throw Object.assign(new Error('El peso al nacimiento debe ser mayor que 0.'), { status: 400 });
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
    const normalizedBody = {
      ...req.body,
      peso_nacimiento: parseDecimal(req.body.peso_nacimiento) ?? req.body.peso_nacimiento,
    };
    const payload = pickPayload(animalColumns, normalizedBody, animalAliases);
    const animalQrColumn = pickColumn(animalColumns, ['qr_id', 'qr_code_id', 'id_qr']);
    const qrIdColumn = idColumnFor('qr_codes', qrColumns);
    if (animalQrColumn && qrIdColumn && qr[qrIdColumn]) payload[animalQrColumn] = qr[qrIdColumn];
    await hydrateBreedSummary(client, animalColumns, payload, razas, tipo_raza);

    const animal = await insertDynamic('animales', payload, client);
    const animalIdColumn = idColumnFor('animales', animalColumns);
    const animalId = animal[animalIdColumn];

    await insertAnimalBreeds(client, animalId, razas, tipo_raza);

    const pesoNacimiento = parseDecimal(req.body.peso_nacimiento);
    if (pesoNacimiento && pesoNacimiento > 0) {
      const pesajeColumns = await getColumns('pesajes');
      const pesajeAnimalColumn = pickColumn(pesajeColumns, ['animal_id', 'id_animal']);
      const fechaColumn = pickColumn(pesajeColumns, ['fecha_pesaje', 'fecha', 'weighing_date']);
      const pesoColumn = pickColumn(pesajeColumns, ['peso_kg', 'peso', 'weight_kg']);
      const observacionesColumn = pickColumn(pesajeColumns, ['observaciones', 'notes']);

      if (pesajeAnimalColumn && fechaColumn && pesoColumn) {
        await insertDynamic(
          'pesajes',
          {
            [pesajeAnimalColumn]: animalId,
            [fechaColumn]: req.body.fecha_nacimiento || todayLocal(),
            [pesoColumn]: pesoNacimiento,
            ...(observacionesColumn ? { [observacionesColumn]: 'Peso inicial registrado al nacimiento' } : {}),
          },
          client,
        );
      }
    }

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
    const normalizedBody = {
      ...req.body,
      peso_nacimiento: parseDecimal(req.body.peso_nacimiento) ?? req.body.peso_nacimiento,
    };
    const payload = pickPayload(columns, normalizedBody, animalAliases);
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
