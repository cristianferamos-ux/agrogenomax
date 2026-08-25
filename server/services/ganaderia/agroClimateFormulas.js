// SPRINT-3D7.1-AGROCLIMA: fórmulas puras del motor agroclimático
// territorial. Sin dependencias de red/DB -- solo aritmética meteorológica
// documentada, testeable sin fixtures de integración (§20/§21/§26 del
// sprint: "no usar aproximación inventada", "test exacto").

/**
 * Humedad relativa (%) derivada de temperatura del aire y punto de rocío
 * a 2m, vía fórmula de Magnus-Tetens (aproximación estándar meteorológica,
 * coeficientes Alduchov & Eskridge 1996: a=17.625, b=243.04°C -- la misma
 * variante que usa ECMWF/Copernicus para productos derivados de ERA5).
 *
 * RH = 100 * exp(a*Td/(b+Td)) / exp(a*T/(b+T))
 *
 * Ambas temperaturas en °C. Resultado acotado a [0, 100] -- un dew point
 * levemente superior a la temperatura (ruido de redondeo de la fuente,
 * dew point <= temperatura en la práctica física) nunca debe producir un
 * valor > 100% ni < 0% (§20 del sprint).
 */
const MAGNUS_A = 17.625;
const MAGNUS_B = 243.04;

export function computeRelativeHumidityFromDewPoint(temperatureC, dewPointC) {
  if (!Number.isFinite(temperatureC) || !Number.isFinite(dewPointC)) return null;

  const numerator = Math.exp((MAGNUS_A * dewPointC) / (MAGNUS_B + dewPointC));
  const denominator = Math.exp((MAGNUS_A * temperatureC) / (MAGNUS_B + temperatureC));
  const relativeHumidity = 100 * (numerator / denominator);

  return Math.min(100, Math.max(0, relativeHumidity));
}

/**
 * Velocidad del viento (misma unidad que u/v, m/s en ERA5) a partir de sus
 * componentes u (este-oeste) y v (norte-sur): magnitud del vector.
 * §21 del sprint -- test exacto: sqrt(3^2+4^2) = 5.
 */
export function computeWindSpeedFromComponents(u, v) {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return Math.sqrt((u * u) + (v * v));
}
