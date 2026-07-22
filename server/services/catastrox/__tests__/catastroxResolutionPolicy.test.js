import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GEOMETRY_STATUS,
  ATTRIBUTE_STATUS,
  RESOLUTION_STATUS,
  CANDIDATE_SELECTION_STATUS,
  REASON_CODE,
  CatastroxResolverContractError,
  resolveCatastroxDuplicate,
} from '../catastroxResolutionPolicy.js';

function noDeliverables(deliverablesAllowed) {
  return Object.values(deliverablesAllowed).every((v) => v === false);
}

function allDeliverables(deliverablesAllowed) {
  return Object.values(deliverablesAllowed).every((v) => v === true);
}

describe('catastroxResolutionPolicy — resolveCatastroxDuplicate', () => {
  // 1. EXACT + NONE
  test('1) EXACT + NONE -> AUTO_RESOLVED, sin candidatos multiples', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000001',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.AUTO_RESOLVED);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.NOT_REQUIRED);
    assert.deepEqual(result.selectedCandidate, { source: 'clean', sourceRecordId: 'A1' });
    assert.deepEqual([...result.reasonCodes], [REASON_CODE.EXACT_EQUIVALENT_DUPLICATES]);
    assert.equal(result.manualReviewRequired, false);
    assert.equal(result.criticalReview, false);
    assert.ok(allDeliverables(result.deliverablesAllowed));
  });

  // 2. Exacto con varios candidatos equivalentes
  test('2) EXACT + NONE con varios candidatos -> SELECTED_EQUIVALENT, conserva todos', () => {
    const candidates = [
      { source: 'legacy', sourceRecordId: 'Z9' },
      { source: 'clean', sourceRecordId: 'A1' },
      { source: 'clean', sourceRecordId: 'A0' },
    ];
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000002',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates,
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.AUTO_RESOLVED);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.SELECTED_EQUIVALENT);
    assert.equal(result.equivalentCandidates.length, 3);
    assert.equal(result.traceabilityRequired, true);
    // clave tecnica: "clean::A0" < "clean::A1" < "legacy::Z9"
    assert.deepEqual(result.selectedCandidate, { source: 'clean', sourceRecordId: 'A0' });
  });

  // 3. MINIMAL_VARIATION + NONE
  test('3) MINIMAL_VARIATION + NONE -> PENDING_POLICY, seleccion pendiente', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000003',
      geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }, { source: 'legacy', sourceRecordId: 'B1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.PENDING_POLICY);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.PENDING_POLICY);
    assert.equal(result.selectedCandidate, null);
    assert.equal(result.manualReviewRequired, false);
    assert.equal(result.traceabilityRequired, true);
    assert.ok(result.reasonCodes.includes(REASON_CODE.MINIMAL_GEOMETRY_VARIATION));
    assert.ok(result.reasonCodes.includes(REASON_CODE.CANDIDATE_SELECTION_POLICY_PENDING));
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 4. EXACT + COMPLEMENTARY
  test('4) EXACT + COMPLEMENTARY -> PENDING_POLICY (regla 4 antes que regla 5)', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000004',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.COMPLEMENTARY,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.PENDING_POLICY);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.PENDING_POLICY);
    assert.ok(result.reasonCodes.includes(REASON_CODE.COMPLEMENTARY_ATTRIBUTE));
    assert.ok(!result.reasonCodes.includes(REASON_CODE.MINIMAL_GEOMETRY_VARIATION));
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 5. MINIMAL_VARIATION + COMPLEMENTARY
  test('5) MINIMAL_VARIATION + COMPLEMENTARY -> PENDING_POLICY con ambos reason codes', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000005',
      geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION,
      attributeStatus: ATTRIBUTE_STATUS.COMPLEMENTARY,
      candidates: [],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.PENDING_POLICY);
    assert.ok(result.reasonCodes.includes(REASON_CODE.MINIMAL_GEOMETRY_VARIATION));
    assert.ok(result.reasonCodes.includes(REASON_CODE.COMPLEMENTARY_ATTRIBUTE));
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 6. EXACT + COMMERCIAL_SENSITIVE
  test('6) EXACT + COMMERCIAL_SENSITIVE -> BLOCKED_REVIEW', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000006',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.COMMERCIAL_SENSITIVE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_REVIEW);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.BLOCKED);
    assert.deepEqual([...result.reasonCodes], [REASON_CODE.COMMERCIAL_ATTRIBUTE_CONFLICT, REASON_CODE.MANUAL_REVIEW_REQUIRED]);
    assert.equal(result.criticalReview, false);
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 7. MATERIAL_CONFLICT + NONE
  test('7) MATERIAL_CONFLICT + NONE -> BLOCKED_REVIEW', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000007',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_REVIEW);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.BLOCKED);
    assert.deepEqual([...result.reasonCodes], [REASON_CODE.MATERIAL_GEOMETRY_CONFLICT, REASON_CODE.MANUAL_REVIEW_REQUIRED]);
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 8. SEPARATE + NONE
  test('8) SEPARATE + NONE -> BLOCKED_REVIEW', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000008',
      geometryStatus: GEOMETRY_STATUS.SEPARATE,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_REVIEW);
    assert.deepEqual([...result.reasonCodes], [REASON_CODE.SEPARATE_GEOMETRIES, REASON_CODE.MANUAL_REVIEW_REQUIRED]);
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 9. Territorial critico
  test('9) TERRITORIAL_CRITICAL -> BLOCKED_CRITICAL, prevalece sobre geometria', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000009',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.TERRITORIAL_CRITICAL,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_CRITICAL);
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.BLOCKED);
    assert.equal(result.criticalReview, true);
    assert.equal(result.manualReviewRequired, true);
    assert.deepEqual([...result.reasonCodes], [REASON_CODE.TERRITORIAL_ATTRIBUTE_CONFLICT, REASON_CODE.MANUAL_REVIEW_REQUIRED]);
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 10. Normalizacion sospechosa + conflicto material
  test('10) MATERIAL_CONFLICT + NORMALIZATION_SUSPECT -> sigue BLOCKED_REVIEW, no se reduce el bloqueo', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000010',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_REVIEW);
    assert.equal(result.criticalReview, false);
    assert.ok(result.reasonCodes.includes(REASON_CODE.MATERIAL_GEOMETRY_CONFLICT));
    assert.ok(result.reasonCodes.includes(REASON_CODE.NORMALIZATION_SUSPECT));
    assert.ok(result.reasonCodes.includes(REASON_CODE.MANUAL_REVIEW_REQUIRED));
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 11. Caso rural/urbano validado
  test('11) Caso validado zona rural/urbano (180940003000000080005000000000)', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '180940003000000080005000000000',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT,
      reasonCodes: [REASON_CODE.ZONE_NORMALIZATION_SUSPECT],
      candidates: [
        { source: 'clean', sourceRecordId: 'r1' },
        { source: 'clean', sourceRecordId: 'r2' },
      ],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_REVIEW);
    assert.equal(result.criticalReview, false);
    assert.ok(noDeliverables(result.deliverablesAllowed));
    const codes = [...result.reasonCodes].sort();
    const expected = [
      REASON_CODE.MATERIAL_GEOMETRY_CONFLICT,
      REASON_CODE.ZONE_NORMALIZATION_SUSPECT,
      REASON_CODE.MANUAL_REVIEW_REQUIRED,
    ].sort();
    assert.deepEqual(codes, expected);
    assert.ok(!result.reasonCodes.includes(REASON_CODE.NORMALIZATION_SUSPECT));
  });

  // 12. Caso manzana cero validado
  test('12) Caso validado manzana con ceros (182470100000001380012000000000)', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '182470100000001380012000000000',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.COMPLEMENTARY,
      reasonCodes: [REASON_CODE.MANZANA_ZERO_SENTINEL],
      candidates: [
        { source: 'clean', sourceRecordId: 'r1' },
        { source: 'clean', sourceRecordId: 'r2' },
      ],
    });
    assert.equal(result.resolutionStatus, RESOLUTION_STATUS.BLOCKED_REVIEW);
    assert.equal(result.criticalReview, false);
    assert.ok(noDeliverables(result.deliverablesAllowed));
    const codes = [...result.reasonCodes].sort();
    const expected = [
      REASON_CODE.MATERIAL_GEOMETRY_CONFLICT,
      REASON_CODE.MANZANA_ZERO_SENTINEL,
      REASON_CODE.MANUAL_REVIEW_REQUIRED,
    ].sort();
    assert.deepEqual(codes, expected);
  });

  // 13. Ningun entregable en estados bloqueados
  test('13) No hay entregables habilitados en ningun estado BLOCKED_*', () => {
    const blockedCritical = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000013',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.TERRITORIAL_CRITICAL,
    });
    const blockedReviewGeom = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000014',
      geometryStatus: GEOMETRY_STATUS.SEPARATE,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    });
    const blockedReviewCommercial = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000015',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.COMMERCIAL_SENSITIVE,
    });
    for (const r of [blockedCritical, blockedReviewGeom, blockedReviewCommercial]) {
      assert.ok(noDeliverables(r.deliverablesAllowed));
    }
  });

  // 14. Ningun entregable mientras la seleccion esta pendiente
  test('14) No hay entregables habilitados mientras candidateSelectionStatus=PENDING_POLICY', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000016',
      geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    });
    assert.equal(result.candidateSelectionStatus, CANDIDATE_SELECTION_STATUS.PENDING_POLICY);
    assert.ok(noDeliverables(result.deliverablesAllowed));
  });

  // 15. Conservacion de trazabilidad
  test('15) equivalentCandidates conserva todos los candidatos de entrada en cada rama', () => {
    const candidates = [
      { source: 'clean', sourceRecordId: 'A1' },
      { source: 'legacy', sourceRecordId: 'L1' },
    ];
    const branches = [
      { geometryStatus: GEOMETRY_STATUS.EXACT, attributeStatus: ATTRIBUTE_STATUS.NONE },
      { geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION, attributeStatus: ATTRIBUTE_STATUS.NONE },
      { geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT, attributeStatus: ATTRIBUTE_STATUS.NONE },
      { geometryStatus: GEOMETRY_STATUS.EXACT, attributeStatus: ATTRIBUTE_STATUS.TERRITORIAL_CRITICAL },
    ];
    for (const branch of branches) {
      const result = resolveCatastroxDuplicate({
        codigoPredial: '000000000000000000000000000017',
        ...branch,
        candidates,
      });
      assert.equal(result.equivalentCandidates.length, candidates.length);
      const sourceIds = result.equivalentCandidates.map((c) => `${c.source}::${c.sourceRecordId}`).sort();
      assert.deepEqual(sourceIds, ['clean::A1', 'legacy::L1']);
    }
  });

  // 16. Determinismo para equivalentes
  test('16) Misma entrada (en distinto orden) produce siempre el mismo selectedCandidate', () => {
    const candidatesOrderA = [
      { source: 'legacy', sourceRecordId: 'L1' },
      { source: 'clean', sourceRecordId: 'A1' },
      { source: 'clean', sourceRecordId: 'A0' },
    ];
    const candidatesOrderB = [
      { source: 'clean', sourceRecordId: 'A0' },
      { source: 'clean', sourceRecordId: 'A1' },
      { source: 'legacy', sourceRecordId: 'L1' },
    ];
    const base = {
      codigoPredial: '000000000000000000000000000018',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    };
    const resultA = resolveCatastroxDuplicate({ ...base, candidates: candidatesOrderA });
    const resultB = resolveCatastroxDuplicate({ ...base, candidates: candidatesOrderB });
    assert.deepEqual(resultA.selectedCandidate, resultB.selectedCandidate);
    assert.equal(resultA.resolutionStatus, resultB.resolutionStatus);
    assert.equal(resultA.candidateSelectionStatus, resultB.candidateSelectionStatus);
    assert.deepEqual(
      resultA.equivalentCandidates.map((c) => `${c.source}::${c.sourceRecordId}`),
      resultB.equivalentCandidates.map((c) => `${c.source}::${c.sourceRecordId}`),
    );
    // repetir la misma llamada produce exactamente el mismo resultado
    const resultA2 = resolveCatastroxDuplicate({ ...base, candidates: candidatesOrderA });
    assert.deepEqual(resultA.selectedCandidate, resultA2.selectedCandidate);
  });

  // 17. No mutacion del objeto de entrada
  test('17) resolveCatastroxDuplicate no muta el objeto de entrada ni sus arreglos anidados', () => {
    const input = Object.freeze({
      codigoPredial: '000000000000000000000000000019',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
      reasonCodes: ['SOME_UPSTREAM_CODE'],
      evidence: { overlapPct: 99.9 },
    });
    const snapshotBefore = JSON.parse(JSON.stringify(input));
    const result = resolveCatastroxDuplicate(input);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshotBefore);
    // el resultado esta congelado (Object.freeze) y no comparte referencia con la entrada
    assert.throws(() => { result.resolutionStatus = 'TAMPERED'; }, /Cannot assign|read only|frozen/i);
    assert.notEqual(result.selectedCandidate, input.candidates[0]);
  });

  // 18. Rechazo de estados desconocidos
  test('18) Rechaza geometryStatus/attributeStatus desconocidos y entrada invalida', () => {
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000020',
      geometryStatus: 'NOT_A_REAL_STATUS',
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    }), RangeError);
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000021',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: 'NOT_A_REAL_ATTRIBUTE',
    }), RangeError);
    assert.throws(() => resolveCatastroxDuplicate({
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    }), TypeError);
    assert.throws(() => resolveCatastroxDuplicate(null), TypeError);
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000022',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: 'not-an-array',
    }), TypeError);
  });

  // 19. Candidatos vacios
  test('19) candidates vacio se tolera fuera de EXACT + NONE, pero no dentro', () => {
    const withEmptyCandidatesBlocked = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000024',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.TERRITORIAL_CRITICAL,
      candidates: [],
    });
    assert.deepEqual([...withEmptyCandidatesBlocked.equivalentCandidates], []);
    assert.equal(withEmptyCandidatesBlocked.selectedCandidate, null);

    const withEmptyCandidatesPending = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000024b',
      geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [],
    });
    assert.equal(withEmptyCandidatesPending.selectedCandidate, null);

    // EXACT + NONE con candidates vacio o ausente es contractualmente incoherente
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000023',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    }), CatastroxResolverContractError);
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000023b',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [],
    }), CatastroxResolverContractError);
  });

  // 20. Reason codes sin duplicados
  test('20) reasonCodes nunca contiene duplicados, incluso fusionando con reasonCodes de entrada', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000025',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      reasonCodes: [REASON_CODE.MATERIAL_GEOMETRY_CONFLICT, REASON_CODE.MANUAL_REVIEW_REQUIRED, 'UPSTREAM_EXTRA'],
    });
    const codes = [...result.reasonCodes];
    assert.equal(codes.length, new Set(codes).size);
    assert.ok(codes.includes('UPSTREAM_EXTRA'));
  });

  // 21. PENDING_POLICY nunca se denomina RESOLVED_WITH_WARNING
  test('21) resolutionStatus nunca es RESOLVED_WITH_WARNING en V1; el estado activo es PENDING_POLICY', () => {
    const branches = [
      { geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION, attributeStatus: ATTRIBUTE_STATUS.NONE },
      { geometryStatus: GEOMETRY_STATUS.EXACT, attributeStatus: ATTRIBUTE_STATUS.COMPLEMENTARY },
      { geometryStatus: GEOMETRY_STATUS.EXACT, attributeStatus: ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT },
    ];
    for (const branch of branches) {
      const result = resolveCatastroxDuplicate({ codigoPredial: '000000000000000000000000000026', ...branch });
      assert.equal(result.resolutionStatus, RESOLUTION_STATUS.PENDING_POLICY);
      assert.notEqual(result.resolutionStatus, RESOLUTION_STATUS.RESOLVED_WITH_WARNING);
      assert.equal(result.resolutionStatus, RESOLUTION_STATUS.PENDING_POLICY);
      assert.notEqual(RESOLUTION_STATUS.PENDING_POLICY, RESOLUTION_STATUS.RESOLVED_WITH_WARNING);
    }
  });

  // 22. source ausente en EXACT + NONE
  test('22) EXACT + NONE con "source" ausente en un candidato -> CatastroxResolverContractError', () => {
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000027',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ sourceRecordId: 'A1' }],
    }), CatastroxResolverContractError);
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000027b',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: '   ', sourceRecordId: 'A1' }],
    }), CatastroxResolverContractError);
  });

  // 23. sourceRecordId ausente en EXACT + NONE
  test('23) EXACT + NONE con "sourceRecordId" ausente en un candidato -> CatastroxResolverContractError', () => {
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000028',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean' }],
    }), CatastroxResolverContractError);
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000028b',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: '' }],
    }), CatastroxResolverContractError);
  });

  // 24. Clave tecnica duplicada en EXACT + NONE
  test('24) EXACT + NONE con clave tecnica duplicada (source+sourceRecordId repetidos) -> CatastroxResolverContractError', () => {
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000029',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [
        { source: 'clean', sourceRecordId: 'A1' },
        { source: 'clean', sourceRecordId: 'A1' },
      ],
    }), CatastroxResolverContractError);
  });

  // 25. candidates vacio en EXACT + NONE (redundante con 19, verificado explicitamente aqui)
  test('25) EXACT + NONE con candidates=[] -> CatastroxResolverContractError, nunca AUTO_RESOLVED', () => {
    assert.throws(() => resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000030',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [],
    }), CatastroxResolverContractError);
  });

  // 26. Intento de mutar reasonCodes
  test('26) reasonCodes esta profundamente congelado: push y asignacion por indice lanzan', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000031',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
    });
    assert.throws(() => { result.reasonCodes.push('INTRUSO'); }, TypeError);
    assert.throws(() => { result.reasonCodes[0] = 'INTRUSO'; }, TypeError);
  });

  // 27. Intento de mutar deliverablesAllowed
  test('27) deliverablesAllowed esta profundamente congelado', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000032',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.throws(() => { result.deliverablesAllowed.pdf = false; }, TypeError);
    assert.throws(() => { result.deliverablesAllowed.nuevoCampo = true; }, TypeError);
  });

  // 28. Intento de mutar equivalentCandidates
  test('28) equivalentCandidates esta profundamente congelado, incluyendo cada candidato anidado', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000033',
      geometryStatus: GEOMETRY_STATUS.MATERIAL_CONFLICT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.throws(() => { result.equivalentCandidates.push({ source: 'x', sourceRecordId: 'y' }); }, TypeError);
    assert.throws(() => { result.equivalentCandidates[0].source = 'INTRUSO'; }, TypeError);
  });

  // 29. Intento de mutar selectedCandidate
  test('29) selectedCandidate esta profundamente congelado', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000034',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1' }],
    });
    assert.throws(() => { result.selectedCandidate.source = 'INTRUSO'; }, TypeError);
    assert.throws(() => { result.selectedCandidate.nuevoCampo = true; }, TypeError);
  });

  // 30. El objeto de entrada permanece intacto tras la llamada (redundante con 17,
  // verificado explicitamente para candidatos con objetos anidados adicionales)
  test('30) el objeto de entrada y sus candidatos anidados permanecen intactos y siguen siendo mutables', () => {
    const input = {
      codigoPredial: '000000000000000000000000000035',
      geometryStatus: GEOMETRY_STATUS.EXACT,
      attributeStatus: ATTRIBUTE_STATUS.NONE,
      candidates: [{ source: 'clean', sourceRecordId: 'A1', meta: { nested: true } }],
    };
    resolveCatastroxDuplicate(input);
    // el input original nunca se congela ni se muta: sigue siendo perfectamente mutable
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(input.candidates[0]), false);
    input.candidates[0].meta.nested = false;
    assert.equal(input.candidates[0].meta.nested, false);
  });

  // 31. reasonCodes permanecen unicos tras fusionar con upstream (redundante con 20,
  // verificado tambien para el reason code family de NORMALIZATION_SUSPECT)
  test('31) reasonCodes permanecen unicos incluso cuando upstream repite el mismo codigo de familia', () => {
    const result = resolveCatastroxDuplicate({
      codigoPredial: '000000000000000000000000000036',
      geometryStatus: GEOMETRY_STATUS.MINIMAL_VARIATION,
      attributeStatus: ATTRIBUTE_STATUS.NORMALIZATION_SUSPECT,
      reasonCodes: [REASON_CODE.ZONE_NORMALIZATION_SUSPECT, REASON_CODE.ZONE_NORMALIZATION_SUSPECT],
    });
    const codes = [...result.reasonCodes];
    assert.equal(codes.length, new Set(codes).size);
    assert.equal(codes.filter((c) => c === REASON_CODE.ZONE_NORMALIZATION_SUSPECT).length, 1);
  });
});
