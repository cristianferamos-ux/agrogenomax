// SPRINT-3D11.3 (R1) -- inventario central de chapetas QR contra un
// Postgres/PostGIS REAL (0000-0023 aplicadas): lotes (Super Admin),
// asignación a organizaciones, resolución por token y por código visible,
// registro atómico animal + chapeta, revocación, reemplazo, animal anulado,
// colisiones, concurrencia, RLS por ROL (agx_app vs agx_qr_admin), trigger
// de transiciones, grants y cifrado del token.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app),
// AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST (agx_qr_admin) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL (superusuario de la base
// desechable); se auto-omite si no están configuradas. La clave de cifrado
// es efímera (AGX_QR_TOKEN_ENCRYPTION_KEY_TEST o aleatoria). Los códigos
// legacy usados son sintéticos (AGX-9xxxxx).
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let appPool;
let animalesRepo;
let chapetasRepo;
let inventario;
let codigos;
let businessDb;
let qrAdminDb;
let qrAdminPool;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  const qrAdminConnectionString = process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST;
  if (!testConnectionString || !adminConnectionString || !qrAdminConnectionString) {
    throw new Error('conexiones de prueba no configuradas');
  }
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;
  process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL = qrAdminConnectionString;
  process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = process.env.AGX_QR_TOKEN_ENCRYPTION_KEY_TEST || crypto.randomBytes(32).toString('base64');
  qrAdminPool = new pg.Pool({ connectionString: qrAdminConnectionString, max: 2 });
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  appPool = new pg.Pool({ connectionString: testConnectionString, max: 4 });
  const check = await adminPool.query("select to_regclass('agx.qr_chapetas') as t");
  dbAvailable = Boolean(check.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  chapetasRepo = await import('../ganaderia/qrChapetasRepository.js');
  inventario = await import('../ganaderia/qrInventarioRepository.js');
  codigos = await import('../ganaderia/qrCodigos.js');
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
  await qrAdminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
});

const HOY = resolveFechaHoyNegocio();
const SUPERADMIN = { actorCuentaId: '00000000-0000-4000-8000-0000000000ad' };
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const URL_BASE = 'https://agrogenomax.test';

function orgId() {
  return crypto.randomUUID();
}

async function seedPredio(org) {
  const result = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio QR', 'ACTIVO') returning predio_id`,
    [org],
  );
  return String(result.rows[0].predio_id);
}

function animalBody(predioId, overrides = {}) {
  return validateCreateAnimalBody({
    clientOperationId: crypto.randomUUID(),
    predioId,
    numeroVisual: `QR-${crypto.randomUUID().slice(0, 6)}`,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...overrides,
  }, { hoy: HOY });
}

async function seedAnimal(org) {
  const { animal } = await animalesRepo.createAnimalIdempotente(org, animalBody(await seedPredio(org)), { actorCuentaId: ACTOR });
  return animal.animalId;
}

async function crearLote(cantidad, extra = {}) {
  return (await inventario.crearLote(
    { cantidad, proveedor: 'Proveedor prueba', observaciones: null, urlBase: URL_BASE, clientOperationId: crypto.randomUUID() },
    { ...SUPERADMIN, ...extra },
  )).lote;
}

async function loteEnStock(cantidad) {
  const lote = await crearLote(cantidad);
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
  return lote;
}

function asignar(loteId, org, extra = {}) {
  return inventario.asignarChapetas(loteId, { organizacionId: org, referencia: 'Plan prueba', clientOperationId: crypto.randomUUID(), ...extra }, SUPERADMIN);
}

/** Lote EN_STOCK con `cantidad` chapetas asignadas a `org`; devuelve [{codigo, token}]. */
async function chapetasDe(org, cantidad = 1) {
  const lote = await loteEnStock(cantidad);
  await asignar(lote.loteId, org);
  return (await inventario.exportLoteProveedor(lote.loteId)).chapetas.map((c) => ({ codigo: c.codigoVisible, token: c.token }));
}

async function estadoDe(codigo) {
  return (await adminPool.query('select estado, organizacion_id, animal_id::text as animal_id from agx.qr_chapetas where codigo_visible = $1', [codigo])).rows[0];
}

/** agx_app con app.current_org_id; intentarGuc simula un ataque SET al antiguo GUC. */
async function asApp(org, fn, { intentarGuc = false } = {}) {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_org_id', $1, true)", [org]);
    if (intentarGuc) await client.query("select set_config('app.agx_qr_admin', 'on', true)");
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/** Rol agx_qr_admin directo (transacción revertida). */
async function asQrAdmin(fn, org = '') {
  const client = await qrAdminPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_org_id', $1, true)", [org]);
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

async function expectPgError(promise, code, constraint) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

function registrar(org, codigo, value) {
  return chapetasRepo.registrarAnimalConChapeta(org, codigo, value, { actorCuentaId: ACTOR });
}

describe('SPRINT-3D11.3: inventario QR contra Postgres real', { skip: !dbAvailable }, () => {
  // ---------------------------------------------------------------------
  // Lotes (Super Admin)
  // ---------------------------------------------------------------------

  test('Super Admin crea lote: GENERADO, N chapetas EN_INVENTARIO con códigos visibles y tokens únicos e independientes', async () => {
    const lote = await crearLote(200);
    assert.equal(lote.estado, 'GENERADO');
    assert.equal(lote.tipo, 'QR_AGX');
    assert.match(lote.codigoLote, /^LQR-\d{8}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(lote.stock.enInventario, 200);
    assert.equal(lote.asignacion, 'SIN_ASIGNAR');

    const { chapetas } = await inventario.exportLoteProveedor(lote.loteId);
    assert.equal(chapetas.length, 200);
    assert.equal(new Set(chapetas.map((c) => c.codigoVisible)).size, 200);
    assert.equal(new Set(chapetas.map((c) => c.token)).size, 200);
    for (const c of chapetas) {
      assert.match(c.codigoVisible, /^AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]$/);
      assert.ok(codigos.isCodigoNuevoValido(c.codigoVisible), 'dígito de control válido');
      assert.match(c.token, /^[A-Za-z0-9_-]{32}$/);
      assert.ok(!c.token.includes(c.codigoVisible.replace(/-/g, '').slice(3)), 'el token no deriva del código');
    }
    const porCodigo = new Map(chapetas.map((c) => [c.codigoVisible, c.token]));
    const rows = await adminPool.query(
      'select c.codigo_visible, c.token_hash, t.token_cifrado, t.clave_version from agx.qr_chapetas c join agx.qr_chapeta_tokens t using (qr_id) where c.lote_id = $1',
      [lote.loteId],
    );
    assert.equal(rows.rows.length, 200);
    for (const row of rows.rows) {
      const token = porCodigo.get(row.codigo_visible);
      assert.equal(row.token_hash, codigos.hashQrToken(token));
      assert.equal(row.token_cifrado.length, 60);
      assert.equal(row.clave_version, 1);
      assert.ok(!row.token_cifrado.toString('latin1').includes(token), 'el token nunca se guarda en claro');
    }
    const columnas = await adminPool.query(
      "select column_name from information_schema.columns where table_schema = 'agx' and table_name = 'qr_chapeta_tokens'",
    );
    assert.ok(!columnas.rows.some((c) => c.column_name === 'token'), 'no existe columna de token en claro');
  });

  test('cifrado del token: AES-256-GCM atado a la chapeta; otra clave o cifrado movido de fila no descifra; sin clave 503', async () => {
    const crypt = await import('../ganaderia/qrTokenCrypto.js');
    const lote = await crearLote(2);
    const rows = (await adminPool.query(
      'select c.codigo_visible, t.token_cifrado from agx.qr_chapetas c join agx.qr_chapeta_tokens t using (qr_id) where c.lote_id = $1 order by c.qr_id',
      [lote.loteId],
    )).rows;
    const key = crypt.loadQrTokenKey();
    assert.match(crypt.decryptQrToken(rows[0].token_cifrado, rows[0].codigo_visible, key), /^[A-Za-z0-9_-]{32}$/);
    assert.throws(() => crypt.decryptQrToken(rows[0].token_cifrado, rows[1].codigo_visible, key));
    assert.throws(() => crypt.decryptQrToken(rows[0].token_cifrado, rows[0].codigo_visible, crypto.randomBytes(32)));
    assert.throws(() => crypt.loadQrTokenKey({}), (error) => error.code === 'QR_KEY_NOT_CONFIGURED' && error.status === 503);
  });

  test('crear lote es idempotente por clientOperationId (doble clic -> un solo lote)', async () => {
    const clientOperationId = crypto.randomUUID();
    const input = { cantidad: 3, proveedor: null, observaciones: null, urlBase: URL_BASE, clientOperationId };
    const [a, b] = await Promise.all([inventario.crearLote(input, SUPERADMIN), inventario.crearLote(input, SUPERADMIN)]);
    assert.equal(a.lote.loteId, b.lote.loteId);
    assert.deepEqual([a.yaExistia, b.yaExistia].sort(), [false, true]);
    const n = await adminPool.query('select count(*)::int as n from agx.qr_chapetas where lote_id = $1', [a.lote.loteId]);
    assert.equal(n.rows[0].n, 3);
  });

  test('colisiones: códigos visibles repetidos o ya existentes se regeneran; el lote queda completo', async () => {
    const previo = (await inventario.exportLoteProveedor((await crearLote(1)).loteId)).chapetas[0].codigoVisible;
    const fijo = `AGX-ZZZZ-ZZZ2-${codigos.digitoControl('ZZZZZZZ2')}`;
    const secuencia = [previo, previo, fijo];
    const codeGenerator = () => secuencia.shift() ?? codigos.generateCodigoVisible();
    const existente = await adminPool.query('select 1 from agx.qr_chapetas where codigo_visible = $1', [fijo]);
    const lote = await crearLote(3, { codeGenerator });
    const { chapetas } = await inventario.exportLoteProveedor(lote.loteId);
    assert.equal(chapetas.length, 3);
    assert.ok(!chapetas.some((c) => c.codigoVisible === previo), 'nunca reutiliza un código existente');
    assert.equal(new Set(chapetas.map((c) => c.codigoVisible)).size, 3);
    if (existente.rowCount === 0) assert.ok(chapetas.some((c) => c.codigoVisible === fijo));
  });

  test('estados del lote: GENERADO -> EN_FABRICACION -> EN_STOCK -> CERRADO; saltos/retrocesos 409', async () => {
    const lote = await crearLote(1);
    await expectSemantic(inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN), 'LOTE_TRANSICION_INVALIDA', 409);
    await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
    assert.equal((await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN)).sinCambios, true);
    await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
    await expectSemantic(inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN), 'LOTE_TRANSICION_INVALIDA', 409);
    const cerrado = await inventario.cambiarEstadoLote(lote.loteId, 'CERRADO', SUPERADMIN);
    assert.equal(cerrado.lote.estado, 'CERRADO');
    const detalle = await inventario.getLote(lote.loteId);
    assert.deepEqual(detalle.historial.map((e) => e.tipoEvento), ['GENERADO', 'ESTADO_CAMBIADO', 'ESTADO_CAMBIADO', 'ESTADO_CAMBIADO']);
  });

  test('importación legacy controlada: lote QR_LEGACY EN_STOCK sin tokens; código existente aborta todo', async () => {
    const base = 900000 + crypto.randomInt(0, 90000);
    const lista = [0, 1, 2].map((i) => `AGX-${String(base + i).padStart(6, '0')}`);
    const { lote } = await inventario.importarLoteLegacy({ codigos: lista, observaciones: 'staging', clientOperationId: crypto.randomUUID() }, SUPERADMIN);
    assert.equal(lote.tipo, 'QR_LEGACY');
    assert.equal(lote.estado, 'EN_STOCK');
    assert.equal(lote.stock.enInventario, 3);
    const tokens = await adminPool.query('select count(*)::int as n from agx.qr_chapeta_tokens t join agx.qr_chapetas c using (qr_id) where c.lote_id = $1', [lote.loteId]);
    assert.equal(tokens.rows[0].n, 0);
    await assert.rejects(
      inventario.importarLoteLegacy({ codigos: [lista[0], `AGX-${String(base + 50).padStart(6, '0')}`], observaciones: null, clientOperationId: crypto.randomUUID() }, SUPERADMIN),
      (error) => error.code === 'QR_CODIGO_YA_EXISTE' && error.codigos.includes(lista[0]),
    );
    const huerfano = await adminPool.query('select count(*)::int as n from agx.qr_chapetas where codigo_visible = $1', [`AGX-${String(base + 50).padStart(6, '0')}`]);
    assert.equal(huerfano.rows[0].n, 0, 'la importación fallida no deja filas');
  });

  // ---------------------------------------------------------------------
  // Asignación a organizaciones
  // ---------------------------------------------------------------------

  test('asignación completa de lote: todas ASIGNADO_ORGANIZACION, asignación TOTAL, eventos por chapeta', async () => {
    const org = orgId();
    const lote = await loteEnStock(4);
    const result = await asignar(lote.loteId, org);
    assert.equal(result.cantidad, 4);
    const detalle = await inventario.getLote(lote.loteId);
    assert.equal(detalle.lote.asignacion, 'TOTAL');
    assert.equal(detalle.lote.stock.asignadasOrganizacion, 4);
    assert.equal(detalle.asignaciones[0].organizacionId, org);
    const eventos = await adminPool.query(
      "select count(*)::int as n from agx.qr_chapeta_eventos e join agx.qr_chapetas c using (qr_id) where c.lote_id = $1 and e.tipo_evento = 'ASIGNADA_ORGANIZACION'",
      [lote.loteId],
    );
    assert.equal(eventos.rows[0].n, 4);
  });

  test('asignación parcial: por cantidad (orden del lote) y por códigos; resto queda en stock; stock insuficiente 409', async () => {
    const orgA = orgId();
    const orgB = orgId();
    const lote = await loteEnStock(6);
    const todas = (await inventario.exportLoteProveedor(lote.loteId)).chapetas.map((c) => c.codigoVisible);
    const parcial = await asignar(lote.loteId, orgA, { cantidad: 2 });
    assert.deepEqual(parcial.codigos, todas.slice(0, 2));
    await asignar(lote.loteId, orgB, { codigos: [todas[5]] });
    const detalle = await inventario.getLote(lote.loteId);
    assert.equal(detalle.lote.asignacion, 'PARCIAL');
    assert.equal(detalle.lote.stock.enInventario, 3);
    await expectSemantic(asignar(lote.loteId, orgB, { cantidad: 4 }), 'STOCK_INSUFICIENTE', 409);
    await expectSemantic(asignar(lote.loteId, orgB, { codigos: [todas[0]] }), 'QR_NO_DISPONIBLE', 409);
    assert.equal((await estadoDe(todas[0])).organizacion_id, orgA, 'nunca se reasigna entre organizaciones');
  });

  test('asignar exige lote EN_STOCK; es idempotente por clientOperationId', async () => {
    const org = orgId();
    const lote = await crearLote(2);
    await expectSemantic(asignar(lote.loteId, org), 'LOTE_NO_EN_STOCK', 409);
    await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
    await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
    const clientOperationId = crypto.randomUUID();
    const first = await asignar(lote.loteId, org, { cantidad: 1, clientOperationId });
    const retry = await asignar(lote.loteId, org, { cantidad: 1, clientOperationId });
    assert.equal(retry.yaExistia, true);
    assert.equal(retry.asignacionId, first.asignacionId);
    assert.equal((await inventario.getLote(lote.loteId)).lote.stock.enInventario, 1);
    await expectSemantic(asignar(lote.loteId, orgId(), { cantidad: 1, clientOperationId }), 'CLIENT_OPERATION_ID_REUSED', 409);
  });

  test('concurrencia: asignaciones parciales simultáneas nunca toman la misma chapeta', async () => {
    const lote = await loteEnStock(10);
    const orgs = [orgId(), orgId(), orgId(), orgId()];
    const results = await Promise.allSettled(orgs.map((org) => asignar(lote.loteId, org, { cantidad: 3 })));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    assert.equal(ok.length, 3, 'solo hay stock para 3 asignaciones de 3');
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'STOCK_INSUFICIENTE').length, 1);
    const asignadas = ok.flatMap((r) => r.codigos);
    assert.equal(new Set(asignadas).size, 9);
  });

  // ---------------------------------------------------------------------
  // Resolución y aislamiento entre organizaciones
  // ---------------------------------------------------------------------

  test('QR no asociado y código manual no asociado -> DISPONIBLE (abrir registro)', async () => {
    const org = orgId();
    const [c] = await chapetasDe(org);
    const porToken = await chapetasRepo.resolverChapeta(org, { token: c.token });
    const porCodigo = await chapetasRepo.resolverChapeta(org, { codigoVisible: c.codigo });
    assert.equal(porToken.resultado, 'DISPONIBLE');
    assert.equal(porCodigo.resultado, 'DISPONIBLE');
    assert.equal(porToken.chapeta.codigoVisible, c.codigo);
    assert.equal(Object.hasOwn(porToken.chapeta, 'tokenHash'), false);
  });

  test('organización A no ve ni usa chapetas de B ni el stock central (404 indistinguible)', async () => {
    const orgA = orgId();
    const orgB = orgId();
    const [deB] = await chapetasDe(orgB);
    const central = (await inventario.exportLoteProveedor((await crearLote(1)).loteId)).chapetas[0];
    assert.equal(await chapetasRepo.resolverChapeta(orgA, { token: deB.token }), null);
    assert.equal(await chapetasRepo.resolverChapeta(orgA, { codigoVisible: deB.codigo }), null);
    assert.equal(await chapetasRepo.resolverChapeta(orgA, { token: central.token }), null);
    assert.equal(await chapetasRepo.resolverChapeta(orgA, { codigoVisible: central.codigoVisible }), null);
    const predioA = await seedPredio(orgA);
    await expectSemantic(registrar(orgA, deB.codigo, animalBody(predioA)), 'QR_NOT_FOUND', 404);
    const animalA = await seedAnimal(orgA);
    await expectSemantic(chapetasRepo.asociarChapetaAAnimal(orgA, animalA, deB.codigo, { actorCuentaId: ACTOR }), 'QR_NOT_FOUND', 404);
    assert.equal((await estadoDe(deB.codigo)).estado, 'ASIGNADO_ORGANIZACION');
    const lista = await chapetasRepo.listChapetasOrganizacion(orgA, { limit: 50, offset: 0 });
    assert.equal(lista.total, 0);
  });

  // ---------------------------------------------------------------------
  // Registro animal + chapeta
  // ---------------------------------------------------------------------

  test('registrar animal con chapeta: ASIGNADO_ANIMAL; QR y código manual abren la ficha; reintento idempotente', async () => {
    const org = orgId();
    const [c] = await chapetasDe(org);
    const value = animalBody(await seedPredio(org));
    const { animal, chapeta, yaExistia } = await registrar(org, c.codigo, value);
    assert.equal(yaExistia, false);
    assert.equal(chapeta.estado, 'ASIGNADO_ANIMAL');
    assert.equal(chapeta.animalId, animal.animalId);
    const retry = await registrar(org, c.codigo, value);
    assert.equal(retry.yaExistia, true);
    assert.equal(retry.animal.animalId, animal.animalId);

    const porToken = await chapetasRepo.resolverChapeta(org, { token: c.token });
    const porCodigo = await chapetasRepo.resolverChapeta(org, { codigoVisible: c.codigo });
    assert.deepEqual([porToken.resultado, porToken.animalId], ['ANIMAL', animal.animalId]);
    assert.deepEqual([porCodigo.resultado, porCodigo.animalId], ['ANIMAL', animal.animalId]);

    const eventos = await adminPool.query(
      "select tipo_evento, metadata_json from agx.animal_eventos where animal_id = $1 order by evento_id",
      [animal.animalId],
    );
    assert.deepEqual(eventos.rows.map((e) => e.tipo_evento), ['REGISTRADO', 'QR_ASOCIADO']);
    assert.ok(!JSON.stringify(eventos.rows).includes(c.token), 'los eventos nunca guardan el token');
    await expectSemantic(registrar(org, c.codigo, animalBody(await seedPredio(org))), 'QR_YA_ASOCIADO', 409);
  });

  test('rollback transaccional: si el registro del animal falla, la chapeta sigue disponible y no hay animal', async () => {
    const org = orgId();
    const [c] = await chapetasDe(org);
    const value = animalBody('999999999');
    await expectSemantic(registrar(org, c.codigo, value), 'PREDIO_NOT_FOUND');
    assert.equal((await estadoDe(c.codigo)).estado, 'ASIGNADO_ORGANIZACION');
    const animales = await adminPool.query('select count(*)::int as n from agx.animales where client_operation_id = $1', [value.clientOperationId]);
    assert.equal(animales.rows[0].n, 0);
    const predio = await seedPredio(org);
    const numero = `DUP-${crypto.randomUUID().slice(0, 5)}`;
    await animalesRepo.createAnimalIdempotente(org, animalBody(predio, { numeroVisual: numero }), { actorCuentaId: ACTOR });
    await expectSemantic(registrar(org, c.codigo, animalBody(predio, { numeroVisual: numero })), 'ANIMAL_NUMERO_VISUAL_DUPLICADO', 409);
    assert.equal((await estadoDe(c.codigo)).estado, 'ASIGNADO_ORGANIZACION');
  });

  test('concurrencia: dos registros simultáneos con la misma chapeta -> un animal, un 409', async () => {
    const org = orgId();
    const [c] = await chapetasDe(org);
    const predio = await seedPredio(org);
    const results = await Promise.allSettled([registrar(org, c.codigo, animalBody(predio)), registrar(org, c.codigo, animalBody(predio))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'QR_YA_ASOCIADO');
  });

  test('asociar a animal existente; un animal no puede tener dos chapetas activas', async () => {
    const org = orgId();
    const [c1, c2] = await chapetasDe(org, 2);
    const animalId = await seedAnimal(org);
    const first = await chapetasRepo.asociarChapetaAAnimal(org, animalId, c1.codigo, { actorCuentaId: ACTOR });
    assert.equal(first.chapeta.estado, 'ASIGNADO_ANIMAL');
    assert.equal((await chapetasRepo.asociarChapetaAAnimal(org, animalId, c1.codigo, { actorCuentaId: ACTOR })).yaExistia, true);
    await expectSemantic(chapetasRepo.asociarChapetaAAnimal(org, animalId, c2.codigo, { actorCuentaId: ACTOR }), 'ANIMAL_YA_TIENE_QR', 409);
    const otroAnimal = await seedAnimal(org);
    await expectSemantic(chapetasRepo.asociarChapetaAAnimal(org, otroAnimal, c1.codigo, { actorCuentaId: ACTOR }), 'QR_YA_ASOCIADO', 409);
  });

  // ---------------------------------------------------------------------
  // Baja, reemplazo, animal anulado
  // ---------------------------------------------------------------------

  test('revocado no resuelve (NO_OPERATIVA) y no vuelve a usarse; dañado igual', async () => {
    const org = orgId();
    const [c1, c2] = await chapetasDe(org, 2);
    const animalId = await seedAnimal(org);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, c1.codigo, { actorCuentaId: ACTOR });
    const baja = await chapetasRepo.bajaChapetaDeAnimal(org, animalId, { causa: 'REVOCADO', motivo: 'Perdida', actorCuentaId: ACTOR });
    assert.equal(baja.chapeta.estado, 'REVOCADO');
    assert.equal((await chapetasRepo.resolverChapeta(org, { token: c1.token })).resultado, 'NO_OPERATIVA');
    await expectSemantic(chapetasRepo.asociarChapetaAAnimal(org, animalId, c1.codigo, { actorCuentaId: ACTOR }), 'QR_NO_OPERATIVO', 410);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, c2.codigo, { actorCuentaId: ACTOR });
    await chapetasRepo.bajaChapetaDeAnimal(org, animalId, { causa: 'DANADO', motivo: 'Rota', actorCuentaId: ACTOR });
    assert.equal((await chapetasRepo.resolverChapeta(org, { codigoVisible: c2.codigo })).chapeta.estado, 'DANADO');
  });

  test('reemplazo: la anterior queda REEMPLAZADO (no resuelve), la nueva abre la ficha; historial e idempotencia', async () => {
    const org = orgId();
    const [vieja, nueva, otra] = await chapetasDe(org, 3);
    const animalId = await seedAnimal(org);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, vieja.codigo, { actorCuentaId: ACTOR });
    const input = { codigoNuevo: nueva.codigo, motivo: 'Chapeta ilegible', actorCuentaId: ACTOR };
    const result = await chapetasRepo.reemplazarChapetaDeAnimal(org, animalId, input);
    assert.equal(result.yaExistia, false);
    assert.equal((await chapetasRepo.reemplazarChapetaDeAnimal(org, animalId, input)).yaExistia, true);
    assert.equal((await chapetasRepo.resolverChapeta(org, { token: vieja.token })).resultado, 'NO_OPERATIVA');
    assert.equal((await chapetasRepo.resolverChapeta(org, { token: nueva.token })).animalId, animalId);
    const qr = await chapetasRepo.getChapetasDeAnimal(org, animalId);
    assert.equal(qr.activa.codigoVisible, nueva.codigo);
    const anterior = qr.historial.find((h) => h.codigoVisible === vieja.codigo);
    assert.equal(anterior.estado, 'REEMPLAZADO');
    assert.equal(anterior.reemplazadoPor, result.chapeta.qrId);
    await expectSemantic(
      chapetasRepo.reemplazarChapetaDeAnimal(org, animalId, { ...input, codigoNuevo: vieja.codigo }),
      'QR_NO_OPERATIVO',
      410,
    );
    const animales = await adminPool.query("select tipo_evento from agx.animal_eventos where animal_id = $1 and tipo_evento like 'QR_%' order by evento_id", [animalId]);
    assert.deepEqual(animales.rows.map((r) => r.tipo_evento), ['QR_ASOCIADO', 'QR_REEMPLAZADO']);
    assert.ok(otra);
  });

  test('animal ANULADO: su chapeta pasa a REVOCADO en la misma transacción y deja de resolver', async () => {
    const org = orgId();
    const [c] = await chapetasDe(org);
    const { animal } = await registrar(org, c.codigo, animalBody(await seedPredio(org)));
    await animalesRepo.anularAnimal(org, animal.animalId, { motivo: 'Duplicado', actorCuentaId: ACTOR });
    const estado = await estadoDe(c.codigo);
    assert.equal(estado.estado, 'REVOCADO');
    assert.equal(estado.animal_id, animal.animalId, 'el historial conserva el animal');
    const resolved = await chapetasRepo.resolverChapeta(org, { token: c.token });
    assert.equal(resolved.resultado, 'NO_OPERATIVA');
  });

  test('Super Admin: detalle con animal asociado, baja y reemplazo sobre chapetas de cualquier organización', async () => {
    const org = orgId();
    const [c1, c2] = await chapetasDe(org, 2);
    const { animal } = await registrar(org, c1.codigo, animalBody(await seedPredio(org)));
    const qrId = (await inventario.buscarChapetas({ codigo: c1.codigo, limit: 5, offset: 0 })).chapetas[0].qrId;
    const detalle = await inventario.getChapetaAdmin(qrId);
    assert.equal(detalle.chapeta.organizacionId, org);
    assert.equal(detalle.animal.animalId, animal.animalId);
    assert.deepEqual(detalle.historial.map((h) => h.tipoEvento), ['ASIGNADA_ORGANIZACION', 'ASOCIADA_ANIMAL']);
    const reemplazo = await inventario.reemplazarChapetaAdmin(qrId, { codigoNuevo: c2.codigo, motivo: 'Soporte' }, SUPERADMIN);
    assert.equal(reemplazo.chapeta.animalId, animal.animalId);
    const qr2 = reemplazo.chapeta.qrId;
    const baja = await inventario.bajaChapetaAdmin(qr2, { causa: 'DANADO', motivo: 'Daño reportado' }, SUPERADMIN);
    assert.equal(baja.chapeta.estado, 'DANADO');
    assert.equal((await inventario.bajaChapetaAdmin(qr2, { causa: 'DANADO', motivo: 'x' }, SUPERADMIN)).sinCambios, true);
    const central = (await inventario.buscarChapetas({ loteId: (await crearLote(1)).loteId, limit: 5, offset: 0 })).chapetas[0];
    assert.equal((await inventario.bajaChapetaAdmin(central.qrId, { causa: 'REVOCADO', motivo: 'Defecto' }, SUPERADMIN)).chapeta.estado, 'REVOCADO');
  });

  // ---------------------------------------------------------------------
  // Frontera por ROL: agx_app vs agx_qr_admin
  // ---------------------------------------------------------------------

  test('agx_app no tiene NINGÚN privilegio sobre lotes, tokens ni eventos de lote -- ni siquiera con SET app.agx_qr_admin', async () => {
    const orgA = orgId();
    await chapetasDe(orgA, 1);
    for (const intentarGuc of [false, true]) {
      for (const table of ['qr_lotes', 'qr_chapeta_tokens', 'qr_lote_eventos']) {
        await asApp(orgA, (client) => expectPgError(client.query(`select count(*) from agx.${table}`), '42501'), { intentarGuc });
      }
      // Stock central: invisible aun "pidiendo" contexto admin por GUC.
      await asApp(orgA, async (client) => {
        const visibles = await client.query("select count(*)::int as n from agx.qr_chapetas where estado = 'EN_INVENTARIO' or organizacion_id is distinct from $1", [orgA]);
        assert.equal(visibles.rows[0].n, 0);
      }, { intentarGuc });
    }
    const funcion = await adminPool.query("select count(*)::int as n from pg_proc where proname = 'qr_admin_context'");
    assert.equal(funcion.rows[0].n, 0, 'no existe frontera basada en GUC');
  });

  test('RLS: la organización ve solo sus chapetas y asignaciones; sin contexto, nada', async () => {
    const orgA = orgId();
    const orgB = orgId();
    await chapetasDe(orgA, 2);
    await chapetasDe(orgB, 1);
    await asApp(orgA, async (client) => {
      assert.equal((await client.query('select count(*)::int as n from agx.qr_chapetas')).rows[0].n, 2);
      assert.equal((await client.query('select count(*)::int as n from agx.qr_asignaciones where organizacion_id <> $1', [orgA])).rows[0].n, 0);
    });
    await asApp('', async (client) => {
      assert.equal((await client.query('select count(*)::int as n from agx.qr_chapetas')).rows[0].n, 0, 'sin contexto no se ve nada');
    });
    const flags = await adminPool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relnamespace = 'agx'::regnamespace and relkind = 'r' and relname like 'qr\\_%' order by relname`,
    );
    assert.equal(flags.rows.length, 6);
    for (const row of flags.rows) assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity], [true, true], row.relname);
  });

  test('agx_app no crea chapetas ni cambia su organización; no revierte estados', async () => {
    const orgA = orgId();
    const orgB = orgId();
    const [c] = await chapetasDe(orgA);
    const animalId = await seedAnimal(orgA);
    const loteId = (await adminPool.query('select lote_id from agx.qr_chapetas where codigo_visible = $1', [c.codigo])).rows[0].lote_id;
    await asApp(orgA, (client) => expectPgError(
      client.query(
        "insert into agx.qr_chapetas (lote_id, tipo, codigo_visible, token_hash) values ($1, 'QR_AGX', $2, $3)",
        [loteId, codigos.generateCodigoVisible(), 'a'.repeat(64)],
      ),
      '42501',
    ), { intentarGuc: true });
    for (const assignment of ['organizacion_id = $2', 'asignacion_id = null', 'asignado_organizacion_at = now()']) {
      await asApp(orgA, (client) => expectPgError(
        client.query(`update agx.qr_chapetas set ${assignment} where codigo_visible = $1`, assignment.includes('$2') ? [c.codigo, orgB] : [c.codigo]),
        '42501',
      ));
    }
    await chapetasRepo.asociarChapetaAAnimal(orgA, animalId, c.codigo, { actorCuentaId: ACTOR });
    await asApp(orgA, (client) => expectPgError(
      client.query(
        "update agx.qr_chapetas set estado = 'ASIGNADO_ORGANIZACION', animal_id = null, asignado_animal_at = null where codigo_visible = $1",
        [c.codigo],
      ),
      '23514',
      'qr_chapetas_animal_inmutable_check',
    ));
    await asApp(orgB, async (client) => {
      const updated = await client.query("update agx.qr_chapetas set motivo = 'x' where codigo_visible = $1", [c.codigo]);
      assert.equal(updated.rowCount, 0);
    });
  });

  test('trigger: identidad y organización inmutables incluso para agx_qr_admin; sacar del inventario exige el rol agx_qr_admin', async () => {
    const orgA = orgId();
    const lote = await loteEnStock(2);
    const [central, otra] = (await inventario.exportLoteProveedor(lote.loteId)).chapetas;
    await asQrAdmin((client) => expectPgError(
      client.query('update agx.qr_chapetas set codigo_visible = $2 where codigo_visible = $1', [central.codigoVisible, codigos.generateCodigoVisible()]),
      '42501',
    ));
    // Un rol con todos los privilegios (superusuario de la base de pruebas)
    // tampoco puede sacar una chapeta del inventario: no es agx_qr_admin.
    const su = await adminPool.connect();
    try {
      await su.query('begin');
      await expectPgError(
        su.query('update agx.qr_chapetas set codigo_visible = $2 where codigo_visible = $1', [central.codigoVisible, codigos.generateCodigoVisible()]),
        '23514',
        'qr_chapetas_inmutable_check',
      );
    } finally {
      await su.query('rollback').catch(() => {});
      su.release();
    }
    const su2 = await adminPool.connect();
    try {
      await su2.query('begin');
      const asig = await su2.query(
        "insert into agx.qr_asignaciones (organizacion_id, lote_id, cantidad, asignado_por, client_operation_id) values ($1, $2, 1, $3, $4) returning asignacion_id",
        [orgA, lote.loteId, ACTOR, crypto.randomUUID()],
      );
      await expectPgError(
        su2.query(
          "update agx.qr_chapetas set estado = 'ASIGNADO_ORGANIZACION', organizacion_id = $2, asignacion_id = $3, asignado_organizacion_at = now() where codigo_visible = $1",
          [otra.codigoVisible, orgA, asig.rows[0].asignacion_id],
        ),
        '23514',
        'qr_chapetas_transicion_check',
      );
    } finally {
      await su2.query('rollback').catch(() => {});
      su2.release();
    }
    const [asignada] = await chapetasDe(orgA);
    await asQrAdmin((client) => expectPgError(
      client.query('update agx.qr_chapetas set organizacion_id = $2 where codigo_visible = $1', [asignada.codigo, orgId()]),
      '23514',
      'qr_chapetas_organizacion_inmutable_check',
    ));
    await asApp(orgA, (client) => expectPgError(
      client.query("update agx.qr_chapetas set estado = 'REVOCADO', revocado_at = now(), revocado_por = $2, motivo = 'x' where codigo_visible = $1", [asignada.codigo, ACTOR])
        .then(() => client.query("update agx.qr_chapetas set estado = 'ASIGNADO_ORGANIZACION', revocado_at = null, revocado_por = null, motivo = null where codigo_visible = $1", [asignada.codigo])),
      '23514',
      'qr_chapetas_transicion_check',
    ));
  });

  test('grants: ningún rol de aplicación tiene DELETE; agx_qr_admin no altera identidad; el pool admin exige el rol agx_qr_admin', async () => {
    const org = orgId();
    for (const table of ['qr_lotes', 'qr_asignaciones', 'qr_chapetas', 'qr_chapeta_tokens', 'qr_chapeta_eventos', 'qr_lote_eventos']) {
      await asApp(org, (client) => expectPgError(client.query(`delete from agx.${table}`), '42501'));
      await asQrAdmin((client) => expectPgError(client.query(`delete from agx.${table}`), '42501'));
    }
    for (const assignment of ["codigo_visible = 'x'", "token_hash = 'x'", 'lote_id = lote_id', "tipo = 'QR_LEGACY'"]) {
      await asQrAdmin((client) => expectPgError(client.query(`update agx.qr_chapetas set ${assignment}`), '42501'));
    }
    await asQrAdmin((client) => expectPgError(client.query("update agx.animales set nombre = 'x'"), '42501'));
    const role = await qrAdminPool.query('select current_user as r, (select rolbypassrls from pg_roles where rolname = current_user) as bypass');
    assert.deepEqual(role.rows[0], { r: 'agx_qr_admin', bypass: false });
  });

  test('esquema: dígito de control validado en la base; formato por tipo y consistencia de estado', async () => {
    const lote = await crearLote(1);
    const valido = codigos.generateCodigoVisible();
    const alfabeto = codigos.CODIGO_ALFABETO;
    const malControl = `${valido.slice(0, -1)}${alfabeto[(alfabeto.indexOf(valido.at(-1)) + 1) % 32]}`;
    const cases = [
      ["'QR_AGX'", `'${malControl}'`, `'${'a'.repeat(64)}'`, 'qr_chapetas_formato_check'],
      ["'QR_AGX'", "'AGX-0000-0000-0'", `'${'a'.repeat(64)}'`, 'qr_chapetas_formato_check'],
      ["'QR_AGX'", `'${valido.slice(0, -2)}'`, `'${'a'.repeat(64)}'`, 'qr_chapetas_formato_check'],
      ["'QR_AGX'", `'${codigos.generateCodigoVisible()}'`, 'null', 'qr_chapetas_formato_check'],
      ["'QR_AGX'", "'AGX-000123'", `'${'b'.repeat(64)}'`, 'qr_chapetas_formato_check'],
    ];
    for (const [tipo, codigo, hash, constraint] of cases) {
      await asQrAdmin((client) => expectPgError(
        client.query(`insert into agx.qr_chapetas (lote_id, tipo, codigo_visible, token_hash) values ($1, ${tipo}, ${codigo}, ${hash})`, [lote.loteId]),
        '23514',
        constraint,
      ));
    }
    await asQrAdmin((client) => expectPgError(
      client.query(
        `insert into agx.qr_chapetas (lote_id, tipo, codigo_visible, token_hash, estado) values ($1, 'QR_AGX', $2, $3, 'ASIGNADO_ANIMAL')`,
        [lote.loteId, codigos.generateCodigoVisible(), 'c'.repeat(64)],
      ),
      '23514',
      'qr_chapetas_estado_consistencia_check',
    ));
    const sql = await adminPool.query('select agx.fn_qr_codigo_control_ok($1) as a, agx.fn_qr_codigo_control_ok($2) as b', [valido, malControl]);
    assert.deepEqual(sql.rows[0], { a: true, b: false });
  });
});

describe('FASE 15: paquete de fabricación contra Postgres real (solo lectura)', { skip: !dbAvailable }, () => {
  async function snapshot(loteId) {
    const q = async (sql) => (await adminPool.query(sql, [loteId])).rows;
    return {
      lote: await q('select * from agx.qr_lotes where lote_id = $1'),
      chapetas: await q('select * from agx.qr_chapetas where lote_id = $1 order by qr_id'),
      tokens: await q('select t.* from agx.qr_chapeta_tokens t join agx.qr_chapetas c on c.qr_id = t.qr_id where c.lote_id = $1 order by t.qr_id'),
      eventosLote: await q('select * from agx.qr_lote_eventos where lote_id = $1 order by evento_id'),
      eventosChapeta: await q('select e.* from agx.qr_chapeta_eventos e join agx.qr_chapetas c on c.qr_id = e.qr_id where c.lote_id = $1 order by e.evento_id'),
    };
  }

  test('34. lote de 10: paquete verificado (token ↔ token_hash, QR ↔ url_qr) y la exportación NO modifica lote, chapetas, tokens ni eventos', async () => {
    const { buildPaqueteFabricacion, prepararFabricacion } = await import('../ganaderia/qrFabricacionPaquete.js');
    const lote = await crearLote(10);
    const antes = await snapshot(lote.loteId);

    const data = await inventario.exportLoteProveedor(lote.loteId);
    assert.equal(data.chapetas.length, 10);
    for (const c of data.chapetas) assert.equal(codigos.hashQrToken(c.token), c.tokenHash);
    const paquete = await buildPaqueteFabricacion(data);
    assert.equal(Object.keys(paquete.files).filter((p) => p.startsWith('svg/')).length, 10);
    const { items } = prepararFabricacion(data);
    for (const item of items) assert.equal(item.url, `${URL_BASE}/qr/${data.chapetas.find((c) => c.codigoVisible === item.codigoVisible).token}`);

    const una = await inventario.exportChapetaProveedor(data.chapetas[3].qrId);
    assert.equal(una.chapeta.codigoVisible, data.chapetas[3].codigoVisible);
    assert.equal(una.chapeta.token, data.chapetas[3].token);
    prepararFabricacion({ lote: una.lote, chapetas: [una.chapeta] }, { cantidadEsperada: 1 });

    assert.deepEqual(await snapshot(lote.loteId), antes);
  });

  test('36. token_cifrado movido a otra fila no descifra (AAD) y aborta el export', async () => {
    const lote = await crearLote(2);
    const filas = (await adminPool.query(
      `select c.qr_id, t.token_cifrado from agx.qr_chapetas c join agx.qr_chapeta_tokens t on t.qr_id = c.qr_id
        where c.lote_id = $1 order by c.qr_id`, [lote.loteId])).rows;
    // Manipulación deliberada SOLO en la base desechable (superusuario): intercambia los cifrados.
    await adminPool.query('update agx.qr_chapeta_tokens set token_cifrado = $1 where qr_id = $2', [filas[1].token_cifrado, filas[0].qr_id]);
    await assert.rejects(inventario.exportLoteProveedor(lote.loteId));
  });

  test('exportación en transacción READ ONLY (Postgres rechaza escrituras) y lote legacy sin tokens', async () => {
    const { withQrAdminTransaction } = await import('../../db/agxQrAdminPool.js');
    await assert.rejects(
      withQrAdminTransaction(async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        assert.equal((await client.query('show transaction_read_only')).rows[0].transaction_read_only, 'on');
        await client.query("update agx.qr_lotes set observaciones = 'x' where false");
      }),
      (error) => error.code === '25006',
    );
    const base = 900000 + Math.floor(Math.random() * 90000);
    const { lote } = await inventario.importarLoteLegacy({ codigos: [`AGX-${base}`], observaciones: null, clientOperationId: crypto.randomUUID() }, SUPERADMIN);
    const data = await inventario.exportLoteProveedor(lote.loteId);
    assert.equal(data.lote.tipo, 'QR_LEGACY');
    assert.equal(data.chapetas[0].token, null);
  });
});
