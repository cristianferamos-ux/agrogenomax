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
  exportChapetaProveedor,
  exportLoteProveedor,
  getChapetaAdmin,
  getLote,
  importarLoteLegacy,
  listLotes,
  reemplazarChapetaAdmin,
} from '../services/ganaderia/qrInventarioRepository.js';
import { buildProveedorHtml } from '../services/ganaderia/qrProveedorExport.js';
import {
  buildManifestCsv,
  buildPaqueteFabricacion,
  buildReferenciaPdf,
  prepararFabricacion,
} from '../services/ganaderia/qrFabricacionPaquete.js';
import { FabricacionVerificationError } from '../services/ganaderia/qrFabricacionGeometria.js';
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

// FASE 15 -- descargas de fabricación (montadas DETRÁS de sesión + Super
// Admin + CSRF del router). Solo lectura. Toda salida pasa por la
// verificación de prepararFabricacion: ante cualquier diferencia se aborta
// (500 EXPORT_VERIFICATION_FAILED) sin entregar un paquete parcial. Las
// dependencias se inyectan solo en tests.
function sendAttachment(res, { filename, type, body, csp }) {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (csp) res.setHeader('Content-Security-Policy', csp);
  res.type(type).send(body);
}

function logVerificacion(error, ref) {
  if (error instanceof FabricacionVerificationError) {
    console.error(`[ganaderia-admin-qr] export abortado (${ref}): ${error.detalle}`);
  }
}

export function createFabricacionExportHandlers({
  loadLote = exportLoteProveedor,
  loadChapeta = exportChapetaProveedor,
} = {}) {
  async function loteExportable(req, res) {
    if (!requireId(res, req.params.loteId, 'INVALID_LOTE_ID')) return null;
    const data = await loadLote(req.params.loteId);
    if (!data) {
      res.status(404).json({ error: 'LOTE_NOT_FOUND' });
      return null;
    }
    if (data.lote.tipo !== 'QR_AGX') {
      res.status(409).json({ error: 'LOTE_LEGACY_SIN_ARCHIVO' });
      return null;
    }
    return data;
  }

  function verificado(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (error) {
        logVerificacion(error, req.params.loteId ? `lote ${req.params.loteId}` : `qr ${req.params.qrId}`);
        throw error;
      }
    };
  }

  return {
    paqueteZip: verificado(async (req, res) => {
      const data = await loteExportable(req, res);
      if (!data) return;
      const paquete = await buildPaqueteFabricacion(data);
      res.setHeader('X-Content-SHA256', paquete.sha256);
      sendAttachment(res, { filename: paquete.filename, type: 'application/zip', body: paquete.buffer });
    }),
    referenciaPdf: verificado(async (req, res) => {
      const data = await loteExportable(req, res);
      if (!data) return;
      const pdf = await buildReferenciaPdf(prepararFabricacion(data));
      sendAttachment(res, { filename: `${data.lote.codigoLote}-referencia.pdf`, type: 'application/pdf', body: pdf });
    }),
    manifestCsv: verificado(async (req, res) => {
      const data = await loteExportable(req, res);
      if (!data) return;
      sendAttachment(res, {
        filename: `${data.lote.codigoLote}-manifest.csv`,
        type: 'text/csv; charset=utf-8',
        body: buildManifestCsv(prepararFabricacion(data)),
      });
    }),
    vistaPreviaHtml: verificado(async (req, res) => {
      const data = await loteExportable(req, res);
      if (!data) return;
      prepararFabricacion(data);
      sendAttachment(res, {
        filename: `${data.lote.codigoLote}-vista-previa.html`,
        type: 'text/html; charset=utf-8',
        body: buildProveedorHtml(data),
        csp: "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
    }),
    arteSvg: verificado(async (req, res) => {
      if (!requireId(res, req.params.qrId, 'INVALID_QR_ID')) return;
      const data = await loadChapeta(req.params.qrId);
      if (!data) {
        res.status(404).json({ error: 'QR_NOT_FOUND' });
        return;
      }
      if (data.lote.tipo !== 'QR_AGX') {
        res.status(409).json({ error: 'LOTE_LEGACY_SIN_ARCHIVO' });
        return;
      }
      const [item] = prepararFabricacion({ lote: data.lote, chapetas: [data.chapeta] }, { cantidadEsperada: 1 }).items;
      sendAttachment(res, { filename: item.filename, type: 'image/svg+xml', body: item.svg, csp: "default-src 'none'" });
    }),
  };
}

export default function createGanaderiaAdminQrRouter({ appEnv, csrfServerSecret, allowedOrigins, fabricacionLoaders } = {}) {
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

  const fabricacion = createFabricacionExportHandlers(fabricacionLoaders);
  router.get('/lotes/:loteId/paquete.zip', handler(fabricacion.paqueteZip));
  router.get('/lotes/:loteId/referencia.pdf', handler(fabricacion.referenciaPdf));
  router.get('/lotes/:loteId/manifest.csv', handler(fabricacion.manifestCsv));
  router.get('/lotes/:loteId/proveedor.html', handler(fabricacion.vistaPreviaHtml));
  router.get('/chapetas/:qrId/arte.svg', handler(fabricacion.arteSvg));

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
