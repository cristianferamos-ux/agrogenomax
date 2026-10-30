// FASE 2A: invariantes de arquitectura del cierre operativo (salida/muerte).
//   - endpoints explícitos /salida y /muerte (sin POST /estado genérico),
//     montados antes del router de animales; tenant solo de la sesión;
//   - fuente canónica animales (estado_operativo + cierre_*) + animal_eventos;
//     sin tabla de cierres ni copia en otra tabla de eventos;
//   - mismo patrón de idempotencia que pesajes (advisory lock + UNIQUE);
//   - sin legacy, Demo ni PDF; la migración 0025 trae rollback;
//   - pesajes y chapetas QR bloquean animales cerrados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSAS_MUERTE, MOTIVOS_SALIDA, errorAnimalCerrado } from '../ganaderia/cierreValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.resolve(SERVER, '..', 'db', 'agx-business', 'migrations');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ARCHIVOS = [
  'services/ganaderia/cierreValidation.js',
  'services/ganaderia/cierreRepository.js',
  'routes/ganaderiaAnimalCierre.js',
];
const migracion = fs.readFileSync(path.join(MIGRATIONS, '0025_animal_cierre_operativo.sql'), 'utf8');

test('endpoints explícitos montados antes del router de animales; sin /estado genérico', () => {
  const index = read('index.js');
  assert.match(index, /\[\['salida', 'SALIDA'\], \['muerte', 'MUERTE'\]\]/);
  const cierre = index.indexOf('`/api/ganaderia/animales/:animalId/${ruta}`');
  const animales = index.indexOf("'/api/ganaderia/animales',");
  assert.ok(cierre > 0 && cierre < animales);
  assert.doesNotMatch(index, /animales\/:animalId\/estado/);
  const ruta = strip(read(ARCHIVOS[2]));
  assert.match(ruta, /router\.use\(createRequireGanaderiaSession\(\{ appEnv \}\)\)/);
  assert.match(ruta, /router\.use\(createRequireGanaderiaCsrf\(/);
  assert.match(ruta, /const \{ organizacionId, cuentaId \} = req\.ganaderiaAuth;/);
  assert.doesNotMatch(ruta, /req\.(body|query|headers)\b[^\n]*organizaci/i);
  assert.doesNotMatch(ruta, /router\.(get|put|patch|delete)\(/);
});

test('catálogos = CHECK de 0025; SACRIFICIO pertenece a MUERTE', () => {
  for (const codigo of [...MOTIVOS_SALIDA, ...CAUSAS_MUERTE]) assert.match(migracion, new RegExp(`'${codigo}'`));
  assert.ok(CAUSAS_MUERTE.includes('SACRIFICIO'));
  assert.ok(!MOTIVOS_SALIDA.includes('SACRIFICIO'));
});

test('persistencia canónica: animales + animal_eventos; sin tabla de cierres', () => {
  assert.doesNotMatch(migracion, /create\s+table/i);
  assert.match(migracion, /'SALIDO', 'MUERTO'/);
  assert.match(migracion, /animal_eventos_un_cierre_idx/);
  const repo = strip(read(ARCHIVOS[1]));
  assert.match(repo, /update agx\.animales\s+set estado_operativo/);
  assert.match(repo, /insert into agx\.animal_eventos/);
  assert.doesNotMatch(repo, /insert into agx\.qr_chapeta_eventos|insert into agx\.animal_pesajes/, 'la chapeta se revoca solo vía revocarChapetaActivaEnTx');
  assert.match(repo, /revocarChapetaActivaEnTx\(client,/);
  assert.match(repo, /withOrganizacionTransaction\(organizacionId/);
});

test('idempotencia con el patrón de pesajes (advisory lock + UNIQUE por organización)', () => {
  const repo = strip(read(ARCHIVOS[1]));
  assert.match(repo, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(repo, /ganaderia_animal_cierre:\$\{organizacionId\}:\$\{value\.clientOperationId\}/);
  assert.match(repo, /for update/);
  assert.match(migracion, /create unique index animales_org_cierre_client_operation_key\s+on agx\.animales \(organizacion_id, cierre_client_operation_id\)/);
  const transporte = repo.indexOf('cierre_client_operation_id = $2');
  const negocio = repo.indexOf("'ANIMAL_ANULADO'");
  assert.ok(transporte > 0 && transporte < negocio, 'conflicto de transporte antes que el de negocio');
});

test('migración: RLS intacto, grants por columna, trigger de cierre terminal, rollback', () => {
  assert.doesNotMatch(migracion, /disable row level security|no force row level security|drop policy/i);
  assert.match(migracion, /grant update \(\s*estado_operativo, cierre_fecha/);
  assert.doesNotMatch(migracion, /grant (all|update) on agx\.animales to agx_app/i);
  assert.match(migracion, /create trigger animales_cierre_guard/);
  assert.match(migracion, /old\.estado_operativo = 'EN_HATO' and new\.estado_operativo in \('SALIDO', 'MUERTO'\)/);
  assert.ok(fs.existsSync(path.join(MIGRATIONS, '0025_animal_cierre_operativo_rollback.sql')));
});

test('sin legacy, Demo ni PDF; el reporte PDF solo LEE el cierre (FASE 2C)', () => {
  for (const rel of ARCHIVOS) {
    assert.doesNotMatch(strip(read(rel)), /from ['"][^'"]*\/db\.js['"]|DATABASE_URL|supabase|demo|pdfkit|reporteProductivo/i, rel);
  }
  // 2A dejó el PDF intacto; 2C lo actualiza solo como LECTOR del animal
  // serializado (estadoOperativo + cierre): nunca registra cierres ni SQL propio.
  for (const rel of ['services/ganaderia/reporteProductivo/reporteProductivoService.js', 'services/ganaderia/reporteProductivo/reporteProductivoModelo.js']) {
    const code = strip(read(rel));
    assert.doesNotMatch(code, /cierreRepository|registrarCierre|estado_operativo|\b(update|insert)\b\s/i, rel);
  }
});

test('guardas: pesajes y chapetas QR rechazan animales salidos o muertos', () => {
  assert.match(strip(read('services/ganaderia/pesajesRepository.js')), /errorAnimalCerrado\(animal\.estado_operativo, 'no admite nuevos pesajes'\)/);
  assert.match(strip(read('services/ganaderia/qrChapetasRepository.js')), /errorAnimalCerrado\(animal\.estado_operativo, 'no admite cambios de chapeta QR'\)/);
  assert.equal(errorAnimalCerrado('EN_HATO', 'x'), null);
  assert.equal(errorAnimalCerrado('SALIDO', 'x').code, 'ANIMAL_YA_SALIDO');
  assert.equal(errorAnimalCerrado('MUERTO', 'x').status, 409);
});
