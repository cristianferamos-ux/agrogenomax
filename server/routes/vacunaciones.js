import { Router } from 'express';
import { getColumns, idColumnFor, insertDynamic, pickColumn, pickPayload, query, tableName } from '../db.js';

const router = Router();

const catalogoAliases = {
  nombre_vacuna: ['nombre_vacuna', 'nombre', 'vacuna'],
  enfermedad_objetivo: ['enfermedad_objetivo', 'enfermedad'],
  laboratorio: ['laboratorio'],
  dosis_sugerida: ['dosis_sugerida', 'dosis'],
  intervalo_dias: ['intervalo_dias'],
  estado: ['estado'],
  observaciones: ['observaciones', 'notes'],
};

const vacunacionAliases = {
  animal_id: ['animal_id', 'id_animal'],
  catalogo_vacuna_id: ['catalogo_vacuna_id', 'vacuna_id'],
  vacuna: ['vacuna'],
  fecha_aplicacion: ['fecha_aplicacion'],
  lote: ['lote'],
  laboratorio: ['laboratorio'],
  dosis: ['dosis'],
  fecha_proxima: ['fecha_proxima', 'proxima_aplicacion'],
  observaciones: ['observaciones', 'notes'],
};

async function ensureAnimalExists(animalId) {
  const animalColumns = await getColumns('animales');
  const animalIdColumn = idColumnFor('animales', animalColumns);
  const result = await query(`select 1 from ${tableName('animales')} where "${animalIdColumn}" = $1 limit 1`, [animalId]);
  return Boolean(result.rows[0]);
}

async function findCatalogoVacuna(catalogoVacunaId) {
  const columns = await getColumns('catalogo_vacunas');
  const idColumn = idColumnFor('catalogo_vacunas', columns);
  const result = await query(`select * from ${tableName('catalogo_vacunas')} where "${idColumn}" = $1 limit 1`, [catalogoVacunaId]);
  return result.rows[0];
}

function validateCatalogoPayload(payload) {
  if (!payload.nombre_vacuna && !payload.nombre && !payload.vacuna) {
    throw Object.assign(new Error('El nombre de la vacuna es obligatorio.'), { status: 400 });
  }
}

function validateVacunacionPayload(payload) {
  if (!payload.animal_id) {
    throw Object.assign(new Error('El animal_id es obligatorio.'), { status: 400 });
  }

  if (!payload.catalogo_vacuna_id && !payload.vacuna_id) {
    throw Object.assign(new Error('Selecciona una vacuna del catálogo.'), { status: 400 });
  }

  if (!payload.fecha_aplicacion) {
    throw Object.assign(new Error('La fecha de aplicacion es obligatoria.'), { status: 400 });
  }
}

router.get('/catalogo-vacunas', async (_req, res, next) => {
  try {
    const result = await query(
      `select *
         from ${tableName('catalogo_vacunas')}
        where coalesce(estado, 'activo') = 'activo'
        order by nombre_vacuna asc`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/catalogo-vacunas', async (req, res, next) => {
  try {
    validateCatalogoPayload(req.body);
    const columns = await getColumns('catalogo_vacunas');
    const payload = pickPayload(columns, req.body, catalogoAliases);
    const row = await insertDynamic('catalogo_vacunas', payload);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.get('/animales/:id/vacunaciones', async (req, res, next) => {
  try {
    const exists = await ensureAnimalExists(req.params.id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    const result = await query(
      `select
          v.*,
          v.fecha_proxima as proxima_aplicacion,
          cv.nombre_vacuna,
          cv.enfermedad_objetivo,
          case
            when v.fecha_proxima is null then null
            when v.fecha_proxima < current_date then 'Vencida'
            when v.fecha_proxima <= current_date + interval '30 days' then 'Próxima a vencer'
            else 'Vigente'
          end as alerta
         from ${tableName('vacunaciones')} v
         left join ${tableName('catalogo_vacunas')} cv on cv.catalogo_vacuna_id = v.catalogo_vacuna_id
        where v.animal_id = $1
        order by v.fecha_aplicacion desc, v.vacunacion_id desc`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/vacunaciones', async (req, res, next) => {
  try {
    validateVacunacionPayload(req.body);

    const exists = await ensureAnimalExists(req.body.animal_id);
    if (!exists) {
      res.status(404).json({ error: 'Animal no encontrado' });
      return;
    }

    const catalogoVacunaId = req.body.catalogo_vacuna_id || req.body.vacuna_id;
    const catalogo = await findCatalogoVacuna(catalogoVacunaId);
    if (!catalogo) {
      res.status(404).json({ error: 'Vacuna no encontrada en catálogo.' });
      return;
    }

    const columns = await getColumns('vacunaciones');
    const normalizedBody = {
      ...req.body,
      catalogo_vacuna_id: catalogoVacunaId,
      fecha_proxima: req.body.fecha_proxima || req.body.proxima_aplicacion,
    };
    const payload = pickPayload(columns, normalizedBody, vacunacionAliases);
    const vacunaColumn = pickColumn(columns, vacunacionAliases.vacuna);
    const laboratorioColumn = pickColumn(columns, vacunacionAliases.laboratorio);
    const dosisColumn = pickColumn(columns, vacunacionAliases.dosis);

    if (vacunaColumn) payload[vacunaColumn] = catalogo.nombre_vacuna;
    if (laboratorioColumn && !payload[laboratorioColumn] && catalogo.laboratorio) payload[laboratorioColumn] = catalogo.laboratorio;
    if (dosisColumn && !payload[dosisColumn] && catalogo.dosis_sugerida) payload[dosisColumn] = catalogo.dosis_sugerida;

    const row = await insertDynamic('vacunaciones', payload);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

export default router;
