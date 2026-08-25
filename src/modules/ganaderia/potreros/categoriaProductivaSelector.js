// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §2: selector jerárquico
// (tipo de producción -> categoría) -- PURO frontend, sin llamadas de red.
// El catálogo real (nombre/parámetros técnicos) viene siempre del backend
// (GET /api/ganaderia/categorias-productivas, agx.catalogo_categorias_productivas)
// -- este módulo SOLO define en qué grupo visual aparece cada `codigo` de
// categoría. Una categoría puede aparecer bajo más de un grupo (§2: "Vacas
// secas" en Cría Y Leche, "Toros reproductores" en Cría Y Reproducción)
// SIN duplicarse en el catálogo -- el codigo es el mismo, solo cambia
// dónde se muestra.
export const GRUPOS_PRODUCTIVOS = [
  { grupo: 'cria', label: 'Cría', codigos: ['vaca_cria_con_ternero', 'vaca_seca', 'toro_reproductor'] },
  { grupo: 'levante', label: 'Levante', codigos: ['ternera_levante', 'ternero_levante', 'novilla_levante', 'novillo_levante'] },
  { grupo: 'ceba', label: 'Ceba / Engorde', codigos: ['ternero_emposte', 'novillo_ceba'] },
  { grupo: 'leche', label: 'Leche', codigos: ['vaca_leche_produccion', 'vaca_seca', 'novilla_reemplazo'] },
  { grupo: 'reproduccion', label: 'Reproducción', codigos: ['vaca_receptora', 'novilla_receptora', 'toro_reproductor'] },
  // §19 del sprint: lote mixto/otro NO invocan el motor automático todavía
  // -- no tienen codigo de catálogo, se muestran como "próximamente".
  { grupo: 'otro', label: 'Otro', comingSoon: ['Lote mixto', 'Otro'] },
];

/**
 * Combina la jerarquía visual estática con el catálogo real del backend
 * (§2 del sprint) -- para cada grupo, resuelve sus `codigos` contra las
 * categorías recibidas de GET /api/ganaderia/categorias-productivas
 * (manteniendo el ORDEN de `codigos`, no el orden de la respuesta). Un
 * `codigo` que no resuelve (catálogo desincronizado) se omite en vez de
 * romper el selector.
 */
export function buildGruposConCategorias(categorias) {
  const byCodigo = new Map((categorias || []).map((c) => [c.codigo, c]));
  return GRUPOS_PRODUCTIVOS.map((grupoDef) => ({
    grupo: grupoDef.grupo,
    label: grupoDef.label,
    comingSoon: grupoDef.comingSoon ?? null,
    categorias: (grupoDef.codigos || [])
      .map((codigo) => byCodigo.get(codigo))
      .filter(Boolean),
  }));
}
