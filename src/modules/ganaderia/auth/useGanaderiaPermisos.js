// FASE 3A -- capacidades del rol de la organización activa para la UI.
// El rol sale SIEMPRE de la sesión del contexto de autenticación
// (organizacionActiva.rol); al revalidarse la sesión con el servidor, el rol
// nuevo reemplaza al anterior y la UI se recalcula. Sin sesión/organización:
// modo lectura (ninguna capacidad de escritura).
import { useMemo } from 'react';
import { useGanaderiaAuthOptional } from './GanaderiaAuthContext.jsx';
import { capacidadesDe } from './ganaderiaPermisos.js';

export function useGanaderiaPermisos() {
  const rol = useGanaderiaAuthOptional()?.organizacionActiva?.rol ?? null;
  return useMemo(() => ({ rol, ...capacidadesDe(rol) }), [rol]);
}
