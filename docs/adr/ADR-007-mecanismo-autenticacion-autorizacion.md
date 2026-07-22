# ADR-007: Mecanismo de autenticación y autorización de AgroGenomaX

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-007 selecciona Amazon Cognito como proveedor de identidad, pero decisiones posteriores precisan su alcance:

- ADR-008 cerró el modelo multicliente: organizaciones, membresías, `organizacion_id`, autorización centralizada y RLS.
- ADR-009 cerró el patrón de sesión: BFF Express, cookie opaca, sesión referenciada, CSRF y Bearer directo solo para integraciones externas autorizadas.
- ADR-011 sustituyó App Runner por ECS Express Mode; ECS + Fargate directo es contingencia AWS y Railway permanece como rollback temporal.
- ADR-013 cerró la autorización transaccional de CatastroX: orders, payments, entitlements, artifacts, tokens/cookies de acceso.
- ADR-014 cerró separación demo/staging/producción: demo standalone/local, sin backend, sin base de datos, sin credenciales demo y sin futuras demos persistentes con backend en este modelo.

Siguen pendientes de implementación, no de arquitectura: Cognito/BFF/CSRF, DDL físico multicliente, RLS, mecanismo exacto de contexto tenant por transacción, implementación ADR-013, política uniforme `403`/`404` si sigue abierta, y revocación inmediata adicional si el negocio la exige.

## 1. Contexto

ADR-005 (Aceptada) estableció el modelo de tres niveles de ruta y dejó pendiente el mecanismo definitivo de autenticación. Este ADR-007 resuelve esa decisión pendiente.

La verificación directa del código confirma que **no existe ningún mecanismo de identidad de usuario en todo el sistema** — ni backend, ni frontend, ni en ninguna de las dos bases de datos activas. También confirma que la demo real de Ganadería (`GanaderiaDemo.jsx`) es 100% local al navegador, sin llamadas al backend — distinto de lo que el riesgo de ADR-004 describe, que proviene de un mecanismo separado y hoy inactivo (`server/sql/003_agx_seed_demo_optional.sql`).

Adicionalmente, se confirmó en código que `GET /api/catastrox/lookups/:lookupId/full-result` **no verifica ningún pago** — su única entrada es un `lookupId` gratuito de 30 minutos de vida emitido por el endpoint público `/lookup`.

## 2. Problema

AgroGenomaX no puede llegar a producción sin resolver quién puede hacer qué. Hoy cualquiera puede leer/modificar el CRUD ganadero completo, obtener el entregable catastral pagado sin pagar, y no existe ningún concepto de organización/cuenta en el esquema `agx`. El equipo no muestra, en ninguna parte del repositorio, tooling ni patrones previos de seguridad de autenticación (sin `helmet`, sin rate limiting salvo un caso puntual, sin hash de contraseñas, sin gestión de secretos más allá de variables de entorno básicas) — evidencia que condiciona directamente qué tan seguro es que el equipo construya criptografía de credenciales por su cuenta.

## 3. Estado actual verificado

*(Confirmado por lectura directa del código.)*

- **Ausencia de autenticación** — CONFIRMADO: `server/index.js` monta 12 routers sin ningún middleware de autenticación.
- **Ausencia de librerías de seguridad** — CONFIRMADO: ni `server/package.json` ni `package.json` (raíz) declaran `jsonwebtoken`, `passport`, `bcrypt`, `argon2`, `express-session`, `express-rate-limit`, `helmet`, ni ningún SDK de AWS.
- **Ausencia de tablas de usuarios en `agx`** — CONFIRMADO: las 11 tablas de `server/sql/001_agx_core_schema.sql` no incluyen usuarios, organizaciones ni roles; `agx.predios.propietario` es texto libre, no una relación.
- **`public`/Supabase sí modela identidad, pero es legacy** — CONFIRMADO: `organizations`, `profiles`, `farms` existen solo en el esquema retirado condicionalmente por ADR-002.
- **Supabase Auth nunca se usó** — CONFIRMADO: `src/lib/supabaseClient.js` es un wrapper manual de `fetch` con la `anon key`, sin `@supabase/supabase-js` ni ninguna llamada a `auth.*`.
- **No existe formulario de login real** — CONFIRMADO: `GanaderiaAccess.jsx` presenta el botón de "Ingreso de usuarios registrados" **deshabilitado**, con la nota "Módulo privado en preparación".
- **Demo 100% local** — CONFIRMADO: `GanaderiaDemo.jsx` usa `loadDemoData()`/`useState`, sin `fetch` ni `ganaderiaApi`, nunca toca `agx`.
- **QR sin verificación de propiedad** — CONFIRMADO: `server/routes/qr.js` no filtra por ninguna cuenta.
- **`full-result` sin verificación de pago** — CONFIRMADO: `server/routes/catastrox.js:1663-1681` llama a `buildLookupFullResultPayload(lookupId)` sin ninguna comprobación de transacción; el `lookupId` lo emite gratuitamente `POST /lookup`.

**NO VERIFICADO**: tamaño real del equipo y presencia/ausencia de un especialista de seguridad dedicado; volumen real o proyectado de usuarios; existencia de cuenta AWS activa más allá de lo descrito en ADR-001; alojamiento real del repositorio en GitHub; proveedor de correo saliente evaluado; tarifa/plan vigente de Cognito al momento de la implementación.

## 4. Requisitos obligatorios

1. No depender de Supabase Auth (ADR-002).
2. Operar correctamente detrás de backend Express en ECS Express Mode (ADR-011), con ECS + Fargate directo como contingencia y Railway como rollback temporal.
3. Todo el CRUD ganadero requiere autenticación, sin excepción (ADR-005).
4. Las rutas administrativas requieren autenticación **y** autorización de rol (ADR-005).
5. CatastroX conserva su compra pública sin login obligatorio; toda operación pública transaccional queda gobernada por ADR-013, incluyendo el cierre arquitectónico del hallazgo de `full-result`.
6. Ninguna interfaz aprobada puede rediseñarse como efecto colateral de este ADR.
7. Contraseñas, si existen, nunca se almacenan en texto plano ni con hash débil.
8. Ningún secreto de servidor puede vivir en el frontend.
9. Debe existir una vía de auditar quién hizo qué, cuándo.
10. El mecanismo debe ser mantenible por el equipo actual sin depender de un especialista de seguridad dedicado.
11. Debe respetar el presupuesto de staging de USD 25/mes; cualquier estimación de costo de un servicio gestionado (incluido Cognito) debe hacerse con la tarifa oficial vigente antes de crear el recurso, no con cifras aproximadas.
12. **El backend debe aceptar exclusivamente access tokens de Cognito como credencial Bearer para autorizar llamadas a la API — el ID token nunca se acepta como credencial de autorización de API** (ver sección 9.1).
13. Las organizaciones, membresías, roles, permisos y roles internos son responsabilidad exclusiva del modelo de datos en `agx` — Cognito no es fuente de verdad de autorización de negocio (ver sección 8).
14. **Se aplica el principio de mínimo privilegio y segregación de funciones a todo rol interno, incluido el superadministrador** — ningún rol interno obtiene acceso automático a datos de clientes por el solo hecho de tener el rol (ver sección 8.1).

## 5. Alternativas consideradas

### 5.1 Amazon Cognito

Servicio gestionado de identidad de AWS. No está instalado ni configurado — evaluación de una alternativa, no descripción de algo implementado.

- **Integración con backend Express en ECS Express Mode**: viable vía verificación de JWT contra el JWKS público del User Pool, sin acoplamiento a la plataforma histórica sustituida.
- **Emisión y validación de tokens**: Cognito emite `id_token`, `access_token` (ambos JWT) y `refresh_token`. **Solo el `access_token` se acepta como Bearer de la API** (sección 9.1) — el `id_token` está diseñado para representar la identidad del usuario ante el propio cliente/relying party, no para autorizar llamadas a una API de recursos, y mezclar ambos es un error de implementación común que este ADR prohíbe explícitamente.
- **Recuperación de contraseña**: incluida de fábrica.
- **MFA**: soportado de fábrica. **TOTP se mantiene como mecanismo preferente a evaluar** por no depender de mensajería SMS; **SMS y determinadas opciones de MFA/mensajería pueden generar costo adicional o requerir configuración adicional** (por ejemplo, integración con Amazon SNS/SES) — no se asume gratuidad de estas opciones.
- **Confirmación de correo**: incluida de fábrica; el envío efectivo puede depender de configuración adicional de mensajería (SES u otro), no se asume resuelto de fábrica sin configuración.
- **Grupos o claims para roles**: Cognito soporta grupos reflejados como claim en el token. **Este ADR establece que los grupos de Cognito NO serán la fuente de verdad de autorización de negocio** (sección 8) — se reservan, como máximo, para una futura excepción explícitamente aprobada y documentada.
- **Integración con frontend React**: el patrón exacto fue cerrado por ADR-009: navegador hacia BFF con cookie opaca y CSRF; Bearer directo solo para integraciones externas autorizadas.
- **Integración con backend Express**: requiere middleware de verificación de JWT con las reglas explícitas de la sección 9.1.
- **Compatibilidad con cuentas empresariales**: soporta federación SAML/OIDC futura, no necesaria hoy.
- **Dependencia de AWS**: alta.
- **Complejidad**: de configuración más que de código.
- **Costos**: **no se puede afirmar en este documento una cifra ni un umbral de capa gratuita** — los costos de Cognito dependen del plan vigente, del número de usuarios activos mensuales (MAU), de si se usa federación, de las funciones de mensajería (SMS/correo) y de funciones avanzadas. **Se requiere una estimación explícita con la tarifa oficial vigente de AWS antes de crear el User Pool** (acción requerida, sección 17).
- **Observabilidad**: integra con CloudWatch de forma nativa.
- **Portabilidad**: baja para la emisión de tokens; moderada para su verificación (estándar JWT/JWKS).
- **Riesgos operativos**: mala configuración de políticas o dominios de callback; riesgo de revocación no inmediata si el backend valida JWT localmente (sección 9.2).
- **Trabajo de implementación requerido**: crear el User Pool (Terraform, ADR-003/010), configurar App Client, BFF Express, middleware de verificación de tokens (sección 9.1), mapeo de identidad a autorización en `agx` (sección 8) y CSRF conforme a ADR-009. Nada de esto se ejecuta en este ADR.

### 5.2 Autenticación propia

Implementación manual de tabla de usuarios, hash de contraseñas, JWT propio, refresh tokens, recuperación, MFA, protección contra fuerza bruta, auditoría — todo a construir desde cero, con riesgo de implementación insegura calificado como **alto**, dado que el repositorio no muestra ninguna experiencia previa demostrable con estas piezas (sección 3).

### 5.3 Estrategia híbrida

Cognito para autenticación (identidad, contraseñas, MFA, recuperación) + modelo de autorización propio en PostgreSQL (`agx`) para organizaciones, membresías, roles y permisos. Esta separación no es opcional ni ambigua — es una regla explícita (sección 8): Cognito nunca decide qué puede hacer un usuario en el dominio de negocio de AgroGenomaX; solo certifica quién es.

### 5.4 Mantener Supabase Auth

Descartada — nunca se implementó en código real (sección 3) y contradice ADR-002.

### 5.5 Mantener el sistema sin autenticación

Descartada — hallazgo Crítico ya documentado en ADR-005.

## 6. Matriz comparativa

| Criterio | Cognito | Autenticación propia | Híbrida (recomendada) |
|---|---|---|---|
| Seguridad (dado el equipo actual) | Alta | Baja-Media | Alta |
| Complejidad de implementación | Media (configuración AWS + integración de tokens + decisión de patrón de sesión, sección 9.3) | Alta | Media-Alta |
| Costo inicial | No estimable en este documento — depende de la tarifa oficial vigente de AWS al momento de la implementación | Bajo en licencias, alto en horas de desarrollo | Similar a Cognito, más horas de diseño del modelo de autorización |
| Costo operativo | No estimable en este documento — depende de MAU, federación, mensajería (SMS/correo) y funciones avanzadas; requiere estimación con tarifa oficial antes de crear el recurso | Medio (mantenimiento continuo de código de seguridad propio) | Igual condición que Cognito puro para la pieza de identidad, más el mantenimiento (comparativamente ligero) del modelo de autorización |
| Dependencia de proveedor | Alta (AWS) | Ninguna | Media (solo la pieza de identidad) |
| Integración con AWS (ECS Express Mode) | Nativa | Neutra | Nativa para identidad, neutra para autorización |
| Portabilidad | Baja | Alta | Media |
| Recuperación de cuenta | Incluida de fábrica | A construir por completo | Incluida de fábrica (vía Cognito) |
| MFA | Incluido de fábrica (TOTP preferente; SMS puede generar costo/config. adicional) | A construir por completo | Incluido de fábrica (vía Cognito) |
| Multi-tenencia (organizaciones/roles por finca) | Débil nativamente | Total, a diseñar desde cero | Total — se diseña en `agx`, fuente de verdad única de autorización |
| Mantenimiento a largo plazo | Bajo | Alto | Bajo-Medio |
| Riesgo de implementación insegura | Bajo, condicionado a implementar correctamente la validación de tokens (sección 9.1) y la política de revocación (sección 9.2) | Alto | Bajo, con las mismas condiciones que Cognito puro |
| Revocación inmediata de acceso | Limitada por diseño si la validación es local (JWT stateless) — requiere mecanismo adicional, sección 9.2 | Depende enteramente del diseño propio | Misma limitación que Cognito puro para el token de acceso; mitigable con TTL corto y mecanismo adicional para casos críticos |
| Adecuación para AgroGenomaX hoy | Alta, con las salvedades de tokens/revocación/sesión de este ADR | Baja | Alta |

## 7. Modelo de identidad propuesto

- **La identidad primaria del usuario vive en Amazon Cognito** (User Pool dedicado).
- **El backend Express acepta exclusivamente el `access_token` de Cognito como credencial Bearer de la API.** El `id_token` nunca se acepta como credencial de autorización — ver sección 9.1 para las reglas completas de validación.
- **El identificador `sub` de Cognito** se usa como clave foránea en las tablas de autorización futuras de `agx` (sección 8).
- **El aprovisionamiento de cuentas no es uniforme entre módulos**:
  - **Ganadería**: el alta inicial de una cuenta/organización se realiza **preferiblemente por invitación de CRH Soluciones Integrales S.A.S.**, no por auto-registro público (`self-sign-up`). Consistente con el estado actual de la interfaz (`GanaderiaAccess.jsx`: "La apertura de cuentas reales será acompañada por el equipo de AgroGenomaX").
  - **CatastroX (compra pública)**: no requiere cuenta ni identidad de Cognito en absoluto.
  - **CatastroX (cuenta futura)**: registro opcional, nunca condición para completar una compra.
  - **Administradores internos**: alta controlada, nunca auto-registro.
  - La política definitiva y el mecanismo exacto de aprovisionamiento por módulo quedan como decisión de seguimiento (sección 20).
- **No se diseña aquí el detalle del User Pool** (políticas de contraseña, plantillas, dominios) — acción requerida (sección 17).

## 8. Modelo de organizaciones, membresías, roles y permisos

**El esquema `agx` no soporta multi-tenencia** (verificado por ausencia, sección 3) — requiere diseño de datos posterior, fuera de alcance de este ADR (sección 19). Este documento no inventa tablas.

**Regla de fuente de verdad**: organizaciones, membresías, roles, permisos y roles internos **viven exclusivamente en `agx`** (tablas a diseñar en el ADR de seguimiento, sección 20). **Cognito es fuente de identidad, no de permisos de negocio.** No se implementará un modelo de autorización dividido entre grupos de Cognito y tablas de `agx`. **Los grupos de Cognito no serán la fuente de verdad de autorización**, salvo que en el futuro se apruebe explícitamente, mediante una decisión separada y documentada, una excepción puntual.

Conceptos que cubre el modelo arquitectónico cerrado por ADR-008 (sin inventar aquí su DDL físico): Usuario (por `sub`), Organización/cliente, Membresía (usuario↔organización con rol), Rol (catálogo, sección 8.1), Permisos derivados del rol, `organizacion_id` directo en tablas organizacionales, asociación opcional de compras de CatastroX a un `sub`, roles internos (administradores/soporte CRH) y su alcance. La demo queda fuera del backend y la base de datos por ADR-014.

### 8.1 Matriz de roles propuesta (sin aprobar impersonación)

*Propuesta para discusión — ningún rol se implementa como parte de este ADR. La capacidad de "impersonación" listada abajo se documenta como posibilidad técnica, **no se aprueba aquí**: queda como decisión separada, explícita y auditada (sección 20).*

**Principio aplicable a todo rol interno**: se rige el diseño de roles internos por **mínimo privilegio y segregación de funciones** — ningún rol interno, incluido el superadministrador, obtiene acceso automático y permanente a los datos de clientes por el solo hecho de tener el rol. Cualquier acceso a datos de una organización específica por parte de un rol interno (superadministrador, Administrador CRH o Soporte) **debe ser temporal, justificado, auditado, y estar asociado a una solicitud, incidente o procedimiento aprobado** — nunca un acceso permanente e irrestricto derivado únicamente de la jerarquía del rol.

| Rol | Tipo | Operaciones permitidas | Operaciones prohibidas | Datos visibles | Alcance organizacional | Rutas aproximadas | Exportación | Soporte/impersonación |
|---|---|---|---|---|---|---|---|---|
| **Superadministrador** | Interno | Administrar configuración global de la plataforma, seguridad, identidades internas (altas/bajas de administradores/soporte) y gobierno técnico (políticas, infraestructura de identidad, parámetros de la plataforma) | Acceso automático a datos de clientes por el solo hecho de tener el rol; exportación masiva global sin un procedimiento excepcional formal | Ningún dato de cliente por defecto; acceso excepcional a datos de una organización específica únicamente cuando sea temporal, justificado, auditado, y esté asociado a una solicitud, incidente o procedimiento aprobado | Global para configuración/seguridad/gobierno técnico; **no global para datos de clientes** — acceso excepcional caso por caso, nunca permanente | Rutas administrativas de configuración global, seguridad e identidades internas; acceso a datos de una organización únicamente mediante el procedimiento excepcional auditado (mecanismo a definir en el diseño de seguimiento) | **Prohibida la exportación masiva global**, salvo procedimiento excepcional formal, auditado y no derivado automáticamente del rol | Impersonación técnicamente posible; **no aprobada en este ADR** — requiere decisión separada y auditada |
| **Administrador CRH** | Interno | Gestión operativa de clientes: alta/gestión de organizaciones, soporte de primer nivel, configuración de catálogos (razas, vacunas) | Acceso permanente e irrestricto a datos de clientes fuera de un caso de gestión activo; modificar configuración global de infraestructura/seguridad (reservado a superadministrador) | Datos de las organizaciones bajo gestión activa, con el mismo principio de acceso temporal, justificado y auditado que el superadministrador cuando la consulta no es parte de una operación de alta/gestión rutinaria ya autorizada | Multi-organización (subconjunto asignado, según diseño de seguimiento), nunca acceso global permanente no justificado | Rutas administrativas de gestión de clientes | Sí, de las organizaciones que gestiona activamente, sujeto a auditoría | Impersonación técnicamente posible; **no aprobada en este ADR** |
| **Soporte** | Interno | Consulta de datos de una organización para atender un caso de soporte, con motivo registrado | Modificar datos de producción del cliente sin un procedimiento explícito de soporte (a definir); consultar datos de una organización sin un caso activo asociado | Datos de la(s) organización(es) del caso activo, con trazabilidad obligatoria de acceso — mismo principio de acceso temporal, justificado y auditado | Acotado estrictamente al caso de soporte activo | Rutas autenticadas de solo lectura + un subconjunto administrativo acotado | No, salvo autorización explícita por caso, auditada | Impersonación es la forma más sensible de "soporte" — **no aprobada en este ADR**, requiere decisión separada, auditada y con motivo obligatorio registrado |
| **Administrador/propietario de finca** | Cliente | CRUD completo sobre los predios/animales de su(s) organización(es); gestión de colaboradores de su organización | Acceder a datos de otra organización; gestión de configuración de la plataforma | Datos de su(s) organización(es) | Una o varias organizaciones de las que es propietario | CRUD ganadero completo (sección 10), gestión de membresías de su organización | Sí, de su(s) organización(es) | No aplica |
| **Técnico/colaborador** | Cliente | CRUD operativo (registrar pesajes, vacunaciones, tratamientos, asociar QR) sobre la(s) organización(es) a la(s) que fue invitado | Gestión de membresías/roles de la organización; eliminar la organización | Datos de la(s) organización(es) a las que pertenece | Una o varias organizaciones, según membresía | CRUD ganadero, con posibles restricciones por sub-recurso (a definir en el diseño de seguimiento) | Según diseño de seguimiento (probablemente sí, limitado a su alcance) | No aplica |
| **Usuario de solo lectura** | Cliente | Consultar dashboards/reportes de su(s) organización(es) | Cualquier operación de escritura | Datos de su(s) organización(es) | Una o varias organizaciones, según membresía | Rutas autenticadas de solo lectura | Según diseño de seguimiento | No aplica |
| **Comprador CatastroX sin cuenta** | Público | Buscar predio, comprar un paquete, acceder al resultado pagado de su propia compra (vía autorización de compra, sección 10) | Acceder al resultado de compras de terceros; cualquier operación autenticada | Únicamente el resultado de su propia búsqueda/compra | N/A (no hay organización) | Rutas públicas controladas y de acceso transaccional mediante autorización de compra (sección 10) | Sí, únicamente de su propia compra (entregables client-side) | No aplica |
| **Comprador CatastroX con cuenta futura** | Cliente (opcional) | Todo lo del comprador sin cuenta, más historial de sus propias compras asociadas a su `sub` | Acceder al historial de compras de otro usuario | Su propio historial de compras | N/A o una organización personal mínima, según diseño de seguimiento | Rutas públicas controladas + una futura ruta autenticada de historial (no existe hoy) | Sí, de sus propias compras | No aplica |
| **Usuario demo** | Público (sin identidad) | Explorar la demo de Ganadería con datos de ejemplo, generar un informe demo | Cualquier operación contra datos reales de `agx` — estructuralmente imposible hoy, porque `GanaderiaDemo.jsx` no llama al backend (sección 3) | Únicamente datos de ejemplo generados localmente | N/A | Ninguna ruta de backend (hoy) | Sí, del informe demo (generado localmente) | No aplica |

## 9. Modelo de tokens y sesiones

### 9.1 Tokens aceptados por el backend

- **El backend Express acepta exclusivamente el `access_token` emitido por Cognito como credencial Bearer para autorizar llamadas a rutas autenticadas y administrativas.**
- **El `id_token` no puede usarse como Bearer token de autorización de API bajo ninguna circunstancia.**
- El middleware de validación (a diseñar, sección 17) debe verificar, sin excepción, para cada solicitud:
  1. **Firma** del JWT contra el JWKS público del User Pool.
  2. **`iss` (issuer)** coincide exactamente con el User Pool esperado.
  3. **Expiración** (`exp`) no superada.
  4. **`token_use` = `access`** — rechazo explícito si el token trae `token_use = id` o cualquier otro valor.
  5. **`client_id` y `aud`, validados según su contrato real, no de forma intercambiable**: el `access_token` de Cognito expone el claim `client_id` (no `aud`) — el middleware debe **validar `client_id` contra el App Client autorizado**. El claim `aud` **se valida cuando exista o cuando sea parte de la configuración aprobada del recurso** (por ejemplo, si en el futuro se introduce un recurso/API Gateway que sí define `aud`). **No se acepta indistintamente `client_id` o `aud` como si fueran equivalentes** sin comprobar cuál de los dos emite realmente el token en el contrato vigente del User Pool y del App Client configurados.
  6. **Scopes/claims aplicables adicionales** (por ejemplo, `scope`, si se definen scopes de recurso en el diseño de seguimiento) según lo que el diseño final del User Pool establezca.
- Un token que falle cualquiera de estas verificaciones se rechaza con `401` (sección 9.4).

### 9.2 Revocación y sus límites

- **Revocar un refresh token o ejecutar `global sign-out` en Cognito NO garantiza, por sí solo, que un backend que valida JWT localmente (verificación de firma contra JWKS, sin llamar a Cognito en cada solicitud) rechace de inmediato un `access_token` ya emitido.** Un `access_token` válido y no expirado seguirá pasando la validación de firma hasta que expire, incluso si el usuario fue deshabilitado o cerró sesión globalmente, salvo que se implemente un mecanismo adicional.
- Para mitigar esta limitación estructural del enfoque stateless:
  - **Los access tokens deben configurarse con vida corta** (minutos, no horas).
  - **Se exige rotación de refresh token** (refresh token rotation) en cada uso.
- **No se promete revocación instantánea sin un mecanismo adicional.** Si el negocio requiere revocación inmediata, eso requiere una pieza adicional **no seleccionada todavía en este ADR**. Se conservan, como alternativas pendientes de evaluación (sin elegir ninguna todavía):
  - consulta del estado del usuario o de una versión de sesión almacenada en `agx` en cada solicitud (o en las rutas más sensibles);
  - una lista de denegación (`denylist`) temporal para sesiones críticas;
  - invalidación de membresías/permisos en `agx` como forma efectiva de revocar autorización, incluso si el token de Cognito sigue siendo técnicamente válido;
  - middleware adicional aplicado únicamente a rutas de alta sensibilidad, con un costo de verificación mayor que la validación local estándar;
  - cualquier otro mecanismo que sea evaluado y aprobado posteriormente.
- **Se registra como decisión de seguimiento** (sección 20) el diseño del mecanismo de revocación inmediata para usuarios deshabilitados o sesiones críticas — no se resuelve ni se selecciona en este documento.

### 9.3 Arquitectura de sesión: SPA con PKCE vs. patrón BFF

**Contexto histórico:** este ADR no seleccionaba un patrón de sesión. **Estado vigente:** ADR-009 cerró la decisión en favor del patrón BFF con cookie opaca, sesión referenciada y CSRF.

**(a) SPA con Authorization Code + PKCE**: el navegador ejecuta directamente el intercambio del código de autorización por tokens con Cognito. Los tokens resultantes quedan disponibles al contexto de JavaScript del cliente. **Una SPA pura no puede almacenar por sí misma un `refresh_token` en una cookie `HttpOnly`**, porque ese atributo solo puede establecerlo un servidor mediante la cabecera `Set-Cookie` — JavaScript no puede fijar ni leer una cookie `HttpOnly`. En este patrón, el `refresh_token` queda necesariamente expuesto al contexto de JavaScript, lo que aumenta la superficie frente a XSS salvo que se mitigue con TTL corto y rotación (sección 9.2).

**(b) Patrón BFF (Backend For Frontend)**: un backend intermediario ejecuta el intercambio Authorization Code + PKCE con Cognito en nombre del navegador, recibe los tokens del lado del servidor, y expone al navegador **únicamente una cookie de sesión `Secure`, `HttpOnly` y `SameSite`** — el JavaScript del cliente nunca ve el `refresh_token`.

| Implicación | SPA + PKCE | Patrón BFF |
|---|---|---|
| Exposición del refresh token a JavaScript | Sí (mayor riesgo XSS) | No (mitiga XSS sobre el refresh token) |
| Riesgo CSRF | Bajo | Requiere mitigación explícita (`SameSite`, y/o token anti-CSRF) |
| Cookies | No estrictamente necesarias para el token en sí | Imprescindibles (cookie de sesión `HttpOnly`/`Secure`/`SameSite`) |
| Dominios | Más simple si frontend y Cognito interactúan directamente | Requiere que el BFF y el frontend compartan un dominio/subdominio compatible con la política de cookies elegida |
| Múltiples pestañas | Los tokens en memoria pueden perderse al recargar/cerrar pestaña | La cookie de sesión persiste de forma más predecible entre pestañas |
| Renovación | El propio cliente gestiona el refresh | El BFF gestiona el refresh de forma transparente |
| Logout | Debe limpiar el estado del cliente y, cuando sea posible, invalidar el refresh token en Cognito | El BFF invalida la cookie de sesión y, cuando sea posible, el refresh token en Cognito |
| Complejidad de infraestructura | Menor | Mayor (requiere backend de sesión adicional) |

La selección entre (a) y (b) quedó resuelta por ADR-009: se adopta BFF para navegador, mientras Bearer directo queda para integraciones externas autorizadas.

### 9.4 Respuestas HTTP de autorización

- **`401 Unauthorized`**: credencial ausente, inválida, expirada, o que falla cualquiera de las verificaciones de la sección 9.1.
- **`403 Forbidden`**: la operación y el recurso son conocidos y el token es válido, pero el usuario autenticado no tiene permiso para esa operación — `403` no oculta que el recurso existe.
- **`404 Not Found`**: opción válida para ocultar la existencia de un recurso de otra organización, cuando se prefiera no confirmar ni negar su existencia.
- **Se registra como decisión de seguimiento** (sección 20) fijar una política uniforme de cuándo usar `403` frente a `404` para cada tipo de recurso.

## 10. Clasificación de rutas

| Ruta | Clasificación propuesta |
|---|---|
| CRUD ganadero (`animales`, `predios`, `potreros`, `pesajes`, `vacunaciones`, `tratamientos`, `reproduccion`, `animal-razas`, `qr/asociar`) | Autenticada |
| `POST /api/qr/importar` | Administrativa |
| `GET /api/razas`, `GET/POST /api/vacunaciones/catalogo-vacunas`, `GET /api/qr/:codigo` | PENDIENTE DE VALIDACIÓN |
| `GET /api/health/db`, endpoints de auditoría de CatastroX | Administrativa |
| `POST /api/catastrox/lookup`, `POST /api/catastrox/lookup-by-code` | Pública controlada |
| `GET /api/catastrox/lookups/:lookupId/preview-map`, `preview-geometry` | Acceso transaccional mediante token de posesión (`lookupId`) |
| **`GET /api/catastrox/lookups/:lookupId/full-result`** | **Deprecado como entrega final**: el hallazgo de que hoy no verifica pago se mantiene como estado de implementación, pero ADR-013 cerró el modelo objetivo mediante orders, payments, entitlements, artifacts y tokens/cookies de acceso |
| `POST /api/catastrox/payments/checkout`, `GET /api/catastrox/payments/verify/:transactionId` | Pública controlada (transaccional, controles de ADR-005 pendientes de implementar) |
| `GET /api/health` | Pública controlada |
| Futuras rutas de descarga de entregables pagados | Acceso transaccional mediante autorización de compra conforme a ADR-013 |

## 11. Flujos por módulo

### 11.1 Ganadería

- **Registro/creación de cuenta**: no se asume auto-registro público. El alta inicial de una organización/cuenta se realiza preferiblemente por invitación de CRH Soluciones Integrales S.A.S. El procedimiento operativo exacto es una decisión de seguimiento (sección 20).
- **Ingreso**: login delegado a Cognito mediante el patrón BFF/cookie/CSRF definido por ADR-009.
- **Recuperación de contraseña**: flujo de fábrica de Cognito.
- **Selección de organización/finca**: si el usuario pertenece a más de una organización, el frontend presenta un selector — depende del modelo de datos de la sección 8, no implementado.
- **Acceso a dashboard desde navegador**: requiere una sesión BFF válida presentada mediante cookie opaca; el BFF resuelve la sesión y valida internamente el `access_token` de Cognito antes de resolver la(s) organización(es) del `sub` contra `agx`. El navegador no administra ni envía directamente el Bearer.
- **CRUD**: filtrado por organización activa conforme al modelo ADR-008 (pendiente de implementación).
- **QR**: la asociación QR↔animal debe validarse contra el mismo contexto de organización que el resto del CRUD.
- **Logout**: invalida la sesión BFF conforme a ADR-009, elimina las cookies correspondientes y, cuando sea posible, revoca o invalida el refresh token en Cognito, con la salvedad de la sección 9.2 sobre la revocación no instantánea del access token ya emitido.
- **Sesión expirada**: el frontend distingue "sesión expirada, renueve o reintente login" de un error genérico.
- **Acceso no autorizado**: una solicitud sin credencial válida responde `401`; una solicitud con credencial válida pero sin permiso sobre una operación conocida responde `403`; el acceso a un recurso de otra organización puede responder `404` si se decide ocultar su existencia (política uniforme pendiente, sección 9.4/20).

### 11.2 CatastroX

- **Búsqueda pública** (`POST /lookup`, `POST /lookup-by-code`): sin login, controles transaccionales conforme a ADR-013 pendientes de implementación.
- **Compra pública** (`POST /payments/checkout`): sin login, controles transaccionales ADR-013 pendientes de implementación.
- **Acceso al resultado pagado**: el hallazgo de que `full-result` hoy no verifica pago se mantiene como estado de implementación. ADR-013 cerró el modelo objetivo con las siguientes piezas:
  - **Token de intercambio de pago**: de un solo uso, emitido inmediatamente después de confirmar la transacción con Wompi, cuyo único propósito es canjearse una vez por el acceso al entregable.
  - **Entitlement (derecho de acceso)**: un registro persistente asociado a la transacción confirmada que representa que "esta compra tiene derecho al entregable de este predio" — no se consume una vez, es un estado consultable repetidamente mientras la compra sea válida.
  - **Token temporal y limitado para consultar el entregable**: vida corta, reutilizable dentro de su ventana de validez, derivado del entitlement, no necesariamente de un solo uso.
  - **Política de reintentos, regeneración y múltiples formatos**: el mecanismo debe permitir generar o volver a solicitar más de un formato a partir del mismo derecho de compra.
  - El diseño objetivo se resuelve por ADR-013.
- **Descarga**: sujeta al mecanismo ADR-013, no al acceso gratuito por `lookupId`.
- **Historial futuro**: asociación opcional al `sub` de un usuario con cuenta futura, nunca obligatoria.
- **Usuario con cuenta**: puede ver su historial de compras; no cambia el flujo de compra en sí.
- **Usuario sin cuenta**: compra igual que hoy, pero el acceso al resultado pagado deja de depender únicamente del `lookupId` gratuito.
- **Administración y soporte**: acceso a endpoints de auditoría sujeto a autenticación y rol administrativo además de las guardas locales existentes, según la topología de red que se defina (ADR-001).

### 11.3 Administración

Acceso exclusivo a usuarios de Cognito con rol administrativo **resuelto contra `agx`** (sección 8), no contra grupos de Cognito como fuente de verdad, y sujeto al principio de acceso temporal/justificado/auditado a datos de clientes (sección 8.1).

### 11.4 Demo

- Se mantiene como hallazgo confirmado: `GanaderiaDemo.jsx` es 100% local, no llama al backend, no requiere identidad de Cognito.
- ADR-014 resolvió el ADR de seguimiento de ADR-004: la demo es standalone/local, sin backend, base de datos, credenciales demo ni futuras demos persistentes con backend en este modelo. El seed `server/sql/003_agx_seed_demo_optional.sql` queda como artefacto histórico no ejecutable para staging o producción.

## 12. Decisión recomendada

**Se aprueba la estrategia híbrida: Amazon Cognito para autenticación (identidad, contraseñas, MFA, recuperación); modelo de organizaciones/membresías/roles/permisos exclusivamente en PostgreSQL (`agx`).**

Precisiones que forman parte de la decisión aprobada:

- El backend acepta **exclusivamente access tokens** como Bearer de la API (sección 9.1); el `id_token` queda prohibido para ese uso; `client_id`/`aud` se validan según su contrato real, no de forma intercambiable.
- La revocación inmediata **no está garantizada** por el solo hecho de usar Cognito con validación local de JWT — requiere access tokens de vida corta, rotación de refresh token, y un mecanismo adicional **todavía no seleccionado** para casos críticos (sección 9.2/20).
- El patrón de sesión (SPA + PKCE vs. BFF) fue cerrado por ADR-009: BFF Express con cookie opaca, sesión referenciada y CSRF.
- Cognito **no es fuente de verdad de autorización de negocio** bajo ninguna circunstancia salvo una excepción futura explícita y documentada (sección 8).
- El acceso pagado de CatastroX fue cerrado arquitectónicamente por ADR-013.
- La demo de Ganadería y la separación de ambientes fueron cerradas arquitectónicamente por ADR-014.
- Ningún costo de Cognito se afirma en este documento sin una estimación con tarifa oficial vigente.
- El aprovisionamiento de cuentas de Ganadería no asume auto-registro público (sección 7/11.1/20).
- **El superadministrador y los demás roles internos (Administrador CRH, Soporte) no obtienen acceso automático ni permanente a datos de clientes por el solo hecho del rol — todo acceso a datos de una organización es temporal, justificado, auditado y asociado a una solicitud, incidente o procedimiento aprobado; la exportación masiva global queda prohibida salvo procedimiento excepcional formal** (sección 8.1).
- La impersonación de soporte no queda aprobada en este documento.

## 13. Justificación

La ausencia de tooling de seguridad preexistente (sección 3) hace que delegar la parte criptográficamente sensible a un proveedor gestionado sea la opción de menor riesgo dado el estado actual del equipo. Separar identidad (Cognito) de autorización (`agx`) desde el diseño evita un modelo de permisos dividido entre dos sistemas que se desincronizan con el tiempo. Aplicar mínimo privilegio y segregación de funciones incluso al rol de mayor jerarquía (superadministrador) reduce el impacto de una credencial interna comprometida y evita que el diseño de roles internos se convierta, por conveniencia, en una puerta trasera de acceso irrestricto a datos de clientes.

## 14. Consecuencias positivas

Exigir que el backend rechace el `id_token` como Bearer (sección 9.1) cierra de antemano una clase de vulnerabilidad de confusión de tokens. Exigir acceso temporal/justificado/auditado incluso para el superadministrador reduce la superficie de exposición de datos de clientes ante una cuenta interna comprometida o un uso indebido, y facilita auditorías de cumplimiento futuras.

## 15. Consecuencias negativas

La limitación de revocación inmediata (sección 9.2) implica que, mientras no se implemente el mecanismo adicional de seguimiento, deshabilitar a un usuario o cerrar una sesión comprometida no tiene efecto instantáneo sobre un access token ya emitido y no expirado. El modelo de acceso temporal/auditado para roles internos añade fricción operativa (un superadministrador no puede simplemente "ver los datos de un cliente" sin un procedimiento asociado) — fricción deliberada, aceptada como costo de seguridad.

## 16. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| `full-result` de CatastroX obtenible sin pago mientras no se implemente la autorización de compra | Hallazgo confirmado, sección 3 | Prioritario; se resuelve implementando ADR-013 |
| Confusión entre `id_token` y `access_token`, o entre `client_id` y `aud`, en la implementación del middleware | Riesgo técnico común en integraciones OIDC | Prohibición explícita y validación de `token_use`/`client_id`/`aud` según su contrato real (sección 9.1) |
| Expectativa incorrecta de revocación instantánea | Limitación estructural de la validación local de JWT | Comunicar la limitación explícitamente; diseñar mecanismo adicional para casos críticos como seguimiento, sin seleccionarlo todavía (sección 9.2/20) |
| Implementación tardía o incompleta del patrón BFF/cookie/CSRF | Decisión cerrada por ADR-009, pendiente de implementación | No declarar funcional ningún flujo privado hasta implementar y validar ADR-009 |
| Autorización dividida entre grupos de Cognito y tablas de `agx` por conveniencia de implementación | Riesgo de desviarse de la regla de la sección 8 | Revisión obligatoria contra ADR-008 antes de implementar |
| Impersonación de soporte implementada sin aprobación ni auditoría | Capacidad técnica listada en la matriz de roles (sección 8.1) pero no aprobada | No implementar impersonación bajo ninguna circunstancia sin una decisión separada, explícita y auditada (sección 20) |
| **Acceso permanente o irrestricto de un rol interno (superadministrador, Administrador CRH, Soporte) a datos de clientes, implementado por conveniencia y sin procedimiento auditado** | Riesgo directo si el diseño de seguimiento no respeta la sección 8.1 | Exigir que toda implementación de roles internos pase por el principio de acceso temporal/justificado/auditado antes de aprobarse |
| Asumir auto-registro público para Ganadería durante la implementación | Contradice el hallazgo de la sección 3 y la sección 7 | Diseño de aprovisionamiento debe partir explícitamente del principio de invitación |
| Estimación de costo de Cognito basada en cifras genéricas o desactualizadas | Riesgo de planificación de costos | Exigir tarifa oficial vigente de AWS antes de crear el User Pool (acción requerida, sección 17) |
| Diseño físico de datos de organizaciones/roles mal planteado | ADR-008 cerrado a nivel arquitectónico; DDL físico pendiente | Diseñar migraciones formales alineadas con ADR-008 antes de implementar |
| Retraso en cerrar las decisiones de seguimiento retrasa el paso a producción | Dependencia directa con ADR-005 | Priorizar las acciones de la sección 17 |

## 17. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Diseñar el User Pool de Cognito (políticas de contraseña, MFA con TOTP como mecanismo preferente a evaluar, plantillas, App Client, dominios) como módulo de Terraform (ADR-003/010).
- Obtener una estimación de costo con la tarifa oficial vigente de AWS para Cognito antes de crear el User Pool.
- Diseñar el middleware de Express que implemente exactamente las verificaciones de la sección 9.1 (firma, issuer, expiración, `token_use=access`, `client_id`/`aud` según su contrato real, scopes/claims aplicables), rechazando explícitamente cualquier `id_token`.
- Configurar access tokens de vida corta y refresh token rotation en el User Pool (sección 9.2).
- Evaluar y seleccionar el mecanismo adicional de revocación inmediata para usuarios deshabilitados o sesiones críticas, entre las alternativas de la sección 9.2 (consulta de estado/versión de sesión en `agx`, denylist temporal, invalidación de membresías/permisos, middleware adicional en rutas sensibles, u otro) — no seleccionado en este ADR.
- Implementar y validar el patrón de sesión BFF/cookie/CSRF seleccionado por ADR-009 antes de declarar funcional cualquier flujo de login.
- Implementar el modelo de organizaciones/membresías/roles/permisos definido por ADR-008, incluyendo el mecanismo concreto de acceso temporal/justificado/auditado para roles internos (sección 8.1).
- Implementar ADR-013 para autorización transaccional de CatastroX.
- Definir la política uniforme de `401`/`403`/`404` por tipo de recurso (sección 9.4).
- Definir el procedimiento operativo exacto de aprovisionamiento de cuentas por módulo (sección 7/11.1).
- Definir el procedimiento excepcional formal y auditado para exportación masiva global por parte del superadministrador (sección 8.1).
- Clasificar en definitiva las rutas hoy marcadas PENDIENTE DE VALIDACIÓN (sección 10).
- Instrumentar logging de eventos de autenticación y de acceso excepcional de roles internos a datos de clientes, sin registrar contraseñas ni tokens completos.

## 18. Criterios de aceptación

- El middleware de autorización rechaza cualquier solicitud que use un `id_token` como Bearer, y valida `client_id`/`aud` según su contrato real, verificable mediante prueba automatizada.
- Existe un User Pool de Cognito configurado, revisado y con una estimación de costo basada en tarifa oficial vigente, antes de que cualquier ruta autenticada dependa de él.
- Todo el CRUD ganadero exige sesión BFF válida o canal autorizado equivalente, con validación interna del `access_token` de Cognito, sin excepción.
- El acceso al entregable pagado de CatastroX ya no es obtenible con solo el `lookupId` gratuito.
- El modelo de datos de organizaciones/membresías/roles/permisos aprobado por ADR-008 está implementado, con `agx` como única fuente de verdad de autorización.
- **Ningún rol interno, incluido el superadministrador, tiene acceso permanente e irrestricto a datos de clientes en la implementación final** — todo acceso queda sujeto a un procedimiento temporal, justificado y auditado.
- **La exportación masiva global está bloqueada salvo un procedimiento excepcional formal y auditado.**
- Ningún flujo privado se declara funcional sin implementar el patrón BFF/cookie/CSRF documentado en ADR-009.
- El aprovisionamiento de cuentas de Ganadería no incluye auto-registro público no aprobado explícitamente.
- La impersonación de soporte no está implementada, o si se implementa en el futuro, cuenta con una decisión separada, explícita y auditada.
- Existe una política documentada de cuándo usar `401`/`403`/`404`.
- Ningún secreto de servidor aparece en el bundle del frontend ni en almacenamiento persistente inseguro del navegador.

## 19. Elementos fuera de alcance

- Creación real del User Pool de Cognito o de cualquier recurso de AWS.
- DDL completo o migraciones de las tablas de organizaciones/membresías/roles/permisos.
- Implementación completa del mecanismo de autorización transaccional de CatastroX definido por ADR-013.
- Implementación completa del patrón BFF definido por ADR-009.
- Selección final del mecanismo de revocación inmediata (sección 9.2).
- Diseño o aprobación de cualquier capacidad de impersonación de soporte.
- Diseño exacto del procedimiento excepcional de acceso auditado de roles internos a datos de clientes (se fija el principio, no el procedimiento).
- Tarifa oficial exacta de Cognito.
- Implementación de código de ningún tipo.
- Cambios a las interfaces congeladas de Home, Ganadería o CatastroX.
- Duplicación de la resolución de ADR-014 sobre demo/staging/producción.

## 20. Decisiones de seguimiento necesarias

1. **DDL físico final del modelo ADR-008** de organizaciones/membresías/roles/permisos, incluyendo el mecanismo concreto de acceso temporal/justificado/auditado para roles internos (sección 8.1).
2. **Implementación física de ADR-013** para autorización transaccional de CatastroX (sección 11.2).
3. **Selección del mecanismo de revocación inmediata** para usuarios deshabilitados o sesiones críticas, entre las alternativas de la sección 9.2 — no seleccionado en este ADR.
4. **Implementación del patrón BFF/cookie/CSRF** seleccionado por ADR-009.
5. **Política uniforme de códigos de respuesta `401`/`403`/`404`** por tipo de recurso (sección 9.4).
6. **Implementación de ADR-014** para demo/staging/producción; la decisión arquitectónica ya está cerrada.
7. **Decisión separada, explícita y auditada sobre impersonación de soporte** — no aprobada en este documento.
8. **Política definitiva de aprovisionamiento/registro de cuentas por módulo** (sección 7).
9. **Estimación de costo de Cognito con tarifa oficial vigente de AWS** antes de crear el User Pool.
10. **Excepción futura explícita**, si se decide algún día usar grupos de Cognito como señal adicional de autorización.
11. **Procedimiento excepcional formal y auditado de exportación masiva global** y de acceso puntual de roles internos a datos de clientes (sección 8.1).
