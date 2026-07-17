import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __clearLookupStateForTests,
  __getLookupByCodeRateStoreSizeForTests,
  __getLookupPreviewForTests,
  buildLookupByCodeQuery,
  createLookupByCodeSuccessState,
  enforceLookupByCodeRateLimit,
  findPredioByCadastralCode,
  normalizeCadastralCodeInput,
  purgeExpiredLookupByCodeRateEntries,
  resolveExactFullResultByCodeRows,
  resolveLookupByCodeCandidates,
  validateCadastralCodeInput,
} from '../catastrox.js';

function makeCandidate(overrides = {}) {
  return {
    codigo_predial: '181500003000000130054000000000',
    codigo_anterior: '18150000300130054000',
    municipio_dane: '18150',
    municipio_nombre: 'CARTAGENA DEL CHAIRA',
    departamento_nombre: 'CAQUETA',
    zona: 'rural',
    query_lat: 0.332450293,
    query_lng: -74.113824162,
    area_m2_exact: 34926.71754,
    perimetro_m_exact: 2327.96,
    part_count: 8,
    bbox_wkt: 'POLYGON((1 1,2 1,2 2,1 2,1 1))',
    geometry_fingerprint: 'geom-fingerprint-1',
    ...overrides,
  };
}

function makeReq(ip = '127.0.0.1') {
  return {
    ip,
    socket: { remoteAddress: ip },
    connection: { remoteAddress: ip },
  };
}

test('normaliza espacios, tabs y guiones sin perder ceros', () => {
  assert.equal(
    normalizeCadastralCodeInput('  0018-1500 0300-1300\t54000  '),
    '001815000300130054000',
  );
});

test('valida exactamente 20 o 30 dígitos', () => {
  assert.equal(validateCadastralCodeInput('18150000300130054000'), '18150000300130054000');
  assert.equal(validateCadastralCodeInput('181500003000000130054000000000'), '181500003000000130054000000000');
  assert.throws(
    () => validateCadastralCodeInput('181500003001300054000'),
    /20 o 30 dígitos/,
  );
});

test('selecciona codigo_anterior para 20 dígitos y codigo_predial para 30', () => {
  const q20 = buildLookupByCodeQuery('18150000300130054000');
  const q30 = buildLookupByCodeQuery('181500003000000130054000000000');
  assert.equal(q20.column, 'codigo_anterior');
  assert.match(q20.sql, /where codigo_anterior = \$1/i);
  assert.equal(q20.params[0], '18150000300130054000');
  assert.equal(q30.column, 'codigo_predial');
  assert.match(q30.sql, /where codigo_predial = \$1/i);
  assert.equal(q30.params[0], '181500003000000130054000000000');
  assert.doesNotMatch(q20.sql, /\blike\b|\bilike\b/i);
  assert.doesNotMatch(q30.sql, /\blike\b|\bilike\b/i);
  assert.match(q30.sql, /geometry_fingerprint/i);
});

test('sin filas devuelve not_found', () => {
  const result = resolveLookupByCodeCandidates([], '18150000300130054000');
  assert.equal(result.outcome, 'not_found');
});

test('una fila válida resuelve predio canónico y queryPoint', () => {
  const result = resolveLookupByCodeCandidates([makeCandidate()], '181500003000000130054000000000');
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.canonicalCode, '181500003000000130054000000000');
  assert.equal(result.candidate.municipio, 'CARTAGENA DEL CHAIRA');
  assert.deepEqual(result.candidate.queryPoint, {
    lat: 0.332450293,
    lng: -74.113824162,
  });
});

test('codigo anterior uno-a-varios se bloquea por múltiples códigos canónicos', () => {
  const result = resolveLookupByCodeCandidates(
    [
      makeCandidate({ codigo_predial: '182560001000000000001000000000' }),
      makeCandidate({ codigo_predial: '182560001000000000002000000000' }),
    ],
    '18256000100030214000',
  );
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.reason, 'MULTIPLE_CANONICAL_CODES');
});

test('mismo código actual con conflicto territorial se bloquea', () => {
  const result = resolveLookupByCodeCandidates(
    [
      makeCandidate(),
      makeCandidate({ zona: 'urbano' }),
    ],
    '181500003000000130054000000000',
  );
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
});

test('mismas métricas y bbox, pero huella distinta se bloquea', () => {
  const result = resolveLookupByCodeCandidates(
    [
      makeCandidate({ geometry_fingerprint: 'geom-a' }),
      makeCandidate({ geometry_fingerprint: 'geom-b' }),
    ],
    '181500003000000130054000000000',
  );
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
});

test('misma huella y mismo código/territorio sigue resoluble', () => {
  const result = resolveLookupByCodeCandidates(
    [
      makeCandidate({ geometry_fingerprint: 'geom-same' }),
      makeCandidate({ geometry_fingerprint: 'geom-same', query_lat: 9.999, query_lng: -9.999 }),
    ],
    '181500003000000130054000000000',
  );
  assert.equal(result.outcome, 'resolved');
});

// =====================================================================
// CX-LOGIC-002: canonicalText colapsa null/undefined/''/espacios al mismo
// valor '', por lo que dos candidatos con un campo de identidad AUSENTE en
// ambos podian tratarse como "iguales" en ese campo sin evidencia real.
// Estos tests cubren exactamente ese defecto, con datos 100% sinteticos.
// =====================================================================

test('CX-LOGIC-002 A. control positivo: territorio+zona+huella completos e iguales -> resolved, sin importar el orden', () => {
  const candidateA = makeCandidate({ query_lat: 1.1, query_lng: -75.1 });
  const candidateB = makeCandidate({ query_lat: 1.1, query_lng: -75.1 });

  const resultAB = resolveLookupByCodeCandidates([candidateA, candidateB], '181500003000000130054000000000');
  const resultBA = resolveLookupByCodeCandidates([candidateB, candidateA], '181500003000000130054000000000');

  assert.equal(resultAB.outcome, 'resolved');
  assert.equal(resultBA.outcome, 'resolved');
});

test('CX-LOGIC-002 B. caso adversarial completo: territorio/zona/huella ausentes en ambos, atributos distintos -> ambiguous en ambos ordenes', () => {
  const candidateA = makeCandidate({
    municipio_dane: null,
    municipio_nombre: null,
    departamento_nombre: null,
    zona: null,
    geometry_fingerprint: null,
    bbox_wkt: 'POLYGON((0 0,1 0,1 1,0 1,0 0))', // geometria conceptualmente distinta de B
    nombre_predio_sintetico: 'PREDIO-A',
  });
  const candidateB = makeCandidate({
    municipio_dane: undefined,
    municipio_nombre: '',
    departamento_nombre: '   ', // solo espacios
    zona: null,
    geometry_fingerprint: '',
    bbox_wkt: 'POLYGON((10 10,11 10,11 11,10 11,10 10))', // geometria conceptualmente distinta de A
    nombre_predio_sintetico: 'PREDIO-B',
  });

  const resultAB = resolveLookupByCodeCandidates([candidateA, candidateB], '181500003000000130054000000000');
  const resultBA = resolveLookupByCodeCandidates([candidateB, candidateA], '181500003000000130054000000000');

  assert.equal(resultAB.outcome, 'ambiguous');
  assert.equal(resultAB.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
  assert.equal(resultBA.outcome, 'ambiguous');
  assert.equal(resultBA.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
  // Ninguna fila se selecciona arbitrariamente: 'resolved' no aparece en
  // ningun orden, y el resultado no expone un 'candidate' construido sobre
  // una fila elegida por posicion.
  assert.equal(resultAB.candidate, undefined);
  assert.equal(resultBA.candidate, undefined);
});

test('CX-LOGIC-002 C. geometry_fingerprint ausente en ambos candidatos (territorio identico, geometrias validas distintas) -> ambiguous en ambos ordenes', () => {
  const candidateA = makeCandidate({ geometry_fingerprint: null, bbox_wkt: 'POLYGON((0 0,1 0,1 1,0 1,0 0))' });
  const candidateB = makeCandidate({ geometry_fingerprint: undefined, bbox_wkt: 'POLYGON((5 5,6 5,6 6,5 6,5 5))' });

  const resultAB = resolveLookupByCodeCandidates([candidateA, candidateB], '181500003000000130054000000000');
  const resultBA = resolveLookupByCodeCandidates([candidateB, candidateA], '181500003000000130054000000000');

  assert.equal(resultAB.outcome, 'ambiguous');
  assert.equal(resultBA.outcome, 'ambiguous');
});

test('CX-LOGIC-002 D. asimetria: un candidato con campo ausente y otro con valor real -> ambiguous en ambos ordenes', () => {
  const candidateAusente = makeCandidate({ municipio_nombre: null });
  const candidateReal = makeCandidate({ municipio_nombre: 'CARTAGENA DEL CHAIRA' });

  const resultAB = resolveLookupByCodeCandidates([candidateAusente, candidateReal], '181500003000000130054000000000');
  const resultBA = resolveLookupByCodeCandidates([candidateReal, candidateAusente], '181500003000000130054000000000');

  assert.equal(resultAB.outcome, 'ambiguous');
  assert.equal(resultAB.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
  assert.equal(resultBA.outcome, 'ambiguous');
  assert.equal(resultBA.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
});

test('CX-LOGIC-002 F. conflicto real y completo en territorio o huella sigue bloqueando (sin regresion)', () => {
  const porZona = resolveLookupByCodeCandidates(
    [makeCandidate({ zona: 'rural' }), makeCandidate({ zona: 'urbano' })],
    '181500003000000130054000000000',
  );
  assert.equal(porZona.outcome, 'ambiguous');
  assert.equal(porZona.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');

  const porHuella = resolveLookupByCodeCandidates(
    [makeCandidate({ geometry_fingerprint: 'geom-a' }), makeCandidate({ geometry_fingerprint: 'geom-b' })],
    '181500003000000130054000000000',
  );
  assert.equal(porHuella.outcome, 'ambiguous');
  assert.equal(porHuella.reason, 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA');
});

test('CX-LOGIC-002 G. candidato unico sigue resolviendo sin regresion', () => {
  const result = resolveLookupByCodeCandidates([makeCandidate()], '181500003000000130054000000000');
  assert.equal(result.outcome, 'resolved');
});

test('CX-LOGIC-002 H. resolveExactFullResultByCodeRows con identidad incompleta nunca devuelve una fila por posicion', () => {
  const candidateA = makeCandidate({
    municipio_dane: null,
    municipio_nombre: null,
    departamento_nombre: null,
    zona: null,
    geometry_fingerprint: null,
    direccion_sintetica: 'DIRECCION-A',
  });
  const candidateB = makeCandidate({
    municipio_dane: null,
    municipio_nombre: null,
    departamento_nombre: null,
    zona: null,
    geometry_fingerprint: null,
    direccion_sintetica: 'DIRECCION-B',
  });

  const resultAB = resolveExactFullResultByCodeRows([candidateA, candidateB], '181500003000000130054000000000');
  const resultBA = resolveExactFullResultByCodeRows([candidateB, candidateA], '181500003000000130054000000000');

  assert.equal(resultAB.outcome, 'ambiguous');
  assert.equal(resultBA.outcome, 'ambiguous');
  assert.equal(resultAB.row, undefined, 'no debe seleccionar DIRECCION-A por posicion');
  assert.equal(resultBA.row, undefined, 'no debe seleccionar DIRECCION-B por posicion');
});

test('full-result exacto por código conserva el codigoPredial almacenado aunque el queryPoint cubra otra geometría', () => {
  const exactRows = [
    makeCandidate({
      codigo_predial: '180290101000000510008000000000',
      codigo_anterior: '18029010100510008000',
      geometry_fingerprint: 'urban-geom-1',
      query_lat: 1.234,
      query_lng: -75.123,
    }),
  ];
  const result = resolveExactFullResultByCodeRows(exactRows, '180290101000000510008000000000');
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.row.codigo_predial, '180290101000000510008000000000');
});

test('findPredioByCadastralCode conserva ceros iniciales y usa consulta parametrizada', async () => {
  let capturedSql = '';
  let capturedParams = null;
  const queryImpl = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [makeCandidate({ codigo_anterior: '00000000000000000000' })] };
  };

  const result = await findPredioByCadastralCode('00000000000000000000', queryImpl);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.column, 'codigo_anterior');
  assert.equal(capturedParams[0], '00000000000000000000');
  assert.match(capturedSql, /where codigo_anterior = \$1/i);
});

test('createLookupByCodeSuccessState guarda searchType code y queriedCode para full-result posterior', () => {
  __clearLookupStateForTests();
  const payload = createLookupByCodeSuccessState(
    'cx-test-lookup',
    '18150000300130054000',
    {
      codigoPredial: '181500003000000130054000000000',
      municipio: 'CARTAGENA DEL CHAIRA',
      departamento: 'CAQUETA',
      zona: 'rural',
      queryPoint: { lat: 0.332450293, lng: -74.113824162 },
    },
  );

  const preview = __getLookupPreviewForTests('cx-test-lookup');
  assert.equal(preview.source, 'clean');
  assert.equal(preview.codigoPredial, '181500003000000130054000000000');
  assert.equal(preview.searchType, 'code');
  assert.equal(preview.queriedCode, '18150000300130054000');
  assert.deepEqual(preview.queryPoint, { lat: 0.332450293, lng: -74.113824162 });
  assert.equal(payload.lookup_id, 'cx-test-lookup');
  assert.equal(payload.canPurchase, true);
  assert.equal(payload.predio.previewMapUrl, '/api/catastrox/lookups/cx-test-lookup/preview-map');
});

test('solicitud 30 permitida y 31 bloqueada con 429', () => {
  __clearLookupStateForTests();
  const req = makeReq('10.0.0.1');
  for (let index = 0; index < 30; index += 1) {
    enforceLookupByCodeRateLimit(req, 1_000 + index);
  }
  assert.throws(
    () => enforceLookupByCodeRateLimit(req, 1_050),
    (error) => error?.status === 429 && error?.publicCode === 'RATE_LIMITED_CADASTRAL_LOOKUP',
  );
});

test('ventana vencida reinicia el contador', () => {
  __clearLookupStateForTests();
  const req = makeReq('10.0.0.2');
  for (let index = 0; index < 30; index += 1) {
    enforceLookupByCodeRateLimit(req, 2_000);
  }
  enforceLookupByCodeRateLimit(req, 2_000 + (10 * 60 * 1000) + 1);
});

test('entradas vencidas se eliminan del store', () => {
  __clearLookupStateForTests();
  enforceLookupByCodeRateLimit(makeReq('10.0.0.3'), 3_000);
  enforceLookupByCodeRateLimit(makeReq('10.0.0.4'), 3_000);
  assert.equal(__getLookupByCodeRateStoreSizeForTests(), 2);
  purgeExpiredLookupByCodeRateEntries(3_000 + (10 * 60 * 1000) + 1);
  assert.equal(__getLookupByCodeRateStoreSizeForTests(), 0);
});

test('normalizar el código no permite evadir el límite', () => {
  __clearLookupStateForTests();
  const normalizedA = validateCadastralCodeInput('1802901010-0510 008000');
  const normalizedB = validateCadastralCodeInput('18029010100510008000');
  assert.equal(normalizedA, normalizedB);
  const req = makeReq('10.0.0.5');
  for (let index = 0; index < 30; index += 1) {
    const submitted = index % 2 === 0 ? normalizedA : normalizedB;
    assert.equal(validateCadastralCodeInput(submitted), '18029010100510008000');
    enforceLookupByCodeRateLimit(req, 4_000);
  }
  assert.throws(
    () => enforceLookupByCodeRateLimit(req, 4_000),
    (error) => error?.status === 429,
  );
});
