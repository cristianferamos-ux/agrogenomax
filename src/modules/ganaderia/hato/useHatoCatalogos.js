// SPRINT-3D11.2: carga de catálogos del registro (razas, categorías,
// predios activos) desde /api/ganaderia/*. Un fallo deja el estado en
// 'error' (nunca un spinner infinito); el formulario puede reintentar.
//
// SPRINT-3D11.3 (R1): local-first -- con el dispositivo preparado los
// catálogos salen de la copia local (IndexedDB) y siguen disponibles sin red.
import { useCallback, useEffect, useState } from 'react';
import { listCategoriasProductivas, listPrediosActivos, listRazas } from './hatoApi.js';
import { useGanaderiaOffline } from '../offline/GanaderiaOfflineProvider.jsx';

export default function useHatoCatalogos({ conPredios = true } = {}) {
  const offline = useGanaderiaOffline();
  const local = offline.preparado && offline.repo ? offline.repo : null;
  const [state, setState] = useState({ status: 'loading', razas: [], categorias: [], predios: [] });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    if (local) {
      try {
        const [razas, categorias, predios] = await Promise.all([
          local.listRazas(),
          local.listCategorias(),
          conPredios ? local.listPredios() : Promise.resolve([]),
        ]);
        setState({ status: 'ok', razas, categorias, predios, origen: 'local' });
      } catch {
        setState({ status: 'error', razas: [], categorias: [], predios: [] });
      }
      return;
    }
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
        origen: 'servidor',
      });
    } catch {
      setState({ status: 'error', razas: [], categorias: [], predios: [] });
    }
  }, [conPredios, local]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
