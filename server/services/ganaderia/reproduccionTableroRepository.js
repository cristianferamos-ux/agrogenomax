// FASE 4C -- tablero reproductivo de la ORGANIZACIÓN (solo lectura) contra
// Postgres-AGX-Business. `organizacionId` llega YA autorizado
// (req.ganaderiaAuth, nunca del cliente) y todo corre en
// withOrganizacionTransaction: RLS+FORCE aísla por organización.
//
// Una sola CTE (TABLERO_CTE) deriva, en SQL y por hembra, el estado
// reproductivo, los últimos eventos, la gestación y las alertas; el listado
// (filtros + paginación) y los KPIs salen de ELLA, así los conteos y el
// listado nunca divergen. Sin N+1 ni historiales en JavaScript: cada lateral
// lee como mucho una fila por animal usando el índice
// reproduccion_eventos_animal_fecha_idx (animal_id, fecha_evento, evento_id).
//
// Paridad con reproduccionEstado.js (plegado en orden fecha_evento,
// evento_id de los eventos ACTIVO):
//   - el estado lo fija el último evento que transiciona (un diagnóstico
//     DUDOSA no transiciona): CELO -> CICLANDO; servicio -> SERVIDA;
//     diagnóstico PRENADA -> PRENADA, VACIA -> VACIA; ABORTO -> VACIA;
//     PARTO -> POSPARTO; sin ninguno -> SIN_ESTADO;
//   - gestación (solo PRENADA): concepción = fecha del diagnóstico - días de
//     gestación o, si no hay días, la del servicio del ciclo (posterior al
//     último parto/aborto y no posterior al diagnóstico; TE - 7 días); fecha
//     probable de parto = concepción + GESTACION_REFERENCIA_DIAS.
// La integración compara este SQL con derivarEstadoReproductivo() animal a
// animal. Nunca toca el Postgres legacy (server/db.js).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { EDAD_EMBRION_TRANSFERENCIA_DIAS, GESTACION_REFERENCIA_DIAS, TIPOS_SERVICIO } from './reproduccionEstado.js';
import { ALERTAS_REPRODUCCION, CONFIGURACION_ALERTAS_REPRODUCCION, ESTADOS_TABLERO } from './reproduccionAlertas.js';

const SERVICIOS_SQL = TIPOS_SERVICIO.map((t) => `'${t}'`).join(', ');

// Último evento ACTIVO del animal que cumple `condicion` (una fila).
const ultimo = (alias, condicion, columnas) => `
  left join lateral (
    select ${columnas}
      from agx.reproduccion_eventos e
     where e.animal_id = h.animal_id and e.estado_registro = 'ACTIVO'${condicion ? ` and ${condicion}` : ''}
     order by e.fecha_evento desc, e.evento_id desc
     limit 1
  ) ${alias} on true`;

const COLS = 'e.evento_id, e.tipo_evento, e.fecha_evento';

/**
 * CTE del tablero. Parámetros fijos: $1 hoy (fecha de negocio), $2 días
 * diagnóstico pendiente, $3 días parto próximo, $4 edad mínima (meses), $5
 * días de gestación de referencia, $6 edad del embrión en TE. `hembras` recibe
 * el WHERE de la consulta (situación, registro, predio, búsqueda).
 */
export function tableroCte(whereHembras) {
  return `
  with hembras as (
    select a.animal_id, a.numero_visual, a.nombre, a.predio_id, p.nombre_predio,
           a.estado, a.estado_operativo, a.nacimiento_tipo, a.fecha_nacimiento,
           a.edad_aproximada_meses, a.edad_referencia_fecha
      from agx.animales a
      join agx.predios p on p.predio_id = a.predio_id
     where a.sexo = 'HEMBRA'${whereHembras ? ` and ${whereHembras}` : ''}
  ),
  base as (
    select h.*,
           ue.tipo_evento as ue_tipo, ue.fecha_evento as ue_fecha,
           ut.tipo_evento as ut_tipo, ut.fecha_evento as ut_fecha, ut.diagnostico_resultado as ut_resultado,
           ut.dias_gestacion as ut_dias,
           us.evento_id as us_id, us.tipo_evento as us_tipo, us.fecha_evento as us_fecha,
           ud.evento_id as ud_id, ud.fecha_evento as ud_fecha, ud.diagnostico_resultado as ud_resultado,
           ud.dias_gestacion as ud_dias,
           up.fecha_evento as up_fecha, up.numero_crias as up_crias,
           ur.evento_id as ur_id, ur.fecha_evento as ur_fecha
      from hembras h
      ${ultimo('ue', null, COLS)}
      ${ultimo('ut', "not (e.tipo_evento = 'DIAGNOSTICO_PRENEZ' and e.diagnostico_resultado = 'DUDOSA')", `${COLS}, e.diagnostico_resultado, e.dias_gestacion`)}
      ${ultimo('us', `e.tipo_evento in (${SERVICIOS_SQL})`, COLS)}
      ${ultimo('ud', "e.tipo_evento = 'DIAGNOSTICO_PRENEZ'", `${COLS}, e.diagnostico_resultado, e.dias_gestacion`)}
      ${ultimo('up', "e.tipo_evento = 'PARTO'", `${COLS}, e.numero_crias`)}
      ${ultimo('ur', "e.tipo_evento in ('PARTO', 'ABORTO')", COLS)}
  ),
  derivado as (
    select b.*,
           case
             when b.ut_tipo is null then 'SIN_ESTADO'
             when b.ut_tipo = 'CELO_OBSERVADO' then 'CICLANDO'
             when b.ut_tipo in (${SERVICIOS_SQL}) then 'SERVIDA'
             when b.ut_tipo = 'DIAGNOSTICO_PRENEZ' and b.ut_resultado = 'PRENADA' then 'PRENADA'
             when b.ut_tipo = 'DIAGNOSTICO_PRENEZ' then 'VACIA'
             when b.ut_tipo = 'ABORTO' then 'VACIA'
             when b.ut_tipo = 'PARTO' then 'POSPARTO'
           end as estado_reproductivo,
           -- Servicio del ciclo: posterior al último parto/aborto.
           (b.us_id is not null and (b.ur_id is null or (b.us_fecha, b.us_id) > (b.ur_fecha, b.ur_id))) as servicio_del_ciclo
      from base b
  ),
  gestacion as (
    select s.*,
           case
             when s.estado_reproductivo <> 'PRENADA' then null
             when s.ut_dias is not null and s.ut_dias > 0 then s.ut_fecha - s.ut_dias
             when s.servicio_del_ciclo and s.us_fecha <= s.ut_fecha
               then s.us_fecha - (case when s.us_tipo = 'TRANSFERENCIA_EMBRION' then $6::int else 0 end)
           end as concepcion,
           case
             when s.estado_reproductivo <> 'PRENADA' then null
             when s.ut_dias is not null and s.ut_dias > 0 then 'DIAGNOSTICO'
             when s.servicio_del_ciclo and s.us_fecha <= s.ut_fecha then 'SERVICIO'
           end as gestacion_base
      from derivado s
  ),
  calc as (
    select g.*,
           g.concepcion + $5::int as fecha_probable_parto,
           (g.estado = 'ACTIVO' and g.estado_operativo = 'EN_HATO') as operativo
      from gestacion g
  ),
  tablero as (
    select c.*,
           (c.operativo and c.estado_reproductivo = 'SERVIDA'
             and (c.ud_id is null or (c.ud_fecha, c.ud_id) < (c.us_fecha, c.us_id))
             and $1::date - c.us_fecha >= $2::int) as alerta_diagnostico_pendiente,
           (c.operativo and c.estado_reproductivo = 'PRENADA' and c.fecha_probable_parto is not null
             and c.fecha_probable_parto - $1::date <= $3::int) as alerta_parto_proximo,
           (c.operativo and c.ud_resultado = 'DUDOSA'
             and (c.us_id is null or (c.us_fecha, c.us_id) < (c.ud_fecha, c.ud_id))
             and (c.ur_id is null or (c.ur_fecha, c.ur_id) < (c.ud_fecha, c.ud_id))) as alerta_diagnostico_dudoso,
           (c.operativo and c.ue_tipo is null and case c.nacimiento_tipo
              when 'EXACTA' then c.fecha_nacimiento + make_interval(months => $4::int) <= $1::date
              when 'APROXIMADA' then c.edad_referencia_fecha - make_interval(months => c.edad_aproximada_meses)
                                     + make_interval(months => $4::int) <= $1::date
              else true
            end) as alerta_sin_seguimiento
      from calc c
  )`;
}

// Alerta (código de la API) -> columna booleana de la CTE.
export const COLUMNA_ALERTA = Object.freeze({
  DIAGNOSTICO_PENDIENTE: 'alerta_diagnostico_pendiente',
  PARTO_PROXIMO: 'alerta_parto_proximo',
  DIAGNOSTICO_DUDOSO: 'alerta_diagnostico_dudoso',
  SIN_SEGUIMIENTO_REPRODUCTIVO: 'alerta_sin_seguimiento',
});

function parametrosBase(hoy, config = CONFIGURACION_ALERTAS_REPRODUCCION) {
  return [
    hoy,
    config.diasDiagnosticoPendiente,
    config.diasPartoProximo,
    config.edadMinimaSinSeguimientoMeses,
    GESTACION_REFERENCIA_DIAS,
    EDAD_EMBRION_TRANSFERENCIA_DIAS,
  ];
}

function escapeLikePrefix(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** WHERE de `hembras` + parámetros (a partir de $7). */
function filtroHembras({ situacion = 'EN_HATO', registro = 'ACTIVO', predioId = null, q = null }, params) {
  const condiciones = [];
  if (registro !== 'TODOS') {
    params.push(registro);
    condiciones.push(`a.estado = $${params.length}`);
  }
  if (situacion !== 'TODOS') {
    params.push(situacion);
    condiciones.push(`a.estado_operativo = $${params.length}`);
  }
  if (predioId) {
    params.push(predioId);
    condiciones.push(`a.predio_id = $${params.length}`);
  }
  if (q) {
    params.push(`${escapeLikePrefix(q.toLowerCase())}%`);
    condiciones.push(`(lower(a.numero_visual) like $${params.length} escape '\\' or lower(a.nombre) like $${params.length} escape '\\')`);
  }
  return condiciones.join(' and ');
}

const iso = (columna) => `to_char(${columna}, 'YYYY-MM-DD')`;

const FILA_SELECT = `
  select t.animal_id::text as animal_id, t.numero_visual, t.nombre, t.predio_id::text as predio_id, t.nombre_predio,
         t.estado, t.estado_operativo, t.estado_reproductivo,
         t.ue_tipo, ${iso('t.ue_fecha')} as ue_fecha,
         t.us_tipo, ${iso('t.us_fecha')} as us_fecha,
         t.ud_resultado, ${iso('t.ud_fecha')} as ud_fecha, t.ud_dias,
         ${iso('t.up_fecha')} as up_fecha, t.up_crias,
         t.gestacion_base, ${iso('t.concepcion')} as concepcion, ${iso('t.fecha_probable_parto')} as fecha_probable_parto,
         case when t.concepcion is null then null else $1::date - t.concepcion end as dias_gestacion_estimados,
         case when t.us_fecha is null then null else $1::date - t.us_fecha end as dias_desde_servicio,
         case when t.fecha_probable_parto is null then null else t.fecha_probable_parto - $1::date end as dias_para_parto,
         t.alerta_diagnostico_pendiente, t.alerta_parto_proximo, t.alerta_diagnostico_dudoso, t.alerta_sin_seguimiento
    from tablero t`;

/** Fila SQL -> fila pública del listado (sin columnas internas). */
export function serializeFilaTablero(row) {
  const alertas = [];
  if (row.alerta_parto_proximo) {
    alertas.push({ codigo: 'PARTO_PROXIMO', nivel: ALERTAS_REPRODUCCION.PARTO_PROXIMO, fecha: row.fecha_probable_parto, dias: row.dias_para_parto });
  }
  if (row.alerta_diagnostico_dudoso) {
    alertas.push({ codigo: 'DIAGNOSTICO_DUDOSO', nivel: ALERTAS_REPRODUCCION.DIAGNOSTICO_DUDOSO, fecha: row.ud_fecha, dias: null });
  }
  if (row.alerta_diagnostico_pendiente) {
    alertas.push({ codigo: 'DIAGNOSTICO_PENDIENTE', nivel: ALERTAS_REPRODUCCION.DIAGNOSTICO_PENDIENTE, fecha: row.us_fecha, dias: row.dias_desde_servicio });
  }
  if (row.alerta_sin_seguimiento) {
    alertas.push({ codigo: 'SIN_SEGUIMIENTO_REPRODUCTIVO', nivel: ALERTAS_REPRODUCCION.SIN_SEGUIMIENTO_REPRODUCTIVO, fecha: null, dias: null });
  }
  return {
    animalId: row.animal_id,
    numeroVisual: row.numero_visual ?? null,
    nombre: row.nombre ?? null,
    predioId: row.predio_id,
    predioNombre: row.nombre_predio,
    estadoReproductivo: row.estado_reproductivo,
    estadoOperativo: row.estado_operativo,
    estadoRegistro: row.estado,
    ultimoEvento: row.ue_tipo ? { tipoEvento: row.ue_tipo, fechaEvento: row.ue_fecha } : null,
    ultimoServicio: row.us_tipo ? { tipoEvento: row.us_tipo, fechaEvento: row.us_fecha } : null,
    ultimoDiagnostico: row.ud_resultado ? { resultado: row.ud_resultado, fechaEvento: row.ud_fecha, diasGestacion: row.ud_dias ?? null } : null,
    ultimoParto: row.up_fecha ? { fechaEvento: row.up_fecha, numeroCrias: row.up_crias ?? null } : null,
    gestacion: row.concepcion
      ? { base: row.gestacion_base, fechaConcepcionEstimada: row.concepcion, diasEstimados: row.dias_gestacion_estimados, fechaProbableParto: row.fecha_probable_parto }
      : null,
    alertas,
  };
}

/** GET .../reproduccion/animales -- listado filtrado y paginado. */
export async function listarTableroReproductivo(organizacionId, filtros, { hoy, config } = {}) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const params = parametrosBase(hoy, config);
    const cte = tableroCte(filtroHembras(filtros, params));
    const condiciones = [];
    if (filtros.estadoReproductivo) {
      params.push(filtros.estadoReproductivo);
      condiciones.push(`t.estado_reproductivo = $${params.length}`);
    }
    if (filtros.alerta) condiciones.push(`t.${COLUMNA_ALERTA[filtros.alerta]}`);
    const where = condiciones.length ? ` where ${condiciones.join(' and ')}` : '';

    const total = await client.query(`${cte} select count(*)::int as total from tablero t${where}`, params);
    const filas = await client.query(
      `${cte} ${FILA_SELECT}${where}
        order by lower(coalesce(t.numero_visual, t.nombre, '')), t.animal_id
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, filtros.limit, filtros.offset],
    );
    return { total: total.rows[0].total, animales: filas.rows.map(serializeFilaTablero) };
  });
}

/**
 * GET .../reproduccion/resumen -- KPIs del hato actual (ACTIVO + EN_HATO),
 * con la MISMA CTE del listado: cada contador coincide con el total del
 * listado con el filtro equivalente.
 */
export async function resumenTableroReproductivo(organizacionId, { predioId = null } = {}, { hoy, config } = {}) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const params = parametrosBase(hoy, config);
    const cte = tableroCte(filtroHembras({ situacion: 'EN_HATO', registro: 'ACTIVO', predioId }, params));
    const porEstado = ESTADOS_TABLERO.map((e) => `count(*) filter (where t.estado_reproductivo = '${e}')::int as "${e}"`).join(',\n');
    const porAlerta = Object.entries(COLUMNA_ALERTA).map(([codigo, col]) => `count(*) filter (where t.${col})::int as "${codigo}"`).join(',\n');
    const { rows } = await client.query(`${cte} select count(*)::int as hembras, ${porEstado}, ${porAlerta} from tablero t`, params);
    const row = rows[0] ?? {};
    return {
      hembrasEnSeguimiento: row.hembras ?? 0,
      porEstado: Object.fromEntries(ESTADOS_TABLERO.map((e) => [e, row[e] ?? 0])),
      porAlerta: Object.fromEntries(Object.keys(COLUMNA_ALERTA).map((c) => [c, row[c] ?? 0])),
    };
  });
}
