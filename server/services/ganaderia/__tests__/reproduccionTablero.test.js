// FASE 4C -- tablero reproductivo sin base de datos: umbrales configurados,
// validación de la query, serialización de filas/alertas e invariantes del
// SQL (una CTE compartida, laterales de una fila, sin N+1, sin legacy).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ALERTAS_REPRODUCCION,
  CODIGOS_ALERTA_REPRODUCCION,
  CONFIGURACION_ALERTAS_REPRODUCCION,
  ESTADOS_TABLERO,
  validateListadoTableroQuery,
  validateResumenTableroQuery,
} from '../reproduccionAlertas.js';
import { COLUMNA_ALERTA, serializeFilaTablero, tableroCte } from '../reproduccionTableroRepository.js';

const fuenteRepo = fs.readFileSync(new URL('../reproduccionTableroRepository.js', import.meta.url), 'utf8');
const fuenteRouter = fs.readFileSync(new URL('../../../routes/ganaderiaReproduccion.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../../../index.js', import.meta.url), 'utf8');

test('umbrales operativos aprobados (Fase 4C), congelados y documentados como provisionales', () => {
  assert.deepEqual({ ...CONFIGURACION_ALERTAS_REPRODUCCION }, { diasDiagnosticoPendiente: 35, diasPartoProximo: 30, edadMinimaSinSeguimientoMeses: 12 });
  assert.ok(Object.isFrozen(CONFIGURACION_ALERTAS_REPRODUCCION));
  const fuente = fs.readFileSync(new URL('../reproduccionAlertas.js', import.meta.url), 'utf8');
  assert.match(fuente, /UMBRALES PROVISIONALES CONFIGURABLES/);
  assert.match(fuente, /No son una recomendación veterinaria/);
});

test('alertas y niveles simples (sin semáforos clínicos)', () => {
  assert.deepEqual(CODIGOS_ALERTA_REPRODUCCION, ['PARTO_PROXIMO', 'DIAGNOSTICO_DUDOSO', 'DIAGNOSTICO_PENDIENTE', 'SIN_SEGUIMIENTO_REPRODUCTIVO']);
  assert.deepEqual(new Set(Object.values(ALERTAS_REPRODUCCION)), new Set(['ATENCION', 'PROXIMA_ACCION', 'INFORMATIVA']));
  assert.deepEqual(Object.keys(COLUMNA_ALERTA).sort(), [...CODIGOS_ALERTA_REPRODUCCION].sort());
  assert.deepEqual(ESTADOS_TABLERO, ['SIN_ESTADO', 'CICLANDO', 'SERVIDA', 'PRENADA', 'VACIA', 'POSPARTO']);
});

test('query del listado: por defecto ACTIVO + EN_HATO, página 50', () => {
  assert.deepEqual(validateListadoTableroQuery({}), {
    predioId: null, estadoReproductivo: null, alerta: null, q: null, situacion: 'EN_HATO', registro: 'ACTIVO', limit: 50, offset: 0,
  });
  assert.deepEqual(validateListadoTableroQuery({
    predioId: '7', estadoReproductivo: 'PRENADA', alerta: 'PARTO_PROXIMO', q: '  tb   01 ', situacion: 'TODOS', registro: 'TODOS', limit: '10', offset: '20',
  }), { predioId: '7', estadoReproductivo: 'PRENADA', alerta: 'PARTO_PROXIMO', q: 'tb 01', situacion: 'TODOS', registro: 'TODOS', limit: 10, offset: 20 });
});

test('query inválida -> 400 INVALID_QUERY (sin organizacionId del cliente)', () => {
  const casos = [
    { organizacionId: 'x' }, { estadoReproductivo: 'NO_APLICA' }, { alerta: 'CRITICA' }, { situacion: 'VENDIDO' }, { registro: 'BORRADO' },
    { limit: '0' }, { limit: '201' }, { offset: '-1' }, { predioId: 'abc' }, { q: 'x'.repeat(81) }, { estadoReproductivo: ['PRENADA'] },
  ];
  for (const query of casos) {
    assert.throws(() => validateListadoTableroQuery(query), (e) => e.status === 400 && e.code === 'INVALID_QUERY', JSON.stringify(query));
  }
  assert.deepEqual(validateResumenTableroQuery({ predioId: '3' }), { predioId: '3' });
  assert.throws(() => validateResumenTableroQuery({ estadoReproductivo: 'PRENADA' }), (e) => e.code === 'INVALID_QUERY');
});

test('fila pública: alertas en orden de prioridad con nivel, fecha y días; nada interno', () => {
  const fila = serializeFilaTablero({
    animal_id: '9', numero_visual: 'TB-9', nombre: null, predio_id: '2', nombre_predio: 'La Esperanza',
    estado: 'ACTIVO', estado_operativo: 'EN_HATO', estado_reproductivo: 'PRENADA',
    ue_tipo: 'DIAGNOSTICO_PRENEZ', ue_fecha: '2026-10-01', us_tipo: 'IATF', us_fecha: '2026-02-01',
    ud_resultado: 'DUDOSA', ud_fecha: '2026-10-01', ud_dias: null, up_fecha: null, up_crias: null,
    gestacion_base: 'SERVICIO', concepcion: '2026-02-01', fecha_probable_parto: '2026-11-11',
    dias_gestacion_estimados: 274, dias_desde_servicio: 274, dias_para_parto: 9,
    alerta_diagnostico_pendiente: false, alerta_parto_proximo: true, alerta_diagnostico_dudoso: true, alerta_sin_seguimiento: false,
  });
  assert.deepEqual(fila.alertas, [
    { codigo: 'PARTO_PROXIMO', nivel: 'ATENCION', fecha: '2026-11-11', dias: 9 },
    { codigo: 'DIAGNOSTICO_DUDOSO', nivel: 'ATENCION', fecha: '2026-10-01', dias: null },
  ]);
  assert.deepEqual(fila.gestacion, { base: 'SERVICIO', fechaConcepcionEstimada: '2026-02-01', diasEstimados: 274, fechaProbableParto: '2026-11-11' });
  assert.equal(fila.ultimoParto, null);
  assert.equal(JSON.stringify(fila).includes('organizacion'), false);
});

test('SQL: una CTE compartida por listado y KPIs, laterales de una fila, umbrales como parámetros', () => {
  const cte = tableroCte('a.estado = $7');
  assert.equal((cte.match(/left join lateral/g) ?? []).length, 6);
  assert.equal((cte.match(/limit 1/g) ?? []).length, 6);
  assert.match(cte, /e\.estado_registro = 'ACTIVO'/);
  assert.match(cte, /a\.sexo = 'HEMBRA' and a\.estado = \$7/);
  assert.match(cte, /order by e\.fecha_evento desc, e\.evento_id desc/);
  // Sin umbrales literales en el SQL: llegan como $2..$6.
  assert.doesNotMatch(cte, /\b(35|30|12|283)\b/);
  assert.equal((fuenteRepo.match(/tableroCte\(/g) ?? []).length, 3); // definición + listado + resumen
  assert.match(fuenteRepo, /withOrganizacionTransaction/);
  assert.doesNotMatch(fuenteRepo, /server\/db\.js'|from '\.\.\/\.\.\/db\.js'/);
  assert.doesNotMatch(fuenteRepo, /for \(const .* of .*\) \{[^}]*client\.query/);
});

test('router: solo GET, lectura para los 4 roles, tenant de la sesión, sin CSRF en lectura', () => {
  assert.doesNotMatch(fuenteRouter, /router\.(post|put|patch|delete)\(/);
  assert.match(fuenteRouter, /router\.use\(createRequireLectura\(\)\)/);
  assert.match(fuenteRouter, /req\.ganaderiaAuth\.organizacionId/);
  assert.doesNotMatch(fuenteRouter, /req\.(query|body|headers)\.organizacion/);
  assert.match(index, /'\/api\/ganaderia\/reproduccion',\s*\n\s*createGanaderiaReproduccionRouter/);
});
