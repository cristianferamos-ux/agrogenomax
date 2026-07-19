# ADR-004: Separación estructural entre datos demo y datos de cuentas reales

- Estado: Aceptada como principio arquitectónico
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-004 conserva vigente el principio arquitectónico de separación estructural entre datos demo y datos de cuentas reales. ADR-014 es el ADR de seguimiento que seleccionó el mecanismo técnico:

- Demo vigente: origen independiente, bundle local standalone, sin backend, sin base de datos, sin relay `/api/*`, sin Cognito, sin Wompi y sin clientes API productivos.
- Staging usa datos sintéticos o previamente anonimizados.
- Producción no recibe datos demo.
- ADR-008 resuelve el aislamiento multicliente real mediante `organizacion_id` y RLS.
- El commit `26ca461` eliminó el fallback mock silencioso de CatastroX.
- `server/sql/003_agx_seed_demo_optional.sql` queda clasificado como artefacto histórico no ejecutable para staging o producción, conforme a ADR-002 y ADR-014.

## Contexto

La auditoría técnica encontró históricamente un flujo de demo explícito para Ganadería (`GanaderiaDemo.jsx` + datos asociados) y un seed de base de datos (`server/sql/003_agx_seed_demo_optional.sql`) marcado explícitamente "NO ejecutar en cuenta real. Solo para entorno demo" — pero esa separación dependía de **disciplina operativa** (no ejecutar el script en la base real), no de una barrera estructural: el esquema `agx` no tenía ningún concepto de organización/tenant ni columna que distinguiera filas demo de filas reales. Adicionalmente, CatastroX tenía un mecanismo de fallback a datos mock (`catastroxApi.js:884-899`, función `lookupPredioWithFallback`) que se activaba ante errores `API_UNAVAILABLE`/`ENDPOINT_NOT_FOUND`, y componentes explícitamente mock (`CatastroXDownloadMock.jsx`, `catastroxMockService.js`). Estos hallazgos se conservan como contexto histórico; el fallback silencioso ya fue eliminado y no debe reintroducirse.

## Problema

En el estado histórico auditado no existía garantía estructural de que los datos de demostración no pudieran aparecer mezclados con datos de cuentas reales, ni de que un fallback a mock estuviera imposibilitado de activarse sin control en producción. Esto era un riesgo de integridad de datos y de confianza comercial. ADR-014 cierra el mecanismo demo/staging/producción, y la regla vigente es que producción y staging no degradan hacia mock.

## Opciones consideradas

- **Mantener el estado actual** (separación solo por disciplina/convención de scripts): descartada — es la causa del riesgo, no una mitigación.
- **Columna `is_demo` con filtrado obligatorio a nivel de aplicación**: **descartada como solución suficiente por sí sola** — depende de que absolutamente todas las consultas presentes y futuras apliquen el filtro correctamente; un único endpoint que lo olvide reintroduce el riesgo por completo. No se descarta como complemento, pero no se acepta como única barrera.
- **Base o esquema completamente independiente para demo, con credenciales propias**: alternativa preferida — aislamiento estructural real (imposible mezclar por diseño, no solo por disciplina de consulta).
- **Entorno completamente distinto (instancia separada) para demo**: variante de la anterior con aislamiento aún mayor, a evaluar según costo/beneficio en el ADR de seguimiento.

## Decisión

Las cuentas demo y las cuentas reales **deben tener datos totalmente separados**. Esta ADR se acepta **como principio arquitectónico vinculante**. Históricamente, la selección final del mecanismo concreto de implementación se remitió a un ADR de seguimiento; ADR-014 resolvió ese seguimiento con demo standalone sin backend/base de datos y staging basado en datos sintéticos o previamente anonimizados.

- **Base de datos o esquema independiente** dedicado exclusivamente a datos demo.
- **Credenciales de conexión independientes** para el entorno demo, distintas de las credenciales de producción.
- **Imposibilidad estructural de conexión cruzada** entre el entorno demo y el de producción (no solo por configuración, sino por diseño — por ejemplo, sin ninguna ruta de red o credencial compartida que permita que un proceso del entorno demo alcance producción o viceversa).
- **Datos demo reiniciables** en cualquier momento, sin riesgo ni dependencia sobre datos de producción.

Una separación basada únicamente en una columna `is_demo` u otro mecanismo de filtrado a nivel de aplicación **no se considera suficiente** para satisfacer esta decisión.

Adicionalmente, se establece como criterio permanente: **el fallback mock de CatastroX no puede activarse en producción ni staging**. El fallback silencioso fue eliminado y no debe reintroducirse. Los fixtures solo pueden existir en demo standalone/local.

## Justificación

- El propio repositorio reconocía el riesgo (la advertencia explícita en `003_agx_seed_demo_optional.sql`), pero una advertencia en un comentario SQL no era una garantía técnica; ese archivo queda como artefacto histórico no ejecutable para staging o producción.
- Una barrera basada solo en `is_demo` traslada la responsabilidad de la separación a cada desarrollador en cada consulta futura, lo cual es estructuralmente frágil frente a un aislamiento real de credenciales/base de datos.
- El fallback mock de CatastroX, aunque estuviera acotado a un escenario de error, podía mostrar al usuario un resultado que aparentaba ser real sin una barrera técnica que lo distinguiera; por eso el fallback silencioso fue eliminado y queda prohibido reintroducirlo fuera de demo standalone/local.

## Consecuencias positivas

- Elimina el riesgo de que datos ficticios aparezcan en reportes, entregables PDF/KML o paneles de una cuenta real.
- Un aislamiento por credenciales/base de datos independiente es verificable de forma objetiva (se puede probar que la conexión demo no alcanza producción), a diferencia de un filtro de aplicación.
- Simplifica cualquier requisito futuro de cumplimiento o auditoría de datos, al tener una frontera estructural clara entre demo y producción.

## Consecuencias negativas

- Parte del trabajo de diseño quedó resuelto por ADR-014; siguen pendientes las implementaciones y verificaciones necesarias para sostener las barreras en todos los despliegues.
- Un entorno/base de datos demo independiente añade infraestructura y mantenimiento adicional respecto al estado actual.

## Riesgos

- Postergar la implementación completa de ADR-014 perpetuaría riesgos de configuración, aunque el mecanismo técnico ya no esté pendiente de decisión.
- Reintroducir fallback mock en producción o staging ante caídas del backend sería una regresión crítica; el comportamiento permitido es error seguro, no degradación a mock.
- Un aislamiento de credenciales mal configurado (por ejemplo, un rol compartido con permisos excesivos) podría no lograr la "imposibilidad de conexión cruzada" exigida, aunque exista una base de datos separada.

## Acciones requeridas

Acciones ya cerradas:

- Crear el ADR de seguimiento: cerrado por ADR-014.
- Eliminar el fallback mock silencioso de CatastroX: cerrado por commit `26ca461`.

Acciones aún pendientes de implementación:

- Implementar y verificar la demo standalone/local sin backend, base de datos, relay `/api/*`, Cognito, Wompi ni clientes API productivos.
- Implementar y verificar staging con datos sintéticos o previamente anonimizados.
- Inventariar y reclasificar puntos donde pueden aparecer datos demo o mock: `GanaderiaDemo.jsx`, `server/sql/003_agx_seed_demo_optional.sql`, `catastroxMockService.js`, `CatastroXDownloadMock.jsx` y cualquier fixture vigente.

Criterios permanentes de no regresión:

- No reintroducir fallback mock en producción o staging.
- No ejecutar `server/sql/003_agx_seed_demo_optional.sql` en staging ni producción.
- No permitir que producción reciba datos demo.

## Criterios de aceptación

- Existe un ADR de seguimiento aprobado que define el mecanismo técnico exacto de separación: ADR-014.
- Ninguna consulta contra una cuenta real puede retornar una fila marcada o almacenada como demo, verificable mediante prueba automatizada o mediante la imposibilidad estructural de conexión cruzada.
- Producción y staging no degradan hacia fallback mock. Los fixtures quedan limitados a demo standalone/local.
- Se descarta formalmente cualquier implementación que dependa únicamente de una columna `is_demo` sin aislamiento estructural adicional.

## Elementos fuera de alcance

- La selección final del mecanismo técnico específico ya fue resuelta por ADR-014; queda fuera de alcance de este ADR duplicar su especificación.
- Migración de los datos demo actualmente existentes en `db_backups/` o en cualquier entorno local.
