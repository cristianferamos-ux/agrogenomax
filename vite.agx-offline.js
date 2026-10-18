// SPRINT-3D11.3 (R1) -- plugin de build para la PWA offline-first:
//   1. emite dist/agx-precache.json con los archivos del build
//      (JS/CSS/imágenes con hash, incluidos los chunks lazy; sin las capas
//      .geojson de CatastroX) para que el
//      Service Worker los precachee y la app arranque sin red;
//   2. empaqueta src/modules/ganaderia/offline/swSyncEntry.js como IIFE en
//      dist/agx-offline-sync.js (global AgxOfflineSync) para el PUSH desde
//      el Service Worker (Background Sync).
// Solo usa la API pública de Vite; sin dependencias nuevas.
import { createHash } from 'node:crypto';
import { build } from 'vite';

export default function agxOfflinePlugin() {
  let outDir = 'dist';
  return {
    name: 'agx-offline',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        // Las capas .geojson de CatastroX (~17 MB) no son necesarias para
        // operar Ganadería sin red: se excluyen del precache.
        .filter((fileName) => !fileName.endsWith('.map') && !fileName.endsWith('.html') && !fileName.endsWith('.geojson') && !fileName.startsWith('.vite/'))
        .map((fileName) => `/${fileName}`)
        .sort();
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16);
      this.emitFile({
        type: 'asset',
        fileName: 'agx-precache.json',
        source: `${JSON.stringify({ version, assets }, null, 2)}\n`,
      });
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: {
            entry: 'src/modules/ganaderia/offline/swSyncEntry.js',
            name: 'AgxOfflineSync',
            formats: ['iife'],
            fileName: () => 'agx-offline-sync.js',
          },
        },
      });
    },
  };
}
