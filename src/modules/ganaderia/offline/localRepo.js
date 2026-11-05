// SPRINT-3D11.3 (R1) -- repositorio local de Ganadería sobre el adaptador
// de almacenamiento (storage.js) de UNA organización. JS puro (sin React
// ni DOM): lo usan las páginas, el motor de sincronización y el Service
// Worker. Nunca fabrica un animal_id de PostgreSQL: un animal creado sin
// red vive como 'loc:<localUuid>' hasta que el servidor confirma su id.
import {
  CODIGOS_SIN_REINTENTO,
  ADVERTENCIA_CORRECCION_DIFERIDA,
  OUTBOX_ESTADOS,
  REPRODUCCION_EVENTO_ANULAR,
  REPRODUCCION_EVENTO_CORREGIR,
  REPRODUCCION_EVENTO_CREAR,
  backoffMs,
  claveOperacionAdministrativa,
  claveOrdenAnimal,
  enBackoffHttp,
  esOperacionAdministrativa,
  esOperacionReproductiva,
  firmaIntencion,
  SINCRONIZANDO_LEASE_MS,
  identidadCoincide,
  instanteEnCadena,
  newOperation,
  normalizarMotivo,
  ordenarOutbox,
  origenVerificable,
} from './outbox.js';
import { CONCILIACION, conciliarAnular, conciliarCorregir } from './reproduccionConciliacionAdmin.js';
import { MENSAJE_OFFLINE_ROLE_FORBIDDEN, puedeEncolar } from '../auth/ganaderiaPermisos.js';
import { normalizeCodigoChapeta, isQrToken } from '../hato/qrToken.js';
import { errorConMensajeSeguro } from '../api/errorModel.js';
import { compararEventos, evaluarRegistroLocal, intencionCoincide, primerBloqueoEnCadena } from '../engine/reproduccion.js';

// FASE 2B: situación del animal (EN_HATO | SALIDO | MUERTO). Una copia local
// anterior a 0025 no trae el campo: se trata como EN_HATO (fallback).
export function situacionLocal(animal) {
  return ['EN_HATO', 'SALIDO', 'MUERTO'].includes(animal?.estadoOperativo) ? animal.estadoOperativo : 'EN_HATO';
}

export const ESTADO_SYNC = Object.freeze({
  SINCRONIZADO: 'SINCRONIZADO',
  PENDIENTE: 'PENDIENTE',
  CONFLICTO: 'CONFLICTO',
  RECHAZADO: 'RECHAZADO',
});

const META_KEY = 'sync';

export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function localError(code, message) {
  return Object.assign(new Error(message), { code });
}

// FASE 3C: errores de dominio que la UI muestra tal cual (OfflineSyncPage:
// descartar pesaje y resolver conflictos). Solo estos -- con mensaje redactado
// para el productor y auditado -- se marcan como seguros; tener un code NO
// basta para mostrar el message (ver api/errorModel.js#mensajeDeExcepcion).
function errorVisible(code, message) {
  return Object.assign(errorConMensajeSeguro(message), { code });
}

/** animal_id de PostgreSQL (nunca 'local:<uuid>' ni un id fabricado). */
function esIdServidor(animalId) {
  return /^[1-9]\d{0,17}$/.test(String(animalId ?? ''));
}

/**
 * FASE 1D.1: vista de un pesaje pendiente (operación PESAJE_CREAR). Sin
 * pesajeId: no existe en el servidor hasta que este lo confirma.
 */
export function pesajePendienteDe(op) {
  return {
    localOperationId: op.operationId,
    localUuid: op.localUuid,
    clientOperationId: op.clientOperationId,
    animalId: op.payload.animalId,
    fecha: op.payload.fecha,
    pesoKg: op.payload.pesoKg,
    metodo: op.payload.metodo,
    observaciones: op.payload.observaciones ?? null,
    estado: op.estado,
    ultimoError: op.ultimoError ?? null,
    createdAt: op.createdAt,
  };
}

/**
 * FASE 4E.1: vista de un evento reproductivo pendiente. Sin eventoId y nunca
 * como estado confirmado: no entra en el estado, las alertas, la analítica ni
 * el PDF, que salen de datos del servidor.
 */
export function eventoPendienteDe(op) {
  return {
    localOperationId: op.operationId,
    clientOperationId: op.clientOperationId,
    animalId: op.payload.animalId,
    ...op.payload.evento,
    ...(esOperacionAdministrativa(op.tipoOperacion)
      ? { tipoOperacion: op.tipoOperacion, eventoObjetivoId: op.payload.eventoId, motivo: op.payload.motivo }
      : {}),
    cuentaOrigenId: op.origen?.cuentaId ?? null,
    estado: op.estado,
    posibleEnServidor: Boolean(op.posibleEnServidor),
    ultimoError: op.ultimoError ?? null,
    createdAt: op.createdAt,
  };
}

// Pendientes que cuentan como causa al evaluar un registro: un rechazado o en
// conflicto no se aplicará tal cual (la cadena espera su resolución explícita).
const ESTADOS_CAUSALES = Object.freeze([
  OUTBOX_ESTADOS.PENDIENTE,
  OUTBOX_ESTADOS.SINCRONIZANDO,
  OUTBOX_ESTADOS.ERROR_REINTENTABLE,
  OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD,
]);

// Una operación puede conciliarse con el pull solo si su resultado es incierto. Lo
// que está enviándose lo cierra su respuesta: un SINCRONIZANDO solo cuenta pasado el
// lease (interrumpido). Conflicto, rechazo y bloqueo por identidad nunca se concilian.
function resultadoIncierto(op, ahora) {
  if (op.estado === OUTBOX_ESTADOS.PENDIENTE || op.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE) return true;
  return op.estado === OUTBOX_ESTADOS.SINCRONIZANDO && Boolean(op.updatedAt) && new Date(op.updatedAt).getTime() <= ahora - SINCRONIZANDO_LEASE_MS;
}

// Un pendiente cuyo evento ya está confirmado (espera a su cuenta para cerrarse) no
// se cuenta dos veces al evaluar un registro. FASE 4E.2B: la cadena del animal incluye
// ANULAR y CORREGIR para el orden, pero aquí se reconstruyen eventos de CREACIÓN: una
// operación administrativa no es un evento nuevo que evaluar.
const eventosCausales = (ops, confirmados) => {
  const confirmadas = new Set(confirmados.map((evento) => evento.clientOperationId));
  return ops
    .filter((op) => op.tipoOperacion === REPRODUCCION_EVENTO_CREAR && ESTADOS_CAUSALES.includes(op.estado) && !confirmadas.has(op.clientOperationId))
    .map((op) => op.payload.evento);
};

const MENSAJE_CONCILIACION_DISTINTA = 'El servidor tiene este registro con datos distintos. Revísalo antes de continuar.';

/** Intención de una operación administrativa, sin depender del orden de los campos. */
const firmaAdministrativa = ({ tipoOperacion, payload }) => JSON.stringify([
  tipoOperacion, payload.animalId, payload.eventoId, payload.motivo, payload.evento ? firmaIntencion(payload.evento) : null,
]);

/**
 * @param {object} storage  adaptador (storage.js)
 * @param {{ organizacionId: string, deviceId: string, now?: () => Date, uuid?: () => string }} options
 */
export function createLocalRepo(storage, { organizacionId, deviceId, now = () => new Date(), uuid = () => globalThis.crypto.randomUUID() }) {
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Un listener roto no detiene al resto.
    }
  });

  async function getMeta() {
    return (await storage.get('meta', META_KEY)) ?? { key: META_KEY, organizacionId, cursor: null, ultimaSyncAt: null, ultimaSyncOk: null, ultimoError: null, preparadoAt: null };
  }

  async function putMeta(changes) {
    await storage.put('meta', { ...(await getMeta()), ...changes, key: META_KEY, organizacionId });
    notify();
  }

  const repo = {
    organizacionId,
    deviceId,
    storage,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify,
    getMeta,
    putMeta,

    async isPreparado() {
      return Boolean((await getMeta()).preparadoAt);
    },

    // -----------------------------------------------------------------
    // Lecturas (rutas offline del piloto)
    // -----------------------------------------------------------------

    /** Mismos filtros que GET /animales: estado ACTIVO y situación EN_HATO por defecto; 'TODOS' no filtra. */
    async listAnimales({ estado = 'ACTIVO', estadoOperativo = 'EN_HATO', q = '', predioId = '' } = {}) {
      const term = q.trim().toLowerCase();
      return (await storage.getAll('animales'))
        .filter((animal) => (estado && estado !== 'TODOS' ? animal.estado === estado : true))
        .filter((animal) => (estadoOperativo && estadoOperativo !== 'TODOS' ? situacionLocal(animal) === estadoOperativo : true))
        .filter((animal) => (predioId ? animal.predioId === predioId : true))
        .filter((animal) => !term
          || String(animal.numeroVisual ?? '').toLowerCase().startsWith(term)
          || String(animal.nombre ?? '').toLowerCase().startsWith(term))
        .sort((a, b) => String(b.creadoLocalAt ?? b.fechaCreacion ?? '').localeCompare(String(a.creadoLocalAt ?? a.fechaCreacion ?? '')));
    },

    /** :animalId del servidor o 'local:<uuid>'. Un local ya sincronizado redirige vía alias. */
    async getAnimal(routeId) {
      if (String(routeId).startsWith('local:')) {
        const localUuid = String(routeId).slice(6);
        const alias = await storage.get('aliases', localUuid);
        if (alias) return { redirectTo: alias.animalId };
        return (await storage.get('animales', `loc:${localUuid}`)) ?? null;
      }
      return (await storage.get('animales', `srv:${routeId}`)) ?? null;
    },

    /** Activos por defecto; incluirArchivados = mismo opt-in que GET /api/ganaderia/predios. */
    listPredios: async ({ incluirArchivados = false } = {}) => (await storage.getAll('predios'))
      .filter((p) => incluirArchivados || p.estado === 'ACTIVO')
      .sort((a, b) => String(b.fechaCreacion ?? '').localeCompare(String(a.fechaCreacion ?? '')) || a.nombrePredio.localeCompare(b.nombrePredio)),
    listPotreros: async (predioId) => (predioId ? storage.getAllByIndex('potreros', 'predioId', predioId) : storage.getAll('potreros')),
    listRazas: async () => (await storage.getAll('razas')).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    listCategorias: async () => (await storage.getAll('categorias')).sort((a, b) => a.nombre.localeCompare(b.nombre)),

    async getChapetaPorCodigo(codigoVisible) {
      return (await storage.get('chapetas', codigoVisible)) ?? null;
    },

    async getChapetaDeAnimal(animal) {
      if (!animal) return null;
      if (animal.animalId) {
        const rows = await storage.getAllByIndex('chapetas', 'animalId', animal.animalId);
        return rows.find((c) => c.estado === 'ASIGNADO_ANIMAL') ?? null;
      }
      return animal.chapetaCodigo ? (await storage.get('chapetas', animal.chapetaCodigo)) ?? null : null;
    },

    /**
     * Resolución OFFLINE de un QR escaneado o código digitado (mismo
     * resultado que el servidor, sobre la copia local):
     *   { resultado:'ANIMAL', to }       chapeta en uso -> ficha
     *   { resultado:'DISPONIBLE', to }   chapeta libre -> registro
     *   { resultado:'NO_OPERATIVA', estado }
     *   { resultado:'DESCONOCIDA' }      no está en este dispositivo: NO se
     *                                    asume inválida (puede ser nueva o de
     *                                    otra organización) -> verificar con red
     */
    async resolverLocal(parsed) {
      let chapeta = null;
      if (parsed.kind === 'token' && isQrToken(parsed.token)) {
        const [row] = await storage.getAllByIndex('chapetas', 'tokenHash', await sha256Hex(parsed.token));
        chapeta = row ?? null;
      } else if (parsed.kind === 'codigo') {
        chapeta = await repo.getChapetaPorCodigo(parsed.codigo);
      }
      if (!chapeta) return { resultado: 'DESCONOCIDA' };
      if (chapeta.reservaLocalUuid) {
        return { resultado: 'ANIMAL', chapeta, to: `/ganaderia/animales/local:${chapeta.reservaLocalUuid}` };
      }
      if (chapeta.estado === 'ASIGNADO_ORGANIZACION') {
        return { resultado: 'DISPONIBLE', chapeta, to: `/ganaderia/animales/nuevo?chapeta=${encodeURIComponent(chapeta.codigoVisible)}` };
      }
      const animal = chapeta.animalId ? await storage.get('animales', `srv:${chapeta.animalId}`) : null;
      if (chapeta.estado === 'ASIGNADO_ANIMAL' && chapeta.animalId) {
        if (!animal || (animal.estado === 'ACTIVO' && situacionLocal(animal) === 'EN_HATO')) {
          return { resultado: 'ANIMAL', chapeta, to: `/ganaderia/animales/${chapeta.animalId}` };
        }
      }
      // FASE 2B: vínculo histórico solo si el animal está en la copia local
      // (misma organización del dispositivo preparado).
      return { resultado: 'NO_OPERATIVA', chapeta, estado: chapeta.estado, animalId: animal ? chapeta.animalId : null };
    },

    async contar() {
      const [animales, chapetas, outbox, meta] = await Promise.all([
        storage.getAll('animales'), storage.getAll('chapetas'), storage.getAll('outbox'), getMeta(),
      ]);
      return {
        animales: animales.filter((a) => a.estado === 'ACTIVO').length,
        chapetasDisponibles: chapetas.filter((c) => c.estado === 'ASIGNADO_ORGANIZACION' && !c.reservaLocalUuid).length,
        pendientes: outbox.filter((op) => [OUTBOX_ESTADOS.PENDIENTE, OUTBOX_ESTADOS.SINCRONIZANDO, OUTBOX_ESTADOS.ERROR_REINTENTABLE, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD].includes(op.estado)).length,
        conflictos: outbox.filter((op) => op.estado === OUTBOX_ESTADOS.CONFLICTO || op.estado === OUTBOX_ESTADOS.RECHAZADO).length,
        errores: outbox.filter((op) => op.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE).length,
        bloqueadasIdentidad: outbox.filter((op) => op.estado === OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD).length,
        ultimaSyncAt: meta.ultimaSyncAt,
        ultimaSyncOk: meta.ultimaSyncOk,
        ultimoError: meta.ultimoError,
        preparadoAt: meta.preparadoAt,
        reproduccionListaAt: meta.reproduccionListaAt ?? null,
      };
    },

    listOutbox: () => storage.getAll('outbox'),
    getOperacion: (operationId) => storage.get('outbox', operationId),
    putOperacion: async (op) => {
      await storage.put('outbox', op);
      notify();
    },

    // -----------------------------------------------------------------
    // Escritura local: registrar animal (con o sin chapeta)
    // -----------------------------------------------------------------

    /**
     * Guarda el animal localmente, reserva la chapeta (si la hay) y encola
     * la operación -- todo en UNA transacción local. `body` es exactamente
     * el cuerpo de POST /api/ganaderia/animales (incluye clientOperationId).
     */
    async registrarAnimalLocal({ body, chapetaCodigo = null }) {
      if (!body?.clientOperationId) throw localError('OPERACION_SIN_ID', 'Falta clientOperationId.');
      const codigo = chapetaCodigo ? normalizeCodigoChapeta(chapetaCodigo) : null;
      if (chapetaCodigo && !codigo) throw localError('QR_CODIGO_INVALIDO', 'Código de chapeta inválido.');

      const operaciones = [];
      let chapeta = null;
      if (codigo) {
        chapeta = await repo.getChapetaPorCodigo(codigo);
        if (!chapeta) throw localError('QR_NO_EN_DISPOSITIVO', 'La chapeta no está en este dispositivo.');
        if (chapeta.estado !== 'ASIGNADO_ORGANIZACION' || chapeta.reservaLocalUuid) {
          throw localError('QR_NO_DISPONIBLE', 'La chapeta ya no está disponible.');
        }
      }

      const localUuid = uuid();
      const at = now().toISOString();
      const [predio, raza, categoria] = await Promise.all([
        body.predioId ? storage.get('predios', String(body.predioId)) : null,
        body.razaPrincipalId ? storage.get('razas', String(body.razaPrincipalId)) : null,
        body.categoriaProductivaId ? storage.get('categorias', String(body.categoriaProductivaId)) : null,
      ]);
      const animal = {
        key: `loc:${localUuid}`,
        localUuid,
        animalId: null,
        clientOperationId: body.clientOperationId,
        estadoSync: ESTADO_SYNC.PENDIENTE,
        creadoLocalAt: at,
        chapetaCodigo: codigo,
        conflicto: null,
        datosFormulario: body,
        predioId: body.predioId ? String(body.predioId) : null,
        predioNombre: predio?.nombrePredio ?? null,
        numeroVisual: body.numeroVisual ?? null,
        nombre: body.nombre ?? null,
        sexo: body.sexo,
        nacimientoTipo: body.nacimientoTipo,
        fechaNacimiento: body.fechaNacimiento ?? null,
        edadAproximadaMeses: body.edadAproximadaMeses ?? null,
        edadReferenciaFecha: body.nacimientoTipo === 'APROXIMADA' ? at.slice(0, 10) : null,
        razaTipo: body.razaTipo,
        razaPrincipalId: body.razaPrincipalId ? String(body.razaPrincipalId) : null,
        razaPrincipalNombre: raza?.nombre ?? null,
        razaOtroNombre: body.razaOtroNombre ?? null,
        cruceDescripcion: body.cruceDescripcion ?? null,
        categoriaProductivaId: body.categoriaProductivaId ? String(body.categoriaProductivaId) : null,
        categoriaProductivaNombre: categoria?.nombre ?? null,
        ultimoPeso: body.pesoInicialKg ? { pesoKg: Number(body.pesoInicialKg), metodo: body.pesoInicialMetodo, fecha: at.slice(0, 10) } : null,
        origenTipo: body.origenTipo ?? null,
        procedencia: body.procedencia ?? null,
        fechaIngreso: body.fechaIngreso ?? null,
        observaciones: body.observaciones ?? null,
        estado: 'ACTIVO',
      };
      operaciones.push({ op: 'put', store: 'animales', value: animal });
      if (chapeta) operaciones.push({ op: 'put', store: 'chapetas', value: { ...chapeta, reservaLocalUuid: localUuid } });

      const op = newOperation({
        tipoOperacion: codigo ? 'ANIMAL_CREAR_CON_CHAPETA' : 'ANIMAL_CREAR',
        entidad: 'animal',
        localUuid,
        clientOperationId: body.clientOperationId,
        payload: { animal: body, chapetaCodigo: codigo },
        deviceId,
        now: now(),
        uuid,
      });
      operaciones.push({ op: 'put', store: 'outbox', value: op });
      await storage.batch(operaciones);
      notify();
      return { localUuid, operationId: op.operationId, animal };
    },

    // -----------------------------------------------------------------
    // FASE 1D.1 -- pesajes pendientes de sincronización (PESAJE_CREAR)
    // -----------------------------------------------------------------

    /**
     * Encola un pesaje de un animal YA confirmado por el servidor. `body` es
     * exactamente el cuerpo de POST /api/ganaderia/animales/:id/pesajes
     * (buildPesajeBody: fecha, pesoKg, metodo, observaciones?,
     * clientOperationId); NUNCA lleva organizacionId (el servidor la toma de
     * la sesión). Idempotente: el mismo clientOperationId no crea una segunda
     * operación (doble clic, reintento del usuario). No se fabrica pesajeId:
     * el pesaje solo existe en el servidor cuando este lo confirma.
     */
    async registrarPesajeLocal({ animalId, body }) {
      if (!esIdServidor(animalId)) {
        throw localError('PESAJE_REQUIERE_ANIMAL_SINCRONIZADO', 'Este animal aún no está sincronizado: registra el pesaje cuando el servidor lo confirme.');
      }
      if (!body?.clientOperationId) throw localError('OPERACION_SIN_ID', 'Falta clientOperationId.');
      if ('organizacionId' in body || 'organizacion_id' in body) throw localError('CAMPO_NO_PERMITIDO', 'La organización la resuelve el servidor.');
      const previa = (await storage.getAll('outbox')).find((op) => op.tipoOperacion === 'PESAJE_CREAR' && op.clientOperationId === body.clientOperationId);
      if (previa) return { localUuid: previa.localUuid, operationId: previa.operationId, pendiente: pesajePendienteDe(previa), yaEncolado: true };
      const op = newOperation({
        tipoOperacion: 'PESAJE_CREAR',
        entidad: 'pesaje',
        localUuid: uuid(),
        clientOperationId: body.clientOperationId,
        payload: {
          animalId: String(animalId),
          fecha: body.fecha,
          pesoKg: body.pesoKg,
          metodo: body.metodo,
          observaciones: body.observaciones ?? null,
          clientOperationId: body.clientOperationId,
        },
        deviceId,
        now: now(),
        uuid,
      });
      await storage.batch([{ op: 'put', store: 'outbox', value: op }]);
      notify();
      return { localUuid: op.localUuid, operationId: op.operationId, pendiente: pesajePendienteDe(op), yaEncolado: false };
    },

    /** Pesajes del outbox de un animal (orden de envío). Nunca entran en los datos confirmados. */
    async listPesajesPendientes(animalId) {
      const ops = (await storage.getAll('outbox'))
        .filter((op) => op.tipoOperacion === 'PESAJE_CREAR' && op.payload?.animalId === String(animalId));
      return ordenarOutbox(ops).map(pesajePendienteDe);
    },

    /** Descarta un pesaje que el servidor rechazó (decisión explícita del usuario). */
    async descartarPesajePendiente(operationId) {
      const op = await storage.get('outbox', operationId);
      if (!op || op.tipoOperacion !== 'PESAJE_CREAR') throw errorVisible('PESAJE_PENDIENTE_NO_ENCONTRADO', 'No hay un pesaje pendiente con ese identificador.');
      if (![OUTBOX_ESTADOS.CONFLICTO, OUTBOX_ESTADOS.RECHAZADO].includes(op.estado)) {
        throw errorVisible('PESAJE_PENDIENTE_EN_CURSO', 'Solo se descartan pesajes que el servidor no aceptó.');
      }
      await storage.batch([{ op: 'delete', store: 'outbox', key: operationId }]);
      notify();
    },

    // -----------------------------------------------------------------
    // FASE 4E.1 -- eventos reproductivos pendientes (REPRODUCCION_EVENTO_CREAR)
    // -----------------------------------------------------------------

    /** Copia local de eventos CONFIRMADOS por el servidor, en orden de plegado. */
    async listEventosReproductivos(animalId) {
      return (await storage.getAllByIndex('reproduccion_eventos', 'animalId', String(animalId))).sort(compararEventos);
    },

    /** Operaciones de la cadena de un animal, en orden de envío. */
    async cadenaReproductiva(animalId) {
      return ordenarOutbox(await storage.getAllByIndex('outbox', 'claveOrden', claveOrdenAnimal(animalId)));
    },

    async listEventosReproductivosPendientes(animalId) {
      return (await repo.cadenaReproductiva(animalId)).map(eventoPendienteDe);
    },

    /**
     * Encola un evento de una hembra YA confirmada por el servidor. `body` es
     * exactamente el cuerpo de POST .../reproduccion/eventos (buildCrearBody);
     * NUNCA lleva organizacionId. Idempotente por clientOperationId.
     *
     * Conflicto que causa un pendiente local: se rechaza. Conflicto que solo
     * sale de la copia confirmada (puede estar desactualizada): devuelve
     * { requiereConfirmacion, advertencia } sin encolar, y con
     * confirmarAdvertencia se encola; el servidor decide al sincronizar.
     */
    async registrarEventoReproductivoLocal({ animalId, body, cuentaId, confirmarAdvertencia = false }) {
      if (!esIdServidor(animalId)) {
        throw errorVisible('REPRODUCCION_REQUIERE_ANIMAL_SINCRONIZADO', 'Esta hembra aún no está sincronizada: registra el evento cuando el servidor la confirme.');
      }
      if (!cuentaId) throw localError('OPERACION_SIN_CUENTA', 'Falta la cuenta de la sesión.');
      if (!body?.clientOperationId) throw localError('OPERACION_SIN_ID', 'Falta clientOperationId.');
      if ('organizacionId' in body || 'organizacion_id' in body) throw localError('CAMPO_NO_PERMITIDO', 'La organización la resuelve el servidor.');
      const { clientOperationId, ...evento } = body;

      const previa = (await storage.getAll('outbox')).find((op) => esOperacionReproductiva(op.tipoOperacion) && op.clientOperationId === clientOperationId);
      if (previa) {
        if (previa.tipoOperacion !== REPRODUCCION_EVENTO_CREAR || previa.payload.animalId !== String(animalId) || firmaIntencion(previa.payload.evento) !== firmaIntencion(evento)) {
          throw errorVisible('CLIENT_OPERATION_ID_REUSED', 'Esta operación ya se registró con datos distintos.');
        }
        return { operationId: previa.operationId, pendiente: eventoPendienteDe(previa), yaEncolado: true };
      }

      const animal = await storage.get('animales', `srv:${animalId}`);
      if (!animal) throw errorVisible('ANIMAL_NO_EN_DISPOSITIVO', 'Esta hembra no está en la copia de este dispositivo.');
      if (animal.sexo !== 'HEMBRA' || animal.estado !== 'ACTIVO' || situacionLocal(animal) !== 'EN_HATO') {
        throw errorVisible('ANIMAL_NO_ADMITE_REPRODUCCION', 'Solo una hembra activa en el hato admite eventos reproductivos.');
      }
      if (!(await getMeta()).reproduccionListaAt) {
        throw errorVisible('REPRODUCCION_SIN_COPIA_LOCAL', 'Conéctate para descargar el historial reproductivo antes de registrar sin señal.');
      }

      const cadena = await repo.cadenaReproductiva(animalId);
      const confirmados = await repo.listEventosReproductivos(animalId);
      const { bloqueo, advertencia } = evaluarRegistroLocal({
        sexo: animal.sexo,
        confirmados,
        pendientes: eventosCausales(cadena, confirmados),
        evento,
      });
      if (bloqueo) throw errorVisible(bloqueo.code, bloqueo.message);
      if (advertencia && !confirmarAdvertencia) return { requiereConfirmacion: true, advertencia };

      const op = newOperation({
        tipoOperacion: REPRODUCCION_EVENTO_CREAR,
        entidad: 'reproduccion_evento',
        localUuid: uuid(),
        clientOperationId,
        payload: { animalId: String(animalId), evento },
        deviceId,
        now: instanteEnCadena(cadena, now()),
        uuid,
        claveOrden: claveOrdenAnimal(animalId),
        origen: { organizacionId, cuentaId },
      });
      await storage.batch([{ op: 'put', store: 'outbox', value: op }]);
      notify();
      return { operationId: op.operationId, pendiente: eventoPendienteDe(op), advertencia, yaEncolado: false };
    },

    /**
     * Sustituye la intención de un evento pendiente en la MISMA operación (misma
     * posición FIFO, nunca dos pendientes para una edición). Con datos distintos
     * lleva un clientOperationId NUEVO; sin cambios no hace nada. Si pudo llegar
     * al servidor no se puede cambiar: se conserva para reconciliarla.
     */
    async editarEventoReproductivoPendiente({ operationId, body, cuentaId, confirmarAdvertencia = false }) {
      const leida = await storage.get('outbox', operationId);
      if (!leida || leida.tipoOperacion !== REPRODUCCION_EVENTO_CREAR) throw errorVisible('EVENTO_PENDIENTE_NO_ENCONTRADO', 'No hay un evento pendiente con ese identificador.');
      if (!identidadCoincide(leida, cuentaId)) throw errorVisible(OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, 'Este evento lo registró otra cuenta: solo esa cuenta puede modificarlo.');
      if (leida.estado === OUTBOX_ESTADOS.SINCRONIZANDO) throw errorVisible('EVENTO_PENDIENTE_EN_CURSO', 'Este evento se está enviando: espera a que termine.');
      if (leida.posibleEnServidor) throw errorVisible('EVENTO_ENVIO_INCIERTO', 'Este evento pudo haber llegado al servidor: se conserva hasta confirmarlo y no se puede modificar.');

      const { clientOperationId: _ignorado, ...evento } = body ?? {};
      if ('organizacionId' in evento || 'organizacion_id' in evento) throw localError('CAMPO_NO_PERMITIDO', 'La organización la resuelve el servidor.');
      if (firmaIntencion(leida.payload.evento) === firmaIntencion(evento)) {
        return { operationId, pendiente: eventoPendienteDe(leida), sinCambios: true };
      }

      const animal = await storage.get('animales', `srv:${leida.payload.animalId}`);
      const confirmados = await repo.listEventosReproductivos(leida.payload.animalId);
      const cadena = await repo.cadenaReproductiva(leida.payload.animalId);
      const posicion = cadena.findIndex((op) => op.operationId === operationId);
      const anteriores = eventosCausales(cadena.slice(0, posicion), confirmados);
      const { bloqueo, advertencia } = evaluarRegistroLocal({ sexo: animal?.sexo, confirmados, pendientes: anteriores, evento });
      if (bloqueo) throw errorVisible(bloqueo.code, bloqueo.message);
      // La edición no puede dejar inválido, de forma determinista, a un pendiente posterior.
      const siguientes = primerBloqueoEnCadena({ sexo: animal?.sexo, confirmados, pendientes: [...anteriores, evento, ...eventosCausales(cadena.slice(posicion + 1), confirmados)] });
      if (siguientes) throw errorVisible(siguientes.bloqueo.code, `Este cambio deja inválido un evento pendiente posterior. ${siguientes.bloqueo.message}`);
      if (advertencia && !confirmarAdvertencia) return { requiereConfirmacion: true, advertencia };

      const clientOperationId = uuid();
      const editada = await storage.mutate('outbox', operationId, (actual) => {
        // Reclamada o cambiada desde la lectura: la decisión ya no es válida.
        if (!actual || actual.updatedAt !== leida.updatedAt || actual.estado !== leida.estado || actual.posibleEnServidor) {
          throw errorVisible('EVENTO_PENDIENTE_CAMBIO', 'Este evento cambió mientras lo editabas. Revísalo e inténtalo de nuevo.');
        }
        return {
          ...actual,
          clientOperationId,
          payload: { ...actual.payload, evento },
          estado: OUTBOX_ESTADOS.PENDIENTE,
          intentos: 0,
          ultimoError: null,
          siguienteIntentoAt: null,
          runtimeNoSoporta: null,
          updatedAt: now().toISOString(),
        };
      });
      notify();
      return { operationId, pendiente: eventoPendienteDe(editada), advertencia, sinCambios: false };
    },

    /**
     * FASE 4E.2B: encola una anulación o corrección de un evento YA confirmado. El rol
     * se comprueba aquí solo como UX: la autoridad es el servidor. `origen` es la
     * cuenta de la sesión y nunca se reasigna.
     *
     * Una sola operación administrativa por evento: la clave del outbox lo garantiza
     * de forma atómica, también entre pestañas. Mismo clientOperationId con la misma
     * intención es idempotente; con otra, CLIENT_OPERATION_ID_REUSED.
     *
     * Dos caminos:
     *   diferida (sin red o con cadena pendiente): CORREGIR devuelve
     *     { requiereConfirmacion, advertencia } hasta que el usuario confirme.
     *   tras un intento online sin resultado: `fallo` { codigo, status, tipo } y
     *     posibleEnServidor conservan el MISMO id y la incertidumbre del envío.
     */
    async encolarOperacionAdministrativa({
      tipoOperacion, animalId, eventoId, motivo, evento = null, clientOperationId, cuentaId, rol,
      confirmarAdvertencia = false, posibleEnServidor = false, fallo = null,
    }) {
      if (!esOperacionAdministrativa(tipoOperacion)) throw localError('OPERACION_DESCONOCIDA', 'Operación administrativa desconocida.');
      if (!puedeEncolar(rol, tipoOperacion)) throw errorVisible('ROLE_FORBIDDEN', MENSAJE_OFFLINE_ROLE_FORBIDDEN);
      if (!esIdServidor(animalId) || !esIdServidor(eventoId)) {
        throw errorVisible('REPRODUCCION_REQUIERE_EVENTO_CONFIRMADO', 'Solo se puede anular o corregir un evento ya confirmado por el servidor.');
      }
      if (!cuentaId) throw localError('OPERACION_SIN_CUENTA', 'Falta la cuenta de la sesión.');
      if (!clientOperationId) throw localError('OPERACION_SIN_ID', 'Falta clientOperationId.');
      const esCorreccion = tipoOperacion === REPRODUCCION_EVENTO_CORREGIR;
      if (esCorreccion && (!evento || typeof evento !== 'object' || 'organizacionId' in evento || 'organizacion_id' in evento)) {
        throw localError('CAMPO_NO_PERMITIDO', 'La corrección no es válida.');
      }
      const motivoNormal = normalizarMotivo(motivo);
      if (!motivoNormal) throw errorVisible('INVALID_MOTIVO', 'Indica el motivo.');

      const payload = { animalId: String(animalId), eventoId: String(eventoId), motivo: motivoNormal, ...(esCorreccion ? { evento } : {}) };
      const firma = firmaAdministrativa({ tipoOperacion, payload });
      const reutilizada = (await storage.getAll('outbox')).find((op) => esOperacionReproductiva(op.tipoOperacion) && op.clientOperationId === clientOperationId);
      if (reutilizada) {
        if (reutilizada.tipoOperacion !== tipoOperacion || firmaAdministrativa(reutilizada) !== firma) {
          throw errorVisible('CLIENT_OPERATION_ID_REUSED', 'Esta operación ya se registró con datos distintos.');
        }
        return { operationId: reutilizada.operationId, pendiente: eventoPendienteDe(reutilizada), yaEncolado: true };
      }

      const conocido = await storage.get('reproduccion_eventos', payload.eventoId);
      // Tras un envío incierto se conserva siempre: es lo que permite reconciliarlo.
      if (conocido?.estadoRegistro === 'ANULADO' && !posibleEnServidor) {
        throw errorVisible('EVENTO_YA_ANULADO', 'Este evento ya fue anulado o corregido.');
      }
      if (esCorreccion && !fallo && !posibleEnServidor && !confirmarAdvertencia) {
        return { requiereConfirmacion: true, advertencia: { code: 'CORRECCION_DIFERIDA', message: ADVERTENCIA_CORRECCION_DIFERIDA } };
      }

      const cadena = await repo.cadenaReproductiva(animalId);
      const instante = instanteEnCadena(cadena, now());
      const operationId = claveOperacionAdministrativa(payload.eventoId);
      const nueva = {
        ...newOperation({
          tipoOperacion,
          entidad: 'reproduccion_evento',
          localUuid: uuid(),
          clientOperationId,
          payload,
          deviceId,
          now: instante,
          uuid: () => operationId,
          claveOrden: claveOrdenAnimal(animalId),
          origen: { organizacionId, cuentaId },
        }),
        posibleEnServidor: Boolean(posibleEnServidor),
        ...(fallo ? {
          estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE,
          intentos: 1,
          ultimoError: { codigo: fallo.codigo, mensaje: null, status: fallo.status ?? 0, tipo: fallo.tipo },
          siguienteIntentoAt: fallo.tipo === 'red' ? null : new Date(now().getTime() + backoffMs(1)).toISOString(),
        } : {}),
      };
      await storage.mutate('outbox', operationId, (actual) => {
        if (actual) throw errorVisible('OPERACION_ADMINISTRATIVA_PENDIENTE', 'Este evento ya tiene una anulación o corrección pendiente en este dispositivo.');
        return nueva;
      });
      notify();
      return { operationId, pendiente: eventoPendienteDe(nueva), yaEncolado: false };
    },

    /**
     * Edita una corrección que no llegó a enviarse con resultado incierto: misma
     * operación y misma posición FIFO; con datos distintos, clientOperationId NUEVO.
     * Con posibleEnServidor no se puede: el servidor pudo guardarla con esta intención.
     * Un conflicto tampoco: el servidor ya decidió sobre el evento y editar no lo cambia.
     */
    async editarCorreccionPendiente({ operationId, motivo, evento, cuentaId, rol }) {
      if (!puedeEncolar(rol, REPRODUCCION_EVENTO_CORREGIR)) throw errorVisible('ROLE_FORBIDDEN', MENSAJE_OFFLINE_ROLE_FORBIDDEN);
      const motivoNormal = normalizarMotivo(motivo);
      if (!motivoNormal) throw errorVisible('INVALID_MOTIVO', 'Indica el motivo.');
      if (!evento || typeof evento !== 'object' || 'organizacionId' in evento || 'organizacion_id' in evento) throw localError('CAMPO_NO_PERMITIDO', 'La corrección no es válida.');
      const clientOperationId = uuid();
      let sinCambios = false;
      const editada = await storage.mutate('outbox', operationId, (actual) => {
        if (!actual || actual.tipoOperacion !== REPRODUCCION_EVENTO_CORREGIR) throw errorVisible('EVENTO_PENDIENTE_NO_ENCONTRADO', 'No hay una corrección pendiente con ese identificador.');
        if (!identidadCoincide(actual, cuentaId)) throw errorVisible(OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, 'Esta corrección la registró otra cuenta: solo esa cuenta puede modificarla.');
        if (actual.estado === OUTBOX_ESTADOS.SINCRONIZANDO) throw errorVisible('EVENTO_PENDIENTE_EN_CURSO', 'Esta corrección se está enviando: espera a que termine.');
        if (actual.posibleEnServidor) throw errorVisible('EVENTO_ENVIO_INCIERTO', 'Esta corrección pudo haber llegado al servidor: se conserva hasta confirmarla y no se puede modificar.');
        if (actual.estado === OUTBOX_ESTADOS.CONFLICTO) throw errorVisible('EVENTO_EN_CONFLICTO', 'El servidor ya decidió sobre este evento: revisa el historial y descarta la corrección.');
        const payload = { ...actual.payload, motivo: motivoNormal, evento };
        if (firmaAdministrativa({ tipoOperacion: actual.tipoOperacion, payload }) === firmaAdministrativa(actual)) {
          sinCambios = true;
          return undefined;
        }
        return {
          ...actual,
          clientOperationId,
          payload,
          estado: OUTBOX_ESTADOS.PENDIENTE,
          intentos: 0,
          ultimoError: null,
          siguienteIntentoAt: null,
          runtimeNoSoporta: null,
          updatedAt: now().toISOString(),
        };
      });
      if (!sinCambios) notify();
      return { operationId, pendiente: eventoPendienteDe(editada), sinCambios };
    },

    /**
     * Cancela un evento pendiente solo en este dispositivo: no llama al backend.
     * Si pudo llegar al servidor se conserva para reconciliarlo; únicamente un
     * conflicto o rechazo se descarta, con confirmarIncierto (el usuario sabe que
     * pudo registrarse y lo verá en el historial). Solo su cuenta puede cancelarlo.
     */
    async cancelarEventoReproductivoPendiente(operationId, { cuentaId, confirmarIncierto = false } = {}) {
      await storage.mutate('outbox', operationId, (actual) => {
        if (!actual || !esOperacionReproductiva(actual.tipoOperacion)) throw errorVisible('EVENTO_PENDIENTE_NO_ENCONTRADO', 'No hay un evento pendiente con ese identificador.');
        if (!identidadCoincide(actual, cuentaId)) throw errorVisible(OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, 'Este evento lo registró otra cuenta: solo esa cuenta puede cancelarlo.');
        if (actual.estado === OUTBOX_ESTADOS.SINCRONIZANDO) throw errorVisible('EVENTO_PENDIENTE_EN_CURSO', 'Este evento se está enviando: espera a que termine.');
        if (actual.posibleEnServidor) {
          const descartable = [OUTBOX_ESTADOS.CONFLICTO, OUTBOX_ESTADOS.RECHAZADO].includes(actual.estado);
          if (!descartable || !confirmarIncierto) throw errorVisible('EVENTO_ENVIO_INCIERTO', 'Este evento pudo haber llegado al servidor: se conserva hasta confirmarlo.');
        }
        return null;
      });
      notify();
    },

    /**
     * Reintento explícito de un conflicto, rechazo o error reintentable: la misma
     * operación, con el MISMO clientOperationId y su misma posición en la cadena. Si
     * el envío anterior llegó al servidor, responderá yaExistia y no se duplica. No
     * cambia posibleEnServidor ni los intentos. Solo la cuenta que la creó.
     */
    async reintentarEventoPendiente(operationId, { cuentaId } = {}) {
      await storage.mutate('outbox', operationId, (actual) => {
        if (!actual || !esOperacionReproductiva(actual.tipoOperacion)) throw errorVisible('EVENTO_PENDIENTE_NO_ENCONTRADO', 'No hay un evento pendiente con ese identificador.');
        if (!identidadCoincide(actual, cuentaId)) throw errorVisible(OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, 'Este evento lo registró otra cuenta: solo esa cuenta puede reintentarlo.');
        if (![OUTBOX_ESTADOS.CONFLICTO, OUTBOX_ESTADOS.RECHAZADO, OUTBOX_ESTADOS.ERROR_REINTENTABLE].includes(actual.estado)) {
          throw errorVisible('EVENTO_NO_REINTENTABLE', 'Este evento no necesita un reintento manual.');
        }
        if (CODIGOS_SIN_REINTENTO.includes(actual.ultimoError?.codigo)) {
          throw errorVisible('EVENTO_NO_REINTENTABLE', 'El servidor tiene este registro con otros datos: reintentar no lo resolverá.');
        }
        if (enBackoffHttp(actual, now())) {
          throw errorVisible('EVENTO_EN_BACKOFF', 'El servidor pidió esperar: se reintentará automáticamente.');
        }
        return { ...actual, estado: OUTBOX_ESTADOS.PENDIENTE, ultimoError: null, siguienteIntentoAt: null, updatedAt: now().toISOString() };
      });
      notify();
    },

    // -----------------------------------------------------------------
    // Aplicación de resultados del servidor
    // -----------------------------------------------------------------

    /**
     * FASE 4E.1: transición ATÓMICA de una operación con cadena. Solo se aplica
     * si sigue exactamente como se leyó (ni editada, ni cancelada, ni reclamada
     * por otro motor). Devuelve la operación actualizada o null si cambió.
     */
    async transicionarOperacion(leida, cambios) {
      let actualizada = null;
      await storage.mutate('outbox', leida.operationId, (actual) => {
        if (!actual || actual.updatedAt !== leida.updatedAt || actual.estado !== leida.estado || actual.clientOperationId !== leida.clientOperationId) return undefined;
        actualizada = { ...actual, ...cambios };
        return actualizada;
      });
      if (actualizada) notify();
      return actualizada;
    },

    /**
     * FASE 4E.1: el servidor confirmó el evento (201 creado o 200 yaExistia). En
     * una transacción: sale del outbox y entra en la copia confirmada, con los
     * campos de `detalle` planos para el plegado del estado.
     */
    async confirmarEventoReproductivoCreado(op, evento) {
      const operaciones = [{ op: 'delete', store: 'outbox', key: op.operationId }];
      if (evento?.eventoId) {
        operaciones.push({ op: 'put', store: 'reproduccion_eventos', value: { ...evento, ...evento.detalle, clientOperationId: op.clientOperationId } });
      }
      await storage.batch(operaciones);
      notify();
    },

    /**
     * FASE 4E.2B: el servidor confirmó la anulación (200, nueva o yaExistia). La
     * respuesta es la vista pública: se fusiona con la copia local para no perder el
     * clientOperationId del evento y se deja la evidencia de qué operación lo anuló.
     */
    async confirmarAnulacionReproductiva(op, evento) {
      const operaciones = [{ op: 'delete', store: 'outbox', key: op.operationId }];
      if (evento?.eventoId) {
        const existente = await storage.get('reproduccion_eventos', evento.eventoId);
        operaciones.push({ op: 'put', store: 'reproduccion_eventos', value: { ...existente, ...evento, ...evento.detalle, anulacionClientOperationId: op.clientOperationId } });
      }
      await storage.batch(operaciones);
      notify();
    },

    /** FASE 4E.2B: la corrección es una transacción: corrector y original entran juntos. */
    async confirmarCorreccionReproductiva(op, corrector, original) {
      const operaciones = [{ op: 'delete', store: 'outbox', key: op.operationId }];
      if (corrector?.eventoId) {
        const existente = await storage.get('reproduccion_eventos', corrector.eventoId);
        operaciones.push({ op: 'put', store: 'reproduccion_eventos', value: { ...existente, ...corrector, ...corrector.detalle, clientOperationId: op.clientOperationId } });
      }
      if (original?.eventoId) {
        const existente = await storage.get('reproduccion_eventos', original.eventoId);
        operaciones.push({ op: 'put', store: 'reproduccion_eventos', value: { ...existente, ...original, ...original.detalle, anulacionClientOperationId: op.clientOperationId } });
      }
      await storage.batch(operaciones);
      notify();
    },

    /** Éxito de una creación: local_uuid -> animal_id definitivo, en una transacción. */
    async confirmarAnimalCreado(op, animalServidor, chapetaServidor) {
      const local = await storage.get('animales', `loc:${op.localUuid}`);
      const operaciones = [
        { op: 'delete', store: 'animales', key: `loc:${op.localUuid}` },
        {
          op: 'put',
          store: 'animales',
          value: {
            ...animalServidor,
            key: `srv:${animalServidor.animalId}`,
            localUuid: op.localUuid,
            clientOperationId: op.clientOperationId,
            estadoSync: ESTADO_SYNC.SINCRONIZADO,
            creadoLocalAt: local?.creadoLocalAt ?? null,
            conflicto: null,
          },
        },
        { op: 'put', store: 'aliases', value: { localUuid: op.localUuid, animalId: animalServidor.animalId } },
        { op: 'delete', store: 'outbox', key: op.operationId },
      ];
      if (op.payload.chapetaCodigo) {
        const previa = await repo.getChapetaPorCodigo(op.payload.chapetaCodigo);
        const merged = {
          ...(previa ?? {}),
          ...(chapetaServidor ?? {}),
          codigoVisible: op.payload.chapetaCodigo,
          tokenHash: previa?.tokenHash ?? null,
          estado: chapetaServidor?.estado ?? 'ASIGNADO_ANIMAL',
          animalId: animalServidor.animalId,
          reservaLocalUuid: null,
        };
        operaciones.push({ op: 'put', store: 'chapetas', value: merged });
      }
      await storage.batch(operaciones);
      notify();
    },

    /**
     * FASE 1D.1: el servidor confirmó el pesaje (201 creado o 200 yaExistia).
     * Se elimina la operación; el historial, KPIs, gráficas, alertas y PDF se
     * vuelven a pedir al servidor (fuente de verdad) vía notify().
     */
    async confirmarPesajeCreado(op) {
      await storage.batch([{ op: 'delete', store: 'outbox', key: op.operationId }]);
      notify();
    },

    /** Conflicto o rechazo: se conservan el animal local y la operación. */
    async marcarOperacionBloqueada(op, { estado, codigo, mensaje, status }) {
      const operaciones = [{
        op: 'put',
        store: 'outbox',
        value: { ...op, estado, ultimoError: { codigo, mensaje, status }, updatedAt: now().toISOString(), siguienteIntentoAt: null },
      }];
      const local = await storage.get('animales', `loc:${op.localUuid}`);
      if (local) {
        operaciones.push({
          op: 'put',
          store: 'animales',
          value: {
            ...local,
            estadoSync: estado === OUTBOX_ESTADOS.CONFLICTO ? ESTADO_SYNC.CONFLICTO : ESTADO_SYNC.RECHAZADO,
            conflicto: { codigo, mensaje, detectadoAt: now().toISOString(), valorLocal: op.payload },
          },
        });
      }
      // Otro dispositivo usó la chapeta: se libera la reserva local (la
      // copia del servidor llega en el siguiente pull) sin borrar el animal.
      if (op.payload?.chapetaCodigo && ['QR_YA_ASOCIADO', 'QR_NO_OPERATIVO', 'QR_NOT_FOUND'].includes(codigo)) {
        const chapeta = await repo.getChapetaPorCodigo(op.payload.chapetaCodigo);
        if (chapeta?.reservaLocalUuid === op.localUuid) {
          operaciones.push({ op: 'put', store: 'chapetas', value: { ...chapeta, reservaLocalUuid: null, estado: codigo === 'QR_YA_ASOCIADO' ? 'ASIGNADO_ANIMAL' : chapeta.estado } });
        }
      }
      await storage.batch(operaciones);
      notify();
    },

    // -----------------------------------------------------------------
    // Resolución de conflictos (con conectividad; nunca silenciosa)
    // -----------------------------------------------------------------

    async _operacionDe(localUuid) {
      const ops = await storage.getAllByIndex('outbox', 'localUuid', localUuid);
      return ops.find((op) => op.entidad === 'animal') ?? null;
    },

    /** Reencola el animal SIN chapeta (la chapeta la usó otro dispositivo). */
    async resolverSinChapeta(localUuid) {
      const op = await repo._operacionDe(localUuid);
      const local = await storage.get('animales', `loc:${localUuid}`);
      if (!op || !local) throw errorVisible('CONFLICTO_NO_ENCONTRADO', 'No hay conflicto para este animal.');
      await storage.batch([
        { op: 'put', store: 'outbox', value: { ...op, tipoOperacion: 'ANIMAL_CREAR', payload: { animal: op.payload.animal, chapetaCodigo: null }, estado: OUTBOX_ESTADOS.PENDIENTE, ultimoError: null, siguienteIntentoAt: null, updatedAt: now().toISOString() } },
        { op: 'put', store: 'animales', value: { ...local, chapetaCodigo: null, estadoSync: ESTADO_SYNC.PENDIENTE, conflicto: null } },
      ]);
      notify();
    },

    /** Reencola el animal con OTRA chapeta disponible en este dispositivo. */
    async resolverConOtraChapeta(localUuid, codigoRaw) {
      const codigo = normalizeCodigoChapeta(codigoRaw);
      if (!codigo) throw errorVisible('QR_CODIGO_INVALIDO', 'Código de chapeta inválido.');
      const op = await repo._operacionDe(localUuid);
      const local = await storage.get('animales', `loc:${localUuid}`);
      const chapeta = await repo.getChapetaPorCodigo(codigo);
      if (!op || !local) throw errorVisible('CONFLICTO_NO_ENCONTRADO', 'No hay conflicto para este animal.');
      if (!chapeta || chapeta.estado !== 'ASIGNADO_ORGANIZACION' || chapeta.reservaLocalUuid) {
        throw errorVisible('QR_NO_DISPONIBLE', 'La chapeta no está disponible.');
      }
      await storage.batch([
        { op: 'put', store: 'outbox', value: { ...op, tipoOperacion: 'ANIMAL_CREAR_CON_CHAPETA', payload: { animal: op.payload.animal, chapetaCodigo: codigo }, estado: OUTBOX_ESTADOS.PENDIENTE, ultimoError: null, siguienteIntentoAt: null, updatedAt: now().toISOString() } },
        { op: 'put', store: 'animales', value: { ...local, chapetaCodigo: codigo, estadoSync: ESTADO_SYNC.PENDIENTE, conflicto: null } },
        { op: 'put', store: 'chapetas', value: { ...chapeta, reservaLocalUuid: localUuid } },
      ]);
      notify();
    },

    /** Corrige campos del animal local (p. ej. número de chapeta duplicado) y reencola. */
    async resolverEditando(localUuid, cambios) {
      const op = await repo._operacionDe(localUuid);
      const local = await storage.get('animales', `loc:${localUuid}`);
      if (!op || !local) throw errorVisible('CONFLICTO_NO_ENCONTRADO', 'No hay conflicto para este animal.');
      const animalBody = { ...op.payload.animal, ...cambios };
      await storage.batch([
        { op: 'put', store: 'outbox', value: { ...op, payload: { ...op.payload, animal: animalBody }, estado: OUTBOX_ESTADOS.PENDIENTE, ultimoError: null, siguienteIntentoAt: null, updatedAt: now().toISOString() } },
        { op: 'put', store: 'animales', value: { ...local, ...cambios, datosFormulario: animalBody, estadoSync: ESTADO_SYNC.PENDIENTE, conflicto: null } },
      ]);
      notify();
    },

    /** Descarta un registro local en conflicto (decisión explícita del usuario). */
    async descartarLocal(localUuid) {
      const op = await repo._operacionDe(localUuid);
      const local = await storage.get('animales', `loc:${localUuid}`);
      const operaciones = [{ op: 'delete', store: 'animales', key: `loc:${localUuid}` }];
      if (op) operaciones.push({ op: 'delete', store: 'outbox', key: op.operationId });
      if (local?.chapetaCodigo) {
        const chapeta = await repo.getChapetaPorCodigo(local.chapetaCodigo);
        if (chapeta?.reservaLocalUuid === localUuid) operaciones.push({ op: 'put', store: 'chapetas', value: { ...chapeta, reservaLocalUuid: null } });
      }
      await storage.batch(operaciones);
      notify();
    },

    // -----------------------------------------------------------------
    // PULL: aplicar cambios del servidor sin pisar lo pendiente local
    // -----------------------------------------------------------------

    /**
     * FASE 4E.1: aplica una página de GET /sync/reproduccion en una sola
     * transacción local, con su cursor. Upsert por eventoId: recibir dos veces lo
     * mismo no duplica y ANULADO es terminal, así que una copia antigua nunca lo
     * revierte. Al terminar un recorrido concilia con los totales del servidor: si
     * falta algo se reinicia el cursor y el siguiente recorrido es completo.
     *
     * Respuesta perdida: el evento se guarda siempre (es la verdad del servidor), pero
     * la operación local solo se cierra si el clientOperationId es exacto, su resultado
     * es incierto, su `origen` es de esta organización y de la cuenta de la sesión que
     * respondió, y además coinciden animal e intención. Un evento de corrección nunca
     * cierra un registro. Otra cuenta o sesión no declarada: la operación no se toca;
     * su cuenta la reenvía y el servidor responde yaExistia. Misma cuenta e intención
     * distinta: CONFLICTO, sin sobrescribir lo local. Un evento ya ANULADO también
     * cierra su creación, porque la creación ocurrió.
     *
     * FASE 4E.2B: ANULAR y CORREGIR se concilian con las mismas condiciones de identidad
     * y con evidencia exacta (reproduccionConciliacionAdmin.js), sobre la página recibida
     * aplicada a la copia local: corrector y original pueden llegar en páginas distintas.
     */
    async aplicarPullReproduccion(pagina) {
      if (pagina?.organizacionId !== organizacionId) throw localError('ORGANIZACION_DISTINTA', 'Los datos recibidos son de otra organización.');
      if (!Array.isArray(pagina.eventos) || typeof pagina.cursor !== 'string' || !pagina.cursor || (!pagina.hayMas && !pagina.totales)) {
        throw localError('PULL_REPRODUCCION_INVALIDO', 'Respuesta de sincronización no válida.');
      }
      const operaciones = [];
      const ahora = now();
      const conciliables = (await storage.getAll('outbox'))
        .filter((op) => esOperacionReproductiva(op.tipoOperacion)
          && resultadoIncierto(op, ahora.getTime())
          && origenVerificable(op)
          && op.origen.organizacionId === organizacionId
          && identidadCoincide(op, pagina.cuentaId));
      const porOperacion = new Map(conciliables
        .filter((op) => op.tipoOperacion === REPRODUCCION_EVENTO_CREAR)
        .map((op) => [op.clientOperationId, op]));
      const administrativas = conciliables.filter((op) => esOperacionAdministrativa(op.tipoOperacion));
      for (const evento of pagina.eventos) {
        if (!evento?.eventoId || !evento.animalId) throw localError('PULL_REPRODUCCION_INVALIDO', 'Respuesta de sincronización no válida.');
        const existente = await storage.get('reproduccion_eventos', evento.eventoId);
        const operacion = evento.clientOperationId ? porOperacion.get(evento.clientOperationId) : null;
        if (operacion) {
          porOperacion.delete(evento.clientOperationId);
          if (operacion.payload?.animalId === evento.animalId && !evento.corrigeEventoId && intencionCoincide(operacion.payload?.evento, evento)) {
            operaciones.push({ op: 'delete', store: 'outbox', key: operacion.operationId });
          } else {
            operaciones.push({
              op: 'put',
              store: 'outbox',
              value: {
                ...operacion,
                estado: OUTBOX_ESTADOS.CONFLICTO,
                ultimoError: { codigo: 'CONCILIACION_INTENCION_DISTINTA', mensaje: MENSAJE_CONCILIACION_DISTINTA, status: 0 },
                siguienteIntentoAt: null,
                updatedAt: ahora.toISOString(),
              },
            });
          }
        }
        if (existente?.estadoRegistro === 'ANULADO' && evento.estadoRegistro !== 'ANULADO') continue;
        operaciones.push({ op: 'put', store: 'reproduccion_eventos', value: { ...evento, ...evento.detalle } });
      }
      let administrativasCerradas = false;
      for (const op of administrativas) {
        const conocidos = new Map((await storage.getAllByIndex('reproduccion_eventos', 'animalId', op.payload.animalId)).map((evento) => [evento.eventoId, evento]));
        for (const evento of pagina.eventos) {
          const existente = conocidos.get(evento.eventoId);
          if (existente?.estadoRegistro === 'ANULADO' && evento.estadoRegistro !== 'ANULADO') continue;
          conocidos.set(evento.eventoId, { ...evento, ...evento.detalle });
        }
        const conciliar = op.tipoOperacion === REPRODUCCION_EVENTO_ANULAR ? conciliarAnular : conciliarCorregir;
        const veredicto = conciliar(op, [...conocidos.values()]);
        if (veredicto === CONCILIACION.SIN_EVIDENCIA) continue;
        administrativasCerradas = true;
        operaciones.push(veredicto === CONCILIACION.CONFIRMADA
          ? { op: 'delete', store: 'outbox', key: op.operationId }
          : {
            op: 'put',
            store: 'outbox',
            value: {
              ...op,
              estado: OUTBOX_ESTADOS.CONFLICTO,
              ultimoError: { codigo: 'CONCILIACION_INTENCION_DISTINTA', mensaje: MENSAJE_CONCILIACION_DISTINTA, status: 0 },
              siguienteIntentoAt: null,
              updatedAt: ahora.toISOString(),
            },
          });
      }
      const meta = await getMeta();
      operaciones.push({
        op: 'put',
        store: 'meta',
        value: { ...meta, reproduccionCursor: pagina.cursor, reproduccionUltimoError: null, ...(pagina.hayMas ? {} : { reproduccionSyncAt: now().toISOString() }) },
      });
      await storage.batch(operaciones);
      if (pagina.eventos.length > 0 || administrativasCerradas) notify();
      if (pagina.hayMas) return { hayMas: true, desfase: false };

      const locales = await storage.getAll('reproduccion_eventos');
      const anulados = locales.filter((evento) => evento.estadoRegistro === 'ANULADO').length;
      const desfase = locales.length < pagina.totales.eventos || anulados < pagina.totales.anulados;
      if (desfase) await putMeta({ reproduccionCursor: null, reproduccionDesfaseAt: now().toISOString() });
      else if (!meta.reproduccionListaAt) await putMeta({ reproduccionListaAt: now().toISOString() });
      return { hayMas: false, desfase };
    },

    async reiniciarCursorReproduccion() {
      await putMeta({ reproduccionCursor: null });
    },

    async aplicarPull(pull) {
      if (pull.organizacionId !== organizacionId) {
        // Nunca mezclar datos de organizaciones distintas.
        throw localError('ORGANIZACION_DISTINTA', 'Los datos recibidos son de otra organización.');
      }
      const operaciones = [];
      const outbox = await storage.getAll('outbox');
      const locales = (await storage.getAll('animales')).filter((a) => !a.animalId);
      const localPorOperacion = new Map(locales.map((a) => [a.clientOperationId, a]));
      const chapetasLocales = new Map((await storage.getAll('chapetas')).map((c) => [c.codigoVisible, c]));

      if (pull.completo) {
        for (const store of ['predios', 'potreros', 'razas', 'categorias']) operaciones.push({ op: 'clear', store });
        const vigentes = new Set(pull.animales.map((a) => `srv:${a.animalId}`));
        for (const existente of await storage.getAll('animales')) {
          if (existente.animalId && !vigentes.has(existente.key)) operaciones.push({ op: 'delete', store: 'animales', key: existente.key });
        }
        const chapetasVigentes = new Set(pull.chapetas.map((c) => c.codigoVisible));
        for (const [codigo, chapeta] of chapetasLocales) {
          if (!chapetasVigentes.has(codigo) && !chapeta.reservaLocalUuid) operaciones.push({ op: 'delete', store: 'chapetas', key: codigo });
        }
      } else {
        for (const store of ['razas', 'categorias']) operaciones.push({ op: 'clear', store });
      }

      for (const animal of pull.animales) {
        const pendiente = animal.clientOperationId ? localPorOperacion.get(animal.clientOperationId) : null;
        const value = { ...animal, key: `srv:${animal.animalId}`, estadoSync: ESTADO_SYNC.SINCRONIZADO, conflicto: null };
        if (pendiente) {
          // La creación llegó al servidor (p. ej. se cortó la respuesta):
          // se empareja por clientOperationId y se cierra la operación.
          value.localUuid = pendiente.localUuid;
          value.creadoLocalAt = pendiente.creadoLocalAt;
          if (pendiente.estadoSync === ESTADO_SYNC.CONFLICTO) {
            value.conflicto = { ...(pendiente.conflicto ?? {}), resueltoPorServidor: true };
          }
          operaciones.push({ op: 'delete', store: 'animales', key: pendiente.key });
          operaciones.push({ op: 'put', store: 'aliases', value: { localUuid: pendiente.localUuid, animalId: animal.animalId } });
          for (const op of outbox.filter((o) => o.localUuid === pendiente.localUuid && o.entidad === 'animal' && o.tipoOperacion.startsWith('ANIMAL_CREAR'))) {
            operaciones.push({ op: 'delete', store: 'outbox', key: op.operationId });
          }
        } else {
          const existente = await storage.get('animales', value.key);
          if (existente?.localUuid) {
            value.localUuid = existente.localUuid;
            value.creadoLocalAt = existente.creadoLocalAt;
          }
        }
        operaciones.push({ op: 'put', store: 'animales', value });
      }

      for (const chapeta of pull.chapetas) {
        const local = chapetasLocales.get(chapeta.codigoVisible);
        // Una reserva local pendiente se conserva mientras el servidor la
        // siga viendo disponible; si otro dispositivo la usó, el push
        // marcará el conflicto (nunca se borra el animal local).
        const reserva = local?.reservaLocalUuid && chapeta.estado === 'ASIGNADO_ORGANIZACION' ? local.reservaLocalUuid : null;
        operaciones.push({ op: 'put', store: 'chapetas', value: { ...chapeta, reservaLocalUuid: reserva } });
      }
      for (const predio of pull.predios) operaciones.push({ op: 'put', store: 'predios', value: predio });
      for (const potrero of pull.potreros) operaciones.push({ op: 'put', store: 'potreros', value: potrero });
      for (const raza of pull.razas) operaciones.push({ op: 'put', store: 'razas', value: raza });
      for (const categoria of pull.categorias) operaciones.push({ op: 'put', store: 'categorias', value: categoria });

      const meta = await getMeta();
      operaciones.push({
        op: 'put',
        store: 'meta',
        value: { ...meta, cursor: pull.cursor, ultimaSyncAt: now().toISOString(), ultimaSyncOk: true, ultimoError: null },
      });
      await storage.batch(operaciones);
      notify();
    },
  };

  return repo;
}
