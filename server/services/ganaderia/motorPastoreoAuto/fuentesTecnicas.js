// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO (hardening rondas 1-3): registro
// único de citas bibliográficas -- evita referencias ambiguas (edición/año
// incorrectos, o coeficientes atribuidos a una fuente que no los publica)
// repetidas por todo el código/DB. Toda cadena `fuente` almacenada en
// agx.catalogo_categorias_productivas.metadata_tecnica o en
// parametros_fuente_json DEBE resolver contra una clave de este objeto.
//
// REGLA DURA (hardening ronda 3, §1/§9): un código de este registro SOLO
// se usa si la ecuación/coeficiente/valor asociado es LITERALMENTE lo que
// esa fuente publica, o si la adaptación se documenta explícitamente en
// `parametroSoportado`/`limitacion`. Nunca se atribuye un coeficiente
// inventado a una institución real.
export const FUENTES_TECNICAS = Object.freeze({
  NASEM_2016_BEEF: {
    cita: 'National Academies of Sciences, Engineering, and Medicine (NASEM). 2016. Nutrient Requirements of Beef Cattle, 8th Revised Edition. Washington, DC: The National Academies Press.',
    parametroSoportado: 'Ecuaciones de consumo voluntario de materia seca (DMI) en función de peso vivo, ganancia diaria y calidad de dieta -- NO una tabla plana de %PV por categoría. Aplicado aquí como ADAPTED: simplificación de campo a un %PV por categoría fisiológica.',
  },
  NRC_2000_BEEF: {
    cita: 'National Research Council (NRC). 2000. Nutrient Requirements of Beef Cattle, Update of the 7th Revised Edition. Washington, DC: National Academy Press.',
    parametroSoportado: 'Ecuaciones de consumo voluntario de materia seca por categoría fisiológica (mantenimiento, crecimiento, lactancia) -- misma familia de modelos que NASEM (2016), usada aquí como referencia complementaria/histórica.',
  },
  // Hardening ronda 3 §1: NASEM (2021), 8th Revised Edition, SÍ publica
  // ecuaciones explícitas de DMI para vacas lactantes (Eq. 2-1: paridad +
  // energía neta de la leche + peso vivo + condición corporal + días en
  // leche; Eq. 2-2: fibra/digestibilidad del forraje + producción). NINGUNA
  // de las dos se implementa en v1 -- Eq. 2-1 requiere condición corporal y
  // paridad (no capturadas), Eq. 2-2 requiere análisis bromatológico del
  // forraje (§7: "no implementar laboratorio todavía"). Se deja este
  // registro únicamente como referencia documental de por qué NO se usa
  // directamente -- NUNCA usar este código para etiquetar un cálculo
  // real de la app (ver NRC_2001_DAIRY_DMI, que sí se implementa).
  NASEM_2021_DAIRY_REFERENCE_ONLY: {
    cita: 'National Academies of Sciences, Engineering, and Medicine (NASEM). 2021. Nutrient Requirements of Dairy Cattle, 8th Revised Edition. Washington, DC: The National Academies Press. Ecuación 2-1 (p. 25 aprox., capítulo 2, "Dry Matter Intake").',
    parametroSoportado: 'Eq. 2-1: DMI = [(3.7 + Paridad×5.7) + 0.305×MilkE(Mcal/d) + 0.022×BW(kg) + (−0.689 − 1.87×Paridad)×BCS] × [1 − (0.212 + Paridad×0.136)×e^(−0.053×DIM)]. Requiere energía neta de la leche (Mcal/d, derivada de %grasa/%proteína), condición corporal (BCS) y paridad -- ninguna capturada en v1. NUNCA usada para calcular en la app; documentada solo para justificar por qué se usa NRC (2001) en su lugar.',
    limitacion: 'No implementable honestamente en v1 -- variables no capturadas (BCS, paridad, energía neta de la leche vía composición real).',
  },
  // Consenso general de requerimientos/crecimiento de ganado lechero
  // (novillas de reemplazo -- NO lactantes, no usa la ecuación de DMI de
  // vacas en producción). Distinto del código _REFERENCE_ONLY de arriba,
  // que está acotado específicamente a la ecuación de DMI de lactancia que
  // esta app decidió NO implementar.
  NASEM_2021_DAIRY_GENERAL: {
    cita: 'National Academies of Sciences, Engineering, and Medicine (NASEM). 2021. Nutrient Requirements of Dairy Cattle, 8th Revised Edition. Washington, DC: The National Academies Press.',
    parametroSoportado: 'Requerimientos y consumo de referencia para novillas de reemplazo en crecimiento (no lactantes) -- aplicado aquí como ADAPTED: simplificación de campo a un %PV por etapa de crecimiento, misma naturaleza que NASEM_2016_BEEF para categorías de carne.',
  },
  // Hardening ronda 3 §1/§3: ecuación REALMENTE implementada para vacas en
  // producción de leche -- verificada (WebSearch, 2026-08-25) contra
  // ScienceDirect/NCBI: Rayburn & Fox (1993), modificada por Fox et al.
  // (1999), reportada en NRC (2001). Requiere SOLO peso vivo, producción de
  // leche y días en leche -- datos que el cliente puede entregar (§1 del
  // hardening: "cuál versión simplificada científicamente publicada puede
  // implementarse con datos que el cliente pueda entregar").
  NRC_2001_DAIRY_DMI: {
    cita: 'National Research Council (NRC). 2001. Nutrient Requirements of Dairy Cattle, 7th Revised Edition. Washington, DC: National Academy Press. Ecuación de predicción de DMI de vacas lactantes (Rayburn & Fox, 1993; modificada por Fox et al., 1999).',
    parametroSoportado: 'DMI (kg/d) = (0.372 × FCM + 0.0968 × BW^0.75) × [1 − e^(−0.192 × (WOL + 3.67))], donde FCM = leche corregida a 4% de grasa (kg/d, ver GAINES_1923_FCM -- NUNCA el volumen de leche crudo), BW = peso vivo (kg), WOL = semana de lactancia (días en leche ÷ 7). Implementada literalmente y completa -- se ejecuta SOLO cuando el cliente aporta %grasa real (sourceType DIRECT). Sin %grasa, esta ecuación NO se ejecuta -- se usa el perfil %PV genérico (ver GENERIC_LACTATING_PROFILE), nunca un %grasa asumido (hardening ronda 4 §1/§5).',
  },
  // Hardening ronda 4 §1/§3: corrige un bug real de la ronda 3 -- FCM (4%
  // fat-corrected milk) NO es el volumen de leche crudo. Fórmula publicada
  // y verificada (WebSearch, 2026-08-25): Gaines & Davidson (1923), FCM =
  // 0.4 × leche_kg + 15 × grasa_kg; refinada por Gaines (1928).
  GAINES_1923_FCM: {
    cita: 'Gaines, W.L., and F.A. Davidson. 1923. Relation between percentage fat content and yield of milk. Illinois Agricultural Experiment Station Bulletin 245. Refinado en Gaines, W.L. 1928.',
    parametroSoportado: 'FCM (4% fat-corrected milk, kg/d) = 0.4 × leche(kg/d) + 15 × grasa(kg/d). Fórmula estándar de la industria láctea para normalizar producción a un contenido de grasa común -- implementada literalmente, requiere %grasa real de la leche (input opcional del productor).',
  },
  // Hardening ronda 4 §5: perfil aplicado cuando el productor NO conoce el
  // %grasa de la leche -- NUNCA se inventa un %grasa ni se ejecuta NRC
  // (2001) con un valor asumido. Reutiliza el mismo mecanismo %PV genérico
  // que cualquier otra categoría (consumo_ms_pct_pv_tipico del catálogo).
  GENERIC_LACTATING_PROFILE: {
    cita: 'Sin ecuación externa -- reutiliza consumo_ms_pct_pv_tipico de agx.catalogo_categorias_productivas (fuente NRC_2001_DAIRY_DMI, columna informativa, ver metadata_tecnica de vaca_leche_produccion) como %PV genérico, mismo mecanismo que categorías no lactantes.',
    parametroSoportado: 'demandaIndividualKgMsDia = pesoPromedioKg × (consumo_ms_pct_pv_tipico / 100). sourceType ADAPTED -- nunca se presenta como si la ecuación NRC (2001) hubiera corrido. Confianza topada en MEDIA (nunca ALTA) mientras se use este perfil.',
  },
  FAO_AGROSAVIA_PASTURA_TROPICAL: {
    cita: 'FAO, Land and Water Division -- Grassland Index (guías de calidad de forraje tropical); AGROSAVIA -- manuales técnicos de manejo de praderas y aforo en sistemas ganaderos tropicales colombianos.',
    parametroSoportado: '% de materia seca típico de forraje fresco tropical vegetativo por tipo botánico general (gramínea/leguminosa) -- valores de consenso de campo, no un ensayo controlado específico. dryMatterSource: BOTANICAL_TYPE.',
  },
  FAO_AGROSAVIA_PASTOREO_RACIONAL: {
    cita: 'FAO -- guías de pastoreo racional/rotacional; AGROSAVIA -- extensión en manejo de praderas tropicales.',
    parametroSoportado: 'Principio de manejo "tomar la mitad, dejar la mitad" (take-half-leave-half) como punto de partida conservador de % de utilización -- FALLBACK universal explícito, nunca óptimo específico de especie/cultivar (hardening ronda 2 §5).',
  },
  // Hardening ronda 3 §5/§6: corrige la ronda anterior -- el 22% atribuido
  // sin cita verificable se reemplaza por un dato REAL verificado
  // (WebFetch, 2026-08-25) de Feedipedia (INRAE-CIRAD-AFZ, base de datos
  // internacional de composición de alimentos, revisión por pares).
  FEEDIPEDIA_BRACHIARIA_HUMIDICOLA: {
    cita: 'Feedipedia (INRAE, CIRAD, AFZ, FAO) -- "Koronivia grass (Brachiaria humidicola), aerial part, fresh". https://www.feedipedia.org/node/585 (consultado 2026-08-25).',
    parametroSoportado: 'Materia seca de la parte aérea fresca: 26.0% ± 3.2 (rango observado 22.1-29.8%, n=4 muestras). La fuente NO reporta edad de rebrote ni época asociada a este dato específico de %MS (n muestral pequeño -- tratado como PASTURE_SPECIFIC_BASELINE, no como constante universal de la especie). % de utilización NO documentado por esta fuente para esta especie -- permanece FALLBACK (take-half-leave-half).',
    limitacion: 'n=4 muestras, sin desglose por edad de rebrote/época -- rango amplio (22.1-29.8%) refleja esa variabilidad. Se usa el punto medio reportado (26.0%) como baseline, nunca como valor medido de un potrero específico.',
  },
});

export function getFuenteTecnica(codigo) {
  return FUENTES_TECNICAS[codigo] ?? null;
}
