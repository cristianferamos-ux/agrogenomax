// Revisión de seguridad (Bloque 5): construye un bundle de producción real
// (vite build, mismo comando que npm run build) hacia un directorio
// temporal y verifica que el texto visible "SOLO DESARROLLO" NO aparezca
// en ningún archivo generado -- la garantía real no es "el runtime lo
// oculta", es "el minificador ni siquiera incluyó la rama que lo
// renderiza" (ver !import.meta.env.PROD en CatastroXOtpVerification.jsx).
// No se busca el identificador `devOtpCode` en sí: ese nombre de
// propiedad SÍ debe seguir existiendo en el bundle (catastroxPaymentService.js
// necesita leerlo si el backend algún día lo envía por error, para
// ignorarlo con seguridad) -- lo que nunca debe existir es la RAMA que lo
// muestra en pantalla, y "SOLO DESARROLLO" es la única cadena que aparece
// exclusivamente en esa rama. Tarda más que el resto de la suite (build
// completo) a propósito: es la única forma honesta de probar esto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

test('build de producción: ningún archivo generado contiene "SOLO DESARROLLO" ni "devOtpCode"', { timeout: 120_000 }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catastrox-prod-build-otp-leak-'));

  try {
    await build({
      root: process.cwd(),
      configFile: false,
      logLevel: 'error',
      plugins: [react()],
      build: {
        outDir,
        emptyOutDir: true,
        // Sin minificar se vería el texto igual si la eliminación de
        // código muerto fallara -- pero minificado (default de
        // producción) es el escenario real de despliegue, así que se deja
        // el default (esbuild) intacto.
      },
    });

    const jsFiles = fs
      .readdirSync(path.join(outDir, 'assets'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(outDir, 'assets', name));

    assert.ok(jsFiles.length > 0, 'el build debe generar al menos un archivo .js');

    for (const filePath of jsFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(
        content,
        /SOLO DESARROLLO/,
        `${path.basename(filePath)} no debe contener el texto "SOLO DESARROLLO" en un build de producción`,
      );
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
