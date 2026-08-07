// Defecto corregido: en el PLANO GEOMÉTRICO INFORMATIVO (páginas de plano
// vectorial del PDF, sin teselas satelitales), predios urbanos pequeños se
// dibujaban innecesariamente chicos -- catastroxPdfGenerator.js reutilizaba
// computeMapState (zoom ENTERO + tope 18, restricción exclusiva de teselas
// Web Mercator, irrelevante para dibujo vectorial puro) también para esta
// página. computeVectorPlanFitState (catastroxPdfGeometry.js) reemplaza esa
// llamada solo para el plano: detecta si la geometría ocupaba menos del
// 45% del recuadro bajo la restricción heredada y, solo en ese caso,
// recalcula con padding reducido para que el polígono ocupe ~60%-75% del
// recuadro útil -- predios medianos/grandes quedan exactamente igual que
// antes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMapState, computeVectorPlanFitState, projectRingToViewport } from '../catastroxPdfGeometry.js';

// Mismas dimensiones reales del recuadro del plano en catastroxPdfGenerator.js
// (TECHNICAL_MAP_AREA insetado en 16pt por lado: 744-32=712, 450-32=418).
const PLANO_MAP_WIDTH = 712;
const PLANO_MAP_HEIGHT = 418;

function buildRectRing(centerLng, centerLat, widthMeters, heightMeters) {
  const degPerMeterLat = 1 / 111320;
  const degPerMeterLng = 1 / (111320 * Math.cos((centerLat * Math.PI) / 180));
  const halfW = (widthMeters / 2) * degPerMeterLng;
  const halfH = (heightMeters / 2) * degPerMeterLat;
  return [
    [centerLng - halfW, centerLat - halfH],
    [centerLng + halfW, centerLat - halfH],
    [centerLng + halfW, centerLat + halfH],
    [centerLng - halfW, centerLat + halfH],
    [centerLng - halfW, centerLat - halfH],
  ];
}

// Lote urbano pequeño típico (15m x 10m) -- exactamente el caso reportado
// ("predios urbanos pequeños").
const SMALL_URBAN_RING = buildRectRing(-75.9, 1.1, 15, 10);
// Predio rural grande (2000m x 1500m) -- caso "mediano/grande" que NO debe
// verse afectado (Requisito 7).
const LARGE_RURAL_RING = buildRectRing(-75.9, 1.1, 2000, 1500);

test('Requisito 1/2: geometría pequeña -- ocupaba menos del 45% del recuadro bajo la restricción heredada (computeMapState), se detecta correctamente como pequeña', () => {
  const result = computeVectorPlanFitState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  assert.equal(result.isSmallGeometry, true);
  assert.ok(result.occupancyRatio < 0.45, `occupancyRatio (${result.occupancyRatio}) debía ser < 0.45`);
  assert.ok(result.occupancyRatio > 0, 'occupancyRatio debe ser positivo, nunca cero ni negativo');
});

test('Requisito 8: para geometrías pequeñas, la escala nueva es estrictamente mayor que la anterior (computeMapState) -- el polígono se renderiza más grande que antes', () => {
  const legacyState = computeMapState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT, 20);
  const newState = computeVectorPlanFitState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  assert.ok(
    newState.scale > legacyState.scale,
    `la escala nueva (${newState.scale}) debe ser mayor que la anterior (${legacyState.scale})`,
  );
});

test('Requisito 8: el polígono más grande sigue cabiendo correctamente dentro del marco (sin desbordar)', () => {
  const newState = computeVectorPlanFitState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  const projected = projectRingToViewport(SMALL_URBAN_RING, newState, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  assert.ok(Math.min(...xs) >= 0, 'ningún vértice debe quedar a la izquierda del recuadro (x < 0)');
  assert.ok(Math.max(...xs) <= PLANO_MAP_WIDTH, 'ningún vértice debe salir por la derecha del recuadro');
  assert.ok(Math.min(...ys) >= 0, 'ningún vértice debe quedar por encima del recuadro (y < 0)');
  assert.ok(Math.max(...ys) <= PLANO_MAP_HEIGHT, 'ningún vértice debe salir por debajo del recuadro');
});

test('Requisito 3: el polígono final ocupa aproximadamente entre 60% y 75% del recuadro ÚTIL (ya descontado el padding reducido) en su eje más restrictivo', () => {
  const newState = computeVectorPlanFitState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  assert.ok(newState.isSmallGeometry);
  const projected = projectRingToViewport(SMALL_URBAN_RING, newState, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const spanXpx = Math.max(...xs) - Math.min(...xs);
  const spanYpx = Math.max(...ys) - Math.min(...ys);
  // Requisito 4: padding reducido a 6%-10% -- recuadro útil = viewport
  // menos ese padding en cada eje.
  const paddingRatio = 0.08;
  const usableWidth = PLANO_MAP_WIDTH * (1 - 2 * paddingRatio);
  const usableHeight = PLANO_MAP_HEIGHT * (1 - 2 * paddingRatio);
  const occupancyVsUsableFrame = Math.max(spanXpx / usableWidth, spanYpx / usableHeight);
  assert.ok(
    occupancyVsUsableFrame >= 0.55 && occupancyVsUsableFrame <= 0.8,
    `ocupación respecto al recuadro útil (${(occupancyVsUsableFrame * 100).toFixed(1)}%) debía quedar cerca del rango pedido 60%-75%`,
  );
});

test('Requisito 4: predio pequeño usa un padding efectivo distinto (reducido) al 20pt absoluto que seguían usando los medianos/grandes', () => {
  const smallState = computeVectorPlanFitState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  const largeState = computeVectorPlanFitState(LARGE_RURAL_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  // El padding de 20pt absoluto equivale a ~5.6%/9.6% del recuadro en cada
  // eje (20/712, 20/418) -- el padding pedido para predios pequeños
  // (6%-10%, aquí 8%) es un valor RATIO explícito y distinto de ese
  // esquema absoluto heredado. Se confirma indirectamente: un predio
  // pequeño (isSmallGeometry=true) usa la rama de padding-ratio nueva,
  // mientras uno mediano/grande (isSmallGeometry=false) sigue devolviendo
  // el resultado íntegro de computeMapState con su padding absoluto de
  // siempre.
  assert.equal(smallState.isSmallGeometry, true);
  assert.equal(largeState.isSmallGeometry, false);
});

test('Requisito 7: geometría mediana/grande -- computeVectorPlanFitState devuelve EXACTAMENTE el mismo resultado que computeMapState (sin cambios de tamaño)', () => {
  const legacyState = computeMapState(LARGE_RURAL_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT, 20);
  const newState = computeVectorPlanFitState(LARGE_RURAL_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  assert.equal(newState.isSmallGeometry, false);
  assert.equal(newState.scale, legacyState.scale, 'la escala debe ser idéntica, no solo similar');
  assert.equal(newState.centerLng, legacyState.centerLng);
  assert.equal(newState.centerLat, legacyState.centerLat);
  assert.equal(newState.centerWorldX, legacyState.centerWorldX);
  assert.equal(newState.centerWorldY, legacyState.centerWorldY);
});

test('Requisito 5: el mapState devuelto conserva la forma esperada por computeDynamicScaleMeters/computeMetersPerPixel (scale + centerLat) -- la escala gráfica se recalcula automáticamente sin cambios adicionales', () => {
  const smallState = computeVectorPlanFitState(SMALL_URBAN_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  const largeState = computeVectorPlanFitState(LARGE_RURAL_RING, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT);
  [smallState, largeState].forEach((state) => {
    assert.equal(typeof state.scale, 'number');
    assert.equal(typeof state.centerLat, 'number');
    assert.ok(Number.isFinite(state.scale) && state.scale > 0);
  });
});

test('geometrías degeneradas (un solo punto repetido) nunca lanzan -- fallback seguro', () => {
  const degenerateRing = [
    [-75.9, 1.1],
    [-75.9, 1.1],
    [-75.9, 1.1],
  ];
  assert.doesNotThrow(() => computeVectorPlanFitState(degenerateRing, PLANO_MAP_WIDTH, PLANO_MAP_HEIGHT));
});
