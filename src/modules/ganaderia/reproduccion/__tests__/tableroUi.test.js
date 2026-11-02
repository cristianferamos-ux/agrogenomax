// FASE 4C: tablero reproductivo de la organización (UI). Modelo puro +
// invariantes por fuente (no hay jsdom en el repo), como el resto de
// pruebas de ganadería.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ETIQUETAS_ALERTA,
  ETIQUETAS_NIVEL,
  FILTROS_RAPIDOS,
  MENSAJE_CARGA_TABLERO,
  anexarPagina,
  cargarVigente,
  crearSecuencia,
  esFiltroAlerta,
  estadoLista,
  estadoResumen,
  filtrosConSituacion,
  kpisDe,
  presentarAlerta,
  queryListado,
  resultadoCarga,
  rutaFichaReproduccion,
  tarjetaAnimal,
  textoUmbrales,
  textoVacio,
} from '../tableroModel.js';
import { MENSAJE_SIN_CONEXION, MENSAJE_SIN_PERMISOS } from '../../api/errorModel.js';
import { CODIGOS_ALERTA_REPRODUCCION, CONFIGURACION_ALERTAS_REPRODUCCION, ESTADOS_TABLERO, validateListadoTableroQuery } from '../../../../../server/services/ganaderia/reproduccionAlertas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..');
const GAN = path.resolve(DIR, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const leer = (...p) => strip(fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'));
const pagina = leer(DIR, 'ReproduccionTableroPage.jsx');
const app = leer(GAN, 'GanaderiaApp.jsx');
const sidebar = leer(GAN, 'components', 'GanaderiaSidebar.jsx');
const detalle = leer(GAN, 'hato', 'HatoDetallePage.jsx');
const api = fs.readFileSync(path.join(GAN, 'hato', 'hatoApi.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(GAN, 'styles', 'ganaderia-hato.css'), 'utf8').replace(/\r\n/g, '\n');

const CORRELATION = 'abcdef12-3456-4789-8abc-def012345678';
const RESUMEN = Object.freeze({
  ok: true,
  fecha: '2026-11-02',
  configuracion: { ...CONFIGURACION_ALERTAS_REPRODUCCION },
  hembrasEnSeguimiento: 12,
  porEstado: { SIN_ESTADO: 3, CICLANDO: 1, SERVIDA: 3, PRENADA: 4, VACIA: 0, POSPARTO: 1 },
  porAlerta: { PARTO_PROXIMO: 2, DIAGNOSTICO_DUDOSO: 1, DIAGNOSTICO_PENDIENTE: 1, SIN_SEGUIMIENTO_REPRODUCTIVO: 2 },
});
const FILA = Object.freeze({
  animalId: '11', numeroVisual: 'TB-11', nombre: 'Lucera', predioId: '2', predioNombre: 'La Esperanza',
  estadoReproductivo: 'PRENADA', estadoOperativo: 'EN_HATO', estadoRegistro: 'ACTIVO',
  ultimoEvento: { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-04-16' },
  ultimoServicio: { tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-02-05' },
  ultimoDiagnostico: { resultado: 'PRENADA', fechaEvento: '2026-04-16', diasGestacion: null },
  ultimoParto: null,
  gestacion: { base: 'SERVICIO', fechaConcepcionEstimada: '2026-02-05', diasEstimados: 270, fechaProbableParto: '2026-11-15' },
  alertas: [{ codigo: 'PARTO_PROXIMO', nivel: 'ATENCION', fecha: '2026-11-15', dias: 13 }],
});

// ---------------------------------------------------------------------------
// KPIs y filtros
// ---------------------------------------------------------------------------

test('KPIs: hembras en seguimiento + los 6 estados + 3 alertas, con valores del backend', () => {
  const kpis = kpisDe(RESUMEN);
  assert.deepEqual(kpis.map((k) => [k.label, k.valor]), [
    ['Hembras en seguimiento', 12], ['Sin estado', 3], ['Ciclando', 1], ['Servidas', 3], ['Preñadas', 4], ['Vacías', 0],
    ['Posparto', 1], ['Diagnóstico pendiente', 1], ['Próximas a parto', 2], ['Diagnóstico dudoso', 1],
  ]);
  assert.deepEqual(kpis.filter((k) => k.alerta).map((k) => k.id), ['DIAGNOSTICO_PENDIENTE', 'PARTO_PROXIMO', 'DIAGNOSTICO_DUDOSO']);
  assert.deepEqual(kpisDe(null), []);
  // Cada KPI es también un filtro rápido (misma lógica que el listado).
  assert.match(pagina, /onClick=\{\(\) => setFiltros\(\(f\) => \(\{ \.\.\.f, filtro: k\.id, situacion: 'EN_HATO' \}\)\)\}/);
});

test('filtros rápidos: los 10 pedidos, cada uno es una consulta válida al backend', () => {
  assert.deepEqual(FILTROS_RAPIDOS.map((f) => f.label), [
    'Todos', 'Sin estado', 'Ciclando', 'Servidas', 'Preñadas', 'Vacías', 'Posparto', 'Diagnóstico pendiente', 'Próximas a parto', 'Diagnóstico dudoso',
  ]);
  for (const f of FILTROS_RAPIDOS) {
    const query = queryListado({ filtro: f.id });
    assert.doesNotThrow(() => validateListadoTableroQuery(query), f.id);
    if (f.query.estadoReproductivo) assert.ok(ESTADOS_TABLERO.includes(f.query.estadoReproductivo));
    if (f.query.alerta) assert.ok(CODIGOS_ALERTA_REPRODUCCION.includes(f.query.alerta));
  }
});

test('query del listado: sin parámetros vacíos; predio, búsqueda, histórico y paginación', () => {
  assert.deepEqual(queryListado({}), { limit: '50' });
  assert.deepEqual(queryListado({ filtro: 'PRENADA', predioId: '4', q: '  tb ', situacion: 'SALIDO' }, { offset: 50 }), {
    estadoReproductivo: 'PRENADA', predioId: '4', q: 'tb', situacion: 'SALIDO', limit: '50', offset: '50',
  });
  assert.deepEqual(queryListado({ filtro: 'PARTO_PROXIMO' }), { alerta: 'PARTO_PROXIMO', limit: '50' });
  assert.doesNotThrow(() => validateListadoTableroQuery(queryListado({ filtro: 'DIAGNOSTICO_DUDOSO', predioId: '4', q: 'x', situacion: 'MUERTO' }, { offset: 100 })));
});

test('histórico: un filtro de alerta vuelve a "Todos" y los chips de alerta se deshabilitan; los de estado se conservan', () => {
  const base = { filtro: 'PARTO_PROXIMO', predioId: '', q: '', situacion: 'EN_HATO' };
  assert.deepEqual(filtrosConSituacion(base, 'SALIDO'), { ...base, situacion: 'SALIDO', filtro: 'TODOS' });
  assert.equal(filtrosConSituacion({ ...base, filtro: 'PRENADA' }, 'MUERTO').filtro, 'PRENADA');
  assert.equal(filtrosConSituacion(base, 'EN_HATO').filtro, 'PARTO_PROXIMO');
  assert.deepEqual(FILTROS_RAPIDOS.filter((f) => esFiltroAlerta(f.id)).map((f) => f.id), ['DIAGNOSTICO_PENDIENTE', 'PARTO_PROXIMO', 'DIAGNOSTICO_DUDOSO']);
  assert.match(pagina, /disabled=\{historico && esFiltroAlerta\(f\.id\)\}/);
  assert.match(pagina, /setFiltros\(\(f\) => filtrosConSituacion\(f, event\.target\.value\)\)/);
});

test('los filtros reflejan el backend: nunca se filtra lo cargado en el navegador', () => {
  assert.match(pagina, /listTableroReproductivo\(queryListado\(filtros\)\)/);
  assert.match(pagina, /useEffect\(\(\) => \{ cargarLista\(\); \}, \[cargarLista\]\)/);
  assert.doesNotMatch(pagina, /animales\.filter\(/);
  assert.match(api, /\$\{BASE\}\/reproduccion\/animales/);
  assert.match(api, /\$\{BASE\}\/reproduccion\/resumen/);
});

// ---------------------------------------------------------------------------
// Alertas y tarjetas
// ---------------------------------------------------------------------------

test('alerta diagnóstico pendiente: "Programar diagnóstico de preñez." con fecha y días del servicio', () => {
  const a = presentarAlerta({ codigo: 'DIAGNOSTICO_PENDIENTE', nivel: 'PROXIMA_ACCION', fecha: '2026-09-28', dias: 35 });
  assert.equal(a.titulo, 'Diagnóstico pendiente');
  assert.equal(a.nivelTexto, 'Próxima acción');
  assert.equal(a.mensaje, 'Programar diagnóstico de preñez (servicio del 28/09/2026, hace 35 días).');
});

test('alerta parto próximo: "Parto estimado para dd/mm/yyyy." y vencido', () => {
  assert.equal(presentarAlerta({ codigo: 'PARTO_PROXIMO', nivel: 'ATENCION', fecha: '2026-11-15', dias: 13 }).mensaje, 'Parto estimado para 15/11/2026.');
  assert.equal(presentarAlerta({ codigo: 'PARTO_PROXIMO', nivel: 'ATENCION', fecha: '2026-10-26', dias: -7 }).mensaje, 'Parto estimado vencido el 26/10/2026.');
  assert.equal(presentarAlerta({ codigo: 'PARTO_PROXIMO', nivel: 'ATENCION', fecha: '2026-11-02', dias: 0 }).mensaje, 'Parto estimado para 02/11/2026.');
});

test('alerta dudosa y sin historial; niveles simples; código desconocido nunca crudo', () => {
  assert.deepEqual(presentarAlerta({ codigo: 'DIAGNOSTICO_DUDOSO', nivel: 'ATENCION', fecha: '2026-10-01' }), {
    codigo: 'DIAGNOSTICO_DUDOSO', nivel: 'ATENCION', titulo: 'Diagnóstico dudoso', nivelTexto: 'Atención', mensaje: 'Requiere nuevo diagnóstico.',
  });
  assert.equal(presentarAlerta({ codigo: 'SIN_SEGUIMIENTO_REPRODUCTIVO', nivel: 'INFORMATIVA' }).nivelTexto, 'Informativa');
  assert.equal(presentarAlerta({ codigo: 'CRITICO', nivel: 'ATENCION' }), null);
  assert.deepEqual(Object.values(ETIQUETAS_NIVEL), ['Atención', 'Próxima acción', 'Informativa']);
  assert.deepEqual(Object.keys(ETIQUETAS_ALERTA).sort(), [...CODIGOS_ALERTA_REPRODUCCION].sort());
  assert.doesNotMatch(JSON.stringify(ETIQUETAS_NIVEL), /cr[ií]tic|rojo|urgente/i);
});

test('tarjeta: identidad, predio, estado, datos clave (sin recalcular fechas) y alertas', () => {
  const t = tarjetaAnimal(FILA);
  assert.equal(t.identidad, 'TB-11 · Lucera');
  assert.equal(t.predio, 'La Esperanza');
  assert.equal(t.estadoTexto, 'Preñada');
  assert.deepEqual(t.datos, [
    ['Último servicio', 'Inseminación artificial · 05/02/2026'],
    ['Último diagnóstico', 'Preñada · 16/04/2026'],
    ['Parto probable', '15/11/2026'],
  ]);
  assert.deepEqual(t.alertas.map((a) => a.mensaje), ['Parto estimado para 15/11/2026.']);
  assert.equal(t.cerrado, null);
  assert.equal(tarjetaAnimal({ ...FILA, estadoOperativo: 'SALIDO', alertas: [] }).cerrado, 'Salido');
  const sinEventos = tarjetaAnimal({ ...FILA, numeroVisual: null, nombre: 'Rosa', estadoReproductivo: 'SIN_ESTADO', ultimoEvento: null, ultimoServicio: null, ultimoDiagnostico: null, gestacion: null, alertas: [] });
  assert.equal(sinEventos.identidad, 'Rosa');
  assert.deepEqual(sinEventos.datos, []);
  assert.doesNotMatch(leer(DIR, 'tableroModel.js'), /\b283\b|sumarDias|diasEntre/);
});

test('estado vacío: textos según filtros', () => {
  assert.equal(textoVacio({ filtro: 'TODOS', situacion: 'EN_HATO' }), 'Aún no hay hembras en el hato.');
  assert.equal(textoVacio({ filtro: 'PRENADA', situacion: 'EN_HATO' }), 'No hay hembras en esta categoría.');
  assert.equal(textoVacio({ filtro: 'TODOS', q: 'x' }), 'Ninguna hembra coincide con la búsqueda.');
  assert.equal(textoVacio({ filtro: 'TODOS', situacion: 'SALIDO' }), 'No hay hembras en este histórico.');
  assert.match(pagina, /textoVacio\(filtros\)/);
});

test('reglas visibles: umbrales del backend explicados como reglas operativas', () => {
  assert.match(textoUmbrales(RESUMEN.configuracion), /35 días o más desde el último servicio/);
  assert.match(textoUmbrales(RESUMEN.configuracion), /30 días o menos/);
  assert.match(textoUmbrales(RESUMEN.configuracion), /12 meses o más/);
  assert.match(textoUmbrales(RESUMEN.configuracion), /no recomendaciones veterinarias/);
});

// ---------------------------------------------------------------------------
// Navegación, RBAC y errores
// ---------------------------------------------------------------------------

test('navegación: menú "Reproducción" -> /ganaderia/reproduccion; tarjeta -> ficha con la pestaña Reproducción', () => {
  assert.match(app, /<Route path="reproduccion" element=\{<ReproduccionTableroPage \/>\} \/>/);
  assert.match(sidebar, /\{ label: 'Reproducción', icon: HeartPulse, to: '\/ganaderia\/reproduccion' \}/);
  assert.equal(rutaFichaReproduccion('11'), '/ganaderia/animales/11?pestana=reproduccion');
  assert.match(pagina, /<Link className="gan-hato-card gan-tablero-card" to=\{t\.ruta\}/);
  // La ficha abre la pestaña pedida (solo ids válidos) y monta su panel.
  assert.match(detalle, /useSearchParams/);
  assert.match(detalle, /PESTANAS\.some\(\(p\) => p\.id === searchParams\.get\('pestana'\)\)/);
  assert.match(detalle, /useState\(pestanaInicial === 'reproduccion'\)/);
});

test('RBAC: tablero de solo lectura para los 4 roles; sin acciones ni formularios en el listado', () => {
  assert.doesNotMatch(pagina, /useGanaderiaPermisos|permisos\./);
  assert.doesNotMatch(pagina, /registrarEventoReproductivo|anularEventoReproductivo|corregirEventoReproductivo|postJsonWithCsrf/);
  assert.doesNotMatch(pagina, /'(owner|admin|operador|lector)'/);
  assert.doesNotMatch(pagina, /<form[^>]*onSubmit=\{(?!buscar)/);
});

test('errores seguros (Fase 3C): red, 403 y 5xx con código de seguimiento; nunca texto técnico', () => {
  assert.deepEqual(resultadoCarga({ ok: false, status: 0, data: { error: 'NETWORK_ERROR' }, failure: 'NETWORK_ERROR' }), { ok: false, mensaje: MENSAJE_SIN_CONEXION });
  assert.deepEqual(resultadoCarga({ ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' }), { ok: false, mensaje: MENSAJE_SIN_PERMISOS });
  assert.deepEqual(
    resultadoCarga({ ok: false, status: 500, data: { error: 'Error interno del servidor', correlationId: CORRELATION }, correlationId: CORRELATION }),
    { ok: false, mensaje: 'Ocurrió un error. Código de seguimiento: abcdef12' },
  );
  const invalido = resultadoCarga({ ok: false, status: 400, data: { error: 'INVALID_QUERY', message: 'estadoReproductivo debe ser uno de: SQL' } });
  assert.equal(invalido.mensaje, MENSAJE_CARGA_TABLERO);
  assert.deepEqual(resultadoCarga({ ok: true, data: { animales: [] } }, 'animales'), { ok: true, data: { animales: [] } });
  // Excepciones (red/TypeError) -> mensaje seguro, vía el modelo.
  assert.deepEqual(estadoLista({ ok: false, error: new TypeError('Failed to fetch') }), { status: 'error', animales: [], total: 0, mensaje: MENSAJE_SIN_CONEXION });
  assert.equal(estadoResumen({ ok: false, error: new Error('SQL boom') }).mensaje, MENSAJE_CARGA_TABLERO);
  assert.doesNotMatch(pagina, /error\.message|data\.message/);
});

// ---------------------------------------------------------------------------
// Response-race (revisión PR #107): solo la petición vigente aplica resultados
// ---------------------------------------------------------------------------

// Promesa controlada desde el test: orden de respuesta determinista.
function diferida() {
  let resolver;
  let rechazar;
  const promesa = new Promise((res, rej) => { resolver = res; rechazar = rej; });
  return { promesa, resolver, rechazar };
}
const okResumen = (n) => ({ ok: true, status: 200, data: { ...RESUMEN, hembrasEnSeguimiento: n } });
const okLista = (ids, total = ids.length) => ({ ok: true, status: 200, data: { total, animales: ids.map((id) => ({ ...FILA, animalId: id })) } });

test('race 1 — resumen: A inicia, B inicia, B responde primero y A después: solo B queda', async () => {
  const seq = crearSecuencia();
  let estado = null;
  const aplicar = (r) => { estado = estadoResumen(r); };
  const a = diferida();
  const b = diferida();
  const pa = cargarVigente(seq, () => a.promesa, aplicar); // predio A
  const pb = cargarVigente(seq, () => b.promesa, aplicar); // predio B
  b.resolver(okResumen(7));
  assert.equal(await pb, true);
  assert.equal(estado.data.hembrasEnSeguimiento, 7);
  a.resolver(okResumen(99));
  assert.equal(await pa, false);
  assert.equal(estado.data.hembrasEnSeguimiento, 7);
});

test('race 2 — resumen: A vieja falla después (error funcional o excepción) y no reemplaza a B', async () => {
  for (const fallo of [
    (d) => d.resolver({ ok: false, status: 500, data: { correlationId: CORRELATION }, correlationId: CORRELATION }),
    (d) => d.rechazar(new TypeError('Failed to fetch')),
  ]) {
    const seq = crearSecuencia();
    let estado = null;
    const aplicar = (r) => { estado = estadoResumen(r); };
    const a = diferida();
    const b = diferida();
    const pa = cargarVigente(seq, () => a.promesa, aplicar);
    const pb = cargarVigente(seq, () => b.promesa, aplicar);
    b.resolver(okResumen(4));
    await pb;
    fallo(a);
    assert.equal(await pa, false);
    assert.deepEqual(estado, { status: 'ok', data: okResumen(4).data, mensaje: null });
  }
});

test('race 3 — listado principal: la respuesta (o el fallo) de filtros viejos nunca pisa la de los nuevos', async () => {
  const seq = crearSecuencia();
  let lista = null;
  const aplicar = (r) => { lista = estadoLista(r); };
  const viejo = diferida();
  const nuevo = diferida();
  const pv = cargarVigente(seq, () => viejo.promesa, aplicar); // filtro "Todos"
  const pn = cargarVigente(seq, () => nuevo.promesa, aplicar); // filtro "Preñadas"
  nuevo.resolver(okLista(['2']));
  await pn;
  viejo.rechazar(new TypeError('Failed to fetch'));
  assert.equal(await pv, false);
  assert.deepEqual(lista.animales.map((a) => a.animalId), ['2']);
  assert.equal(lista.status, 'ok');
});

test('race 4 — "Ver más" en vuelo + cambio de filtros: su fallo o su página vieja no tocan el listado nuevo', async () => {
  for (const desenlace of ['falla', 'responde']) {
    const seq = crearSecuencia();
    let lista = null;
    const aplicarLista = (r) => { lista = estadoLista(r); };
    await cargarVigente(seq, async () => okLista(['1', '2'], 4), aplicarLista); // página 1 de los filtros viejos
    const mas = diferida();
    // "Ver más" usa el id vigente SIN avanzar la secuencia.
    const pMas = cargarVigente(seq, () => mas.promesa, (r) => { lista = anexarPagina(lista, r); }, { id: seq.actual });
    const nuevo = diferida();
    const pNuevo = cargarVigente(seq, () => nuevo.promesa, aplicarLista); // el usuario cambia filtros
    nuevo.resolver(okLista(['9']));
    await pNuevo;
    if (desenlace === 'falla') mas.rechazar(new TypeError('Failed to fetch'));
    else mas.resolver(okLista(['3', '4'], 4));
    assert.equal(await pMas, false, desenlace);
    assert.deepEqual(lista, { status: 'ok', animales: okLista(['9']).data.animales, total: 1, mensaje: null }, desenlace);
  }
});

test('"Ver más" vigente: añade la página o deja aviso seguro sin perder lo cargado', async () => {
  const seq = crearSecuencia();
  let lista = null;
  await cargarVigente(seq, async () => okLista(['1', '2'], 4), (r) => { lista = estadoLista(r); });
  await cargarVigente(seq, async () => okLista(['3', '4'], 4), (r) => { lista = anexarPagina(lista, r); }, { id: seq.actual });
  assert.deepEqual(lista.animales.map((a) => a.animalId), ['1', '2', '3', '4']);
  assert.equal(seq.actual, 1);
  await cargarVigente(seq, async () => { throw new TypeError('Failed to fetch'); }, (r) => { lista = anexarPagina(lista, r); }, { id: seq.actual });
  assert.equal(lista.animales.length, 4);
  assert.equal(lista.mensaje, MENSAJE_SIN_CONEXION);
});

test('la página usa secuencias independientes y protege resumen, listado y "Ver más" (éxito, error y catch)', () => {
  assert.match(pagina, /secuenciaResumen\.current = crearSecuencia\(\)/);
  assert.match(pagina, /secuenciaLista\.current = crearSecuencia\(\)/);
  assert.match(pagina, /cargarVigente\(\s*secuenciaResumen\.current,[\s\S]*?setResumen\(estadoResumen\(resultado\)\)/);
  assert.match(pagina, /cargarVigente\(\s*secuenciaLista\.current,\s*\(\) => listTableroReproductivo\(queryListado\(filtros\)\),\s*\(resultado\) => setLista\(estadoLista\(resultado\)\)/);
  assert.match(pagina, /anexarPagina\(l, resultado\)\),\s*\{ id: secuenciaLista\.current\.actual \}/);
  // Ningún setResumen/setLista con datos fuera de cargarVigente (solo el "loading" previo).
  const sets = pagina.match(/set(Resumen|Lista)\(.*$/gm) ?? [];
  assert.ok(sets.length >= 4);
  for (const s of sets) assert.match(s, /status: 'loading'|estadoResumen|estadoLista|anexarPagina/, s);
  assert.doesNotMatch(pagina, /try \{[\s\S]*?await (getResumenReproductivo|listTableroReproductivo)/);
});

// ---------------------------------------------------------------------------
// Responsive
// ---------------------------------------------------------------------------

test('responsive: tarjetas (no tabla), filtros que se envuelven, KPIs en 2 columnas en móvil, sin anchos fijos', () => {
  assert.doesNotMatch(pagina, /<table/);
  const bloque = css.slice(css.indexOf('/* FASE 4C: tablero reproductivo'));
  assert.match(bloque, /\.gan-tablero-filtros \{[^}]*flex-wrap: wrap;/);
  assert.doesNotMatch(bloque, /overflow-x: auto/);
  assert.match(bloque, /@media \(max-width: 640px\) \{\n\s+\.gan-tablero-kpis \{\n\s+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(bloque, /^\s+(min-)?width:\s*\d{3,}px/m);
  assert.match(bloque, /\.gan-tablero-alerta-nivel/);
});
