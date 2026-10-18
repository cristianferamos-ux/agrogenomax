# AgroGenomaX — Sprint 3D11.2: fortalecimiento de pruebas

Fecha: 15 de octubre de 2026 (America/Bogota).
Rama: `feature/ganaderia-animales-manual`.
Worktree: `agx-ganaderia-acceso-001`.
Base revisada: `1272ae4` (`feat(ganaderia): add manual animal registration`).

## Cambios

### Ejecución de Node en Windows

- `package.json`: `test:node` ahora ejecuta `node .tools/run-node-tests.mjs`.
- `.tools/node-test-files.json`: contiene exactamente los 164 archivos anteriores, en el mismo orden y sin duplicados; se contrastó contra `git show HEAD:package.json`.
- El comando anterior medía 10.902 caracteres. Ahora el shell recibe un comando corto y los archivos pasan directamente a `node:test.run`, con aislamiento por proceso y concurrencia.
- `.tools/test-runner.mjs`: comparte la ejecución y el reporte; devuelve código 1 ante fallos reales. En modo general conserva la semántica de `skip` y `todo`, incluso TODO con aserción fallida.
- Los nuevos contratos se ejecutan con `npm run test:test-runners` y también forman parte de `test:all` / `npm test`.

### Integración obligatoria de animales

- `test:ganaderia-animales-integration` ahora utiliza `.tools/run-ganaderia-animales-integration.mjs` y su validación específica `.tools/animales-integration-env.mjs`.
- Exige ambas variables: `AGX_BUSINESS_DATABASE_URL_TEST` y `AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL`. Rechaza valores vacíos, espacios y URL inválidas.
- No carga archivos `.env`, no toma la URL runtime como alternativa y no imprime cadenas de conexión ni mensajes del driver con posibles datos sensibles.
- Como restricción del comando dedicado, ambas conexiones deben ser PostgreSQL en loopback (`localhost`, `127.0.0.1` o `::1`), al mismo nombre de base y puerto. La conexión app debe utilizar `agx_app` para que las pruebas de RLS sean relevantes. La validación usa el destino efectivo interpretado por `pg`, incluido un posible `host` en query string.
- Comprueba las dos conexiones mediante consultas de metadatos, con límites de conexión y consulta de 5 segundos, y cierra ambos pools.
- Verifica seis tablas necesarias: `predios`, `catalogo_categorias_productivas`, `catalogo_razas`, `animales`, `animal_pesajes` y `animal_eventos`. La ausencia de tablas produce error y remite a las migraciones hasta 0022; no ejecuta migraciones.
- Las suites existentes siguen comprobando columnas, restricciones, políticas, grants y comportamiento del repositorio. Cualquier fallo provoca salida 1.
- El reporte del comando dedicado rechaza cualquier prueba o suite con `skip` o `todo`. También exige al menos 24 pruebas aprobadas del archivo de esquema y 27 del repositorio. Un archivo vacío no se cuenta como una prueba ejecutada.
- Las dos suites originales de integración no fueron modificadas. En la suite general conservan sus omisiones cuando no existe entorno de pruebas.

### Advertencias de Vite

Se reprodujo `The server is being restarted or closed. Request is outdated [plugin vite:dep-scan]` al ejecutar las suites semántica y geométrica. Sus servidores SSR cerraban mientras seguía activo el escaneo de entradas HTML del navegador. El arranque normal de Vite no reprodujo ese problema.

Se añadió únicamente `optimizeDeps: { noDiscovery: true, include: [] }` a:

- `src/modules/catastrox/semantic/tests/runSemanticTests.mjs`.
- `src/modules/catastrox/utils/tests/runGeometryTests.mjs`.

Estas suites solo necesitan el cargador SSR. Sus pruebas siguieron pasando y sus logs finales ya no contienen `vite:dep-scan` ni `Failed to run dependency scan`. No se modificó `vite.config.js`, el nivel de logs ni la configuración de la aplicación. La compilación conserva la advertencia independiente de chunks mayores de 500 kB.

Referencia: [opciones oficiales de optimización de Vite](https://vite.dev/config/dep-optimization-options#optimizedeps-nodiscovery).

### Dependencias

Se conservan todos los rangos de `dependencies` y `devDependencies` de `package.json`. Se actualizó `package-lock.json` mediante `npm audit fix --package-lock-only --ignore-scripts --no-fund`, sin `--force`. Ese comando devuelve 1 por incidencias de desarrollo pendientes; la auditoría de producción posterior devuelve 0.

`npm install` indicó éxito pero mantuvo versiones locales antiguas. Se ejecutó después `npm ci --ignore-scripts --no-audit --no-fund`; las verificaciones finales utilizan las versiones reinstaladas desde el lockfile.

| Paquete | Antes | Después |
| --- | --- | --- |
| @xmldom/xmldom | 0.9.11 | 0.9.12 |
| baseline-browser-mapping | 2.10.31 | 2.11.29 |
| browserslist | 4.28.2 | 4.29.3 |
| caniuse-lite | 1.0.30001793 | 1.0.30001816 |
| electron-to-chromium | 1.5.360 | 1.5.457 |
| ip-address | 10.3.1 | 10.7.4 |
| nanoid | 3.3.12 | 3.3.20 |
| node-releases | 2.0.45 | 2.0.59 |
| postcss | 8.5.15 | 8.5.30 |
| postcss-selector-parser | 6.1.2 | 6.1.4 |
| proxy-addr | 2.0.7 | 2.0.8 |
| qs | 6.15.2 | 6.16.1 |
| react-router | 7.16.0 | 7.18.4 |
| react-router-dom | 7.16.0 | 7.18.4 |
| side-channel | 1.1.0 | 1.1.1 |
| source-map-js | 1.2.1 | 1.2.2 |
| update-browserslist-db | 1.2.3 | 1.3.4 |

Tailwind permanece en **3.4.19**, con rango **^3.4.17**. Vite permanece en 7.3.6.

## Verificación ejecutada

Node 24.16.0, npm 11.13.0. Ejecución general en Windows. Integración PostgreSQL mediante la imagen Node 24.16.0 ya instalada, compartiendo la red del contenedor desechable existente `agx-3d11-test-pg`, con el código montado en solo lectura. Se utilizó `agx_3d11_test`; el caso negativo de tablas ausentes solo consultó metadatos de la base local `postgres` del mismo contenedor.

| Comprobación | Resultado |
| --- | --- |
| `npm run test:test-runners` (incluido en `test:all`) | 36 aprobadas; 0 fallos, 0 omisiones |
| `npm run test:node`, sin entorno PostgreSQL | 164 archivos conservados; 2.843 aprobadas, 27 omitidas, 0 fallos |
| `npm run test:ganaderia-animales-integration`, entorno válido | 51 aprobadas; 0 fallos, 0 omisiones |
| Falta de variable app | Salida 1 con diagnóstico de configuración |
| Falta de variable admin | Salida 1 con diagnóstico de configuración |
| Conexión rechazada | Salida 1 con diagnóstico de conexión app |
| Rol admin inexistente | Salida 1 con diagnóstico de conexión admin |
| Tablas ausentes | Salida 1, con las seis tablas faltantes identificadas |
| `ganaderiaAnimalesAuth.test.js` + `animalValidation.test.js` | 54 aprobadas, 0 omisiones |
| `npm run test:catastrox-semantic`, tras ajuste SSR | 29 aprobadas; sin advertencias dep-scan |
| `npm run test:catastrox-geometry`, tras ajuste SSR | 86 aprobadas; sin advertencias dep-scan |
| `npm run test:all` | Salida 0 con dependencias finales; luego se repitieron las dos suites SSR afectadas por el último ajuste |
| `npm run build` con dependencias finales | Salida 0; permanece aviso de tamaño de chunks |
| `npm audit --omit=dev --json` | 0 vulnerabilidades, salida 0 |
| `npm audit --json`, incluidas dependencias de desarrollo | 7 incidencias: 5 altas y 2 moderadas; todas en paquetes marcados dev |
| `git diff --check` | Sin errores de whitespace |

Precisiones sobre los antecedentes proporcionados:

- Las 51 pruebas del comando dedicado comprenden 3 comprobaciones estáticas del SQL y 48 que ejercitan PostgreSQL. Todas se ejecutaron sin omisiones.
- La suite Node general se ejecutó sin variables de integración y aprobó 2.843 pruebas; la diferencia de 51 frente al antecedente de 2.894 coincide con la suite de animales ejecutada por separado contra PostgreSQL. No se presenta esa suma como una única regresión general con base configurada.
- La selección explícita de autorización y validación de animales contiene 54 pruebas en este checkout. No se afirma haber reproducido el antecedente de 80 pruebas específicas con esa selección.
- La auditoría completa conserva incidencias en `braces`, `chokidar`, `fast-glob`, `micromatch`, `postcss-nested`, `postcss-selector-parser` y `tailwindcss`. npm propone Tailwind 4 como solución automática con `--force`; no se aplicó por la restricción del sprint. La auditoría de producción está limpia.

## Límites respetados

- Trabajo exclusivamente en `feature/ganaderia-animales-manual`; no se cambió la rama del checkout inicial ni sus cambios preexistentes.
- Sin acceso a bases de producción ni lectura o modificación de archivos `.env` por parte de los cambios de este sprint.
- Sin ejecución ni edición de migraciones.
- Sin cambios en rutas, servicios, validación funcional, UI ni repositorios de animales.
- Sin commit, push, PR, merge ni deploy.

Los cambios permanecen sin commit para revisión.

## Cierre adicional de seguridad

Fecha: 15 de octubre de 2026.

### Protección de PostgreSQL

- Se exige `AGX_ALLOW_DISPOSABLE_DB_TESTS=yes`.
- Se exige `AGX_DISPOSABLE_TEST_DB_NAME` con sufijo `_test`.
- Las conexiones deben coincidir con el nombre declarado.
- Se mantiene la restricción a loopback y el rol `agx_app`.
- La autorización y el nombre de la base son controles preventivos; no garantizan por sí solos que el servidor sea desechable.
- La integración real se ejecutó sobre `agx_3d11_test`, dentro del entorno Docker de pruebas aislado.

### Fortalecimiento del ejecutor

- Se valida que el manifiesto no esté vacío.
- Se rechazan archivos inexistentes o inválidos.
- Los fallos de escritura del reporte producen resultado `1`.
- Se mantiene el control estricto de `skip`, `todo` y umbrales de pruebas.

### Resultados posteriores a los ajustes

| Comprobación | Resultado |
| --- | --- |
| Contratos de ejecutores | 42 aprobados; 0 fallidos; 0 omitidos |
| Rechazo sin autorización | Aprobado |
| Archivo inexistente mediante `runTestFiles` | Rechazado |
| Error simulado del reporte | Detectado; resultado `1` |
| Integración PostgreSQL | 51 aprobadas; 0 fallidas; 0 omitidas |
| Compilación Vite | Exitosa; 2.194 módulos transformados |
| `git diff --check` | Sin errores; advertencias LF/CRLF |

### Estado del sprint

Los cambios permanecen sin commit. No se realizaron migraciones,
push, PR, merge ni despliegue durante este cierre adicional.

Pendiente: revisión final de los archivos nuevos y preparación del commit.