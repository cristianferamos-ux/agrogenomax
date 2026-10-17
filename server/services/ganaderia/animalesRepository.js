// SPRINT-3D11.2: acceso a datos del dominio Animal contra
// Postgres-AGX-Business (0022). Mismo contrato que prediosRepository.js:
// cada función recibe `organizacionId` ya autorizado por el llamador
// (req.ganaderiaAuth, nunca del cliente) y opera dentro de
// withOrganizacionTransaction -- RLS+FORCE es el mecanismo de aislamiento;
// un animal/predio de otra organización es indistinguible de uno
// inexistente (404).
//
// Nunca toca el Postgres legacy (server/db.js) ni sus tablas de animales/QR.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { resolveFechaHoyNegocio } from './motorDescansoAuto/businessTimezone.js';
import { computeCreationIntentHash } from './animalIntentHash.js';
import { isCategoriaCompatibleConSexo } from './categoriaSexoCompat.js';
import { validateAnimalConsistency } from './animalValidation.js';

const NUMERO_VISUAL_UNIQUE_CONSTRAINT = 'animales_org_numero_visual_activo_key';
const CLIENT_OPERATION_UNIQUE_CONSTRAINT = 'animales_org_client_operation_key';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

// Fechas como texto (sin conversión de zona horaria del driver) y
// updated_at con microsegundos: es la precondición de concurrencia
// optimista que el cliente devuelve al corregir.
const ANIMAL_SELECT = `
  select a.animal_id::text as animal_id,
         a.predio_id::text as predio_id,
         p.nombre_predio,
         a.numero_visual,
         a.nombre,
         a.sexo,
         a.nacimiento_tipo,
         to_char(a.fecha_nacimiento, 'YYYY-MM-DD') as fecha_nacimiento,
         a.edad_aproximada_meses,
         to_char(a.edad_referencia_fecha, 'YYYY-MM-DD') as edad_referencia_fecha,
         a.raza_tipo,
         a.raza_principal_id::text as raza_principal_id,
         r.nombre as raza_principal_nombre,
         a.raza_otro_nombre,
         a.cruce_descripcion,
         a.categoria_productiva_id::text as categoria_productiva_id,
         c.codigo as categoria_codigo,
         c.nombre as categoria_nombre,
         a.origen_tipo,
         a.procedencia,
         to_char(a.fecha_ingreso, 'YYYY-MM-DD') as fecha_ingreso,
         a.observaciones,
         a.estado,
         a.estado_motivo,
         a.estado_at,
         a.created_at,
         to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_iso,
         lp.peso_kg as ultimo_peso_kg,
         lp.metodo as ultimo_peso_metodo,
         to_char(lp.fecha, 'YYYY-MM-DD') as ultimo_peso_fecha
    from agx.animales a
    join agx.predios p on p.predio_id = a.predio_id
    left join agx.catalogo_razas r on r.raza_id = a.raza_principal_id
    left join agx.catalogo_categorias_productivas c on c.categoria_id = a.categoria_productiva_id
    left join lateral (
      select ap.peso_kg, ap.metodo, ap.fecha
        from agx.animal_pesajes ap
       where ap.animal_id = a.animal_id
       order by ap.fecha desc, ap.pesaje_id desc
       limit 1
    ) lp on true`;

// API: nunca expone organizacion_id, client_operation_id ni
// creation_intent_hash.
export function serializeAnimal(row) {
  return {
    animalId: row.animal_id,
    predioId: row.predio_id,
    predioNombre: row.nombre_predio,
    numeroVisual: row.numero_visual,
    nombre: row.nombre,
    sexo: row.sexo,
    nacimientoTipo: row.nacimiento_tipo,
    fechaNacimiento: row.fecha_nacimiento,
    edadAproximadaMeses: row.edad_aproximada_meses,
    edadReferenciaFecha: row.edad_referencia_fecha,
    razaTipo: row.raza_tipo,
    razaPrincipalId: row.raza_principal_id,
    razaPrincipalNombre: row.raza_principal_nombre ?? null,
    razaOtroNombre: row.raza_otro_nombre,
    cruceDescripcion: row.cruce_descripcion,
    categoriaProductivaId: row.categoria_productiva_id,
    categoriaProductivaCodigo: row.categoria_codigo ?? null,
    categoriaProductivaNombre: row.categoria_nombre ?? null,
    ultimoPeso: row.ultimo_peso_kg === null || row.ultimo_peso_kg === undefined
      ? null
      : { pesoKg: Number(row.ultimo_peso_kg), metodo: row.ultimo_peso_metodo, fecha: row.ultimo_peso_fecha },
    origenTipo: row.origen_tipo,
    procedencia: row.procedencia,
    fechaIngreso: row.fecha_ingreso,
    observaciones: row.observaciones,
    estado: row.estado,
    estadoMotivo: row.estado_motivo,
    estadoAt: row.estado_at,
    fechaCreacion: row.created_at,
    fechaActualizacion: row.updated_at_iso,
  };
}

export async function fetchAnimal(client, animalId) {
  const result = await client.query(`${ANIMAL_SELECT} where a.animal_id = $1`, [animalId]);
  return result.rows[0] ? serializeAnimal(result.rows[0]) : null;
}

function escapeLikePrefix(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** GET /api/ganaderia/animales -- más recientes primero, offset/limit. */
export async function listAnimales(organizacionId, { predioId, estado, sexo, q, limit, offset }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const conditions = [];
    const params = [];
    if (estado !== 'TODOS') {
      params.push(estado);
      conditions.push(`a.estado = $${params.length}`);
    }
    if (predioId) {
      params.push(predioId);
      conditions.push(`a.predio_id = $${params.length}`);
    }
    if (sexo) {
      params.push(sexo);
      conditions.push(`a.sexo = $${params.length}`);
    }
    if (q) {
      params.push(`${escapeLikePrefix(q.toLowerCase())}%`);
      conditions.push(
        `(lower(a.numero_visual) like $${params.length} escape '\\' or lower(a.nombre) like $${params.length} escape '\\')`,
      );
    }
    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

    const totalResult = await client.query(`select count(*)::int as total from agx.animales a ${where}`, params);
    const rowsResult = await client.query(
      `${ANIMAL_SELECT} ${where}
        order by a.created_at desc, a.animal_id desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { animales: rowsResult.rows.map(serializeAnimal), total: totalResult.rows[0].total };
  });
}

/** GET /api/ganaderia/animales/:animalId -- null si no existe o es de otra organización. */
export async function getAnimal(organizacionId, animalId) {
  return withOrganizacionTransaction(organizacionId, (client) => fetchAnimal(client, animalId));
}

async function assertPredioActivo(client, predioId) {
  // FOR SHARE: un archivado concurrente del predio espera al COMMIT de este
  // alta (la FK compuesta sola no bloquearía ese UPDATE de estado).
  const result = await client.query('select estado from agx.predios where predio_id = $1 for share', [predioId]);
  const predio = result.rows[0];
  if (!predio) throw semanticError('PREDIO_NOT_FOUND', 404, 'El predio no existe.');
  if (predio.estado !== 'ACTIVO') {
    throw semanticError('PREDIO_ARCHIVADO', 409, 'El predio está archivado: no admite nuevos animales.');
  }
}

// Las FK a catálogos son simples y NO pasan por RLS: cada id se valida aquí
// con un SELECT bajo RLS (y activo = true) antes de escribirlo.
async function assertRazaDisponible(client, razaId) {
  const result = await client.query('select 1 from agx.catalogo_razas where raza_id = $1 and activo = true', [razaId]);
  if (!result.rows[0]) throw semanticError('INVALID_RAZA', 400, 'La raza seleccionada no está disponible.');
}

async function assertCategoriaDisponible(client, categoriaId, sexo) {
  const result = await client.query(
    'select codigo from agx.catalogo_categorias_productivas where categoria_id = $1 and activo = true',
    [categoriaId],
  );
  const categoria = result.rows[0];
  if (!categoria) throw semanticError('INVALID_CATEGORIA', 400, 'La categoría seleccionada no está disponible.');
  if (!isCategoriaCompatibleConSexo(categoria.codigo, sexo)) {
    throw semanticError('CATEGORIA_INCOMPATIBLE_SEXO', 400, 'La categoría no corresponde al sexo del animal.');
  }
}

function translateUniqueViolation(error) {
  if (error?.code === '23505' && error.constraint === NUMERO_VISUAL_UNIQUE_CONSTRAINT) {
    return semanticError('ANIMAL_NUMERO_VISUAL_DUPLICADO', 409, 'Ya hay un animal activo con este número de chapeta.');
  }
  if (error?.code === '23505' && error.constraint === CLIENT_OPERATION_UNIQUE_CONSTRAINT) {
    // Imposible bajo el advisory lock por operación -- nunca se traduce
    // como duplicado de chapeta.
    return new Error('CLIENT_OPERATION_ID_CONFLICT_UNDER_LOCK');
  }
  return error;
}

/**
 * POST /api/ganaderia/animales -- creación idempotente por
 * (organizacion_id, client_operation_id), resuelta EXCLUSIVAMENTE contra
 * agx.animales.creation_intent_hash (nunca contra animal_eventos):
 *   1. advisory lock transaccional por org + operación (serializa
 *      reintentos concurrentes de la MISMA intención);
 *   2. si la operación ya existe: mismo hash -> {yaExistia: true}, sin
 *      ninguna escritura; hash distinto -> 409 CLIENT_OPERATION_ID_REUSED;
 *   3. si no existe: predio ACTIVO, catálogos, INSERT animal (+ pesaje
 *      inicial) + evento REGISTRADO, todo en la misma transacción.
 * El conflicto de transporte (paso 2) siempre se evalúa antes que el de
 * negocio (chapeta duplicada, paso 3).
 */
export async function createAnimalIdempotente(organizacionId, value, { actorCuentaId, now = new Date() } = {}) {
  return withOrganizacionTransaction(organizacionId, (client) =>
    createAnimalInTransaction(client, organizacionId, value, { actorCuentaId, now }));
}

/**
 * Núcleo de createAnimalIdempotente sobre una transacción YA abierta con
 * app.current_org_id fijado. SPRINT-3D11.3: lo reutiliza el registro con
 * chapeta QR para crear el animal y asociar la chapeta atómicamente.
 */
export async function createAnimalInTransaction(client, organizacionId, value, { actorCuentaId, now = new Date() } = {}) {
  const creationIntentHash = computeCreationIntentHash(value);
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `ganaderia_animal_create:${organizacionId}:${value.clientOperationId}`,
  ]);

  const existingResult = await client.query(
    `select animal_id::text as animal_id, creation_intent_hash
       from agx.animales
      where organizacion_id = $1 and client_operation_id = $2`,
    [organizacionId, value.clientOperationId],
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (existing.creation_intent_hash !== creationIntentHash) {
      throw semanticError(
        'CLIENT_OPERATION_ID_REUSED',
        409,
        'Esta operación ya registró un animal con datos distintos. Revisa tu lista de animales.',
      );
    }
    return { animal: await fetchAnimal(client, existing.animal_id), yaExistia: true };
  }

  await assertPredioActivo(client, value.predioId);
  if (value.razaPrincipalId) await assertRazaDisponible(client, value.razaPrincipalId);
  if (value.categoriaProductivaId) await assertCategoriaDisponible(client, value.categoriaProductivaId, value.sexo);

  const hoy = resolveFechaHoyNegocio(now);
  const edadReferenciaFecha = value.nacimientoTipo === 'APROXIMADA' ? hoy : null;

  let animalId;
  try {
    const inserted = await client.query(
      `insert into agx.animales
         (organizacion_id, predio_id, numero_visual, nombre, sexo,
          nacimiento_tipo, fecha_nacimiento, edad_aproximada_meses, edad_referencia_fecha,
          raza_tipo, raza_principal_id, raza_otro_nombre, cruce_descripcion,
          categoria_productiva_id, origen_tipo, procedencia, fecha_ingreso, observaciones,
          client_operation_id, creation_intent_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       returning animal_id::text as animal_id`,
      [
        organizacionId,
        value.predioId,
        value.numeroVisual,
        value.nombre,
        value.sexo,
        value.nacimientoTipo,
        value.fechaNacimiento,
        value.edadAproximadaMeses,
        edadReferenciaFecha,
        value.razaTipo,
        value.razaPrincipalId,
        value.razaOtroNombre,
        value.cruceDescripcion,
        value.categoriaProductivaId,
        value.origenTipo,
        value.procedencia,
        value.fechaIngreso,
        value.observaciones,
        value.clientOperationId,
        creationIntentHash,
      ],
    );
    animalId = inserted.rows[0].animal_id;
  } catch (error) {
    throw translateUniqueViolation(error);
  }

  let pesajeInicialId = null;
  if (value.pesoInicialKg !== null) {
    const pesaje = await client.query(
      `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id)
       values ($1, $2, $3, $4, $5, 'REGISTRO_INICIAL', $6)
       returning pesaje_id::text as pesaje_id`,
      [organizacionId, animalId, hoy, value.pesoInicialKg, value.pesoInicialMetodo, actorCuentaId],
    );
    pesajeInicialId = pesaje.rows[0].pesaje_id;
  }

  // Auditoría únicamente -- el protocolo de reintento no lee este evento.
  await client.query(
    `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
     values ($1, $2, 'REGISTRADO', $3::jsonb, $4)`,
    [organizacionId, animalId, JSON.stringify({ intentHash: creationIntentHash, pesajeInicialId }), actorCuentaId],
  );

  return { animal: await fetchAnimal(client, animalId), yaExistia: false };
}

// Columnas corregibles: clave camelCase del valor normalizado -> columna.
const CORRECTABLE_COLUMNS = Object.freeze({
  numeroVisual: 'numero_visual',
  nombre: 'nombre',
  sexo: 'sexo',
  nacimientoTipo: 'nacimiento_tipo',
  fechaNacimiento: 'fecha_nacimiento',
  edadAproximadaMeses: 'edad_aproximada_meses',
  edadReferenciaFecha: 'edad_referencia_fecha',
  razaTipo: 'raza_tipo',
  razaPrincipalId: 'raza_principal_id',
  razaOtroNombre: 'raza_otro_nombre',
  cruceDescripcion: 'cruce_descripcion',
  categoriaProductivaId: 'categoria_productiva_id',
  origenTipo: 'origen_tipo',
  procedencia: 'procedencia',
  fechaIngreso: 'fecha_ingreso',
  observaciones: 'observaciones',
});

async function lockAnimalForUpdate(client, animalId, fechaActualizacionEsperada = null) {
  const result = await client.query(
    `select a.animal_id::text as animal_id, a.estado,
            a.numero_visual, a.nombre, a.sexo,
            a.nacimiento_tipo, to_char(a.fecha_nacimiento, 'YYYY-MM-DD') as fecha_nacimiento,
            a.edad_aproximada_meses, to_char(a.edad_referencia_fecha, 'YYYY-MM-DD') as edad_referencia_fecha,
            a.raza_tipo, a.raza_principal_id::text as raza_principal_id, a.raza_otro_nombre, a.cruce_descripcion,
            a.categoria_productiva_id::text as categoria_productiva_id,
            a.origen_tipo, a.procedencia, to_char(a.fecha_ingreso, 'YYYY-MM-DD') as fecha_ingreso,
            a.observaciones,
            ($2::timestamptz is not null and a.updated_at = $2::timestamptz) as precondicion_ok
       from agx.animales a
      where a.animal_id = $1
      for update`,
    [animalId, fechaActualizacionEsperada],
  );
  return result.rows[0] || null;
}

function rowToCorrectableValue(row) {
  return Object.fromEntries(Object.entries(CORRECTABLE_COLUMNS).map(([key, column]) => [key, row[column] ?? null]));
}

/**
 * POST /api/ganaderia/animales/:animalId/corregir -- corrige grupos
 * completos de datos declarados. Nunca predio_id, estado, peso,
 * client_operation_id ni creation_intent_hash (sin grant UPDATE en 0022).
 *   - Sin diferencias reales -> {sinCambios: true}, sin escritura ni evento
 *     (un reintento tras perder la respuesta es inocuo).
 *   - Con diferencias, exige fechaActualizacionEsperada == updated_at
 *     (concurrencia optimista) -> 409 ANIMAL_MODIFICADO si otro cambio
 *     llegó antes.
 */
export async function corregirAnimal(
  organizacionId,
  animalId,
  { cambios, fechaActualizacionEsperada },
  { actorCuentaId, now = new Date() } = {},
) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const row = await lockAnimalForUpdate(client, animalId, fechaActualizacionEsperada);
    if (!row) throw semanticError('ANIMAL_NOT_FOUND', 404, 'El animal no existe.');
    if (row.estado === 'ANULADO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'Este registro está anulado y no admite correcciones.');
    }

    const actual = rowToCorrectableValue(row);
    const merged = { ...actual, ...cambios };

    if (Object.hasOwn(cambios, 'nacimientoTipo')) {
      if (merged.nacimientoTipo === 'APROXIMADA') {
        const mismaDeclaracion = actual.nacimientoTipo === 'APROXIMADA'
          && actual.edadAproximadaMeses === merged.edadAproximadaMeses;
        merged.edadReferenciaFecha = mismaDeclaracion ? actual.edadReferenciaFecha : resolveFechaHoyNegocio(now);
      } else {
        merged.edadReferenciaFecha = null;
      }
    }

    validateAnimalConsistency(merged);

    const changedKeys = Object.keys(CORRECTABLE_COLUMNS).filter((key) => (actual[key] ?? null) !== (merged[key] ?? null));
    if (changedKeys.length === 0) {
      return { animal: await fetchAnimal(client, animalId), sinCambios: true };
    }
    if (!row.precondicion_ok) {
      throw semanticError(
        'ANIMAL_MODIFICADO',
        409,
        'El animal fue modificado mientras lo editabas. Recarga sus datos y vuelve a intentarlo.',
      );
    }

    if (changedKeys.includes('razaPrincipalId') && merged.razaPrincipalId) {
      await assertRazaDisponible(client, merged.razaPrincipalId);
    }
    if (merged.categoriaProductivaId && (changedKeys.includes('categoriaProductivaId') || changedKeys.includes('sexo'))) {
      await assertCategoriaDisponible(client, merged.categoriaProductivaId, merged.sexo);
    }

    const columns = changedKeys.map((key) => CORRECTABLE_COLUMNS[key]);
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    try {
      await client.query(
        `update agx.animales set ${setClause}, updated_at = now() where animal_id = $1`,
        [animalId, ...changedKeys.map((key) => merged[key])],
      );
    } catch (error) {
      throw translateUniqueViolation(error);
    }

    await client.query(
      `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
       values ($1, $2, 'DATOS_CORREGIDOS', $3::jsonb, $4)`,
      [organizacionId, animalId, JSON.stringify({ campos: columns }), actorCuentaId],
    );

    return { animal: await fetchAnimal(client, animalId), sinCambios: false };
  });
}

/**
 * POST /api/ganaderia/animales/:animalId/anular -- ACTIVO -> ANULADO
 * (terminal). FOR UPDATE serializa intentos concurrentes; un reintento
 * sobre un animal ya ANULADO devuelve {yaAnulado: true} sin escribir (el
 * primer motivo es el autoritativo). El índice único parcial de 0022 hace
 * imposible un segundo evento ANULADO.
 */
export async function anularAnimal(organizacionId, animalId, { motivo, actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const row = await lockAnimalForUpdate(client, animalId);
    if (!row) throw semanticError('ANIMAL_NOT_FOUND', 404, 'El animal no existe.');
    if (row.estado === 'ANULADO') {
      return { animal: await fetchAnimal(client, animalId), yaAnulado: true };
    }

    await client.query(
      `update agx.animales
          set estado = 'ANULADO', estado_at = now(), estado_por = $2, estado_motivo = $3, updated_at = now()
        where animal_id = $1`,
      [animalId, actorCuentaId, motivo],
    );
    await client.query(
      `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
       values ($1, $2, 'ANULADO', $3::jsonb, $4)`,
      [organizacionId, animalId, JSON.stringify({ motivo }), actorCuentaId],
    );

    // SPRINT-3D11.3 (R1): la chapeta QR de un animal anulado deja de ser un
    // identificador operativo -- pasa a REVOCADO en la misma transacción
    // (historial conservado; el código no se reutiliza).
    const chapeta = await client.query(
      `update agx.qr_chapetas
          set estado = 'REVOCADO', revocado_at = now(), revocado_por = $2,
              motivo = 'Animal anulado', updated_at = now()
        where animal_id = $1 and estado = 'ASIGNADO_ANIMAL'
        returning qr_id::text as qr_id, codigo_visible`,
      [animalId, actorCuentaId],
    );
    for (const row of chapeta.rows) {
      await client.query(
        `insert into agx.qr_chapeta_eventos (qr_id, organizacion_id, tipo_evento, metadata_json, actor_cuenta_id)
         values ($1, $2, 'REVOCADA', $3::jsonb, $4)`,
        [row.qr_id, organizacionId, JSON.stringify({ causa: 'ANIMAL_ANULADO', animalId: String(animalId) }), actorCuentaId],
      );
      await client.query(
        `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
         values ($1, $2, 'QR_REVOCADO', $3::jsonb, $4)`,
        [organizacionId, animalId, JSON.stringify({ qrId: row.qr_id, codigoVisible: row.codigo_visible, causa: 'ANIMAL_ANULADO' }), actorCuentaId],
      );
    }

    return { animal: await fetchAnimal(client, animalId), yaAnulado: false };
  });
}
