// SPRINT-3D11.2: carga de catálogos del registro (razas, categorías,
// predios activos) desde /api/ganaderia/*. Un fallo deja el estado en
// 'error' (nunca un spinner infinito); el formulario puede reintentar.
import { useCallback, useEffect, useState } from 'react';
import { listCategoriasProductivas, listPrediosActivos, listRazas } from './hatoApi.js';

export default function useHatoCatalogos({ conPredios = true } = {}) {
  const [state, setState] = useState({ status: 'loading', razas: [], categorias: [], predios: [] });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      const [razasRes, categoriasRes, prediosRes] = await Promise.all([
        listRazas(),
        listCategoriasProductivas(),
        conPredios ? listPrediosActivos() : Promise.resolve({ ok: true, data: { predios: [] } }),
      ]);
      if (!razasRes.ok || !categoriasRes.ok || !prediosRes.ok) {
        setState({ status: 'error', razas: [], categorias: [], predios: [] });
        return;
      }
      setState({
        status: 'ok',
        razas: Array.isArray(razasRes.data?.razas) ? razasRes.data.razas : [],
        categorias: Array.isArray(categoriasRes.data?.categorias) ? categoriasRes.data.categorias : [],
        predios: (Array.isArray(prediosRes.data?.predios) ? prediosRes.data.predios : [])
          .filter((predio) => predio.estado === 'ACTIVO'),
      });
    } catch {
      setState({ status: 'error', razas: [], categorias: [], predios: [] });
    }
  }, [conPredios]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
