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
//
// FASE 1D.1 -- PESAJE_CREAR: POST /api/ganaderia/animales/:animalId/pesajes
// con el MISMO clientOperationId desde que se encola (nunca uno nuevo por
// reintento): 201 creado o 200 yaExistia confirman y eliminan la operación.
// Solo animales YA confirmados por el servidor (animalId numérico): un
// pesaje de un animal creado sin red no se encola (localRepo lo rechaza) y,
// por defensa, request() devuelve null y nunca se envía.

const ANIMAL_ID_SERVIDOR = /^[1-9]\d{0,17}$/;

export function esAnimalIdServidor(animalId) {
  return ANIMAL_ID_SERVIDOR.test(String(animalId ?? ''));
}

/** Cuerpo del POST: el mismo contrato que el registro online (buildPesajeBody). */
export function cuerpoPesaje(payload) {
  return {
    fecha: payload.fecha,
    pesoKg: payload.pesoKg,
    metodo: payload.metodo,
    ...(payload.observaciones ? { observaciones: payload.observaciones } : {}),
    clientOperationId: payload.clientOperationId,
  };
}

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
  PESAJE_CREAR: {
    request: (op) => (esAnimalIdServidor(op.payload?.animalId)
      ? { path: `/api/ganaderia/animales/${encodeURIComponent(op.payload.animalId)}/pesajes`, body: cuerpoPesaje(op.payload) }
      : null),
    onSuccess: (repo, op, data) => repo.confirmarPesajeCreado(op, data.pesaje ?? null),
  },
});

export function handlerFor(tipoOperacion) {
  const handler = OPERATION_HANDLERS[tipoOperacion];
  if (!handler) throw new Error(`OPERACION_SIN_MANEJADOR:${tipoOperacion}`);
  return handler;
}
