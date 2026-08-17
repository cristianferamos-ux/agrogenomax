import { Router } from 'express';
import { getColumns, idColumnFor, pickColumn, pool, query, tableName } from '../db.js';
import { createRequireGanaderiaCsrf, createRequireGanaderiaIdentity } from '../security/ganaderiaSession.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: server/index.js ya no monta este
// router directamente -- ahora importa el default export como fábrica
// (createQrRouter) y le pasa la config de sesión/CSRF ya validada por
// getConfig() en el arranque. GET /:codigo se deja deliberadamente
// PÚBLICO (sin exigir sesión): la auditoría previa (AGX-SUPERADMIN
// Organizaciones y QR) confirmó que /qr/:codigo es una ruta PÚBLICA real
// en el frontend hoy (App.jsx, "uso público por QR físico" -- alguien
// escanea una chapeta física sin haber iniciado sesión) y que no existe
// ningún relay de Cloudflare que sirva /api/qr con datos reales, por lo
// que exigir sesión aquí rompería ese flujo ya diseñado para ser público
// sin sustituir nada. POST /importar y POST /asociar sí exigen sesión +
// CSRF -- son los dos que la auditoría marcó como hallazgo crítico
// (reasignación de QR sin autenticación).
const qrAnimalCandidates = ['animal_id', 'id_animal'];
const qrStatusCandidates = ['estado', 'status'];
const qrCodeColumn = 'codigo_qr';

async function findQrByCode(codigo, client = null) {
  const columns = await getColumns('qr_codes');

  if (!columns.has(qrCodeColumn)) {
    throw Object.assign(new Error('La tabla agx.qr_codes no tiene la columna codigo_qr.'), {
      status: 500,
    });
  }

  const runner = client || { query };
  const result = await runner.query(
    `select * from ${tableName('qr_codes')} q where q."${qrCodeColumn}" = $1 limit 1`,
    [codigo],
  );

  return { qr: result.rows[0] || null, columns };
}

async function findAnimalForQr(qr, qrColumns, client = null) {
  if (!qr) return null;
  const qrAnimalColumn = pickColumn(qrColumns, qrAnimalCandidates);
  const qrIdColumn = idColumnFor('qr_codes', qrColumns);
  const runner = client || { query };

  if (qrAnimalColumn && qr[qrAnimalColumn]) {
    const result = await runner.query(`select * from ${tableName('animales')} where "animal_id" = $1 limit 1`, [
      qr[qrAnimalColumn],
    ]);
    if (result.rows[0]) return result.rows[0];
  }

  const animalColumns = await getColumns('animales');
  const animalQrColumn = pickColumn(animalColumns, ['qr_id', 'qr_code_id', 'id_qr']);

  if (animalQrColumn && qrIdColumn && qr[qrIdColumn]) {
    const result = await runner.query(
      `select * from ${tableName('animales')} where "${animalQrColumn}" = $1 limit 1`,
      [qr[qrIdColumn]],
    );
    if (result.rows[0]) return result.rows[0];
  }

  return null;
}

export default function createQrRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();
  const requireIdentity = createRequireGanaderiaIdentity({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  // Deliberadamente PÚBLICO -- ver comentario de cabecera del archivo.
  router.get('/:codigo', async (req, res, next) => {
    try {
      const codigo = String(req.params.codigo || '').trim().toUpperCase();
      const { qr, columns } = await findQrByCode(codigo);

      if (!qr) {
        res.status(404).json({ exists: false, codigo });
        return;
      }

      const animal = await findAnimalForQr(qr, columns);
      const statusColumn = pickColumn(columns, qrStatusCandidates);
      const assignedByStatus = statusColumn && String(qr[statusColumn] || '').toLowerCase() === 'asignado';

      res.json({
        exists: true,
        assigned: Boolean(animal || assignedByStatus),
        qr,
        animal,
      });
    } catch (error) {
      console.error('QR route error', {
        codigo: String(req.params.codigo || '').trim().toUpperCase(),
        message: error?.message,
        status: error?.status,
        stack: error?.stack,
      });
      next(error);
    }
  });

  router.post('/importar', requireIdentity, requireCsrf, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.codigos) ? req.body.codigos : [];
    if (!items.length) {
      throw Object.assign(new Error('Debes enviar un arreglo codigos.'), { status: 400 });
    }

    const columns = await getColumns('qr_codes');
    const statusColumn = pickColumn(columns, qrStatusCandidates);
    const rows = [];

    if (!columns.has(qrCodeColumn)) {
      throw Object.assign(new Error('La tabla agx.qr_codes no tiene la columna codigo_qr.'), { status: 500 });
    }

    for (const codigo of items) {
      const params = statusColumn ? [codigo, 'libre'] : [codigo];
      const columnsSql = statusColumn ? `"${qrCodeColumn}", "${statusColumn}"` : `"${qrCodeColumn}"`;
      const valuesSql = statusColumn ? '$1, $2' : '$1';
      const result = await query(
        `insert into ${tableName('qr_codes')} (${columnsSql})
         values (${valuesSql})
         on conflict ("${qrCodeColumn}") do update set "${qrCodeColumn}" = excluded."${qrCodeColumn}"
         returning *`,
        params,
      );
      rows.push(result.rows[0]);
    }

    res.status(201).json(rows);
  } catch (error) {
    next(error);
  }
  });

  router.post('/asociar', requireIdentity, requireCsrf, async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { codigo, animal_id } = req.body;
    if (!codigo || !animal_id) {
      throw Object.assign(new Error('codigo y animal_id son obligatorios.'), { status: 400 });
    }

    await client.query('begin');
    const { qr, columns } = await findQrByCode(codigo, client);

    if (!qr) {
      throw Object.assign(new Error('QR no registrado en AgroGenomaX.'), { status: 404 });
    }

    const existingAnimal = await findAnimalForQr(qr, columns, client);
    if (existingAnimal && String(existingAnimal.animal_id) !== String(animal_id)) {
      throw Object.assign(new Error('Este QR ya está asociado a otro animal.'), { status: 409 });
    }

    const qrAnimalColumn = pickColumn(columns, qrAnimalCandidates);
    const statusColumn = pickColumn(columns, qrStatusCandidates);
    const updates = {};

    if (qrAnimalColumn) updates[qrAnimalColumn] = animal_id;
    if (statusColumn) updates[statusColumn] = 'asignado';

    const setClause = Object.keys(updates)
      .map((column, index) => `"${column}" = $${index + 1}`)
      .join(', ');
    const qrIdColumn = idColumnFor('qr_codes', columns);
    const params = Object.values(updates);
    params.push(qr[qrIdColumn]);

    const result = setClause
      ? await client.query(
          `update ${tableName('qr_codes')} set ${setClause} where "${qrIdColumn}" = $${params.length} returning *`,
          params,
        )
      : { rows: [qr] };

    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
  });

  return router;
}

export { findAnimalForQr, findQrByCode };
