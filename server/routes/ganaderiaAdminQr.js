// SPRINT-3D11.3 (R1) -- Administración > QR Ganadería / Inventario de
// chapetas. Monta en /api/ganaderia/admin/qr (server/index.js) y reutiliza
// EXACTAMENTE la autorización del panel admin existente
// (createRequireGanaderiaIdentity + createRequireGanaderiaSuperAdmin +
// CSRF en mutaciones). Una cuenta cliente recibe 403 en toda la superficie.
// La base de datos se opera con el rol agx_qr_admin (conexión propia,
// server/db/agxQrAdminPool.js); agx_app nunca toca el inventario global.
import { Router } from 'express';
import {
  createRequireGanaderiaCsrf,
  createRequireGanaderiaIdentity,
  createRequireGanaderiaSuperAdmin,
} from '../security/ganaderiaSession.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import {
  validateAsignarBody,
  validateBajaAdminBody,
  validateBuscarChapetasQuery,
  validateCrearLoteBody,
  validateEstadoLoteBody,
  validateImportarLegacyBody,
  validateListLotesQuery,
  validateReemplazarBody,
} from '../services/ganaderia/qrValidation.js';
import {
  asignarChapetas,
  bajaChapetaAdmin,
  buscarChapetas,
  cambiarEstadoLote,
  crearLote,
  exportLoteProveedor,
  getChapetaAdmin,
  getLote,
  importarLoteLegacy,
  listLotes,
  reemplazarChapetaAdmin,
} from '../services/ganaderia/qrInventarioRepository.js';
import { buildProveedorCsv, buildProveedorHtml } from '../services/ganaderia/qrProveedorExport.js';
import { isOrganizacionActiva, listOrganizacionesActivas } from '../services/ganaderia/qrOrganizaciones.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    const body = { error: error.code, message: error.message };
    if (Array.isArray(error.codigos)) body.codigos = error.codigos.slice(0, 50);
    if (typeof error.estado === 'string') body.estado = error.estado;
    if (typeof error.disponibles === 'number') body.disponibles = error.disponibles;
    res.status(error.status).json(body);
    return true;
  }
  return false;
}

// Dominio impreso en el QR: SIEMPRE la configuración del servidor
// (AGX_QR_PUBLIC_ORIGIN, validada en server/config/env.js), nunca Origin,
// Referer ni nada enviado por el navegador. Sin variable -> 503 fail-closed.
export function resolveQrPublicOrigin(source = process.env) {
  const raw = source.AGX_QR_PUBLIC_ORIGIN;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const url = new URL(raw);
    return url.origin === raw && (url.protocol === 'https:' || url.protocol === 'http:') ? raw : null;
  } catch {
    return null;
  }
}

function handler(fn) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  };
}

function requireId(res, value, code) {
  if (isValidPositiveId(value)) return true;
  res.status(400).json({ error: code });
  return false;
}

export default function createGanaderiaAdminQrRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  router.use(createRequireGanaderiaIdentity({ appEnv }));
  router.use(createRequireGanaderiaSuperAdmin());
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  const actor = (req) => ({ actorCuentaId: req.ganaderiaAuth.cuentaId });

  router.get('/organizaciones', handler(async (req, res) => {
    res.json({ ok: true, organizaciones: await listOrganizacionesActivas() });
  }));

  router.get('/lotes', handler(async (req, res) => {
    const paging = validateListLotesQuery(req.query);
    res.json({ ok: true, ...(await listLotes(paging)), ...paging });
  }));

  router.post('/lotes', handler(async (req, res) => {
    const value = validateCrearLoteBody(req.body);
    const urlBase = resolveQrPublicOrigin();
    if (!urlBase) {
      res.status(503).json({ error: 'QR_PUBLIC_ORIGIN_NOT_CONFIGURED' });
      return;
    }
    const { lote, yaExistia } = await crearLote({ ...value, urlBase }, actor(req));
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, lote });
  }));

  router.post('/lotes/importar-legacy', handler(async (req, res) => {
    const value = validateImportarLegacyBody(req.body);
    const { lote, yaExistia } = await importarLoteLegacy(value, actor(req));
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, lote });
  }));

  router.get('/lotes/:loteId', handler(async (req, res) => {
    if (!requireId(res, req.params.loteId, 'INVALID_LOTE_ID')) return;
    const detalle = await getLote(req.params.loteId);
    if (!detalle) {
      res.status(404).json({ error: 'LOTE_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...detalle });
  }));

  router.post('/lotes/:loteId/estado', handler(async (req, res) => {
    if (!requireId(res, req.params.loteId, 'INVALID_LOTE_ID')) return;
    const { estado } = validateEstadoLoteBody(req.body);
    res.json({ ok: true, ...(await cambiarEstadoLote(req.params.loteId, estado, actor(req))) });
  }));

  router.post('/lotes/:loteId/asignar', handler(async (req, res) => {
    if (!requireId(res, req.params.loteId, 'INVALID_LOTE_ID')) return;
    const value = validateAsignarBody(req.body);
    if (!(await isOrganizacionActiva(value.organizacionId))) {
      res.status(404).json({ error: 'ORGANIZACION_NOT_FOUND' });
      return;
    }
    const result = await asignarChapetas(req.params.loteId, value, actor(req));
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  async function sendExport(req, res, format) {
    if (!requireId(res, req.params.loteId, 'INVALID_LOTE_ID')) return;
    const data = await exportLoteProveedor(req.params.loteId);
    if (!data) {
      res.status(404).json({ error: 'LOTE_NOT_FOUND' });
      return;
    }
    if (data.lote.tipo !== 'QR_AGX') {
      res.status(409).json({ error: 'LOTE_LEGACY_SIN_ARCHIVO' });
      return;
    }
    const filename = `${data.lote.codigoLote}-proveedor.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (format === 'csv') {
      res.type('text/csv; charset=utf-8').send(buildProveedorCsv(data));
    } else {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.type('text/html; charset=utf-8').send(await buildProveedorHtml(data));
    }
  }

  router.get('/lotes/:loteId/proveedor.csv', handler((req, res) => sendExport(req, res, 'csv')));
  router.get('/lotes/:loteId/proveedor.html', handler((req, res) => sendExport(req, res, 'html')));

  router.get('/chapetas', handler(async (req, res) => {
    const filtros = validateBuscarChapetasQuery(req.query);
    res.json({ ok: true, ...(await buscarChapetas(filtros)), limit: filtros.limit, offset: filtros.offset });
  }));

  router.get('/chapetas/:qrId', handler(async (req, res) => {
    if (!requireId(res, req.params.qrId, 'INVALID_QR_ID')) return;
    const detalle = await getChapetaAdmin(req.params.qrId);
    if (!detalle) {
      res.status(404).json({ error: 'QR_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...detalle });
  }));

  for (const [path, causa] of [['revocar', 'REVOCADO'], ['danada', 'DANADO']]) {
    router.post(`/chapetas/:qrId/${path}`, handler(async (req, res) => {
      if (!requireId(res, req.params.qrId, 'INVALID_QR_ID')) return;
      const { motivo } = validateBajaAdminBody(req.body);
      res.json({ ok: true, ...(await bajaChapetaAdmin(req.params.qrId, { causa, motivo }, actor(req))) });
    }));
  }

  router.post('/chapetas/:qrId/reemplazar', handler(async (req, res) => {
    if (!requireId(res, req.params.qrId, 'INVALID_QR_ID')) return;
    const value = validateReemplazarBody(req.body);
    const result = await reemplazarChapetaAdmin(req.params.qrId, value, actor(req));
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  return router;
}
