// Runner rastreable de la suite de pruebas geometricas: plano tecnico (anillos
// interiores) y orientacion de anillos para Shapefile (convencion ESRI).
//
// Por que existe: ambos archivos de prueba importan ../catastroxDeliverables.js, que a
// su vez importa (indirectamente, via
// ../semantic/catastroxSemanticCatalog.js) un JSON sin el atributo `with { type: 'json'
// }` que Node exige en ejecucion directa. Ese archivo es codigo aprobado y compartido
// con el motor de produccion; no se modifica para esta suite. Vite (ya declarado en
// package.json) resuelve imports JSON sin ese atributo de forma nativa, por lo que se
// usa su SSR module loader como entorno de ejecucion — el mismo mecanismo que
// ../../semantic/tests/runSemanticTests.mjs. Este runner es el unico mecanismo aprobado
// para correr la suite y vive dentro de la carpeta de utils versionada: no depende de
// audit_outputs/, scripts externos, copias manuales ni servidores previamente activos.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/modules/catastrox/utils/tests -> ... -> raiz del proyecto (5 niveles).
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');

const TEST_FILES = [
  '/src/modules/catastrox/utils/__tests__/buildTechnicalPolygonSubpaths.test.js',
  '/src/modules/catastrox/utils/__tests__/shapefileRingOrientation.test.js',
  '/src/modules/catastrox/utils/__tests__/projectedGeometryExports.test.js',
];

const server = await createServer({
  root: projectRoot,
  configFile: false,
  plugins: [react()],
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  for (const file of TEST_FILES) {
    console.log(`\n=== ${file} ===`);
    // Cada archivo registra sus propias pruebas via node:test al cargarse; node:test
    // acumula el resultado de todas las pruebas del proceso y fija process.exitCode
    // automaticamente si alguna falla (sin necesidad de logica adicional aqui).
    await server.ssrLoadModule(file);
  }
} finally {
  await server.close();
}
