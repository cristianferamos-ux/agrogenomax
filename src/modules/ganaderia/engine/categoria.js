// FASE 0 -- categoría productiva según el modelo Business.
// Fuente oficial ÚNICA: agx.catalogo_categorias_productivas (el animal guarda
// categoria_productiva_id). El motor NO infiere categorías por edad/sexo ni
// clasifica texto libre: si el animal no tiene categoría oficial, el
// resultado es null (desconocida). La taxonomía por regex de la Demo vive
// aislada en engine/demo/categoriaDemo.js.

export const SEXOS = Object.freeze(['MACHO', 'HEMBRA']);

/** Sexo Business ('MACHO' | 'HEMBRA') o null. Sin alias de texto libre. */
export function sexoAnimal(animal) {
  const sexo = animal?.sexo;
  return SEXOS.includes(sexo) ? sexo : null;
}

function idCategoria(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function categoriaOficial(entrada) {
  return {
    categoriaId: idCategoria(entrada.categoriaId ?? entrada.categoria_id),
    codigo: entrada.codigo ?? null,
    nombre: entrada.nombre ?? null,
    grupoProductivo: entrada.grupoProductivo ?? entrada.grupo_productivo ?? null,
  };
}

/**
 * Categoría oficial del animal: busca su categoria_productiva_id en el
 * catálogo oficial. Si no se pasa catálogo pero el animal ya viene
 * serializado por la API con código y nombre, los usa. null si no hay
 * categoría o el id no existe en el catálogo.
 */
export function resolverCategoriaProductiva(animal, catalogo = null) {
  const id = idCategoria(animal?.categoriaProductivaId ?? animal?.categoria_productiva_id);
  if (!id) return null;
  if (Array.isArray(catalogo)) {
    const entrada = catalogo.find((c) => idCategoria(c?.categoriaId ?? c?.categoria_id) === id);
    return entrada ? categoriaOficial(entrada) : null;
  }
  const codigo = animal?.categoriaProductivaCodigo ?? null;
  const nombre = animal?.categoriaProductivaNombre ?? null;
  return { categoriaId: id, codigo, nombre, grupoProductivo: null };
}
