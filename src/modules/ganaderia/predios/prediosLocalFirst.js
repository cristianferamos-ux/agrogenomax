// SPRINT-3D11.3 (R1): carga local-first de "Mis predios". JS puro.
//   * dispositivo preparado: pinta YA la copia local (IndexedDB);
//   * con red: refresca desde GET /api/ganaderia/predios (fuente de verdad);
//   * sin red o si el servidor falla: se queda con la copia local (nunca un
//     error si hay datos locales).
// Sin dispositivo preparado: comportamiento en línea de siempre.
export async function cargarPrediosLocalFirst({ local, online, incluirArchivados, fetchRemote, onLocal }) {
  let lista = null;
  if (local) {
    lista = await local.listPredios({ incluirArchivados });
    onLocal?.(lista);
    if (!online) return { predios: lista, origen: 'local' };
  }
  try {
    return { predios: await fetchRemote(incluirArchivados), origen: 'servidor' };
  } catch (error) {
    if (lista) return { predios: lista, origen: 'local' };
    throw error;
  }
}
