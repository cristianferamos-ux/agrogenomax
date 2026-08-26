// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico) §6: frescura
// explícita del contexto agroclimático.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessAgroClimateFreshness,
  AGROCLIMATE_FRESHNESS,
  FRESHNESS_FRESH_MAX_DIAS,
  FRESHNESS_AGING_MAX_DIAS,
} from '../agroClimateFreshness.js';

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}
function daysAgo(days) {
  return hoursAgo(days * 24);
}

test('sin contexto -> NO_AGROCLIMATE_CONTEXT', () => {
  const result = assessAgroClimateFreshness({});
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.NONE);
  assert.equal(result.edadDias, null);
});

test('dentro de la ventana FRESH', () => {
  const result = assessAgroClimateFreshness({ createdAt: daysAgo(1) });
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.FRESH);
});

test('justo dentro del límite de FRESH sigue siendo FRESH', () => {
  // Un segundo de margen respecto al límite exacto -- comparar contra el
  // borde exacto es inherentemente inestable (el tiempo avanza entre el
  // cálculo de `createdAt` y la evaluación dentro de la función).
  const result = assessAgroClimateFreshness({ createdAt: hoursAgo(FRESHNESS_FRESH_MAX_DIAS * 24 - 0.01) });
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.FRESH);
});

test('más allá de FRESH pero dentro de AGING', () => {
  const result = assessAgroClimateFreshness({ createdAt: daysAgo(FRESHNESS_FRESH_MAX_DIAS + 1) });
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.AGING);
});

test('más allá de AGING -> STALE', () => {
  const result = assessAgroClimateFreshness({ createdAt: daysAgo(FRESHNESS_AGING_MAX_DIAS + 1) });
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.STALE);
});

test('prioriza sourceObservedUntil sobre createdAt (dato real de la fuente, no fecha de registro)', () => {
  // created_at reciente, pero la fuente reporta datos reales muy viejos --
  // debe clasificar por el dato real (STALE), nunca por la fecha de
  // registro del snapshot.
  const result = assessAgroClimateFreshness({
    createdAt: daysAgo(0),
    sourceObservedUntil: daysAgo(FRESHNESS_AGING_MAX_DIAS + 5),
  });
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.STALE);
});

test('fecha inválida se trata como ausencia de contexto (nunca lanza)', () => {
  const result = assessAgroClimateFreshness({ createdAt: 'no-es-una-fecha' });
  assert.equal(result.freshness, AGROCLIMATE_FRESHNESS.NONE);
});

// -----------------------------------------------------------------------
// §17 del hardening territorial: source-aware -- IDEAM tiene una ventana
// de frescura MÁS ESTRICTA que ERA5-Land (observación de estación, no
// reanálisis con rezago operativo).
// -----------------------------------------------------------------------

test('IDEAM: 5 días de antigüedad ya es STALE (ventana más estricta que ERA5_LAND)', () => {
  const resultIdeam = assessAgroClimateFreshness({ createdAt: daysAgo(5), fuentePrincipal: 'IDEAM' });
  const resultEra5 = assessAgroClimateFreshness({ createdAt: daysAgo(5), fuentePrincipal: 'ERA5_LAND' });
  assert.equal(resultIdeam.freshness, AGROCLIMATE_FRESHNESS.AGING);
  assert.equal(resultEra5.freshness, AGROCLIMATE_FRESHNESS.FRESH);
});

test('sin fuente_principal conocida, se aplica la ventana MÁS CONSERVADORA (ERA5_LAND), nunca la más laxa', () => {
  const resultSinFuente = assessAgroClimateFreshness({ createdAt: daysAgo(5) });
  const resultEra5 = assessAgroClimateFreshness({ createdAt: daysAgo(5), fuentePrincipal: 'ERA5_LAND' });
  assert.equal(resultSinFuente.freshness, resultEra5.freshness);
});
