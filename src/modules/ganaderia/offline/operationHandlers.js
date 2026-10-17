// SPRINT-3D11.3 (R1) -- registro de manejadores del outbox. Cada tipo de
// operación declara cómo construir la petición y cómo aplicar el éxito; la
// clasificación de errores (reintentable / conflicto / rechazo) es común
// en syncEngine.js. Para agregar pesajes, vacunas, tratamientos,
// reproducción u observaciones basta con registrar un manejador nuevo.
//
//   request(op, repo) -> { path, body } | null   (null = aún no lista, p. ej.
//                                                   depende de un animal sin animal_id)
//   onSuccess(repo, op, data)                     aplica la respuesta del servidor
//
// Todas las escrituras van a endpoints ya idempotentes por clientOperationId
// y transaccionales en el backend.

export const OPERATION_HANDLERS = Object.freeze({
  ANIMAL_CREAR: {
    request: (op) => ({ path: '/api/ganaderia/animales', body: op.payload.animal }),
    onSuccess: (repo, op, data) => repo.confirmarAnimalCreado(op, data.animal, null),
  },
  ANIMAL_CREAR_CON_CHAPETA: {
    request: (op) => ({
      path: `/api/ganaderia/qr/chapetas/${encodeURIComponent(op.payload.chapetaCodigo)}/registrar-animal`,
      body: op.payload.animal,
    }),
    onSuccess: (repo, op, data) => repo.confirmarAnimalCreado(op, data.animal, data.chapeta ?? null),
  },
});

export function handlerFor(tipoOperacion) {
  const handler = OPERATION_HANDLERS[tipoOperacion];
  if (!handler) throw new Error(`OPERACION_SIN_MANEJADOR:${tipoOperacion}`);
  return handler;
}
