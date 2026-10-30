// FASE 1C.2 -- datos del reporte productivo individual. Habla solo con
// Postgres-AGX-Business bajo el tenant de la sesión (withOrganizacionTransaction
// + RLS): el animal (getAnimal) y su historial derivado de pesajes
// (obtenerHistorialPesajes, motor canónico). Nunca legacy, Demo ni vistas.
// null si el animal no existe o es de otra organización (la ruta responde 404
// sin distinguir ambos casos).
// FASE 2C: también la chapeta QR del animal (getChapetasDeAnimal), proyectada
// a código visible + estado: qrId, token y metadata nunca llegan al modelo.
import { getAnimal } from '../animalesRepository.js';
import { obtenerHistorialPesajes } from '../pesajesService.js';
import { getChapetasDeAnimal } from '../qrChapetasRepository.js';
import { construirReporteProductivo } from './reporteProductivoModelo.js';
import { generarPdfReporteProductivo } from './reporteProductivoPdf.js';

const proyectarChapeta = (c) => (c ? { codigoVisible: c.codigoVisible, estado: c.estado } : null);

export async function cargarDatosReporteProductivo(organizacionId, animalId) {
  const animal = await getAnimal(organizacionId, animalId);
  if (!animal) return null;
  const historial = await obtenerHistorialPesajes(organizacionId, animalId);
  if (!historial) return null;
  const chapetas = await getChapetasDeAnimal(organizacionId, animalId);
  if (!chapetas) return null;
  return {
    animal,
    historial,
    chapetas: { activa: proyectarChapeta(chapetas.activa), historial: chapetas.historial.map(proyectarChapeta) },
  };
}

/** { modelo, pdf } o null (animal inexistente o ajeno). */
export async function generarReporteProductivo(organizacionId, animalId, { ahora = new Date(), cargarDatos = cargarDatosReporteProductivo } = {}) {
  const datos = await cargarDatos(organizacionId, animalId);
  if (!datos) return null;
  const modelo = construirReporteProductivo({ ...datos, ahora });
  const pdf = await generarPdfReporteProductivo(modelo, { ahora });
  return { modelo, pdf };
}
