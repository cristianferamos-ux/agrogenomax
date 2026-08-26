// SPRINT-3D8-DESCANSO-REENTRADA: registro único de citas bibliográficas del
// motor de descanso -- mismo criterio que
// motorPastoreoAuto/fuentesTecnicas.js: toda cadena `fuente` almacenada en
// parametros_fuente_json DEBE resolver contra una clave de este objeto.
//
// REGLA DURA (mismo criterio que motorPastoreoAuto, §1/§9 de su hardening
// ronda 3): un código de este registro SOLO se usa si el valor asociado es
// LITERALMENTE lo que esa fuente documenta, o si la adaptación se
// documenta explícitamente en `parametroSoportado`/`limitacion`. Nunca se
// atribuye un número inventado a una institución real.
export const FUENTES_TECNICAS_DESCANSO = Object.freeze({
  // Fuente PRIMARIA del baseline específico de Urochloa/Brachiaria
  // humidicola cv. Llanero (§18/§3 del sprint) -- investigación de AGROSAVIA
  // (Corporación Colombiana de Investigación Agropecuaria) publicada en
  // Tropical Grasslands-Forrajes Tropicales, revista con revisión por
  // pares. Documenta potreros de esta pastura manejados bajo pastoreo
  // rotacional con 30 días de descanso en el Piedemonte de los Llanos
  // Orientales de Colombia (verificado vía WebSearch, 2026-08-25).
  RINCON_2018_HUMIDICOLA_LLANERO: {
    cita: 'Rincón, A.; Flórez, H.; Ballesteros, H.; León, L.M. 2018. Efectos de la fertilización en la productividad de una pastura de Brachiaria humidicola cv. Llanero en el Piedemonte de los Llanos Orientales de Colombia. Tropical Grasslands-Forrajes Tropicales, 6(3), 158-168. https://doi.org/10.17138/tgft(6)158-168',
    parametroSoportado: 'Manejo rotacional documentado de una pastura de Brachiaria humidicola cv. Llanero (no degradada, suelo ácido de baja fertilidad, Piedemonte Llanero) bajo 30 días de descanso entre pastoreos. Aplicado aquí como punto medio (rest_days_typical_reference) de un baseline PASTURE_SPECIFIC_REGIONAL (hardening dinámico §3) -- min/max (25/35 días) reflejan el margen de incertidumbre explícito del sprint, nunca un segundo experimento con esos extremos exactos. Conservado como EVIDENCIA CONTEXTUAL/REGIONAL (§3 del hardening) -- nunca como recomendación directa universal de 30 días: el motor SIEMPRE atraviesa el ajuste dinámico agroclimático antes de producir un resultado.',
  },
  // Fuente SECUNDARIA para altura de entrada/salida específica de U.
  // humidicola cv. Tully (CIAT 679) -- manual técnico 2025 de CIAT/Alianza
  // Bioversity-CIAT, verificado vía WebFetch del PDF completo (2026-08-25).
  // Tabla 2 (score vs. altura vs. carga) documenta explícitamente 15 cm
  // (score 1.5, límite inferior del rango "ideal" de manejo, Tabla 3) y
  // 30 cm (score 2.5, cercano al límite superior del rango "ideal").
  CIAT_2025_MANEJO_HUMIDICOLA: {
    cita: 'Bastidas, M.; Ospina, L.; Aguiar, A.; Márquez, M.; Rao, I.M.; Montoya, A.; Jiménez, J.; Jaramillo, G.; Yedra, A.; Rivas, I.; Arango, J. 2025. Manejo estratégico de Urochloa humidicola (Pasto Humidícola) para la optimización de sistemas ganaderos de la Orinoquía colombiana. Manual Técnico - Volumen 2. Centro Internacional de Agricultura Tropical (CIAT), Cali, Colombia. 49 p. https://hdl.handle.net/10568/174483',
    parametroSoportado: 'Tabla 2 (relación score/altura/carga para U. humidicola cv. Tully): score 1.5 = 15 cm, score 2.5 = 30 cm. Tabla 3 documenta un score "ideal" de manejo entre 1.75 y 2.75 a lo largo del año. Se usan aquí los DOS VALORES DE TABLA (15 cm y 30 cm) como altura de salida/residual y altura de entrada respectivamente -- nunca una interpolación no documentada. ADAPTED: el manual describe cv. Tully (CIAT 679) en Vichada, no necesariamente el mismo cultivar que agx.catalogo_pasturas registra como "Brachiaria humidicola" genérico -- se trata como referencia de la misma especie (Urochloa humidicola), no como dato medido en el potrero del cliente.',
    limitacion: 'El manual usa un modelo de "score" (altura + cobertura) para decidir carga animal, no un número fijo de días de descanso -- confirma explícitamente que acortar/alargar el descanso es una palanca de manejo (nunca una constante universal), consistente con el enfoque de rango de este motor.',
  },
  // Hardening dinámico §2/§3: ya NO se usa como fallback universal para
  // cualquier pastura (eso fue corregido -- §4 del hardening: "NO usar
  // 25-35 días como fallback para cualquier gramínea"). Se conserva
  // ÚNICAMENTE como evidencia CORROBORANTE del baseline regional de
  // humidicola (dos fuentes institucionales distintas documentan
  // independientemente el mismo rango para la misma región/sistema
  // productivo) -- nunca aplicado a una pastura sin perfil específico.
  AGROSAVIA_PIEDEMONTE_LLANERO_PASTOREO: {
    cita: 'AGROSAVIA (Corporación Colombiana de Investigación Agropecuaria). Manejo de pastoreo en el Piedemonte llanero para sistemas intensivos de producción de carne. Oferta tecnológica, agrosavia.co (consultado 2026-08-25).',
    parametroSoportado: 'Periodo de descanso recomendado de 25 a 35 días en sistemas de pastoreo rotacional del Piedemonte Llanero, para buen desarrollo y disponibilidad de forraje. Corrobora independientemente el rango PASTURE_SPECIFIC_REGIONAL de humidicola (RINCON_2018_HUMIDICOLA_LLANERO) para la misma región/sistema productivo -- NUNCA usado como fallback para pasturas sin perfil específico (corrección del hardening dinámico, §4).',
  },
  // Regla propia del motor (NO atribuida a una fuente externa) -- ajuste
  // conservador por déficit hídrico prolongado (ventana de 30 días),
  // extensión proporcional del MISMO umbral de déficit de 7 días ya usado
  // y citado en motorPastoreoAuto/pastureClimateEngine.js
  // (PRECIPITACION_7D_UMBRAL_DEFICIT_MM = 10 mm, FAO_AGROSAVIA_PASTOREO_RACIONAL).
  MOTOR_DESCANSO_AJUSTE_DEFICIT_30D: {
    cita: 'Regla de ingeniería propia de AgroGenomaX (SPRINT-3D8) -- no atribuida a una institución externa.',
    parametroSoportado: 'Umbral de déficit hídrico de 30 días (40 mm) derivado proporcionalmente del umbral de 7 días ya vigente en el motor de pastoreo (10 mm / 7 días); NUNCA presentado como una cifra publicada por FAO/AGROSAVIA/CIAT. Regla explícita, monotónica (nunca reduce el descanso por buen clima) -- §5 del sprint: "no inventar una ecuación fisiológica compleja".',
  },
});

export function getFuenteTecnicaDescanso(codigo) {
  return FUENTES_TECNICAS_DESCANSO[codigo] ?? null;
}
