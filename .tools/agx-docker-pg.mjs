// HARDENING PRE-SANIDAD (PR A) -- clusters PostgreSQL DESECHABLES en Docker
// para la prueba DR y la integración del runner. Solo loopback, puerto
// asignado por Docker, contraseña de superusuario aleatoria por ejecución.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export const IMAGES = {
  // Mismas versiones mayores que producción (verificado 2026-11-06):
  // Postgres-AGX-Business = PostgreSQL 16.4 + PostGIS 3.4; Postgres-AGX = 18.6.
  business: 'postgis/postgis:16-3.4',
  auth: 'postgres:18',
};

function docker(args, { input, encoding = 'utf8', allowFail = false } = {}) {
  const res = spawnSync('docker', args, { input, encoding, maxBuffer: 512 * 1024 * 1024 });
  if (res.error) throw new Error(`docker no disponible (${res.error.code})`);
  if (res.status !== 0 && !allowFail) {
    const err = Buffer.isBuffer(res.stderr) ? res.stderr.toString('utf8') : res.stderr;
    throw new Error(`docker ${args[0]} falló: ${(err || '').trim().split('\n').slice(-2).join(' | ')}`);
  }
  return res;
}

export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function startCluster(kind, label) {
  const image = IMAGES[kind];
  const name = `agx-${label}-${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(18).toString('hex');
  docker(['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', image]);
  const port = docker(['port', name, '5432/tcp']).stdout.trim().split('\n')[0].split(':').pop();
  const cluster = {
    name, kind, port, password,
    adminUrl: (db = 'postgres') => `postgres://postgres:${password}@127.0.0.1:${port}/${db}`,
    exec: (args, opts) => docker(['exec', ...(opts?.input !== undefined ? ['-i'] : []), name, ...args], opts),
  };
  // La imagen oficial reinicia el servidor tras el init: esperar a que
  // acepte TCP de forma estable (dos sondas seguidas).
  let ok = 0;
  for (let i = 0; i < 90 && ok < 2; i += 1) {
    const res = docker(['exec', '-e', `PGPASSWORD=${password}`, name, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-tAc', 'select 1'], { allowFail: true });
    ok = res.status === 0 ? ok + 1 : 0;
    await sleep(1000);
  }
  if (ok < 2) {
    stopCluster(cluster);
    throw new Error(`el cluster ${name} no quedó listo`);
  }
  return cluster;
}

export function stopCluster(cluster) {
  if (cluster) docker(['rm', '-f', cluster.name], { allowFail: true });
}
