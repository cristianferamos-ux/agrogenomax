// SPRINT-3D11.3 (R1) -- inventario central de chapetas QR. Corre SIEMPRE
// con el rol PostgreSQL agx_qr_admin (withQrAdminTransaction de
// server/db/agxQrAdminPool.js, conexión propia) -- agx_app no tiene ningún
// privilegio sobre el inventario global. Solo lo invocan rutas detrás de
// createRequireGanaderiaSuperAdmin (server/routes/ganaderiaAdminQr.js).
//
// Flujo: crear lote (genera códigos + tokens) -> GENERADO -> EN_FABRICACION
// -> EN_STOCK -> asignar (todo o parte) a una organización -> CERRADO.
import { withQrAdminTransaction } from '../../db/agxQrAdminPool.js';
import { decryptQrToken, encryptQrToken, loadQrTokenKey, QR_TOKEN_CLAVE_VERSION } from './qrTokenCrypto.js';
import {
  generateCodigoLote,
  generateCodigoVisible,
  generateQrToken,
  hashQrToken,
} from './qrCodigos.js';
import {
  CHAPETA_SELECT,
  bajaEnTx,
  lockChapetaPorId,
  reemplazarEnTx,
  semanticError,
  serializeChapeta,
} from './qrChapetasRepository.js';

const MAX_GENERATION_ROUNDS = 10;
const ESTADOS_LOTE = Object.freeze(['GENERADO', 'EN_FABRICACION', 'EN_STOCK', 'CERRADO']);
// Transiciones físicas del lote: un paso adelante, o cierre desde cualquiera.
const SIGUIENTE_ESTADO_LOTE = Object.freeze({ GENERADO: 'EN_FABRICACION', EN_FABRICACION: 'EN_STOCK' });

const LOTE_SELECT = `
  select l.lote_id::text as lote_id, l.codigo_lote, l.tipo, l.cantidad, l.estado, l.url_base,
         l.proveedor, l.observaciones, l.created_at, l.updated_at,
         count(c.qr_id) filter (where c.estado = 'EN_INVENTARIO')::int as en_inventario,
         count(c.qr_id) filter (where c.estado = 'ASIGNADO_ORGANIZACION')::int as asignadas_organizacion,
         count(c.qr_id) filter (where c.estado = 'ASIGNADO_ANIMAL')::int as asignadas_animal,
         count(c.qr_id) filter (where c.estado in ('REVOCADO', 'DANADO', 'REEMPLAZADO'))::int as de_baja,
         count(c.qr_id) filter (where c.organizacion_id is not null)::int as asignadas_total
    from agx.qr_lotes l
    left join agx.qr_chapetas c on c.lote_id = l.lote_id`;

// Asignación derivada (no almacenada): SIN_ASIGNAR / PARCIAL / TOTAL.
function asignacionDerivada(row) {
  if (row.asignadas_total === 0) return 'SIN_ASIGNAR';
  if (row.en_inventario === 0) return 'TOTAL';
  return 'PARCIAL';
}

export function serializeLote(row) {
  return {
    loteId: row.lote_id,
    codigoLote: row.codigo_lote,
    tipo: row.tipo,
    cantidad: row.cantidad,
    estado: row.estado,
    urlBase: row.url_base,
    proveedor: row.proveedor,
    observaciones: row.observaciones,
    creadoAt: row.created_at,
    actualizadoAt: row.updated_at,
    stock: {
      enInventario: row.en_inventario,
      asignadasOrganizacion: row.asignadas_organizacion,
      asignadasAnimal: row.asignadas_animal,
      deBaja: row.de_baja,
    },
    asignacion: asignacionDerivada(row),
  };
}

function serializeChapetaAdmin(row) {
  return { ...serializeChapeta(row), loteId: row.lote_id, codigoLote: row.codigo_lote, organizacionId: row.organizacion_id };
}

async function fetchLote(client, loteId, { lock = false } = {}) {
  if (lock) await client.query('select 1 from agx.qr_lotes where lote_id = $1 for update', [loteId]);
  const result = await client.query(`${LOTE_SELECT} where l.lote_id = $1 group by l.lote_id`, [loteId]);
  return result.rows[0] || null;
}

async function insertLoteEvento(client, { loteId, tipoEvento, metadata = {}, actorCuentaId }) {
  await client.query(
    `insert into agx.qr_lote_eventos (lote_id, tipo_evento, metadata_json, actor_cuenta_id)
     values ($1, $2, $3::jsonb, $4)`,
    [loteId, tipoEvento, JSON.stringify(metadata), actorCuentaId],
  );
}

async function findLotePorOperacion(client, clientOperationId) {
  const result = await client.query('select lote_id::text as lote_id from agx.qr_lotes where client_operation_id = $1', [
    clientOperationId,
  ]);
  return result.rows[0]?.lote_id ?? null;
}

async function insertLoteRow(client, { tipo, cantidad, estado, urlBase, proveedor, observaciones, actorCuentaId, clientOperationId }) {
  for (let attempt = 1; attempt <= MAX_GENERATION_ROUNDS; attempt += 1) {
    const result = await client.query(
      `insert into agx.qr_lotes
         (codigo_lote, tipo, cantidad, estado, url_base, proveedor, observaciones, creado_por, client_operation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (codigo_lote) do nothing
       returning lote_id::text as lote_id`,
      [generateCodigoLote(), tipo, cantidad, estado, urlBase, proveedor, observaciones, actorCuentaId, clientOperationId],
    );
    if (result.rows[0]) return result.rows[0].lote_id;
  }
  throw new Error('QR_LOTE_CODIGO_EXHAUSTED');
}

/**
 * Inserta `cantidad` chapetas QR_AGX en el lote. Códigos y tokens se
 * generan en rondas; las colisiones (código visible o hash de token ya
 * existentes) se descartan con ON CONFLICT DO NOTHING y se regeneran
 * solo las faltantes. El token solo se persiste CIFRADO (qr_chapeta_tokens).
 */
async function generarChapetas(client, { loteId, cantidad, codeGenerator, tokenGenerator, key }) {
  let pendientes = cantidad;
  for (let round = 1; round <= MAX_GENERATION_ROUNDS && pendientes > 0; round += 1) {
    const codigos = new Set();
    const tokens = new Map(); // hash -> token
    while (codigos.size < pendientes) codigos.add(codeGenerator());
    const codigoList = [...codigos];
    const hashList = codigoList.map(() => {
      let token = tokenGenerator();
      while (tokens.has(hashQrToken(token))) token = tokenGenerator();
      const hash = hashQrToken(token);
      tokens.set(hash, token);
      return hash;
    });
    const inserted = await client.query(
      `insert into agx.qr_chapetas (lote_id, tipo, codigo_visible, token_hash)
       select $1, 'QR_AGX', codigo, hash from unnest($2::text[], $3::text[]) as t(codigo, hash)
       on conflict do nothing
       returning qr_id::text as qr_id, codigo_visible, token_hash`,
      [loteId, codigoList, hashList],
    );
    if (inserted.rows.length > 0) {
      await client.query(
        `insert into agx.qr_chapeta_tokens (qr_id, token_cifrado, clave_version)
         select qr_id, cifrado, $3 from unnest($1::bigint[], $2::bytea[]) as t(qr_id, cifrado)`,
        [
          inserted.rows.map((row) => row.qr_id),
          inserted.rows.map((row) => encryptQrToken(tokens.get(row.token_hash), row.codigo_visible, key)),
          QR_TOKEN_CLAVE_VERSION,
        ],
      );
    }
    pendientes -= inserted.rows.length;
  }
  if (pendientes > 0) throw new Error('QR_CHAPETA_GENERATION_EXHAUSTED');
}

/**
 * POST /admin/qr/lotes -- crea un lote QR_AGX y genera sus chapetas.
 * Idempotente por clientOperationId. urlBase = AGX_QR_PUBLIC_ORIGIN (lo
 * resuelve la ruta desde la configuración del servidor, nunca del navegador).
 */
export async function crearLote(
  { cantidad, proveedor, observaciones, urlBase, clientOperationId },
  { actorCuentaId, codeGenerator = generateCodigoVisible, tokenGenerator = generateQrToken, key = loadQrTokenKey() },
) {
  return withQrAdminTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agx_qr_lote:${clientOperationId}`]);
    const existente = await findLotePorOperacion(client, clientOperationId);
    if (existente) return { lote: serializeLote(await fetchLote(client, existente)), yaExistia: true };

    const loteId = await insertLoteRow(client, {
      tipo: 'QR_AGX', cantidad, estado: 'GENERADO', urlBase, proveedor, observaciones, actorCuentaId, clientOperationId,
    });
    await generarChapetas(client, { loteId, cantidad, codeGenerator, tokenGenerator, key });
    await insertLoteEvento(client, { loteId, tipoEvento: 'GENERADO', metadata: { cantidad }, actorCuentaId });
    return { lote: serializeLote(await fetchLote(client, loteId)), yaExistia: false };
  });
}

/**
 * POST /admin/qr/lotes/importar-legacy -- importación CONTROLADA de códigos
 * impresos del sistema anterior (AGX-000001...) como QR_LEGACY, en un lote
 * EN_STOCK (ya existen físicamente). Sin token: se resuelven por código.
 * Un código ya existente aborta toda la importación.
 */
export async function importarLoteLegacy({ codigos, observaciones, clientOperationId }, { actorCuentaId }) {
  return withQrAdminTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agx_qr_lote:${clientOperationId}`]);
    const existente = await findLotePorOperacion(client, clientOperationId);
    if (existente) return { lote: serializeLote(await fetchLote(client, existente)), yaExistia: true };

    const loteId = await insertLoteRow(client, {
      tipo: 'QR_LEGACY', cantidad: codigos.length, estado: 'EN_STOCK', urlBase: null, proveedor: null,
      observaciones, actorCuentaId, clientOperationId,
    });
    const inserted = await client.query(
      `insert into agx.qr_chapetas (lote_id, tipo, codigo_visible)
       select $1, 'QR_LEGACY', codigo from unnest($2::text[]) as t(codigo)
       on conflict (codigo_visible) do nothing
       returning codigo_visible`,
      [loteId, codigos],
    );
    if (inserted.rows.length !== codigos.length) {
      const nuevos = new Set(inserted.rows.map((row) => row.codigo_visible));
      throw semanticError('QR_CODIGO_YA_EXISTE', 409, 'Algunos códigos ya existen en el inventario.', {
        codigos: codigos.filter((codigo) => !nuevos.has(codigo)),
      });
    }
    await insertLoteEvento(client, {
      loteId, tipoEvento: 'IMPORTADO_LEGACY', metadata: { cantidad: codigos.length }, actorCuentaId,
    });
    return { lote: serializeLote(await fetchLote(client, loteId)), yaExistia: false };
  });
}

export async function listLotes({ limit, offset }) {
  return withQrAdminTransaction(async (client) => {
    const total = await client.query('select count(*)::int as n from agx.qr_lotes');
    const result = await client.query(
      `${LOTE_SELECT} group by l.lote_id order by l.created_at desc, l.lote_id desc limit $1 offset $2`,
      [limit, offset],
    );
    return { lotes: result.rows.map(serializeLote), total: total.rows[0].n };
  });
}

export async function getLote(loteId) {
  return withQrAdminTransaction(async (client) => {
    const row = await fetchLote(client, loteId);
    if (!row) return null;
    const asignaciones = await client.query(
      `select asignacion_id::text as asignacion_id, organizacion_id, cantidad, referencia, created_at
         from agx.qr_asignaciones where lote_id = $1 order by created_at, asignacion_id`,
      [loteId],
    );
    const eventos = await client.query(
      `select tipo_evento, metadata_json, actor_cuenta_id, ocurrido_en
         from agx.qr_lote_eventos where lote_id = $1 order by ocurrido_en, evento_id`,
      [loteId],
    );
    return {
      lote: serializeLote(row),
      asignaciones: asignaciones.rows.map((a) => ({
        asignacionId: a.asignacion_id,
        organizacionId: a.organizacion_id,
        cantidad: a.cantidad,
        referencia: a.referencia,
        creadoAt: a.created_at,
      })),
      historial: eventos.rows.map((e) => ({
        tipoEvento: e.tipo_evento, metadata: e.metadata_json, actorCuentaId: e.actor_cuenta_id, ocurridoEn: e.ocurrido_en,
      })),
    };
  });
}

/** POST /admin/qr/lotes/:id/estado -- un paso adelante o CERRADO. Mismo estado -> sin cambios. */
export async function cambiarEstadoLote(loteId, estado, { actorCuentaId }) {
  if (!ESTADOS_LOTE.includes(estado)) throw semanticError('INVALID_ESTADO', 400, 'Estado de lote inválido.');
  return withQrAdminTransaction(async (client) => {
    const row = await fetchLote(client, loteId, { lock: true });
    if (!row) throw semanticError('LOTE_NOT_FOUND', 404, 'Lote no encontrado.');
    if (row.estado === estado) return { lote: serializeLote(row), sinCambios: true };
    const permitido = estado === 'CERRADO' ? row.estado !== 'CERRADO' : SIGUIENTE_ESTADO_LOTE[row.estado] === estado;
    if (!permitido) {
      throw semanticError('LOTE_TRANSICION_INVALIDA', 409, `El lote no puede pasar de ${row.estado} a ${estado}.`);
    }
    await client.query('update agx.qr_lotes set estado = $2, updated_at = now() where lote_id = $1', [loteId, estado]);
    await insertLoteEvento(client, {
      loteId, tipoEvento: 'ESTADO_CAMBIADO', metadata: { desde: row.estado, hacia: estado }, actorCuentaId,
    });
    return { lote: serializeLote(await fetchLote(client, loteId)), sinCambios: false };
  });
}

/**
 * POST /admin/qr/lotes/:id/asignar -- entrega a UNA organización:
 *   * cantidad: las N primeras chapetas EN_INVENTARIO del lote (orden de
 *     generación = orden físico de la hoja del proveedor), o
 *   * codigos: chapetas concretas del lote (todas deben estar EN_INVENTARIO).
 * Lote EN_STOCK obligatorio. Lote bloqueado FOR UPDATE: dos asignaciones
 * concurrentes nunca toman la misma chapeta. Idempotente por clientOperationId.
 * organizacionId llega validada por la ruta contra Postgres-AGX.
 */
export async function asignarChapetas(loteId, { organizacionId, cantidad, codigos, referencia, clientOperationId }, { actorCuentaId }) {
  return withQrAdminTransaction(async (client) => {
    const replay = await client.query(
      `select asignacion_id::text as asignacion_id, lote_id::text as lote_id, organizacion_id, cantidad
         from agx.qr_asignaciones where client_operation_id = $1`,
      [clientOperationId],
    );
    if (replay.rows[0]) {
      const previa = replay.rows[0];
      if (previa.lote_id !== String(loteId) || previa.organizacion_id !== organizacionId) {
        throw semanticError('CLIENT_OPERATION_ID_REUSED', 409, 'La operación ya se usó para otra asignación.');
      }
      return { asignacionId: previa.asignacion_id, cantidad: previa.cantidad, yaExistia: true };
    }

    const lote = await fetchLote(client, loteId, { lock: true });
    if (!lote) throw semanticError('LOTE_NOT_FOUND', 404, 'Lote no encontrado.');
    if (lote.estado !== 'EN_STOCK') {
      throw semanticError('LOTE_NO_EN_STOCK', 409, 'Solo se asignan chapetas de un lote EN_STOCK.');
    }

    let seleccion;
    if (codigos) {
      seleccion = await client.query(
        `select qr_id::text as qr_id, codigo_visible, estado from agx.qr_chapetas
          where lote_id = $1 and codigo_visible = any($2::text[]) order by qr_id for update`,
        [loteId, codigos],
      );
      const disponibles = new Set(seleccion.rows.filter((r) => r.estado === 'EN_INVENTARIO').map((r) => r.codigo_visible));
      const noDisponibles = codigos.filter((codigo) => !disponibles.has(codigo));
      if (noDisponibles.length > 0) {
        throw semanticError('QR_NO_DISPONIBLE', 409, 'Algunas chapetas no están disponibles en este lote.', { codigos: noDisponibles });
      }
    } else {
      const total = cantidad ?? lote.en_inventario;
      if (total < 1 || total > lote.en_inventario) {
        throw semanticError('STOCK_INSUFICIENTE', 409, `El lote solo tiene ${lote.en_inventario} chapetas disponibles.`, {
          disponibles: lote.en_inventario,
        });
      }
      seleccion = await client.query(
        `select qr_id::text as qr_id, codigo_visible, estado from agx.qr_chapetas
          where lote_id = $1 and estado = 'EN_INVENTARIO' order by qr_id limit $2 for update`,
        [loteId, total],
      );
    }
    const qrIds = seleccion.rows.map((row) => row.qr_id);

    const asignacion = await client.query(
      `insert into agx.qr_asignaciones (organizacion_id, lote_id, cantidad, referencia, asignado_por, client_operation_id)
       values ($1, $2, $3, $4, $5, $6) returning asignacion_id::text as asignacion_id`,
      [organizacionId, loteId, qrIds.length, referencia, actorCuentaId, clientOperationId],
    );
    const asignacionId = asignacion.rows[0].asignacion_id;
    await client.query(
      `update agx.qr_chapetas
          set estado = 'ASIGNADO_ORGANIZACION', organizacion_id = $2, asignacion_id = $3,
              asignado_organizacion_at = now(), updated_at = now()
        where qr_id = any($1::bigint[])`,
      [qrIds, organizacionId, asignacionId],
    );
    await client.query(
      `insert into agx.qr_chapeta_eventos (qr_id, organizacion_id, tipo_evento, metadata_json, actor_cuenta_id)
       select qr_id, $2, 'ASIGNADA_ORGANIZACION', jsonb_build_object('asignacionId', $3::text), $4
         from unnest($1::bigint[]) as t(qr_id)`,
      [qrIds, organizacionId, asignacionId, actorCuentaId],
    );
    await insertLoteEvento(client, {
      loteId,
      tipoEvento: 'ASIGNADO_ORGANIZACION',
      metadata: { asignacionId, organizacionId, cantidad: qrIds.length },
      actorCuentaId,
    });
    return { asignacionId, cantidad: qrIds.length, codigos: seleccion.rows.map((r) => r.codigo_visible), yaExistia: false };
  });
}

/** GET /admin/qr/chapetas -- búsqueda en todo el inventario. */
export async function buscarChapetas({ codigo, loteId, estado, organizacionId, limit, offset }) {
  return withQrAdminTransaction(async (client) => {
    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (codigo) add('c.codigo_visible = ?', codigo);
    if (loteId) add('c.lote_id = ?', loteId);
    if (estado) add('c.estado = ?', estado);
    if (organizacionId) add('c.organizacion_id = ?', organizacionId);
    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const total = await client.query(`select count(*)::int as n from agx.qr_chapetas c ${where}`, params);
    params.push(limit, offset);
    const result = await client.query(
      `select x.*, l.codigo_lote from (${CHAPETA_SELECT} ${where}) x
         join agx.qr_lotes l on l.lote_id = x.lote_id::bigint
        order by x.lote_id::bigint desc, x.qr_id::bigint
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { chapetas: result.rows.map(serializeChapetaAdmin), total: total.rows[0].n };
  });
}

/** GET /admin/qr/chapetas/:qrId -- detalle + animal asociado + historial. */
export async function getChapetaAdmin(qrId) {
  return withQrAdminTransaction(async (client) => {
    const result = await client.query(
      `select x.*, l.codigo_lote from (${CHAPETA_SELECT} where c.qr_id = $1) x
         join agx.qr_lotes l on l.lote_id = x.lote_id::bigint`,
      [qrId],
    );
    const row = result.rows[0];
    if (!row) return null;
    let animal = null;
    if (row.animal_id) {
      // Lectura del animal bajo la organización dueña de la chapeta.
      await client.query("select set_config('app.current_org_id', $1, true)", [row.organizacion_id]);
      const animalResult = await client.query(
        `select animal_id::text as animal_id, numero_visual, nombre, estado from agx.animales where animal_id = $1`,
        [row.animal_id],
      );
      const a = animalResult.rows[0];
      if (a) animal = { animalId: a.animal_id, numeroVisual: a.numero_visual, nombre: a.nombre, estado: a.estado };
    }
    const eventos = await client.query(
      `select tipo_evento, metadata_json, actor_cuenta_id, organizacion_id, ocurrido_en
         from agx.qr_chapeta_eventos where qr_id = $1 order by ocurrido_en, evento_id`,
      [qrId],
    );
    return {
      chapeta: serializeChapetaAdmin(row),
      animal,
      historial: eventos.rows.map((e) => ({
        tipoEvento: e.tipo_evento, metadata: e.metadata_json, actorCuentaId: e.actor_cuenta_id,
        organizacionId: e.organizacion_id, ocurridoEn: e.ocurrido_en,
      })),
    };
  });
}

async function lockChapetaAdmin(client, qrId) {
  const chapeta = await lockChapetaPorId(client, qrId);
  if (!chapeta) throw semanticError('QR_NOT_FOUND', 404, 'Chapeta no encontrada.');
  // Operaciones sobre chapetas ya asignadas corren también bajo la
  // organización dueña (eventos del animal con RLS de tenant).
  if (chapeta.organizacion_id) {
    await client.query("select set_config('app.current_org_id', $1, true)", [chapeta.organizacion_id]);
  }
  return chapeta;
}

/** POST /admin/qr/chapetas/:qrId/revocar | /danada. Repetir la misma baja -> sin cambios. */
export async function bajaChapetaAdmin(qrId, { causa, motivo }, { actorCuentaId }) {
  return withQrAdminTransaction(async (client) => {
    const chapeta = await lockChapetaAdmin(client, qrId);
    if (chapeta.estado === causa) return { chapeta: serializeChapeta(chapeta), sinCambios: true };
    if (['REVOCADO', 'DANADO', 'REEMPLAZADO'].includes(chapeta.estado)) {
      throw semanticError('QR_NO_OPERATIVO', 410, 'La chapeta ya está fuera de uso.', { estado: chapeta.estado });
    }
    const row = await bajaEnTx(client, {
      organizacionId: chapeta.organizacion_id, chapeta, causa, motivo, actorCuentaId,
    });
    return { chapeta: serializeChapeta(row), sinCambios: false };
  });
}

/** POST /admin/qr/chapetas/:qrId/reemplazar -- mismo núcleo que el reemplazo de la organización. */
export async function reemplazarChapetaAdmin(qrId, { codigoNuevo, motivo }, { actorCuentaId }) {
  return withQrAdminTransaction(async (client) => {
    const chapeta = await lockChapetaAdmin(client, qrId);
    if (chapeta.estado !== 'ASIGNADO_ANIMAL') {
      throw semanticError('QR_NO_ACTIVO', 409, 'Solo se reemplaza una chapeta asociada a un animal.');
    }
    return reemplazarEnTx(client, {
      organizacionId: chapeta.organizacion_id, animalId: chapeta.animal_id, codigoNuevo, motivo, actorCuentaId,
    });
  });
}

/**
 * Filas del archivo del proveedor. Descifra cada token en memoria (nunca lo
 * persiste en claro); un cifrado manipulado o movido de fila falla el tag GCM.
 */
// FASE 15: la exportación es SOLO LECTURA -- transacción READ ONLY (Postgres
// rechaza cualquier escritura) y sin eventos.
const EXPORT_CHAPETA_SELECT = `select c.qr_id::text as qr_id, c.lote_id::text as lote_id, c.codigo_visible, c.token_hash, t.token_cifrado
   from agx.qr_chapetas c
   left join agx.qr_chapeta_tokens t on t.qr_id = c.qr_id`;

function exportRow(r, claveActiva) {
  return {
    qrId: r.qr_id,
    codigoVisible: r.codigo_visible,
    tokenHash: r.token_hash,
    token: r.token_cifrado ? decryptQrToken(r.token_cifrado, r.codigo_visible, claveActiva) : null,
  };
}

export async function exportLoteProveedor(loteId, { key } = {}) {
  return withQrAdminTransaction(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    const lote = await fetchLote(client, loteId);
    if (!lote) return null;
    const result = await client.query(`${EXPORT_CHAPETA_SELECT} where c.lote_id = $1 order by c.qr_id`, [loteId]);
    const claveActiva = lote.tipo === 'QR_AGX' ? key ?? loadQrTokenKey() : null;
    return {
      lote: serializeLote(lote),
      chapetas: result.rows.map((r) => exportRow(r, claveActiva)),
    };
  });
}

/** Una sola chapeta (SVG maestro individual), mismo descifrado con AAD. */
export async function exportChapetaProveedor(qrId, { key } = {}) {
  return withQrAdminTransaction(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    const result = await client.query(`${EXPORT_CHAPETA_SELECT} where c.qr_id = $1`, [qrId]);
    const row = result.rows[0];
    if (!row) return null;
    const lote = await fetchLote(client, row.lote_id);
    const claveActiva = lote.tipo === 'QR_AGX' ? key ?? loadQrTokenKey() : null;
    return { lote: serializeLote(lote), chapeta: exportRow(row, claveActiva) };
  });
}
