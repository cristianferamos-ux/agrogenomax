// CATX-PDF-PARITY-002 (tercera vuelta): pruebas directas y deterministas
// (sin PDFKit, sin red, sin Postgres) del motor de colocación de vértices y
// distancias portado en catastroxPdfDimensions.js. Verifican el requisito
// explícito del usuario: "colocación de etiquetas con evasión de
// colisiones" -- probado con cuadrilátero simple, polígono cóncavo,
// polígono con lados cortos y polígono irregular con muchos vértices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rectsOverlap,
  pointInPolygon,
  buildVisiblePointPlacements,
  buildTechnicalSegmentDimensionPlacements,
  getCompassRoseRect,
  getScaleBarRect,
  chooseScaleBarAnchor,
} from '../catastroxPdfDimensions.js';

// Medidor determinista sin PDFKit/canvas: ancho proporcional al número de
// caracteres (suficiente para probar geometría/colisiones -- no se necesita
// la métrica exacta de Helvetica, solo un ancho consistente).
function measureTextWidth(text, fontSize) {
  return String(text).length * fontSize * 0.55;
}
const formatDistanceLabel = (meters) => `${meters.toFixed(2)} m`;

function segmentsFromPoints(points) {
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return { from: `P${index + 1}`, to: `P${((index + 1) % points.length) + 1}`, distance: Math.hypot(next[0] - point[0], next[1] - point[1]) };
  });
}

function allPlacementRectsDisjoint(placements) {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (rectsOverlap(placements[i].rect, placements[j].rect, 0)) return false;
    }
  }
  return true;
}

const MAP_RECT = { x: 40, y: 40, width: 500, height: 400 };

test('rectsOverlap/pointInPolygon: casos base', () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), true);
  assert.equal(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 }), false);
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon([5, 5], square), true);
  assert.equal(pointInPolygon([50, 50], square), false);
});

test('CATX-PDF-PARITY-002: (a) cuadrilátero simple -- etiquetas y vértices sin colisión entre sí', () => {
  const points = [[100, 100], [400, 100], [400, 350], [100, 350]];
  const segments = segmentsFromPoints(points);
  const pointPlacements = buildVisiblePointPlacements(points, MAP_RECT, points, []);
  assert.equal(pointPlacements.filter((p) => p.hidden).length, 0, 'ningún vértice debería quedar oculto en un cuadrilátero simple');

  const compassRect = getCompassRoseRect(MAP_RECT.x + 60, MAP_RECT.y + 60);
  const scaleRect = getScaleBarRect(MAP_RECT.x + 20, MAP_RECT.y + MAP_RECT.height - 20, true);
  const { placements, omittedCount } = buildTechnicalSegmentDimensionPlacements({
    measureTextWidth,
    formatDistanceLabel,
    projectedRefs: points,
    referenceSegments: segments,
    polygonPoints: points,
    pointPlacements,
    mapRect: MAP_RECT,
    reservedRects: [compassRect, scaleRect],
  });

  assert.equal(omittedCount, 0, 'un cuadrilátero simple no debería omitir ninguna etiqueta de distancia');
  assert.equal(placements.length, 4);
  assert.ok(allPlacementRectsDisjoint(placements), 'las etiquetas de distancia no deben solaparse entre sí');
  placements.forEach((placement) => {
    const blocksVertex = pointPlacements.some((pp) => !pp.hidden && rectsOverlap(placement.rect, pp.rect, 0));
    assert.equal(blocksVertex, false, 'una etiqueta de distancia no debe solaparse con un círculo de vértice');
    const blocksCompass = rectsOverlap(placement.rect, compassRect, 0);
    const blocksScale = rectsOverlap(placement.rect, scaleRect, 0);
    assert.equal(blocksCompass, false, 'una etiqueta de distancia no debe solaparse con la rosa de los vientos');
    assert.equal(blocksScale, false, 'una etiqueta de distancia no debe solaparse con la escala gráfica');
  });
});

test('CATX-PDF-PARITY-002: (b) polígono cóncavo (forma de "L") -- coloca etiquetas sin solapar, exterior correcto vía pointInPolygon', () => {
  // "L" cóncava: el vértice interior (300,300) tiene ángulo reflejo -- el
  // motor debe decidir "exterior" con pointInPolygon (no con un signo de
  // producto punto respecto a un centroide, que falla en polígonos
  // cóncavos) para no colocar la etiqueta dentro del propio polígono.
  const points = [
    [100, 100], [400, 100], [400, 300], [300, 300], [300, 400], [100, 400],
  ];
  const segments = segmentsFromPoints(points);
  const pointPlacements = buildVisiblePointPlacements(points, MAP_RECT, points, []);
  const { placements, omittedCount } = buildTechnicalSegmentDimensionPlacements({
    measureTextWidth,
    formatDistanceLabel,
    projectedRefs: points,
    referenceSegments: segments,
    polygonPoints: points,
    pointPlacements,
    mapRect: MAP_RECT,
    reservedRects: [],
  });

  assert.ok(placements.length >= 4, `se esperaban al menos 4 de 6 etiquetas colocadas en la L cóncava, hubo ${placements.length} (omitidas: ${omittedCount})`);
  assert.ok(allPlacementRectsDisjoint(placements), 'las etiquetas del polígono cóncavo no deben solaparse entre sí');
  placements.forEach((placement) => {
    assert.equal(pointInPolygon([placement.centerX, placement.centerY], points), false, 'cada etiqueta debe quedar fuera del polígono (lado exterior del tramo)');
  });
});

test('CATX-PDF-PARITY-002: (c) polígono con lados muy cortos -- nunca lanza, nunca fuerza una etiqueta superpuesta', () => {
  // Dos vértices casi coincidentes (tramo de 4px, bajo el umbral de 10px
  // que usa buildTechnicalSegmentDimensionPlacements) mezclados con tramos
  // normales -- el tramo corto debe omitirse limpiamente, el resto debe
  // seguir colocándose sin colisión.
  const points = [[100, 100], [400, 100], [404, 104], [400, 350], [100, 350]];
  const segments = segmentsFromPoints(points);
  const pointPlacements = buildVisiblePointPlacements(points, MAP_RECT, points, []);

  assert.doesNotThrow(() => {
    const { placements, omittedCount } = buildTechnicalSegmentDimensionPlacements({
      measureTextWidth,
      formatDistanceLabel,
      projectedRefs: points,
      referenceSegments: segments,
      polygonPoints: points,
      pointPlacements,
      mapRect: MAP_RECT,
      reservedRects: [],
    });
    assert.ok(omittedCount >= 1, 'el tramo de 4px (bajo el umbral de 10px) debía omitirse, no forzarse');
    assert.ok(allPlacementRectsDisjoint(placements), 'las etiquetas restantes no deben solaparse entre sí pese al tramo corto');
  });
});

test('CATX-PDF-PARITY-002: (d) polígono irregular con muchos vértices -- todas las etiquetas colocadas están libres de colisión', () => {
  // Estrella de 12 puntas (12 vértices, tramos cortos y ángulos muy
  // variados) -- caso de estrés para la grilla de candidatos.
  const points = [];
  const centerX = 300;
  const centerY = 250;
  for (let i = 0; i < 12; i += 1) {
    const angle = (Math.PI / 6) * i;
    const radius = i % 2 === 0 ? 180 : 90;
    points.push([centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius]);
  }
  const segments = segmentsFromPoints(points);
  const pointPlacements = buildVisiblePointPlacements(points, MAP_RECT, points, []);
  const { placements } = buildTechnicalSegmentDimensionPlacements({
    measureTextWidth,
    formatDistanceLabel,
    projectedRefs: points,
    referenceSegments: segments,
    polygonPoints: points,
    pointPlacements,
    mapRect: MAP_RECT,
    reservedRects: [],
  });

  assert.ok(allPlacementRectsDisjoint(placements), 'en un polígono irregular de 12 vértices, ninguna etiqueta colocada debe solaparse con otra');
  placements.forEach((placement) => {
    const blocksVertex = pointPlacements.some((pp) => !pp.hidden && rectsOverlap(placement.rect, pp.rect, 0));
    assert.equal(blocksVertex, false, 'ninguna etiqueta colocada debe solaparse con un círculo de vértice, incluso con 12 vértices densos');
  });
});

// --- Cuarta vuelta: chooseScaleBarAnchor (puerto completo, sin esquina fija) ---

test('chooseScaleBarAnchor: sin colisiones, elige el primer candidato (esquina inferior izquierda) por desempate de orden', () => {
  const anchor = chooseScaleBarAnchor(MAP_RECT, [], [], [], true);
  assert.deepEqual(anchor, { x: MAP_RECT.x + 18, y: MAP_RECT.y + MAP_RECT.height - 24 });
});

test('CATX-PDF-PARITY-002: chooseScaleBarAnchor reubica dinámicamente la escala cuando la posición inicial (esquina inferior izquierda) choca con una etiqueta ya colocada', () => {
  const defaultCandidate = { x: MAP_RECT.x + 18, y: MAP_RECT.y + MAP_RECT.height - 24 };
  const defaultRect = getScaleBarRect(defaultCandidate.x, defaultCandidate.y, true);
  // Un "placement" ficticio que ocupa exactamente el rect de la posición
  // por defecto -- fuerza rectsOverlap(rect, placement.rect, 10) en el
  // candidato 0, nunca en los otros 3 (están en otras esquinas del mapa).
  const blockingPlacement = { rect: { x: defaultRect.x, y: defaultRect.y, width: defaultRect.width, height: defaultRect.height } };

  const anchor = chooseScaleBarAnchor(MAP_RECT, [], [], [blockingPlacement], true);

  assert.notDeepEqual(anchor, defaultCandidate, 'la escala debe reubicarse a otro candidato cuando la esquina por defecto choca con una etiqueta -- nunca mantener una esquina fija');
  const anchorRect = getScaleBarRect(anchor.x, anchor.y, true);
  assert.equal(rectsOverlap(anchorRect, blockingPlacement.rect, 10), false, 'la posición elegida no debe seguir chocando con la etiqueta bloqueante');
});

test('CATX-PDF-PARITY-002: chooseScaleBarAnchor evita la esquina cuando choca con muchos vértices de referencia densos', () => {
  const defaultCandidate = { x: MAP_RECT.x + 18, y: MAP_RECT.y + MAP_RECT.height - 24 };
  const defaultRect = getScaleBarRect(defaultCandidate.x, defaultCandidate.y, true);
  // 8 puntos de referencia distribuidos DENTRO del rect de la esquina por
  // defecto (+padding 16) -- cada uno suma 22 al puntaje de ese candidato.
  const denseRefs = Array.from({ length: 8 }, (_, i) => [
    defaultRect.x + 10 + (i % 4) * 30,
    defaultRect.y + 10 + Math.floor(i / 4) * 15,
  ]);

  const anchor = chooseScaleBarAnchor(MAP_RECT, [], denseRefs, [], true);
  assert.notDeepEqual(anchor, defaultCandidate, 'con 8 vértices densos dentro de la esquina por defecto, la escala debe moverse a un candidato más libre');
});
