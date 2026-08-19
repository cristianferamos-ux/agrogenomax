# AgroGenomaX

## 1. Forma de trabajo

- Idioma de trabajo: español.
- Precisión técnica y bajo consumo de tokens.
- Un sprint nuevo debe preferir una sesión nueva de Claude Code. Dentro del mismo sprint puede mantenerse la sesión.
- Al iniciar un sprint: 1) leer CLAUDE.md; 2) confirmar repo/branch/HEAD/working tree; 3) leer solo archivos relevantes para el objetivo.
- No recorrer ni leer todo el repo salvo necesidad demostrada. No leer archivos completos si basta con búsquedas dirigidas.
- No imprimir logs extensos; mostrar solo errores, resumen y próximos pasos.
- Usar el skill `crh-token-saver` cuando corresponda.
- Antes de eliminar, sobrescribir o publicar algo, pedir confirmación.
- Informes finales compactos: cambios, pruebas, riesgos, estado Git y verdict.

## 2. Arquitectura de producto

Módulos activos: Ganadería Inteligente, CatastroX.
AGX Territorio: desarrollo estratégico, no asumir implementación activa salvo evidencia en repo.

- CatastroX = motor territorial/catastral.
- Ganadería Inteligente = vertical operativa ganadera multi-tenant.
- Ganadería Demo = protegida; no modificar salvo autorización explícita.

No mezclar dominios, bases de datos o comportamiento público sin autorización.

## 3. Bases de datos

- Postgres-AGX = autenticación/identidad (cuentas, sesiones, organizaciones, membresías y componentes asociados).
- Postgres-AGX-Business = fuente de verdad para nuevos datos de negocio de Ganadería Inteligente. Nuevas tablas: tenant-aware, `organizacion_id`, RLS ENABLE + FORCE, acceso mediante rol de aplicación restrictivo, FK tenant-safe cuando aplique.
- PostGIS territorial existente = fuente de CatastroX/consulta territorial. No modificar datos productivos de CatastroX sin autorización.
- Legacy Postgres / `DATABASE_URL` / `server/db.js` = legado sin aislamiento organizacional suficiente. No ampliar ni migrar funcionalidad nueva hacia legacy. No modificar legacy salvo autorización explícita.

## 4. Multi-tenancy y seguridad

- `organizacion_id` se obtiene server-side desde la sesión. Nunca confiar en organizacionId enviado por frontend/body/query/header.
- Toda nueva vertical de negocio debe respetar aislamiento tenant.
- CSRF obligatorio en mutaciones autenticadas. Fetch autenticado usa `credentials:'include'`.
- No exponer detalles internos, SQL, secretos ni stack traces al cliente.
- No usar cuentas ni datos reales de clientes para desarrollo/pruebas salvo autorización explícita. Preferir fixtures, mocks y DB desechable.

## 5. Infraestructura actual

- Producción Railway real: project `intuitive-rejoicing`. Servicios relevantes: agrogenomax, Postgres-AGX, Postgres-AGX-Business, postgis.
- Frontend: Cloudflare Pages.
- Repositorio: cristianferamos-ux/agrogenomax.
- NO TOCAR (salvo autorización explícita): zooming-magic, aware-exploration, optimistic-unity.

IMPORTANTE: Railway está conectado a main con auto-deploy. Antes de mergear código que dependa de cambios de esquema, definir explícitamente la secuencia segura migración/merge/deploy — no asumir que habrá tiempo entre merge y deploy automático.

## 6. Protección CatastroX

No modificar sin autorización explícita: comportamiento público `/api/catastrox/*`, frontend CatastroX, paywall/gating, compras, tokens, contratos públicos, datos productivos, arquitectura del módulo.

Puede reutilizarse CatastroX internamente mediante capas/adaptadores cuando el sprint lo autorice, sin alterar sus contratos públicos.

## 7. Git y producción

Por defecto: NO commit. NO push. NO PR. NO merge. NO deploy. NO migración en producción.
Cada una requiere autorización explícita dentro del sprint.

No interpretar "vamos", "continúa" o instrucciones generales como permiso automático para publicar o desplegar si el sprint estableció una parada previa.

- Antes de commit: revisar diff, ejecutar gates requeridos.
- Antes de merge: revisar PR completo y CI.
- Antes de producción: confirmar proyecto/servicio/DB exactos.

## 8. Secretos

Nunca: imprimir `.env` completo, imprimir passwords, imprimir connection strings con credenciales, commitear secretos, guardar secretos en documentación.
En informes: enmascarar valores sensibles.

## 9. Pruebas estándar

Gate general cuando aplique: `npm run test:node`, `npm run test:catastrox-semantic`, `npm run test:catastrox-geometry`, `npm run build`.
Para Mis Predios / Business DB cuando aplique: `npm run test:ganaderia-predios-integration`.

La integración Business DB requiere Postgres/PostGIS desechable; actualmente no debe asumirse ejecutada por GitHub Actions. CI verde no sustituye evidencia de integración DB cuando el cambio toca persistencia.

Ejecutar solo las suites relevantes durante iteración; ejecutar gate completo antes del cierre Git cuando el sprint lo exija.

## 10. Regla de alcance

El repositorio es la fuente de verdad sobre qué código existe actualmente. No asumir que información histórica de conversaciones sigue vigente.

Para cada sprint: inspeccionar primero la implementación actual pertinente; distinguir hechos observados de propuestas; no ampliar alcance silenciosamente; si aparece un hallazgo fuera de alcance, reportarlo antes de modificarlo.
