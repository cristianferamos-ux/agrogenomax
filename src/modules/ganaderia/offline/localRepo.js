// SPRINT-3D11.3 (R1) -- repositorio local de Ganadería sobre el adaptador
// de almacenamiento (storage.js) de UNA organización. JS puro (sin React
// ni DOM): lo usan las páginas, el motor de sincronización y el Service
// Worker. Nunca fabrica un animal_id de PostgreSQL: un animal creado sin
// red vive como 'loc:<localUuid>' hasta que el servidor confirma su id.
import { OUTBOX_ESTADOS, newOperation } from './outbox.js';
import { normalizeCodigoChapeta, isQrToken } from '../hato/qrToken.js';

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

    async listAnimales({ estado = 'ACTIVO', q = '', predioId = '' } = {}) {
      const term = q.trim().toLowerCase();
      return (await storage.getAll('animales'))
        .filter((animal) => (estado ? animal.estado === estado : true))
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
      if (chapeta.estado === 'ASIGNADO_ANIMAL' && chapeta.animalId) {
        const animal = await storage.get('animales', `srv:${chapeta.animalId}`);
        if (!animal || animal.estado === 'ACTIVO') return { resultado: 'ANIMAL', chapeta, to: `/ganaderia/animales/${chapeta.animalId}` };
      }
      return { resultado: 'NO_OPERATIVA', chapeta, estado: chapeta.estado };
    },

    async contar() {
      const [animales, chapetas, outbox, meta] = await Promise.all([
        storage.getAll('animales'), storage.getAll('chapetas'), storage.getAll('outbox'), getMeta(),
      ]);
      return {
        animales: animales.filter((a) => a.estado === 'ACTIVO').length,
        chapetasDisponibles: chapetas.filter((c) => c.estado === 'ASIGNADO_ORGANIZACION' && !c.reservaLocalUuid).length,
        pendientes: outbox.filter((op) => [OUTBOX_ESTADOS.PENDIENTE, OUTBOX_ESTADOS.SINCRONIZANDO, OUTBOX_ESTADOS.ERROR_REINTENTABLE].includes(op.estado)).length,
        conflictos: outbox.filter((op) => op.estado === OUTBOX_ESTADOS.CONFLICTO || op.estado === OUTBOX_ESTADOS.RECHAZADO).length,
        errores: outbox.filter((op) => op.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE).length,
        ultimaSyncAt: meta.ultimaSyncAt,
        ultimaSyncOk: meta.ultimaSyncOk,
        ultimoError: meta.ultimoError,
        preparadoAt: meta.preparadoAt,
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
    // Aplicación de resultados del servidor
    // -----------------------------------------------------------------

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
      if (!op || !local) throw localError('CONFLICTO_NO_ENCONTRADO', 'No hay conflicto para este animal.');
      await storage.batch([
        { op: 'put', store: 'outbox', value: { ...op, tipoOperacion: 'ANIMAL_CREAR', payload: { animal: op.payload.animal, chapetaCodigo: null }, estado: OUTBOX_ESTADOS.PENDIENTE, ultimoError: null, siguienteIntentoAt: null, updatedAt: now().toISOString() } },
        { op: 'put', store: 'animales', value: { ...local, chapetaCodigo: null, estadoSync: ESTADO_SYNC.PENDIENTE, conflicto: null } },
      ]);
      notify();
    },

    /** Reencola el animal con OTRA chapeta disponible en este dispositivo. */
    async resolverConOtraChapeta(localUuid, codigoRaw) {
      const codigo = normalizeCodigoChapeta(codigoRaw);
      if (!codigo) throw localError('QR_CODIGO_INVALIDO', 'Código de chapeta inválido.');
      const op = await repo._operacionDe(localUuid);
      const local = await storage.get('animales', `loc:${localUuid}`);
      const chapeta = await repo.getChapetaPorCodigo(codigo);
      if (!op || !local) throw localError('CONFLICTO_NO_ENCONTRADO', 'No hay conflicto para este animal.');
      if (!chapeta || chapeta.estado !== 'ASIGNADO_ORGANIZACION' || chapeta.reservaLocalUuid) {
        throw localError('QR_NO_DISPONIBLE', 'La chapeta no está disponible.');
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
      if (!op || !local) throw localError('CONFLICTO_NO_ENCONTRADO', 'No hay conflicto para este animal.');
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
