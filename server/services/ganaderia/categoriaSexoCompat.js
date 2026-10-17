// SPRINT-3D11.2: compatibilidad sexo <-> categoría productiva declarada.
// agx.catalogo_categorias_productivas no tiene columna de sexo (0007) y
// 3D11.2 no la agrega: el mapeo vive aquí, por `codigo`, y se replica en
// src/modules/ganaderia/hato/categoriaSexo.js (paridad verificada por
// test). Un código ausente de este mapa no es asignable a un animal.
//
// ternero_emposte: la descripción del catálogo ("Animal joven en
// preceba/emposte") no indica sexo -- válido para ambos.
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

export function isCategoriaAsignableAAnimal(codigo) {
  return Object.hasOwn(CATEGORIA_SEXOS, codigo);
}

export function isCategoriaCompatibleConSexo(codigo, sexo) {
  return isCategoriaAsignableAAnimal(codigo) && CATEGORIA_SEXOS[codigo].includes(sexo);
}
