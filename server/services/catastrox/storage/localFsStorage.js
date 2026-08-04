// CATX-DELIVERY-001: adaptador de almacenamiento SOLO PARA DESARROLLO.
//
// !! NO APTO PARA PRODUCCIÓN !! -- escribe al sistema de archivos del
// proceso. En Railway (y en cualquier plataforma de contenedores efímeros)
// ese disco NO sobrevive un redeploy/reinicio: cualquier PDF guardado así
// se pierde silenciosamente. server/config/env.js impide arrancar en
// producción con CATASTROX_STORAGE_DRIVER=local-dev-only -- este archivo
// existe únicamente para poder probar el pipeline completo en una máquina
// local sin depender de Postgres para los bytes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveMaxDeliverableBytes } from './postgresBlobStorage.js';

function resolveBaseDir() {
  return process.env.CATASTROX_LOCAL_STORAGE_DIR || '.local-storage/catastrox-deliverables';
}

function resolveFilePath(deliverableId) {
  // deliverableId es un uuid generado por Postgres (gen_random_uuid()) --
  // nunca un valor libre del cliente, así que es seguro usarlo como nombre
  // de archivo sin sanitizar más allá de esta validación de forma.
  if (!/^[0-9a-f-]{36}$/i.test(String(deliverableId || ''))) {
    throw Object.assign(new Error('deliverableId inválido para almacenamiento local.'), {
      code: 'DELIVERABLE_ID_REQUIRED',
    });
  }
  return path.join(resolveBaseDir(), `${deliverableId}.pdf`);
}

export async function put(deliverableId, buffer, { contentType = 'application/pdf' } = {}) {
  void contentType; // el adaptador local solo sirve application/pdf, sin metadato aparte
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('El PDF generado está vacío -- no se almacena.'), {
      code: 'EMPTY_DELIVERABLE_BUFFER',
    });
  }
  const maxBytes = resolveMaxDeliverableBytes();
  if (buffer.length > maxBytes) {
    throw Object.assign(
      new Error(`El PDF generado (${buffer.length} bytes) supera el límite permitido (${maxBytes} bytes).`),
      { code: 'DELIVERABLE_TOO_LARGE' },
    );
  }

  const filePath = resolveFilePath(deliverableId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);

  return { storageKey: `local:${deliverableId}` };
}

export async function get(deliverableId) {
  try {
    const bytes = await fs.readFile(resolveFilePath(deliverableId));
    return { bytes, contentType: 'application/pdf' };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
