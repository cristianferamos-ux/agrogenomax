// SPRINT-3D7.1-AGROCLIMA: orquestador -- combina ERA5-Land (primaria) e
// IDEAM (complementaria), aísla fallos entre proveedores (§15 del sprint
// original), y produce el snapshot normalizado listo para persistir.
//
// POLÍTICA DE FUSIÓN (decisión explícita de este sprint):
//   - ERA5-Land (core: temperatura/RH/suelo) es SIEMPRE la fuente
//     autoritativa de humedad_suelo_superficial/subsuperficial cuando
//     está disponible -- IDEAM mide humedad de suelo en % a 30/50cm, una
//     magnitud física distinta de la volumétrica m³/m³ (0-7cm/7-28cm) --
//     nunca se mezclan sin una conversión válida.
//   - precipitación/radiación/viento: provienen del secundario ERA5
//     (0.25°, modelo explícito, ver era5LandProvider.js) cuando ERA5-Land
//     respondió; si el secundario específicamente falló pero el núcleo
//     ERA5-Land sí respondió, se intenta IDEAM SOLO para
//     precipitación/viento (unidad compatible) -- radiación no tiene
//     equivalente IDEAM en el mapeo de sensores usado aquí.
//   - temperatura/humedad relativa/viento: ERA5-Land primero; si
//     ERA5-Land falla por completo, se usa IDEAM (misma unidad física)
//     SOLO para esos campos -- nunca sobrescribe un valor ya presente.
//   - Si ambos proveedores fallan: UNAVAILABLE, nunca datos inventados.
import { fetchEra5LandObservation } from './era5LandProvider.js';
import { selectIdeamStation, IdeamProviderError } from './ideamProvider.js';
import { AGRO_CLIMATE_STATUS } from './agroClimateObservation.js';

async function safeCall(fn) {
  try {
    const value = await fn();
    return { ok: true, value, error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

function describeError(error) {
  return {
    code: error?.code || 'UNKNOWN_ERROR',
    message: error?.message || 'Error desconocido.',
  };
}

// Campos con unidad compatible entre ERA5(-Land) e IDEAM -- únicos
// candidatos a fallback.
const FALLBACK_ELIGIBLE_FIELDS = [
  'precipitacion24hMm', 'precipitacion7dMm', 'precipitacion15dMm', 'precipitacion30dMm',
  'temperaturaMediaC', 'temperaturaMinC', 'temperaturaMaxC',
  'humedadRelativaMediaPct', 'vientoMedioMs',
];

/**
 * Refresca el contexto agroclimático de un punto (lat/lng ya resuelto
 * server-side por el repositorio -- este módulo nunca recibe ni confía
 * en coordenadas del cliente).
 */
export async function refreshAgroClimateContext({
  lat,
  lng,
  now = new Date(),
  fetchImpl = fetch,
  era5Options = {},
  ideamOptions = {},
} = {}) {
  const era5Result = await safeCall(() => fetchEra5LandObservation({ lat, lng, now, fetchImpl, ...era5Options }));
  const ideamSelection = await safeCall(() => selectIdeamStation({ lat, lng, now, fetchImpl, ...ideamOptions }));

  const era5 = era5Result.ok ? era5Result.value : null;
  const ideamOutcome = ideamSelection.ok ? ideamSelection.value : null;
  const ideam = ideamOutcome?.outcome === 'STATION_FOUND' ? ideamOutcome.observation : null;

  const snapshot = {
    sourceObservedUntil: era5?.observedUntil ?? null,
    fuentePrincipal: era5 ? 'ERA5_LAND' : (ideam ? 'IDEAM' : null),
    calidad: era5 ? era5.quality : (ideam ? ideam.quality : null),
  };

  for (const field of FALLBACK_ELIGIBLE_FIELDS) {
    snapshot[field] = era5?.[field] ?? ideam?.[field] ?? null;
  }
  // Exclusivos de ERA5-Land (core) -- ver política de fusión de cabecera.
  snapshot.humedadSueloSuperficial = era5?.humedadSueloSuperficial ?? null;
  snapshot.humedadSueloSubsuperficial = era5?.humedadSueloSubsuperficial ?? null;
  snapshot.radiacionSolar = era5?.radiacionSolar ?? null;

  const fuentesJson = [];
  if (era5) {
    fuentesJson.push({
      dataset: 'ERA5_LAND',
      provider: era5.metadata.provider,
      status: 'OK',
      model: era5.metadata.model,
      coreObservedUntil: era5.metadata.coreObservedUntil,
      coreGridLat: era5.metadata.coreGridLat,
      coreGridLng: era5.metadata.coreGridLng,
      coreResolutionDeg: era5.metadata.coreResolutionDeg,
      secondaryModel: era5.metadata.secondaryModel,
      secondaryDataset: era5.metadata.secondaryDataset,
      secondaryGridLat: era5.metadata.secondaryGridLat,
      secondaryGridLng: era5.metadata.secondaryGridLng,
      secondaryResolutionDeg: era5.metadata.secondaryResolutionDeg,
      secondaryObservedUntil: era5.metadata.secondaryObservedUntil,
      secondaryError: era5.metadata.secondaryError,
      variableProvenance: era5.metadata.variableProvenance,
    });
  } else {
    fuentesJson.push({ dataset: 'ERA5_LAND', provider: 'OPEN_METEO', status: 'FAILED', error: describeError(era5Result.error) });
  }

  if (ideamOutcome?.outcome === 'STATION_FOUND') {
    fuentesJson.push({
      dataset: 'IDEAM',
      provider: ideam.metadata.provider,
      catalogDataset: ideam.metadata.catalogDataset,
      observationDataset: ideam.metadata.observationDataset,
      status: 'OK',
      stationCode: ideam.metadata.stationCode,
      stationName: ideam.metadata.stationName,
      categoria: ideam.metadata.categoria,
      tecnologia: ideam.metadata.tecnologia,
      estado: ideam.metadata.estado,
      distanceKm: ideam.metadata.distanceKm,
      observedUntil: ideam.observedUntil,
      variablesAvailable: ideam.metadata.variablesAvailable,
    });
  } else if (ideamOutcome?.outcome === 'NO_STATION_NEARBY') {
    fuentesJson.push({
      dataset: 'IDEAM', provider: 'IDEAM_DATOS_ABIERTOS', status: 'NO_STATION_NEARBY',
      candidatesFound: 0,
    });
  } else if (ideamOutcome?.outcome === 'STATION_FOUND_NO_RECENT_OBSERVATIONS') {
    fuentesJson.push({
      dataset: 'IDEAM', provider: 'IDEAM_DATOS_ABIERTOS', status: 'STATION_FOUND_NO_RECENT_OBSERVATIONS',
      candidatesFound: ideamOutcome.candidatesFound,
      candidatesProbed: ideamOutcome.candidatesProbed,
    });
  } else {
    fuentesJson.push({
      dataset: 'IDEAM', provider: 'IDEAM_DATOS_ABIERTOS', status: 'FAILED',
      error: describeError(ideamSelection.error || new IdeamProviderError('Fallo desconocido de IDEAM.')),
    });
  }

  // COMPLETE solo con ERA5-Land (core) realmente disponible -- es la
  // única fuente que cubre la identidad completa del snapshot. PARTIAL
  // cuando hay algún dato usable (IDEAM cubrió campos compatibles pese a
  // que ERA5-Land falló, o ERA5-Land respondió pero su secundario
  // falló). UNAVAILABLE cuando ningún proveedor entregó nada usable.
  const hasAnyUsableField = FALLBACK_ELIGIBLE_FIELDS.some((field) => snapshot[field] !== null)
    || snapshot.humedadSueloSuperficial !== null;

  let status;
  if (era5) {
    status = AGRO_CLIMATE_STATUS.COMPLETE;
  } else if (hasAnyUsableField) {
    status = AGRO_CLIMATE_STATUS.PARTIAL;
  } else {
    status = AGRO_CLIMATE_STATUS.UNAVAILABLE;
  }

  return { status, snapshot, fuentesJson };
}
