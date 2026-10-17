// SPRINT-3D11.2: espejo de server/services/ganaderia/categoriaSexoCompat.js
// (el frontend no importa server/; paridad verificada por
// __tests__/categoriaSexoParity.test.js). Solo filtra el selector -- el
// servidor revalida siempre.
export const CATEGORIA_SEXOS = Object.freeze({
  vaca_cria_con_ternero: Object.freeze(['HEMBRA']),
  vaca_seca: Object.freeze(['HEMBRA']),
  ternera_levante: Object.freeze(['HEMBRA']),
  novilla_levante: Object.freeze(['HEMBRA']),
  vaca_leche_produccion: Object.freeze(['HEMBRA']),
  novilla_reemplazo: Object.freeze(['HEMBRA']),
  vaca_receptora: Object.freeze(['HEMBRA']),
  novilla_receptora: Object.freeze(['HEMBRA']),
  toro_reproductor: Object.freeze(['MACHO']),
  ternero_levante: Object.freeze(['MACHO']),
  novillo_levante: Object.freeze(['MACHO']),
  novillo_ceba: Object.freeze(['MACHO']),
  ternero_emposte: Object.freeze(['MACHO', 'HEMBRA']),
});

export function categoriasParaSexo(categorias, sexo) {
  if (!sexo) return [];
  return (categorias || []).filter((categoria) => CATEGORIA_SEXOS[categoria.codigo]?.includes(sexo));
}
