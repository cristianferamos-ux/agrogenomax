// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas puras de
// computeRecomendacionPastoreo/computeDemandaIndividualLecheNrc2001/
// computeFcmKgDia y de resolveNivelConfianza.
//
// HARDENING RONDA 4 -- corrige un bug real de la ronda 3: FCM (4%
// fat-corrected milk) NO es el volumen de leche crudo. FCM = 0.4×leche_kg
// + 15×grasa_kg (Gaines & Davidson 1923). litrosPromedioVacaDia NUNCA debe
// usarse directamente como FCM -- estos tests lo verifican explícitamente.
// Sin %grasa real, el motor NUNCA ejecuta la ecuación NRC (2001) --
// usa un perfil %PV genérico (GENERIC_LACTATING_PROFILE), confianza topada
// en MEDIA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRecomendacionPastoreo,
  computeDemandaIndividualLecheNrc2001,
  computeFcmKgDia,
  resolveNivelConfianza,
  FICHA_STALE_DIAS,
  DENSIDAD_LECHE_KG_POR_LITRO,
} from '../recomendacionPastoreoFormulas.js';
import { computeCapacidadPastoreoModoDias } from '../../capacidadPastoreoFormulas.js';

const BASE_ARGS = {
  biomasaFrescaKg: 5000,
  materiaSecaPct: 20,
  utilizacionPct: 50,
  consumoPctPesoVivo: 2.4,
  pesoPromedioKg: 420,
  numeroAnimales: 10,
};

test('sin ecuación de leche, computeRecomendacionPastoreo coincide exactamente con computeCapacidadPastoreoModoDias (misma física, §7 del sprint)', () => {
  const actual = computeRecomendacionPastoreo(BASE_ARGS);
  const esperado = computeCapacidadPastoreoModoDias({
    biomasaFrescaKg: BASE_ARGS.biomasaFrescaKg,
    porcentajeMateriaSeca: BASE_ARGS.materiaSecaPct,
    porcentajeUtilizacion: BASE_ARGS.utilizacionPct,
    consumoPctPesoVivo: BASE_ARGS.consumoPctPesoVivo,
    pesoVivoPromedioKg: BASE_ARGS.pesoPromedioKg,
    numeroAnimales: BASE_ARGS.numeroAnimales,
  });
  assert.equal(actual.materiaSecaTotalKg, esperado.materiaSecaTotalKg);
  assert.equal(actual.demandaDiariaLoteKgMs, esperado.demandaDiariaLoteKgMs);
  assert.equal(actual.diasOcupacionEstimados, esperado.diasOcupacionEstimados);
  assert.equal(actual.dmiModel, null);
});

// -----------------------------------------------------------------------
// Hardening ronda 4 §3: FCM = Gaines & Davidson (1923).
// -----------------------------------------------------------------------

test('computeFcmKgDia reproduce la fórmula de Gaines & Davidson (1923): FCM = 0.4*leche + 15*grasa_kg', () => {
  const milkKgDia = 20;
  const grasaPct = 3.8;
  const grasaKgDia = milkKgDia * (grasaPct / 100);
  const esperado = 0.4 * milkKgDia + 15 * grasaKgDia;
  assert.equal(computeFcmKgDia(milkKgDia, grasaPct), esperado);
});

test('FCM cambia con %grasa a igualdad de litros -- grasa 3% vs 4.5% producen FCM DIFERENTE (hardening §9 -- test explícito pedido)', () => {
  const fcm3 = computeFcmKgDia(20, 3);
  const fcm45 = computeFcmKgDia(20, 4.5);
  assert.notEqual(fcm3, fcm45);
  assert.ok(fcm45 > fcm3);
});

// -----------------------------------------------------------------------
// Hardening ronda 4 §1/§2: ecuación NRC (2001) completa -- WOL = DIM/7,
// FCM real (nunca litros directamente).
// -----------------------------------------------------------------------

test('computeDemandaIndividualLecheNrc2001 reproduce la ecuación NRC (2001) literal con FCM real (no litros directamente)', () => {
  const pesoPromedioKg = 500;
  const litrosPromedioVacaDia = 20;
  const diasEnLeche = 100;
  const grasaLechePct = 3.8;

  const milkKgDayUsed = litrosPromedioVacaDia * DENSIDAD_LECHE_KG_POR_LITRO;
  const fcmKgDay = computeFcmKgDia(milkKgDayUsed, grasaLechePct);
  const wol = diasEnLeche / 7;
  const esperado = (0.372 * fcmKgDay + 0.0968 * Math.pow(pesoPromedioKg, 0.75)) * (1 - Math.exp(-0.192 * (wol + 3.67)));

  const detalle = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg, litrosPromedioVacaDia, diasEnLeche, grasaLechePct });
  assert.ok(Math.abs(detalle.predictedDmiKgDay - esperado) < 1e-9);
});

test('WOL = diasEnLeche / 7 EXACTO (hardening §2 -- test explícito pedido)', () => {
  const detalle = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg: 500, litrosPromedioVacaDia: 20, diasEnLeche: 91, grasaLechePct: 4 });
  assert.equal(detalle.weeksOfLactation, 91 / 7);
  assert.equal(detalle.weeksOfLactation, 13);
});

test('litros NUNCA se usan directamente como FCM -- milkKgDayUsed (conversión física) es distinto de fcmKgDay (fórmula Gaines) salvo coincidencia numérica', () => {
  const detalle = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg: 500, litrosPromedioVacaDia: 20, diasEnLeche: 100, grasaLechePct: 3.8 });
  assert.equal(detalle.milkKgDayUsed, 20 * DENSIDAD_LECHE_KG_POR_LITRO);
  assert.notEqual(detalle.fcmKgDay, detalle.milkInputLitersDay);
  assert.notEqual(detalle.fcmKgDay, detalle.milkKgDayUsed);
  // fcmKgDay debe derivarse de milkKgDayUsed + grasa vía Gaines, nunca ser
  // una copia directa del volumen de leche.
  assert.equal(detalle.fcmKgDay, computeFcmKgDia(detalle.milkKgDayUsed, 3.8));
});

test('provenance completa (§7 hardening): milkInputLitersDay, milkKgDayUsed, milkDensityOrConversionSource, milkFatPct, milkFatKgDay, fcmKgDay, daysInMilk, weeksOfLactation, bwKg, predictedDmiKgDay, equationSource, dmiModelSourceType', () => {
  const detalle = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg: 500, litrosPromedioVacaDia: 20, diasEnLeche: 100, grasaLechePct: 3.8 });
  for (const campo of [
    'milkInputLitersDay', 'milkKgDayUsed', 'milkDensityOrConversionSource', 'milkFatPct', 'milkFatKgDay',
    'fcmKgDay', 'daysInMilk', 'weeksOfLactation', 'bwKg', 'predictedDmiKgDay', 'equationSource', 'dmiModelSourceType',
  ]) {
    assert.ok(campo in detalle, `falta el campo de provenance ${campo}`);
  }
  assert.equal(detalle.equationSource, 'NRC_2001_DAIRY_DMI');
  assert.equal(detalle.dmiModelSourceType, 'DIRECT');
});

// -----------------------------------------------------------------------
// Hardening ronda 4 §5: sin %grasa, NUNCA se ejecuta la ecuación FCM --
// perfil %PV genérico (GENERIC_LACTATING_PROFILE).
// -----------------------------------------------------------------------

test('computeRecomendacionPastoreo con esCategoriaLeche=true y grasaLechePct null usa el perfil %PV genérico, NUNCA la ecuación NRC (2001)', () => {
  const resultado = computeRecomendacionPastoreo({
    ...BASE_ARGS,
    esCategoriaLeche: true,
    litrosPromedioVacaDia: 20,
    diasEnLeche: 100,
    grasaLechePct: null,
  });
  assert.equal(resultado.dmiModel, 'GENERIC_LACTATING_PROFILE');
  assert.equal(resultado.dmiDetalle, null);
  // Perfil genérico = misma fórmula que cualquier categoría no lactante.
  assert.equal(resultado.demandaIndividualKgMsDia, BASE_ARGS.pesoPromedioKg * (BASE_ARGS.consumoPctPesoVivo / 100));
});

test('5 L/día vs 15 L/día SIN %grasa producen la MISMA demanda -- litros nunca se usan directamente (hardening §9, confirma la corrección del bug de ronda 3)', () => {
  const con5L = computeRecomendacionPastoreo({ ...BASE_ARGS, esCategoriaLeche: true, litrosPromedioVacaDia: 5, diasEnLeche: 100, grasaLechePct: null });
  const con15L = computeRecomendacionPastoreo({ ...BASE_ARGS, esCategoriaLeche: true, litrosPromedioVacaDia: 15, diasEnLeche: 100, grasaLechePct: null });
  assert.equal(con5L.demandaIndividualKgMsDia, con15L.demandaIndividualKgMsDia);
  assert.equal(con5L.dmiModel, 'GENERIC_LACTATING_PROFILE');
});

test('5 L/día vs 15 L/día CON la misma %grasa producen demanda DIFERENTE vía la ecuación NRC (2001) real (hardening §9)', () => {
  const con5L = computeRecomendacionPastoreo({ ...BASE_ARGS, esCategoriaLeche: true, litrosPromedioVacaDia: 5, diasEnLeche: 100, grasaLechePct: 3.8 });
  const con15L = computeRecomendacionPastoreo({ ...BASE_ARGS, esCategoriaLeche: true, litrosPromedioVacaDia: 15, diasEnLeche: 100, grasaLechePct: 3.8 });
  assert.notEqual(con5L.demandaIndividualKgMsDia, con15L.demandaIndividualKgMsDia);
  assert.ok(con15L.demandaIndividualKgMsDia > con5L.demandaIndividualKgMsDia);
  assert.equal(con5L.dmiModel, 'NRC_2001_DAIRY_DMI');
});

test('DIM 30 vs DIM 150 (misma leche/grasa) producen factor de lactancia y demanda DIFERENTES (hardening §9)', () => {
  const dim30 = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg: 500, litrosPromedioVacaDia: 20, diasEnLeche: 30, grasaLechePct: 3.8 });
  const dim150 = computeDemandaIndividualLecheNrc2001({ pesoPromedioKg: 500, litrosPromedioVacaDia: 20, diasEnLeche: 150, grasaLechePct: 3.8 });
  assert.notEqual(dim30.weeksOfLactation, dim150.weeksOfLactation);
  assert.notEqual(dim30.predictedDmiKgDay, dim150.predictedDmiKgDay);
});

test('grasaLechePct=0 se trata igual que ausente -- NO ejecuta la ecuación (evita división/comportamiento raro con grasa cero)', () => {
  const resultado = computeRecomendacionPastoreo({ ...BASE_ARGS, esCategoriaLeche: true, litrosPromedioVacaDia: 20, diasEnLeche: 100, grasaLechePct: 0 });
  assert.equal(resultado.dmiModel, 'GENERIC_LACTATING_PROFILE');
});

// -----------------------------------------------------------------------
// Hardening ronda 3 §4: ternero al pie NUNCA suma demanda.
// -----------------------------------------------------------------------

test('terneroAlPie=true NO altera demandaDiariaLoteKgMs -- sin constante universal (hardening §4)', () => {
  const sinTernero = computeRecomendacionPastoreo({ ...BASE_ARGS, terneroAlPie: false });
  const conTernero = computeRecomendacionPastoreo({ ...BASE_ARGS, terneroAlPie: true });
  assert.equal(conTernero.demandaDiariaLoteKgMs, sinTernero.demandaDiariaLoteKgMs);
});

// -----------------------------------------------------------------------
// resolveNivelConfianza (§9 del sprint + hardening rondas 2/3/4).
// -----------------------------------------------------------------------

const CONFIANZA_TODO_OK = {
  tieneContexto: true,
  fichaEdadDias: 1,
  dryMatterSource: 'BOTANICAL_TYPE',
  categoriaFuenteTipo: 'ADAPTED',
  terneroAlPie: null,
  usaPerfilGenericoLeche: false,
};

test('resolveNivelConfianza: ALTA cuando todo está disponible y NRC (2001) real corrió (o no aplica)', () => {
  assert.equal(resolveNivelConfianza(CONFIANZA_TODO_OK), 'ALTA');
});

test('resolveNivelConfianza: usaPerfilGenericoLeche=true topa la confianza en MEDIA, nunca ALTA (hardening ronda 4 §5)', () => {
  assert.equal(resolveNivelConfianza({ ...CONFIANZA_TODO_OK, usaPerfilGenericoLeche: true }), 'MEDIA');
});

test('resolveNivelConfianza: usaPerfilGenericoLeche no mejora una confianza ya degradada (nunca sube de BAJA/MEDIA)', () => {
  const yaMedia = resolveNivelConfianza({ ...CONFIANZA_TODO_OK, tieneContexto: false, usaPerfilGenericoLeche: true });
  assert.equal(yaMedia, 'MEDIA');
  const yaBaja = resolveNivelConfianza({
    ...CONFIANZA_TODO_OK, tieneContexto: false, categoriaFuenteTipo: 'FALLBACK', usaPerfilGenericoLeche: true,
  });
  assert.equal(yaBaja, 'BAJA');
});

test('resolveNivelConfianza: degrada un nivel por cada condición faltante (sin cambios de rondas previas)', () => {
  assert.equal(resolveNivelConfianza({ ...CONFIANZA_TODO_OK, tieneContexto: false }), 'MEDIA');
  assert.equal(resolveNivelConfianza({ ...CONFIANZA_TODO_OK, fichaEdadDias: FICHA_STALE_DIAS + 1 }), 'MEDIA');
  assert.equal(resolveNivelConfianza({ ...CONFIANZA_TODO_OK, dryMatterSource: 'FALLBACK' }), 'MEDIA');
  assert.equal(resolveNivelConfianza({ ...CONFIANZA_TODO_OK, categoriaFuenteTipo: 'FALLBACK' }), 'MEDIA');
  assert.equal(resolveNivelConfianza({ ...CONFIANZA_TODO_OK, terneroAlPie: true }), 'MEDIA');
});

test('resolveNivelConfianza: nunca baja de BAJA aunque se cumplan todas las condiciones a la vez', () => {
  const nivel = resolveNivelConfianza({
    tieneContexto: false,
    fichaEdadDias: FICHA_STALE_DIAS + 1,
    dryMatterSource: 'FALLBACK',
    categoriaFuenteTipo: 'FALLBACK',
    terneroAlPie: true,
    usaPerfilGenericoLeche: true,
  });
  assert.equal(nivel, 'BAJA');
});
