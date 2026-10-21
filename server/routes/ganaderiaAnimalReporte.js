// FASE 1C.2 -- REPORTE PRODUCTIVO INDIVIDUAL (PDF generado en servidor con
// pdfkit). Monta en /api/ganaderia/animales/:animalId/reporte-productivo.pdf
// (server/index.js), ANTES del router de animales. Mismo contrato de
// seguridad que ganaderiaAnimalPesajes.js: sesión obligatoria; el tenant sale
// EXCLUSIVAMENTE de req.ganaderiaAuth (nunca de query/body/headers); GET sin
// CSRF (política de lectura). Solo Postgres-AGX-Business; nunca legacy.
//
//   GET -> 200 application/pdf (attachment; no-store)
//          400 INVALID_ANIMAL_ID
//          401 SESSION_REQUIRED / SESSION_INVALID
//          404 ANIMAL_NOT_FOUND (inexistente o de otra organización: no se
//              distingue). Un animal ANULADO sí tiene reporte.
import { Router } from 'express';
import { createRequireGanaderiaCsrf, createRequireGanaderiaSession } from '../security/ganaderiaSession.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import { cargarDatosReporteProductivo, generarReporteProductivo } from '../services/ganaderia/reporteProductivo/reporteProductivoService.js';

export default function createGanaderiaAnimalReporteRouter({
  appEnv,
  csrfServerSecret,
  allowedOrigins,
  cargarDatos = cargarDatosReporteProductivo,
  reloj = () => new Date(),
} = {}) {
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      const reporte = await generarReporteProductivo(req.ganaderiaAuth.organizacionId, req.params.animalId, {
        ahora: reloj(),
        cargarDatos,
      });
      if (!reporte) {
        res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${reporte.modelo.nombreArchivo}"`);
      res.setHeader('Content-Length', String(reporte.pdf.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).end(reporte.pdf);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
