import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

function parseCoordinate(value, label) {
  if (value === undefined || value === null || value === '') {
    throw Object.assign(new Error(`La coordenada ${label} es obligatoria.`), { status: 400 });
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error(`La coordenada ${label} debe ser numérica.`), { status: 400 });
  }

  return parsed;
}

function toNullableString(value) {
  return value === null || value === undefined || value === '' ? null : String(value).trim();
}

function buildQueryPoint(lat, lng) {
  return {
    lat: Number(lat),
    lng: Number(lng),
  };
}

function normalizeMunicipioRow(row) {
  if (!row) return null;

  return {
    codigoMunicipio: toNullableString(row.mpcodigo),
    municipio: toNullableString(row.mpnombre),
    departamento: toNullableString(row.depto),
    gestorCatastral: toNullableString(row.gestor),
  };
}

async function findMunicipioByPoint(lng, lat) {
  const directMatch = await query(
    `with point as (
       select ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
     )
     select
       mpcodigo,
       mpnombre,
       depto,
       gestor
     from gis.municipios_colombia, point
     where ST_Covers(gis.municipios_colombia.geom, point.geom)
        or ST_Intersects(gis.municipios_colombia.geom, point.geom)
     limit 1`,
    [lng, lat],
  );

  if (directMatch.rows[0]) {
    return normalizeMunicipioRow(directMatch.rows[0]);
  }

  const nearestMatch = await query(
    `with point as (
       select ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
     )
     select
       mpcodigo,
       mpnombre,
       depto,
       gestor
     from gis.municipios_colombia, point
     order by gis.municipios_colombia.geom <-> point.geom
     limit 1`,
    [lng, lat],
  );

  return normalizeMunicipioRow(nearestMatch.rows[0]);
}

router.post('/lookup', async (req, res, next) => {
  try {
    const lat = parseCoordinate(req.body?.lat, 'lat');
    const lng = parseCoordinate(req.body?.lng, 'lng');

    const predioResult = await query(
      `with punto as (
         select ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
       ),
       predio as (
         select
           c.id,
           c.codigo,
           c.codigo_anterior,
           c.codigo_municipio,
           c.codigo_departamento,
           c.shape_area,
           c.shape_length,
           ST_AsGeoJSON(c.geom)::json as geometry
         from gis.catastro_caqueta c, punto p
         where ST_Contains(c.geom, p.geom)
         limit 1
       ),
       municipio as (
         select
           m.mpcodigo,
           m.mpnombre,
           m.depto,
           m.gestor
         from gis.municipios_colombia m, punto p
         where ST_Covers(m.geom, p.geom)
            or ST_Intersects(m.geom, p.geom)
         limit 1
       )
       select
         p.*,
         m.mpcodigo,
         m.mpnombre,
         m.depto,
         m.gestor
       from predio p
       left join municipio m on true`,
      [lng, lat],
    );

    if (predioResult.rows[0]) {
      const row = predioResult.rows[0];
      const areaM2 = Number(row.shape_area);
      const perimetroM = Number(row.shape_length);

      res.json({
        found: true,
        status: 'FOUND',
        queryPoint: buildQueryPoint(lat, lng),
        predio: {
          id: row.id,
          codigo: toNullableString(row.codigo),
          codigoAnterior: toNullableString(row.codigo_anterior),
          codigoMunicipio: toNullableString(row.codigo_municipio),
          codigoDepartamento: toNullableString(row.codigo_departamento),
          municipio: toNullableString(row.mpnombre),
          departamento: toNullableString(row.depto),
          gestor: toNullableString(row.gestor),
          areaM2,
          areaHa: Number.isFinite(areaM2) ? Number((areaM2 / 10000).toFixed(2)) : null,
          perimetroM: Number.isFinite(perimetroM) ? perimetroM : null,
          geometry: row.geometry,
        },
      });
      return;
    }

    const municipio = await findMunicipioByPoint(lng, lat);

    if (municipio) {
      res.status(404).json({
        found: false,
        status: 'SIN_COBERTURA_CATASTRAL',
        queryPoint: buildQueryPoint(lat, lng),
        municipio: municipio.municipio,
        departamento: municipio.departamento,
        gestor: municipio.gestorCatastral,
        message:
          'No se encontró información predial individualizada para esta ubicación en la cobertura catastral cargada actualmente.',
        coverage: {
          codigoMunicipio: municipio.codigoMunicipio,
          municipio: municipio.municipio,
          departamento: municipio.departamento,
          gestorCatastral: municipio.gestorCatastral,
          estadoCobertura: 'GESTOR_DIFERENTE',
        },
      });
      return;
    }

    res.status(404).json({
      found: false,
      status: 'PENDIENTE_VALIDACION',
      queryPoint: buildQueryPoint(lat, lng),
      municipio: null,
      departamento: null,
      message:
        'No fue posible identificar el municipio para esta ubicación con la información geográfica cargada actualmente.',
      coverage: {
        codigoMunicipio: null,
        municipio: null,
        departamento: null,
        gestorCatastral: null,
        estadoCobertura: 'PENDIENTE_VALIDACION',
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
