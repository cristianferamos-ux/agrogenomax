// Runner rastreable de la suite de pruebas de la biblioteca semantica urbana.
//
// Por que existe: los archivos de prueba (../urban/__tests__/*.test.js) importan, a
// traves de urbanDomainCatalog.js, el catalogo existente ../catastroxSemanticCatalog.js,
// que a su vez importa ../catastroxSemanticCatalog.caqueta.json con un import ESM plano
// (sin el atributo `with { type: 'json' }` que exige Node en ejecucion directa). Ese
// archivo es codigo aprobado y compartido con el motor de produccion; no se modifica
// para esta suite. Vite (ya declarado en package.json) resuelve imports JSON sin ese
// atributo de forma nativa, por lo que se usa su SSR module loader como entorno de
// ejecucion. Este runner es el unico mecanismo aprobado para correr la suite y vive
// dentro de la carpeta semantica versionada: no depende de ningun script externo al
// commit.
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/modules/catastrox/semantic/tests -> ... -> raiz del proyecto (5 niveles).
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');

const TEST_FILES = [
  '/src/modules/catastrox/semantic/urban/__tests__/urbanInterpretationEngine.test.js',
  '/src/modules/catastrox/semantic/urban/__tests__/urbanAggregationRules.test.js',
  '/src/modules/catastrox/semantic/urban/__tests__/urbanNarrativeBuilder.test.js',
  '/src/modules/catastrox/semantic/urban/__tests__/urbanQualityRules.test.js',
];

const server = await createServer({
  root: projectRoot,
  configFile: path.resolve(projectRoot, 'vite.config.js'),
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
