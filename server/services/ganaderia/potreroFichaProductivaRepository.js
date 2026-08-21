// SPRINT-3D6-FICHA-PRODUCTIVA: acceso a datos de la ficha productiva del
// potrero (agx.potrero_fichas_productivas / agx.potrero_ficha_pasturas /
// agx.catalogo_pasturas, fundación en 0004_potrero_ficha_productiva.sql)
// contra Postgres-AGX-Business. Mismo principio de separación
// router/repositorio que potrerosRepository.js -- probable directamente
// contra un Postgres/PostGIS real vía withOrganizacionTransaction.
//
// Regla de dominio: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA PRODUCTIVA.
// Regla de historial (§4 del sprint): cada POST crea una fila NUEVA en
// agx.potrero_fichas_productivas -- nunca se actualiza una ficha existente.
// "Ficha actual" es una noción de lectura (la más reciente por created_at).
//
// Regla de biomasa (§14/§15): biomasa_total_kg SIEMPRE se calcula aquí a
// partir de agx.potreros.area_ha (autoritativo) -- el body del cliente
// nunca aporta area/biomasa, ver validación del router.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';

// g/m² de materia fresca -- máximo técnico para evitar errores absurdos de
// captura (ver informe SPRINT-3D6 §19). Un aforo real de pastura tropical
// bien manejada rara vez supera 3000-4000 g/m²; 10000 deja margen amplio
// para mezclas muy densas sin aceptar valores claramente erróneos (p.ej.
// un dígito de más).
export const AFORO_MAX_G_M2 = 10000;

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function assertPredioIdFormat(predioId) {
  if (!/^\d+$/.test(String(predioId))) {
    throw semanticError('INVALID_PREDIO_ID', 400, 'predioId inválido.');
  }
}

function assertPotreroIdFormat(potreroId) {
  if (!/^\d+$/.test(String(potreroId))) {
    throw semanticError('INVALID_POTRERO_ID', 400, 'potreroId inválido.');
  }
}

/**
 * Confirma que `potreroId` existe, pertenece a `predioId` y a la
 * organización activa (RLS + FORCE + filtro explícito por predio_id --
 * mismo criterio que getPotreroDetail en potrerosRepository.js). Devuelve
 * area_ha (autoritativa, nunca aportada por el cliente) para el cálculo de
 * biomasa.
 */
async function assertPotreroBelongsToPredio(client, predioId, potreroId) {
  const result = await client.query(
    'select potrero_id, area_ha from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------
// Catálogo de pasturas (§5/§6/§7/§9 del sprint).
// ---------------------------------------------------------------------

/**
 * Lista el catálogo visible para la organización activa -- sistema
 * (organizacion_id NULL) + personalizado propio, nunca personalizado de
 * otra organización (garantizado por la policy catalogo_pasturas_read,
 * no por este filtro). `search` es un ILIKE opcional sobre nombre
 * común/científico para el selector searchable de la UI.
 */
export async function listCatalogoPasturas(organizacionId, { search = '' } = {}) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const term = search.trim();
    if (term) {
      const result = await client.query(
        `select pastura_id, organizacion_id, nombre_comun, nombre_cientifico, genero, especie, cultivar, tipo, alcance
           from agx.catalogo_pasturas
          where activo = true
            and (nombre_comun ilike $1 or nombre_cientifico ilike $1)
          order by (organizacion_id is not null) desc, nombre_comun asc`,
        [`%${term}%`],
      );
      return result.rows;
    }
    const result = await client.query(
      `select pastura_id, organizacion_id, nombre_comun, nombre_cientifico, genero, especie, cultivar, tipo, alcance
         from agx.catalogo_pasturas
        where activo = true
        order by (organizacion_id is not null) desc, nombre_comun asc`,
    );
    return result.rows;
  });
}

const TIPO_CATALOGO_VALUES = new Set(['graminea', 'leguminosa', 'mezcla', 'otra']);

export function isValidCatalogoTipo(tipo) {
  return TIPO_CATALOGO_VALUES.has(tipo);
}

/**
 * Crea una entrada PERSONALIZADA del catálogo (§9 del sprint: "Agregar
 * otra pastura") -- alcance/organizacion_id SIEMPRE fijados aquí, nunca
 * aportados por el cliente. Jamás inserta en el catálogo de sistema (la
 * policy catalogo_pasturas_tenant_write de agx_app lo rechazaría de todas
 * formas -- esto es además la validación explícita a nivel de aplicación).
 */
export async function createPasturaPersonalizada(organizacionId, { nombreComun, nombreCientifico, genero, especie, cultivar, tipo }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(
      `insert into agx.catalogo_pasturas
         (organizacion_id, nombre_comun, nombre_cientifico, genero, especie, cultivar, tipo, alcance)
       values ($1, $2, $3, $4, $5, $6, $7, 'personalizado')
       returning pastura_id, organizacion_id, nombre_comun, nombre_cientifico, genero, especie, cultivar, tipo, alcance`,
      [organizacionId, nombreComun, nombreCientifico, genero, especie, cultivar, tipo],
    );
    return result.rows[0];
  });
}

/**
 * Resuelve una lista de pasturaId contra el catálogo visible para la
 * organización activa (sistema + propio) -- una pastura personalizada de
 * OTRA organización es indistinguible de "no existe" (RLS ya la oculta),
 * nunca se filtra por un JOIN sin RLS. Lanza ESPECIE_NOT_FOUND si algún
 * id no resuelve. Devuelve las filas EN EL MISMO ORDEN que `pasturaIds`
 * (nunca el orden de SELECT) -- el índice 0 decide la especie "principal".
 */
async function resolveEspecies(client, pasturaIds) {
  const result = await client.query(
    `select pastura_id, nombre_comun, alcance
       from agx.catalogo_pasturas
      where pastura_id = any($1::bigint[]) and activo = true`,
    [pasturaIds],
  );
  const byId = new Map(result.rows.map((row) => [String(row.pastura_id), row]));
  return pasturaIds.map((id) => {
    const row = byId.get(String(id));
    if (!row) {
      throw semanticError('ESPECIE_NOT_FOUND', 404, `La pastura ${id} no existe o no pertenece a tu organización.`);
    }
    return row;
  });
}

// ---------------------------------------------------------------------
// Ficha productiva (§2/§4/§10-§16 del sprint).
// ---------------------------------------------------------------------

function computeBiomasaTotalKg(areaHa, aforoPromedioGM2) {
  const areaM2 = Number(areaHa) * 10000;
  const gramos = areaM2 * Number(aforoPromedioGM2);
  return gramos / 1000;
}

function serializeEspecieRow(row) {
  return {
    pasturaId: String(row.pastura_id),
    nombreComun: row.nombre_comun,
    porcentajeEstimado: row.porcentaje_estimado === null ? null : Number(row.porcentaje_estimado),
  };
}

async function fetchEspeciesByFichaIds(client, fichaIds) {
  if (fichaIds.length === 0) return new Map();
  const result = await client.query(
    `select fp.ficha_id, cp.pastura_id, cp.nombre_comun, fp.porcentaje_estimado
       from agx.potrero_ficha_pasturas fp
       join agx.catalogo_pasturas cp on cp.pastura_id = fp.pastura_id
      where fp.ficha_id = any($1::bigint[])
      order by fp.ficha_id, fp.orden asc, fp.ficha_pastura_id asc`,
    [fichaIds],
  );
  const byFicha = new Map();
  for (const row of result.rows) {
    const key = String(row.ficha_id);
    if (!byFicha.has(key)) byFicha.set(key, []);
    byFicha.get(key).push(serializeEspecieRow(row));
  }
  return byFicha;
}

function serializeFichaRow(row, especies) {
  return {
    fichaId: String(row.ficha_id),
    tipoCobertura: row.tipo_cobertura,
    nombrePrincipal: row.nombre_principal,
    nombrePersonalizado: row.nombre_personalizado ?? null,
    aforoPromedioGM2: Number(row.aforo_promedio_g_m2),
    numeroMuestras: row.numero_muestras === null ? null : Number(row.numero_muestras),
    fechaAforo: row.fecha_aforo,
    observaciones: row.observaciones ?? null,
    biomasaTotalKg: Number(row.biomasa_total_kg),
    especies: especies ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Ficha actual (más reciente) + historial resumido de un potrero (§17/§23
 * del sprint). Devuelve { actual: null, historial: [] } si el potrero
 * todavía no tiene ninguna ficha registrada (§24) -- nunca 404 en ese
 * caso, el potrero sí existe.
 */
export async function getFichaProductivaByPotrero(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const result = await client.query(
      `select ficha_id, tipo_cobertura, nombre_principal, nombre_personalizado,
              aforo_promedio_g_m2, numero_muestras, to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo,
              observaciones, biomasa_total_kg, created_at, updated_at
         from agx.potrero_fichas_productivas
        where potrero_id = $1
        order by created_at desc`,
      [potreroId],
    );

    if (result.rows.length === 0) {
      return { actual: null, historial: [] };
    }

    const especiesByFicha = await fetchEspeciesByFichaIds(client, result.rows.map((r) => r.ficha_id));
    const [actualRow, ...historialRows] = result.rows;

    return {
      actual: serializeFichaRow(actualRow, especiesByFicha.get(String(actualRow.ficha_id))),
      historial: historialRows.map((row) => serializeFichaRow(row, especiesByFicha.get(String(row.ficha_id)))),
    };
  });
}

/**
 * Crea una ficha productiva NUEVA (append -- §4 del sprint, nunca
 * sobrescribe una fila existente). `especies` es [{ pasturaId,
 * porcentajeEstimado }], ya validado por el router (formato, rangos) --
 * este repositorio SOLO resuelve pasturaId contra el catálogo visible
 * (org-scoped) y calcula tipoCobertura/nombrePrincipal/biomasaTotalKg.
 * area_ha SIEMPRE viene de agx.potreros -- nunca del body (§15).
 */
export async function createFichaProductiva(organizacionId, predioId, potreroId, {
  especies,
  aforoPromedioGM2,
  numeroMuestras,
  fechaAforo,
  observaciones,
  nombrePersonalizado,
}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const potrero = await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const especiesResueltas = await resolveEspecies(client, especies.map((e) => e.pasturaId));

    const tipoCobertura =
      especiesResueltas.length > 1
        ? 'mezcla'
        : especiesResueltas[0].alcance === 'personalizado'
          ? 'otra'
          : 'pastura';

    const nombrePrincipal = especiesResueltas[0].nombre_comun;
    const biomasaTotalKg = computeBiomasaTotalKg(potrero.area_ha, aforoPromedioGM2);

    const fichaResult = await client.query(
      `insert into agx.potrero_fichas_productivas
         (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, nombre_personalizado,
          aforo_promedio_g_m2, numero_muestras, fecha_aforo, observaciones, biomasa_total_kg)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ficha_id, tipo_cobertura, nombre_principal, nombre_personalizado,
                 aforo_promedio_g_m2, numero_muestras, to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo,
                 observaciones, biomasa_total_kg, created_at, updated_at`,
      [
        organizacionId,
        potreroId,
        tipoCobertura,
        nombrePrincipal,
        nombrePersonalizado,
        aforoPromedioGM2,
        numeroMuestras,
        fechaAforo,
        observaciones,
        biomasaTotalKg,
      ],
    );
    const fichaRow = fichaResult.rows[0];

    for (let i = 0; i < especies.length; i += 1) {
      await client.query(
        `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden)
         values ($1, $2, $3, $4, $5)`,
        [organizacionId, fichaRow.ficha_id, especies[i].pasturaId, especies[i].porcentajeEstimado, i],
      );
    }

    const especiesSerializadas = especiesResueltas.map((row, i) => ({
      pasturaId: String(row.pastura_id),
      nombreComun: row.nombre_comun,
      porcentajeEstimado: especies[i].porcentajeEstimado ?? null,
    }));

    return serializeFichaRow(fichaRow, especiesSerializadas);
  });
}
