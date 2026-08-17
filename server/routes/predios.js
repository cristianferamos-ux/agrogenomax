import { Router } from 'express';
import { getColumns, insertDynamic, pickPayload, query, tableName } from '../db.js';
import { createRequireGanaderiaCsrf, createRequireGanaderiaIdentity } from '../security/ganaderiaSession.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: exige sesión Ganadería válida
// (agx.sesiones/agx.cuentas, NUNCA agx.organizaciones/membresias -- esas
// tablas todavía no existen en producción) en TODAS las rutas de este
// router. CSRF se auto-omite para GET/HEAD/OPTIONS (ver
// createRequireGanaderiaCsrf), así que aplicarlo router-wide es seguro.
const aliases = {
  nombre: ['nombre_predio', 'nombre', 'name'],
  codigo: ['codigo', 'codigo_interno', 'internal_code'],
  propietario: ['propietario', 'owner_name'],
  documento: ['documento', 'owner_document', 'nit'],
  telefono: ['telefono', 'phone'],
  correo: ['correo', 'email'],
  departamento: ['departamento', 'department'],
  municipio: ['municipio', 'municipality'],
  vereda: ['vereda', 'village'],
  area_total: ['area_total', 'area_total_ha', 'total_area_ha'],
  observaciones: ['observaciones', 'notes'],
};

export default function createPrediosRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();
  router.use(createRequireGanaderiaIdentity({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', async (_req, res, next) => {
    try {
      const result = await query(`select * from ${tableName('predios')} order by 1 desc`);
      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      if (!req.body.nombre) {
        throw Object.assign(new Error('El nombre del predio es obligatorio.'), { status: 400 });
      }

      const columns = await getColumns('predios');
      const payload = pickPayload(columns, req.body, aliases);
      const row = await insertDynamic('predios', payload);
      res.status(201).json(row);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
