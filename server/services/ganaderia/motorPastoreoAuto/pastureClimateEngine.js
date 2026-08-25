// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §8 (+ hardening rondas 2/3):
// motor DETERMINÍSTICO (ninguna IA generativa) para estimar % materia seca
// y % utilización a partir de la pastura de la ficha + contexto
// agroclimático más reciente disponible. Base técnica documentada en
// REFERENCIAS_TECNICAS.md/fuentesTecnicas.js -- NUNCA inventa ecuaciones
// agroclimáticas: un único ajuste conservador (déficit hídrico de 7 días),
// nunca un ajuste que incremente la utilización por clima favorable.
//
// Hardening ronda 3 §6: `dryMatterSource` -- taxonomía explícita de
// incertidumbre de materia seca, nunca falsa precisión:
//   MEASURED > PASTURE_SPECIFIC_BASELINE > BOTANICAL_TYPE > FALLBACK.
// MEASURED queda preparado (§7: arquitectura lista) pero INALCANZABLE en
// v1 -- no existe todavía un input de %MS medido/bromatológico.
//
// Hardening ronda 3 §5: Brachiaria/Urochloa humidicola pasa de "22% MS"
// sin cita a PASTURE_SPECIFIC_BASELINE con metadata completa (cultivar,
// fuente, rango documentado, limitación de tamaño muestral) -- ver
// fuentesTecnicas.js FEEDIPEDIA_BRACHIARIA_HUMIDICOLA.
//
// % de utilización sigue siendo SIEMPRE FALLBACK (take-half-leave-half,
// hardening ronda 2 §5) -- ninguna fuente consultada documenta un % de
// utilización específico de especie/cultivar, solo el % de materia seca.
//
// Sin dependencias de DB/HTTP -- puro y testeable.

// %MS base por tipo botánico de pastura (agx.catalogo_pasturas.tipo) --
// punto medio del rango documentado (FAO/AGROSAVIA, ver REFERENCIAS_TECNICAS.md).
// dryMatterSource: BOTANICAL_TYPE (o FALLBACK para 'otra').
const MATERIA_SECA_BASE_PCT = {
  graminea: 20,
  leguminosa: 22,
  mezcla: 21,
  otra: 20,
};

// %Utilización -- principio "tomar la mitad, dejar la mitad"
// (take-half-leave-half), SIEMPRE FALLBACK -- ninguna fuente consultada
// documenta un % de utilización específico por especie/cultivar (hardening
// ronda 2 §5, reafirmado en ronda 3: nunca presentado como óptimo).
const UTILIZACION_BASE_PCT = 50;

// Ajuste conservador único por déficit hídrico reciente (§8: nunca un
// ajuste que incremente la utilización por clima favorable).
const PRECIPITACION_7D_UMBRAL_DEFICIT_MM = 10;
const UTILIZACION_AJUSTE_DEFICIT_PCT = 5;

const TIPOS_PASTURA_VALIDOS = new Set(['graminea', 'leguminosa', 'mezcla', 'otra']);

// Hardening ronda 3 §5/§6: único lookup PASTURE_SPECIFIC_BASELINE de v1,
// con dato REAL verificado (Feedipedia/INRAE-CIRAD-AFZ, ver
// fuentesTecnicas.js FEEDIPEDIA_BRACHIARIA_HUMIDICOLA) -- reemplaza el 22%
// sin cita de la ronda anterior. Reconocido por coincidencia
// case-insensitive/sin-acentos de nombre_comun O nombre_cientifico.
const PASTURA_ESPECIFICA = [
  {
    patrones: ['brachiaria humidicola', 'urochloa humidicola'],
    materiaSecaPct: 26,
    materiaSecaRangoPct: [22.1, 29.8],
    fuenteTecnica: 'FEEDIPEDIA_BRACHIARIA_HUMIDICOLA',
    regionContexto: 'Base internacional Feedipedia -- sin desglose por región/época en la muestra (n=4).',
    edadRebroteReportada: null,
  },
];

function normalizarNombre(valor) {
  if (typeof valor !== 'string') return '';
  return valor
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function resolvePasturaEspecifica(nombreComun, nombreCientifico) {
  const comun = normalizarNombre(nombreComun);
  const cientifico = normalizarNombre(nombreCientifico);
  if (!comun && !cientifico) return null;
  return PASTURA_ESPECIFICA.find((entry) => entry.patrones.some(
    (patron) => (comun && comun.includes(patron)) || (cientifico && cientifico.includes(patron)),
  )) ?? null;
}

/**
 * Resuelve %MS y %utilización aplicados + provenance (§8/§9 del sprint,
 * hardening §5/§6) a partir de la pastura de la ficha (tipo botánico +
 * nombres, para intentar match PASTURE_SPECIFIC_BASELINE) y, si existe, el
 * snapshot agroclimático más reciente del potrero (puede ser null -- §17
 * del sprint: modo degradado sin contexto).
 *
 * tipoPastura: 'graminea' | 'leguminosa' | 'mezcla' | 'otra'.
 * nombresPastura: { nombreComun, nombreCientifico } (opcional -- null si
 * la ficha es una mezcla sin especie dominante única).
 * contexto: { precipitacion7dMm } o null.
 * materiaSecaMedidaPct: hardening §7 -- arquitectura preparada para un
 * futuro %MS medido/bromatológico (dryMatterSource=MEASURED). NUNCA
 * poblado en v1 -- no existe todavía ningún input que lo alimente.
 */
export function resolvePastureClimateParams(tipoPastura, nombresPastura, contexto, materiaSecaMedidaPct = null) {
  const tipo = TIPOS_PASTURA_VALIDOS.has(tipoPastura) ? tipoPastura : 'otra';
  const especifica = resolvePasturaEspecifica(nombresPastura?.nombreComun, nombresPastura?.nombreCientifico);

  const medida = typeof materiaSecaMedidaPct === 'number' && Number.isFinite(materiaSecaMedidaPct) && materiaSecaMedidaPct > 0;

  const materiaSecaPct = medida ? materiaSecaMedidaPct : (especifica ? especifica.materiaSecaPct : MATERIA_SECA_BASE_PCT[tipo]);
  const dryMatterSource = medida ? 'MEASURED' : (especifica ? 'PASTURE_SPECIFIC_BASELINE' : (tipo === 'otra' ? 'FALLBACK' : 'BOTANICAL_TYPE'));

  const precipitacion7d = contexto?.precipitacion7dMm;
  const hayDeficitHidrico = typeof precipitacion7d === 'number'
    && Number.isFinite(precipitacion7d)
    && precipitacion7d < PRECIPITACION_7D_UMBRAL_DEFICIT_MM;

  const utilizacionPct = hayDeficitHidrico
    ? UTILIZACION_BASE_PCT - UTILIZACION_AJUSTE_DEFICIT_PCT
    : UTILIZACION_BASE_PCT;

  return {
    materiaSecaPct,
    utilizacionPct,
    tipoPasturaAplicado: tipo,
    // Diagnóstico: true SOLO cuando el input recibido no era una de las
    // clasificaciones válidas (anomalía de datos, distinto de "otra"
    // elegido explícitamente). No decide el nivel de confianza por sí
    // solo -- eso lo hace dryMatterSource (ver recomendacionPastoreoFormulas.js).
    tipoPasturaDesconocido: tipo === 'otra' && tipoPastura !== 'otra',
    // Hardening ronda 3 §6: MEASURED > PASTURE_SPECIFIC_BASELINE >
    // BOTANICAL_TYPE > FALLBACK -- nunca falsa precisión.
    dryMatterSource,
    pasturaEspecificaMetadata: especifica ? {
      cultivarEspecie: 'Brachiaria humidicola (sin. Urochloa humidicola)',
      fuenteTecnica: especifica.fuenteTecnica,
      materiaSecaRangoPct: especifica.materiaSecaRangoPct,
      regionContexto: especifica.regionContexto,
      edadRebroteReportada: especifica.edadRebroteReportada,
    } : null,
    // Utilización SIEMPRE FALLBACK (hardening ronda 2 §5 + ronda 3 §5):
    // ninguna fuente consultada documenta un % específico de especie.
    utilizacionFuenteTipo: 'FALLBACK',
    ajusteDeficitHidricoAplicado: hayDeficitHidrico,
    fuenteTecnica: {
      materiaSeca: medida ? null : (especifica ? especifica.fuenteTecnica : 'FAO_AGROSAVIA_PASTURA_TROPICAL'),
      utilizacion: hayDeficitHidrico
        ? 'FAO_AGROSAVIA_PASTOREO_RACIONAL_AJUSTE_DEFICIT_HIDRICO_7D'
        : 'FAO_AGROSAVIA_PASTOREO_RACIONAL_TAKE_HALF_LEAVE_HALF',
    },
  };
}
