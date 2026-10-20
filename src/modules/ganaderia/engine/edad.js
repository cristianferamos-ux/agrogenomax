// FASE 0 -- edad del animal según el modelo Business (agx.animales):
//   EXACTA       fecha_nacimiento -> edad a la fecha objetivo.
//   APROXIMADA   edad_aproximada_meses declarada en edad_referencia_fecha,
//                proyectada desde ESA fecha (no desde hoy).
//   DESCONOCIDA  edad null (nunca se inventa).
// Funciones puras: la fecha objetivo es SIEMPRE un input explícito. Sin
// heurísticas tipo "más de 60 = días". Sin redondeo (solo al presentar).
//
// La compatibilidad con la Demo y la UI huérfana legacy vive en
// engine/demo/edadDemo.js -- no es regla Business.
import { aFechaISO, diasEntre, mesesDecimalesEntre, mesesYDiasEntre } from './fechas.js';

export const NACIMIENTO_TIPOS = Object.freeze(['EXACTA', 'APROXIMADA', 'DESCONOCIDA']);

function campo(animal, camel, snake) {
  const value = animal?.[camel] ?? animal?.[snake];
  return value === undefined || value === '' ? null : value;
}

/** Datos de nacimiento normalizados del animal Business (camelCase de la API o snake_case de la DB). */
export function datosNacimiento(animal) {
  const fechaNacimiento = aFechaISO(campo(animal, 'fechaNacimiento', 'fecha_nacimiento'));
  const edadRaw = campo(animal, 'edadAproximadaMeses', 'edad_aproximada_meses');
  const edadAproximadaMeses = edadRaw === null ? null : Number(edadRaw);
  const edadReferenciaFecha = aFechaISO(campo(animal, 'edadReferenciaFecha', 'edad_referencia_fecha'));
  let tipo = campo(animal, 'nacimientoTipo', 'nacimiento_tipo');
  if (!NACIMIENTO_TIPOS.includes(tipo)) {
    if (fechaNacimiento) tipo = 'EXACTA';
    else if (Number.isFinite(edadAproximadaMeses) && edadReferenciaFecha) tipo = 'APROXIMADA';
    else tipo = 'DESCONOCIDA';
  }
  return { tipo, fechaNacimiento, edadAproximadaMeses, edadReferenciaFecha };
}

/**
 * Edad del animal en `fechaObjetivo` ('YYYY-MM-DD').
 * Devuelve { tipo, meses, mesesCompletos, diasRestantes, diasTotales } o
 * { tipo, meses: null, ... } cuando no puede determinarse (DESCONOCIDA, datos
 * incompletos, fecha objetivo anterior al nacimiento).
 *   EXACTA:     meses = meses de calendario desde fecha_nacimiento (decimal).
 *   APROXIMADA: meses = edad_aproximada_meses + meses de calendario desde
 *               edad_referencia_fecha (negativo si la fecha objetivo es anterior).
 */
export function calcularEdadAnimal(animal, fechaObjetivo) {
  const nac = datosNacimiento(animal);
  const objetivo = aFechaISO(fechaObjetivo);
  const vacia = { tipo: nac.tipo, meses: null, mesesCompletos: null, diasRestantes: null, diasTotales: null };
  if (!objetivo) return vacia;

  if (nac.tipo === 'EXACTA') {
    if (!nac.fechaNacimiento) return vacia;
    const md = mesesYDiasEntre(nac.fechaNacimiento, objetivo);
    if (!md) return vacia;
    return {
      tipo: 'EXACTA',
      meses: mesesDecimalesEntre(nac.fechaNacimiento, objetivo),
      mesesCompletos: md.meses,
      diasRestantes: md.dias,
      diasTotales: diasEntre(nac.fechaNacimiento, objetivo),
    };
  }

  if (nac.tipo === 'APROXIMADA') {
    if (!Number.isFinite(nac.edadAproximadaMeses) || nac.edadAproximadaMeses < 0 || !nac.edadReferenciaFecha) return vacia;
    const haciaAdelante = diasEntre(nac.edadReferenciaFecha, objetivo) >= 0;
    const transcurridos = haciaAdelante
      ? mesesDecimalesEntre(nac.edadReferenciaFecha, objetivo)
      : -mesesDecimalesEntre(objetivo, nac.edadReferenciaFecha);
    const meses = nac.edadAproximadaMeses + transcurridos;
    if (meses < 0) return vacia;
    return { tipo: 'APROXIMADA', meses, mesesCompletos: Math.floor(meses), diasRestantes: null, diasTotales: null };
  }

  return { ...vacia, tipo: 'DESCONOCIDA' };
}

/** Texto de presentación (único lugar con redondeo). APROXIMADA lleva "≈". */
export function formatearEdad(edad, { desconocida = 'Edad desconocida' } = {}) {
  if (!edad || !Number.isFinite(edad.meses)) return desconocida;
  const prefijo = edad.tipo === 'APROXIMADA' ? '≈ ' : '';
  if (edad.tipo === 'EXACTA' && edad.mesesCompletos < 2) {
    if (edad.mesesCompletos === 0) return edad.diasTotales === 1 ? '1 día' : `${edad.diasTotales} días`;
    if (edad.diasRestantes === 0) return '1 mes';
    return `1 mes y ${edad.diasRestantes === 1 ? '1 día' : `${edad.diasRestantes} días`}`;
  }
  const meses = Math.floor(edad.meses);
  if (meses < 24) return `${prefijo}${meses === 1 ? '1 mes' : `${meses} meses`}`;
  const anios = Math.floor(meses / 12);
  const resto = meses % 12;
  return `${prefijo}${anios} años${resto ? ` y ${resto === 1 ? '1 mes' : `${resto} meses`}` : ''}`;
}
