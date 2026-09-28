// SPRINT-3D10.4 FASE 2 -- pruebas puras del motor automático de carga
// recomendada (cargaAutomaticaFormulas.js). Sin DB/HTTP -- solo
// aritmética, mismo criterio que capacidadPastoreoFormulas.test.js.
//
// Contrato cerrado en 3D10.2/3D10.2.1/3D10.2.2/3D10.2.3/3D10.2.4 (ver esos
// sprints para la demostración matemática completa) -- estos tests
// verifican la implementación, no re-derivan la ciencia.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OCCUPATION_POLICY_V1,
  resolverPoliticaOcupacion,
  computeCargaRecomendadaAutomatica,
  evaluarEscenarioUsuario,
  ESTADO_PASTURA_SIN_POLITICA,
} from '../cargaAutomaticaFormulas.js';

// ===========================================================================
// §16 -- resolverPoliticaOcupacion (política de soporte por pastura)
// ===========================================================================

test('caso A: gramínea de género de catálogo de sistema -> policy 2/3/4, confidence MEDIA', () => {
  for (const genero of ['Urochloa', 'Brachiaria', 'Megathyrsus', 'Panicum', 'Cynodon', 'Cenchrus']) {
    const r = resolverPoliticaOcupacion({ tipo: 'graminea', genero, alcance: 'sistema' });
    assert.equal(r.estado, 'OK', `género ${genero} debería resolver OK`);
    assert.equal(r.policy.minDays, 2);
    assert.equal(r.policy.targetDays, 3);
    assert.equal(r.policy.maxDays, 4);
    assert.equal(r.policy.confidence, 'MEDIA', `género ${genero} debería ser confidence MEDIA`);
  }
});

test('caso B: personalizada tipo=graminea (género no reconocido) -> misma policy, confidence BAJA', () => {
  const r = resolverPoliticaOcupacion({ tipo: 'graminea', genero: null, alcance: 'personalizado' });
  assert.equal(r.estado, 'OK');
  assert.equal(r.policy.targetDays, 3);
  assert.equal(r.policy.confidence, 'BAJA');
});

test('caso C: leguminosa por género (Arachis/Leucaena) -> NO policy, PASTURA_SIN_POLITICA_DEFINIDA', () => {
  for (const genero of ['Arachis', 'Leucaena']) {
    const r = resolverPoliticaOcupacion({ tipo: 'leguminosa', genero, alcance: 'sistema' });
    assert.equal(r.estado, ESTADO_PASTURA_SIN_POLITICA);
    assert.equal(r.policy, null);
  }
});

test('caso C: personalizada tipo=leguminosa (sin género) -> NO policy', () => {
  const r = resolverPoliticaOcupacion({ tipo: 'leguminosa', genero: null, alcance: 'personalizado' });
  assert.equal(r.estado, ESTADO_PASTURA_SIN_POLITICA);
  assert.equal(r.policy, null);
});

test('caso D: mezcla con género dominante identificable (gramínea de sistema) -> política de la dominante', () => {
  const r = resolverPoliticaOcupacion({ tipo: 'mezcla', generoDominante: 'Urochloa' });
  assert.equal(r.estado, 'OK');
  assert.equal(r.policy.targetDays, 3);
  assert.equal(r.policy.confidence, 'MEDIA');
});

test('caso E: mezcla SIN dominante identificable -> PASTURA_SIN_POLITICA_DEFINIDA', () => {
  const r = resolverPoliticaOcupacion({ tipo: 'mezcla', generoDominante: null });
  assert.equal(r.estado, ESTADO_PASTURA_SIN_POLITICA);
});

test('caso E: mezcla con dominante leguminosa (no gramínea) -> PASTURA_SIN_POLITICA_DEFINIDA (no inventa política)', () => {
  const r = resolverPoliticaOcupacion({ tipo: 'mezcla', generoDominante: 'Arachis' });
  assert.equal(r.estado, ESTADO_PASTURA_SIN_POLITICA);
});

test('caso E: tipo=otra -> PASTURA_SIN_POLITICA_DEFINIDA', () => {
  const r = resolverPoliticaOcupacion({ tipo: 'otra' });
  assert.equal(r.estado, ESTADO_PASTURA_SIN_POLITICA);
});

test('unknown/sin input -> PASTURA_SIN_POLITICA_DEFINIDA, nunca un fallback silencioso', () => {
  const r = resolverPoliticaOcupacion();
  assert.equal(r.estado, ESTADO_PASTURA_SIN_POLITICA);
  assert.equal(r.policy, null);
});

test('OCCUPATION_POLICY_V1 es el contrato exacto aprobado (2/3/4)', () => {
  assert.equal(OCCUPATION_POLICY_V1.minDays, 2);
  assert.equal(OCCUPATION_POLICY_V1.targetDays, 3);
  assert.equal(OCCUPATION_POLICY_V1.maxDays, 4);
  assert.ok(typeof OCCUPATION_POLICY_V1.version === 'string' && OCCUPATION_POLICY_V1.version.length > 0);
});

// ===========================================================================
// §5/§6/§14 -- computeCargaRecomendadaAutomatica
// ===========================================================================

// DI=1 fijo; MSU = N_raw_3d * targetDays(3) -- reproduce exactamente los
// valores de C ya validados en 3D10.2.4§N/3D10.3.1. materiaSecaTotalKg se
// fija en 2×MSU (equivalente a %utilización=50%, arbitrario -- no afecta
// la decisión de N/días, solo el remanente).
function buildInputsParaNRaw3d(nRaw3d) {
  const demandaIndividualKgMsDia = 1;
  const materiaSecaUtilizableKg = nRaw3d * OCCUPATION_POLICY_V1.targetDays;
  return {
    materiaSecaUtilizableKg,
    materiaSecaTotalKg: materiaSecaUtilizableKg * 2,
    demandaIndividualKgMsDia,
    occupationPolicy: OCCUPATION_POLICY_V1,
  };
}

const CASOS_AUTOMATICO = [
  { nRaw3d: 0.4, estado: 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE' },
  { nRaw3d: 0.8, numeroAnimalesRecomendado: 1, diasPermanenciaRecomendada: 2, motivoDuracion: 'FALLBACK_MIN_2_DAYS' },
  { nRaw3d: 0.99, numeroAnimalesRecomendado: 1, diasPermanenciaRecomendada: 2, motivoDuracion: 'FALLBACK_MIN_2_DAYS' },
  { nRaw3d: 1.0, numeroAnimalesRecomendado: 1, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 1.1, numeroAnimalesRecomendado: 1, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 1.4, numeroAnimalesRecomendado: 1, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 1.8, numeroAnimalesRecomendado: 1, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 2.1, numeroAnimalesRecomendado: 2, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 2.9, numeroAnimalesRecomendado: 2, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 10.7, numeroAnimalesRecomendado: 10, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
  { nRaw3d: 100.5, numeroAnimalesRecomendado: 100, diasPermanenciaRecomendada: 3, motivoDuracion: 'TARGET_3_DAYS' },
];

for (const caso of CASOS_AUTOMATICO) {
  test(`N_raw_3d=${caso.nRaw3d} -> ${caso.estado ?? `${caso.numeroAnimalesRecomendado} animal(es), ${caso.diasPermanenciaRecomendada} días (${caso.motivoDuracion})`}`, () => {
    const inputs = buildInputsParaNRaw3d(caso.nRaw3d);
    const r = computeCargaRecomendadaAutomatica(inputs);

    if (caso.estado === 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE') {
      assert.equal(r.estado, 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE');
      assert.equal(r.numeroAnimalesRecomendado, null);
      assert.equal(r.diasPermanenciaRecomendada, null);
      assert.equal(r.motivoDuracion, null);
      assert.equal(r.consumoOperativoKg, null);
      assert.equal(r.remanenteOperativoKg, null);
      assert.equal(r.margenForrajeKg, null);
      assert.equal(r.diasMaximosSoportadosExactos, null);
      // occupationPolicy SIEMPRE viaja, incluso en estado no-OK (provenance).
      assert.equal(r.occupationPolicy, OCCUPATION_POLICY_V1);
      return;
    }

    assert.equal(r.estado, 'OK');
    assert.equal(r.numeroAnimalesRecomendado, caso.numeroAnimalesRecomendado);
    assert.equal(r.diasPermanenciaRecomendada, caso.diasPermanenciaRecomendada);
    assert.equal(r.motivoDuracion, caso.motivoDuracion);

    // Campos derivados, recalculados en el propio test (fórmula independiente).
    const consumoEsperado = inputs.demandaIndividualKgMsDia * caso.numeroAnimalesRecomendado * caso.diasPermanenciaRecomendada;
    assert.ok(Math.abs(r.consumoOperativoKg - consumoEsperado) < 1e-9);
    assert.ok(Math.abs(r.remanenteOperativoKg - (inputs.materiaSecaTotalKg - consumoEsperado)) < 1e-9);
    assert.ok(Math.abs(r.margenForrajeKg - (inputs.materiaSecaUtilizableKg - consumoEsperado)) < 1e-9);

    // §7.F -- diasMaximosSoportadosExactos nunca gobierna N/duración: se
    // recalcula DESPUÉS, con el N ya decidido -- puede diferir de nRaw3d.
    const diasMaximosEsperado = inputs.materiaSecaUtilizableKg / (inputs.demandaIndividualKgMsDia * caso.numeroAnimalesRecomendado);
    assert.ok(Math.abs(r.diasMaximosSoportadosExactos - diasMaximosEsperado) < 1e-9);
  });
}

// -----------------------------------------------------------------------
// §7 -- invariantes matemáticas, verificadas contra TODOS los casos OK.
// -----------------------------------------------------------------------

test('§7.A/B/C/D/E -- invariantes se cumplen en todos los casos OK del contrato', () => {
  for (const caso of CASOS_AUTOMATICO) {
    if (caso.estado) continue; // salta el caso insuficiente
    const inputs = buildInputsParaNRaw3d(caso.nRaw3d);
    const r = computeCargaRecomendadaAutomatica(inputs);

    assert.ok(r.consumoOperativoKg <= inputs.materiaSecaUtilizableKg + 1e-9, `A: consumo<=MSU falló para nRaw3d=${caso.nRaw3d}`);
    assert.ok(r.remanenteOperativoKg >= inputs.materiaSecaTotalKg - inputs.materiaSecaUtilizableKg - 1e-9, `B falló para nRaw3d=${caso.nRaw3d}`);
    assert.ok(r.margenForrajeKg >= -1e-9, `C: margen>=0 falló para nRaw3d=${caso.nRaw3d}`);
    assert.ok([2, 3].includes(r.diasPermanenciaRecomendada), `D: días debe ser 2 o 3, nRaw3d=${caso.nRaw3d}`);
    assert.ok(r.numeroAnimalesRecomendado >= 1, `E falló para nRaw3d=${caso.nRaw3d}`);
  }
});

test('§7.F -- diasMaximosSoportadosExactos NUNCA es igual a diasPermanenciaRecomendada cuando difieren realmente (nRaw3d=2.9 -> N=2, días=3, máximo real >=3 pero distinto de 3 salvo coincidencia)', () => {
  // nRaw3d=2.9 -> N_raw_target original=2.9 (no usado para N), N=2 (floor de
  // C/(DI*3)=8.7/3=2.9 -> floor=2), diasMaximos=8.7/(1*2)=4.35 -- distinto
  // de 3 (la duración recomendada), demostrando que el máximo NUNCA
  // determina la duración mostrada.
  const inputs = buildInputsParaNRaw3d(2.9);
  const r = computeCargaRecomendadaAutomatica(inputs);
  assert.equal(r.diasPermanenciaRecomendada, 3);
  assert.ok(Math.abs(r.diasMaximosSoportadosExactos - 4.35) < 1e-9);
  assert.notEqual(r.diasMaximosSoportadosExactos, r.diasPermanenciaRecomendada);
});

// -----------------------------------------------------------------------
// §8 -- input inválido (computeCargaRecomendadaAutomatica).
// -----------------------------------------------------------------------

const INPUTS_VALIDOS = { materiaSecaTotalKg: 1000, materiaSecaUtilizableKg: 500, demandaIndividualKgMsDia: 10, occupationPolicy: OCCUPATION_POLICY_V1 };

const CASOS_INVALIDOS = [
  ['materiaSecaTotalKg', 0], ['materiaSecaTotalKg', -1], ['materiaSecaTotalKg', NaN], ['materiaSecaTotalKg', Infinity],
  ['materiaSecaTotalKg', null], ['materiaSecaTotalKg', undefined],
  ['materiaSecaUtilizableKg', 0], ['materiaSecaUtilizableKg', -1], ['materiaSecaUtilizableKg', NaN], ['materiaSecaUtilizableKg', Infinity],
  ['demandaIndividualKgMsDia', 0], ['demandaIndividualKgMsDia', -1], ['demandaIndividualKgMsDia', NaN], ['demandaIndividualKgMsDia', Infinity],
  ['occupationPolicy', null], ['occupationPolicy', undefined], ['occupationPolicy', {}],
];

for (const [campo, valor] of CASOS_INVALIDOS) {
  test(`INPUT_INVALID: computeCargaRecomendadaAutomatica lanza excepción si ${campo}=${String(valor)}`, () => {
    assert.throws(
      () => computeCargaRecomendadaAutomatica({ ...INPUTS_VALIDOS, [campo]: valor }),
      (error) => error.code === 'INPUT_INVALID',
    );
  });
}

test('INPUT_INVALID nunca se confunde con NO_RECOMMENDATION_INSUFFICIENT_FORAGE -- un MSU genuinamente bajo (pero válido) SÍ retorna el estado de negocio, no lanza', () => {
  const r = computeCargaRecomendadaAutomatica({ ...INPUTS_VALIDOS, materiaSecaUtilizableKg: 0.001 });
  assert.equal(r.estado, 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE');
});

// ===========================================================================
// §9/§10/§11/§15 -- evaluarEscenarioUsuario (override puro)
// ===========================================================================

// DI=1, N_usuario=1 -> maximo = MSU directamente.
function buildInputsParaMaximo(maximo) {
  return {
    materiaSecaUtilizableKg: maximo,
    materiaSecaTotalKg: maximo * 2,
    demandaIndividualKgMsDia: 1,
    numeroAnimalesUsuario: 1,
    occupationPolicy: OCCUPATION_POLICY_V1,
  };
}

const CASOS_OVERRIDE = [
  { maximo: 0.8, clasificacion: 'INSUFFICIENT_FORAGE', dias: null, confirmable: false },
  { maximo: 1.6, clasificacion: 'INSUFFICIENT_FORAGE', dias: null, confirmable: false },
  { maximo: 1.99, clasificacion: 'INSUFFICIENT_FORAGE', dias: null, confirmable: false },
  { maximo: 2.0, clasificacion: 'MINIMUM_COMPATIBLE', dias: 2, confirmable: true },
  { maximo: 2.4, clasificacion: 'MINIMUM_COMPATIBLE', dias: 2, confirmable: true },
  { maximo: 2.99, clasificacion: 'MINIMUM_COMPATIBLE', dias: 2, confirmable: true },
  { maximo: 3.0, clasificacion: 'TARGET_COMPATIBLE', dias: 3, confirmable: true },
  { maximo: 3.5, clasificacion: 'TARGET_COMPATIBLE', dias: 3, confirmable: true },
  { maximo: 4.0, clasificacion: 'TARGET_COMPATIBLE', dias: 3, confirmable: true },
  { maximo: 4.8, clasificacion: 'TARGET_COMPATIBLE', dias: 3, confirmable: true },
  { maximo: 7.5, clasificacion: 'TARGET_COMPATIBLE', dias: 3, confirmable: true },
];

for (const caso of CASOS_OVERRIDE) {
  test(`§15 maximo=${caso.maximo} -> ${caso.clasificacion}, días=${caso.dias}, confirmable=${caso.confirmable}`, () => {
    const inputs = buildInputsParaMaximo(caso.maximo);
    const r = evaluarEscenarioUsuario(inputs);

    assert.equal(r.clasificacionEscenario, caso.clasificacion);
    assert.equal(r.diasPermanenciaEscenario, caso.dias);
    assert.equal(r.confirmable, caso.confirmable);
    assert.ok(Math.abs(r.diasMaximosSoportadosExactos - caso.maximo) < 1e-9);

    if (caso.confirmable) {
      const consumoEsperado = inputs.demandaIndividualKgMsDia * inputs.numeroAnimalesUsuario * caso.dias;
      assert.ok(Math.abs(r.consumoEscenarioKg - consumoEsperado) < 1e-9);
      assert.ok(Math.abs(r.remanenteEscenarioKg - (inputs.materiaSecaTotalKg - consumoEsperado)) < 1e-9);
      assert.ok(Math.abs(r.margenForrajeEscenarioKg - (inputs.materiaSecaUtilizableKg - consumoEsperado)) < 1e-9);
      // §10 -- invariante dura: nunca consume más de lo utilizable cuando confirmable.
      assert.ok(r.consumoEscenarioKg <= inputs.materiaSecaUtilizableKg + 1e-9);
    } else {
      assert.equal(r.consumoEscenarioKg, null);
      assert.equal(r.remanenteEscenarioKg, null);
      assert.equal(r.margenForrajeEscenarioKg, null);
    }
  });
}

test('§15 caso especial 7.5 -> EXACTAMENTE 3 días, nunca 7 ni una advertencia de ocupación prolongada (§11 -- prohibición explícita)', () => {
  const r = evaluarEscenarioUsuario(buildInputsParaMaximo(7.5));
  assert.equal(r.diasPermanenciaEscenario, 3);
  assert.notEqual(r.diasPermanenciaEscenario, 7);
  assert.equal(r.clasificacionEscenario, 'TARGET_COMPATIBLE');
  assert.ok(!('advertencia' in r), 'el resultado puro no debe incluir ninguna advertencia de ocupación prolongada');
});

test('§13 -- shape de salida no incluye fechaIngreso/fechaSalida/HTTP/tenant/DB ids', () => {
  const r = evaluarEscenarioUsuario(buildInputsParaMaximo(3.5));
  for (const campoProhibido of ['fechaIngreso', 'fechaSalida', 'fechaIngresoPrevista', 'fechaSalidaEstimada', 'organizacionId', 'potreroId', 'fichaId']) {
    assert.ok(!(campoProhibido in r), `evaluarEscenarioUsuario no debe incluir ${campoProhibido}`);
  }
});

test('§13 -- shape de salida de recomendación automática no incluye fechas/HTTP/tenant/DB ids', () => {
  const r = computeCargaRecomendadaAutomatica(buildInputsParaNRaw3d(2.1));
  for (const campoProhibido of ['fechaIngresoPrevista', 'fechaSalidaEstimada', 'organizacionId', 'potreroId', 'fichaId']) {
    assert.ok(!(campoProhibido in r), `computeCargaRecomendadaAutomatica no debe incluir ${campoProhibido}`);
  }
});

// -----------------------------------------------------------------------
// §8 -- input inválido (evaluarEscenarioUsuario).
// -----------------------------------------------------------------------

const INPUTS_OVERRIDE_VALIDOS = { materiaSecaTotalKg: 1000, materiaSecaUtilizableKg: 500, demandaIndividualKgMsDia: 10, numeroAnimalesUsuario: 5, occupationPolicy: OCCUPATION_POLICY_V1 };

for (const [campo, valor] of [...CASOS_INVALIDOS, ['numeroAnimalesUsuario', 0], ['numeroAnimalesUsuario', -1], ['numeroAnimalesUsuario', NaN]]) {
  test(`INPUT_INVALID: evaluarEscenarioUsuario lanza excepción si ${campo}=${String(valor)}`, () => {
    assert.throws(
      () => evaluarEscenarioUsuario({ ...INPUTS_OVERRIDE_VALIDOS, [campo]: valor }),
      (error) => error.code === 'INPUT_INVALID',
    );
  });
}

// ===========================================================================
// §18 -- precisión numérica: nada se redondea salvo donde el contrato exige floor.
// ===========================================================================

test('§18 -- MSU/DI/consumo/remanente/margen/diasMaximos conservan precisión completa (sin redondeo interno)', () => {
  const inputs = buildInputsParaNRaw3d(10.7); // C=32.1, no es un entero limpio
  const r = computeCargaRecomendadaAutomatica(inputs);
  // diasMaximosSoportadosExactos = 32.1/(1*10) = 3.21 -- no debe truncarse.
  assert.ok(Math.abs(r.diasMaximosSoportadosExactos - 3.21) < 1e-9);
  assert.notEqual(r.diasMaximosSoportadosExactos, Math.floor(r.diasMaximosSoportadosExactos));
});
