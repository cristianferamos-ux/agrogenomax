# ADR-008: Modelo multicliente, organizaciones, membresías y aislamiento de datos

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-008 sigue vigente como decisión central de multicliente: tablas compartidas con `organizacion_id` directo, autorización centralizada y RLS obligatorio. Decisiones posteriores precisan su alcance:

- ADR-014 sustituye cualquier tratamiento que permitiera demo persistente dentro del plano real.
- No existe "organización demo" dentro de producción ni staging como destino de fixtures.
- El seed `003_agx_seed_demo_optional.sql` no se migra ni se asigna a una organización; se conserva solo como artefacto histórico no ejecutable para staging o producción.
- Demo es standalone/local, sin backend ni base de datos.
- ADR-009 gobierna BFF/sesión/CSRF.
- ADR-011 gobierna ECS; el backend vigente es Express en ECS Express Mode, con ECS + Fargate directo como contingencia.
- ADR-013 gobierna CatastroX transaccional.

## 1. Contexto

ADR-007 (Aceptada) estableció que Amazon Cognito es el proveedor de identidad, que `agx` es la fuente única de autorización de negocio, y que el esquema `agx` actual **no soporta multi-tenencia** — dejando explícitamente pendiente el ADR de modelo de datos que este documento resuelve. ADR-002 ya había establecido `agx` como fuente de verdad de Ganadería. ADR-004 identificó el riesgo de mezcla demo/producción; ADR-014 resolvió posteriormente el mecanismo técnico de separación demo/staging/producción.

La verificación directa del código confirma que `agx` es hoy un **espacio de datos completamente plano**: ninguna de sus 11 tablas tiene una columna que vincule una fila a un cliente, cuenta u organización, y **cero archivos** en `server/` contienen las palabras "organizacion", "tenant" ni "organization". Todas las rutas de negocio ganadero operan sobre el conjunto completo de filas de sus tablas, sin excepción.

## 2. Problema

AgroGenomaX no puede operar como plataforma multicliente segura mientras `agx` no tenga un concepto explícito de "a quién pertenecen estos datos". Hoy, cualquier llamada autenticada (una vez que ADR-007 se implemente) seguiría pudiendo leer o modificar los predios, animales y registros de **cualquier cliente**, porque no existe ningún mecanismo — ni en el esquema de datos ni en las rutas — que ate un recurso a una organización.

## 3. Estado actual verificado

*(Confirmado por lectura directa del código.)*

**Tablas existentes en `agx`** — 11 tablas: `predios`, `potreros`, `razas`, `qr_codes`, `animales`, `animal_razas`, `pesajes`, `catalogo_vacunas`, `vacunaciones`, `tratamientos`, `reproduccion`. Todas con PK `bigserial` (numérica, secuencial, predecible).

**Claves foráneas verificadas**: `potreros.predio_id → predios` (restrict); `animales.predio_id → predios` (restrict); `animales.potrero_id → potreros` (restrict); `animales.qr_id → qr_codes` (unique, restrict); `qr_codes.animal_id → animales` (diferida, set null); `animal_razas.animal_id → animales` (cascade); `animal_razas.raza_id → razas` (restrict); `pesajes.animal_id → animales` (cascade); `vacunaciones.animal_id → animales` (cascade); `vacunaciones.catalogo_vacuna_id → catalogo_vacunas` (restrict); `tratamientos.animal_id → animales` (cascade); `reproduccion.animal_id → animales` (cascade).

**Relación entre predios, potreros, animales y registros**: jerarquía `predio → potrero → animal → (pesaje | vacunación | tratamiento | reproducción)`.

**Ausencia total de columnas de organización** — CONFIRMADO: ninguna tabla de `agx` tiene `organizacion_id`, `cliente_id`, `tenant_id` ni equivalente. Cero coincidencias de "organizacion"/"tenant"/"organization" en `server/`.

**Ausencia total de usuarios, membresías, roles y permisos en `agx`** — CONFIRMADO.

**`predios.propietario`** — CONFIRMADO: columna `text` libre, sin FK; dato descriptivo, no de autorización (sección 9).

**Rutas que retornan datos globales sin filtro** — CONFIRMADO: `GET /api/predios`, `GET /api/animales`, `GET /api/razas` sin `where`; `GET /api/potreros` solo filtra si el cliente envía `?predio_id=` (opcional, no obligatorio); `GET /api/vacunaciones/catalogo-vacunas` filtra solo por `estado='activo'`.

**Operaciones que hoy permiten acceso cruzado** — CONFIRMADO: `GET/PUT /api/animales/:id` (IDOR estructural, ID secuencial adivinable); `GET/POST /api/qr/*` sin verificación de propiedad; rutas de detalle (`pesajes`, `vacunaciones`, `tratamientos`, `reproduccion`) usan `ensureAnimalExists` como única validación (existencia, no pertenencia).

**`POST /api/vacunaciones/catalogo-vacunas`** — CONFIRMADO: inserta en el catálogo global sin ningún control de rol.

**`agx.razas` es de solo lectura vía API hoy** — CONFIRMADO: no existe ruta de creación.

**Seed `002_agx_seed_demo.sql`** (nombre real; discrepancia frente al `002_agx_seed_catalogos.sql` de las fuentes de la tarea original, señalada en el cierre) — inserta datos catálogo reales (razas, QR libres, vacuna base), no animales ni predios.

**Seed `003_agx_seed_demo_optional.sql`** — inserta un predio, potreros, un animal, pesajes y una vacunación demo **directamente en las tablas de producción**, sin ninguna marca de "demo" a nivel de columna. Riesgo identificado por ADR-004 y mecanismo técnico cerrado por ADR-014: el archivo no se migra ni se asigna a una organización; queda como artefacto histórico no ejecutable para staging o producción.

**Esquema legacy `public`/Supabase — referencia histórica, no normativa**: ya modela `organizations`, `profiles` (un único `role` por usuario) y `farms` (`organization_id` obligatorio, `owner_name`/`owner_document` distintos del `organization_id`). Se cita solo como antecedente conceptual, no como base de este diseño.

**NO VERIFICADO**: volumen real de clientes/predios/animales; si existe ya algún cliente real en producción; alojamiento del repositorio en GitHub; tamaño exacto de instancia RDS a usar.

## 4. Requisitos obligatorios

1. `agx` es la fuente única de autorización de negocio (ADR-007) — Cognito no decide autorización.
2. El backend identifica al usuario mediante el claim `sub` del access token de Cognito (ADR-007).
3. Todo el CRUD ganadero requiere autenticación, sin excepción.
4. Ningún usuario puede leer o modificar datos de otra organización, bajo ninguna circunstancia.
5. Los grupos de Cognito no son fuente de verdad de autorización.
6. **Ninguna interfaz o ruta actual puede rediseñarse en su URL o en su contrato público como efecto colateral de este ADR — interfaces y rutas congeladas durante la migración.** Esta congelación se refiere exclusivamente a URLs y contratos públicos, no a la implementación interna: ver precisión obligatoria más abajo.
7. `predios.propietario` no puede confundirse ni fusionarse silenciosamente con el concepto de organización SaaS.
8. Ningún dato existente puede reasignarse, eliminarse ni migrarse sin inventario y respaldo previos.
9. Los accesos de personal interno de CRH a datos de clientes deben ser temporales, justificados, auditados y asociados a una solicitud/incidente — nunca automáticos por jerarquía de rol.
10. El riesgo de ADR-004 permanece abierto y no se resuelve en este documento.
11. No se aprueba impersonación de soporte en este documento.
12. `organizacion_id` directo es obligatorio en todas las tablas de negocio organizacionales (`predios`, `potreros`, `animales`, `qr_codes`, `animal_razas`, `pesajes`, `vacunaciones`, `tratamientos`, `reproduccion`) — no se deriva exclusivamente por relación (sección 13).
13. PostgreSQL Row Level Security (RLS) es requisito obligatorio antes de operar producción multicliente con datos reales — no es una mejora opcional a mediano plazo (sección 14). El middleware centralizado de Express sigue siendo requisito inmediato para desarrollo y staging, independiente de RLS.
14. **Existe como máximo una membresía vigente por combinación usuario–organización, y esa membresía tiene exactamente un rol** — no se resuelven necesidades de capacidades adicionales creando una segunda membresía del mismo usuario en la misma organización (corrección de esta ronda, sección 10).
15. Todo acceso de un rol interno a datos de una organización de cliente requiere una Concesión de acceso interno activa y válida — el rol interno, por sí solo, nunca otorga acceso automático (sección 15).
16. El backend nunca acepta un `organizacion_id` impuesto libremente por el cliente: lo asigna él mismo en creación (a partir de la membresía activa validada) y lo trata como inmutable por el cliente en actualización (sección 12).
17. **El contexto de autorización usado por RLS se establece dentro de la misma transacción que ejecuta las consultas autorizadas; ninguna conexión conserva contexto de organización entre solicitudes; el rol de PostgreSQL de la aplicación no puede tener `BYPASSRLS` ni privilegios administrativos** (corrección de esta ronda, sección 14).
18. **Una Concesión de acceso interno nunca omite ni desactiva RLS — amplía temporalmente el conjunto autorizado del usuario interno únicamente para la organización y el alcance de la concesión** (corrección de esta ronda, sección 15).
19. No se escribe DDL definitivo ni se ejecuta ninguna migración.

**Precisión obligatoria sobre "rutas congeladas"** (corrección de esta ronda, aplicable a todo el documento): "ruta congelada" significa que las URLs y los contratos públicos (forma de la solicitud y de la respuesta observable por el cliente) no cambian como efecto colateral de este ADR. **No significa que la implementación interna de esas rutas permanezca sin cambios** — de hecho, debe cambiar para incorporar el middleware de autorización, el filtrado organizacional, el contexto transaccional y las políticas de RLS descritos en este documento. **"Ruta congelada" nunca es una justificación válida para conservar una implementación insegura** (por ejemplo, las consultas sin filtro de organización confirmadas en la sección 3).

## 5. Alternativas de aislamiento multicliente

### 5.1 Base de datos por organización

- **Seguridad/aislamiento**: el más fuerte posible.
- **Complejidad operativa**: alta — cada alta de cliente implica aprovisionar una base nueva, gestionar credenciales, backups y monitoreo por separado.
- **Costo**: crece linealmente con el número de clientes.
- **Migraciones**: cada cambio de esquema debe aplicarse N veces.
- **Backups**: N estrategias independientes.
- **Observabilidad**: dispersa.
- **Escalabilidad de gestión**: mala sin automatización — inexistente hoy.
- **Consultas de plataforma**: imposibles sin agregación entre conexiones.
- **Compatibilidad con backend Express en ECS/RDS**: requiere resolución dinámica de credenciales de conexión por usuario.
- **Riesgo de filtración entre clientes**: mínimo.
- **Portabilidad**: alta.
- **Facilidad de soporte**: baja al inicio.
- **Adecuación al tamaño actual de AgroGenomaX**: **baja** — sin tooling de automatización de infraestructura (ADR-007, sección 3).

### 5.2 Esquema PostgreSQL separado por organización

- **Seguridad/aislamiento**: fuerte, menor que 5.1.
- **Complejidad operativa**: alta — cada esquema requiere el DDL completo, y funciones compartidas (`agx.set_updated_at()`) deben replicarse o generalizarse.
- **Costo**: menor que 5.1, pero de difícil administración a escala.
- **Migraciones**: N ejecuciones.
- **Backups**: restaurar un solo cliente sin afectar a otros es complejo.
- **Observabilidad**: mejor que 5.1, pero requiere desagregación por esquema.
- **Escalabilidad de gestión**: limitada por herramientas estándar de PostgreSQL.
- **Consultas de plataforma**: difíciles.
- **Compatibilidad con backend Express en ECS/RDS**: requiere resolver `search_path` dinámico — `server/db.js` usa hoy un único `Pool` con esquema fijo, patrón que habría que rediseñar por completo.
- **Riesgo de filtración entre clientes**: bajo, no nulo.
- **Portabilidad**: alta.
- **Facilidad de soporte**: media.
- **Adecuación al tamaño actual de AgroGenomaX**: **baja**.

### 5.3 Tablas compartidas con `organizacion_id`

- **Seguridad/aislamiento**: depende de que **todas** las consultas apliquen el filtro correctamente — mitigable con disciplina de diseño (middleware, sección 14) y con **RLS obligatorio antes de producción** (sección 14).
- **Complejidad operativa**: la más baja de las cuatro.
- **Costo**: el más bajo, consistente con ADR-001 (una única instancia RDS de Ganadería).
- **Migraciones**: una sola ejecución por cambio.
- **Backups**: una sola estrategia.
- **Observabilidad**: centralizada.
- **Escalabilidad de gestión**: alta.
- **Consultas de plataforma**: simples.
- **Compatibilidad con backend Express en ECS/RDS**: la más directa — coincide con el patrón de conexión ya existente en `server/db.js`.
- **Riesgo de filtración entre clientes**: el más alto de las cuatro **si no se implementa correctamente** — mitigado con dos capas (Express + RLS obligatorio antes de producción, con las condiciones de pooling de la sección 14).
- **Portabilidad**: alta.
- **Facilidad de soporte**: alta.
- **Adecuación al tamaño actual de AgroGenomaX**: **alta**.

### 5.4 Modelo híbrido

Tablas compartidas con `organizacion_id` como modelo general, reservando la posibilidad de aislar físicamente a un cliente específico en el futuro si un caso de negocio concreto lo justifica. No es una alternativa a implementar en esta fase, sino una vía de evolución que 5.3 no bloquea.

## 6. Matriz comparativa

| Criterio | Base por organización | Esquema por organización | Tablas compartidas + `organizacion_id` | Híbrido |
|---|---|---|---|---|
| Aislamiento/seguridad | Muy alto | Alto | Medio, elevado a alto mediante Express + RLS obligatorio antes de producción (secciones 13-14) | Igual que tablas compartidas hasta que se active un caso de aislamiento físico |
| Complejidad operativa | Alta | Alta | Baja, con un requisito adicional de diseño de RLS antes de producción | Baja, con capacidad de crecer puntualmente |
| Costo | Crece con clientes | Medio | Bajo, consistente con ADR-001 | Bajo, con costo adicional solo si se activa aislamiento físico |
| Migraciones | N ejecuciones | N ejecuciones | 1 ejecución | 1 ejecución (regla general) |
| Backups | N estrategias | Restauración compleja por cliente | 1 estrategia | 1 estrategia (regla general) |
| Observabilidad | Dispersa | Parcialmente dispersa | Centralizada | Centralizada (regla general) |
| Escalabilidad de gestión | Baja sin automatización | Baja sin automatización | Alta | Alta, con capacidad de excepción |
| Consultas de plataforma | Difíciles | Difíciles | Simples | Simples (regla general) |
| Compatibilidad con Express en ECS + RDS | Requiere rediseño de conexión | Requiere `search_path` dinámico | Compatible sin rediseño | Compatible sin rediseño |
| Riesgo de filtración entre clientes | Mínimo | Bajo | Medio, mitigado a bajo mediante defensa en profundidad obligatoria | Medio, mitigable igual |
| Portabilidad | Alta | Alta | Alta | Alta |
| Facilidad de soporte | Baja inicialmente | Media | Alta | Alta |
| Adecuación al tamaño actual de AgroGenomaX | Baja | Baja | **Alta** | Alta como marco, no como implementación inicial |

## 7. Decisión de aislamiento recomendada

**Se mantiene el modelo de tablas compartidas con `organizacion_id` (sección 5.3), dentro del marco conceptual híbrido (sección 5.4).** Se mantienen los dos endurecimientos ya incorporados (`organizacion_id` directo obligatorio, RLS obligatorio antes de producción) y se añaden, en esta ronda final, tres precisiones estructurales: (a) **una membresía única por combinación usuario–organización**, con exactamente un rol; (b) **condiciones vinculantes de aislamiento transaccional y de privilegios del rol de PostgreSQL** que hacen que RLS sea efectivo y no evitable (sección 14); (c) **las Concesiones de acceso interno operan dentro de RLS, nunca lo omiten** (sección 15).

Esta recomendación sigue sin elegirse "por ser la opción más común": es la única de las cuatro alternativas compatible, sin rediseño, con ADR-001 y con el patrón de conexión ya existente en `server/db.js`.

## 8. Modelo conceptual de entidades

*Nombres de entidades y columnas son **conceptuales** — el diseño técnico definitivo (DDL) queda para una fase de implementación posterior.*

| Entidad | Propósito | Propietario de los datos | Alcance | Relaciones principales | Estado actual | Necesidad de migración |
|---|---|---|---|---|---|---|
| Usuario de aplicación | Representa a una persona autenticada vía Cognito | Cognito (identidad) + `agx` (perfil/membresías) | N/A | Vinculado por `sub` a sus membresías | **Inexistente** en `agx` | Nueva tabla/relación |
| **Organización** | Cliente de AgroGenomaX; raíz multicliente del modelo, no una entidad interna de plataforma | `agx` | Raíz de aislamiento | Tiene predios (vía `organizacion_id` directo), tiene membresías | **Inexistente** | Nueva tabla |
| Membresía | Vínculo usuario↔organización con exactamente un rol; **como máximo una membresía vigente por combinación (usuario, organización)** (corrección de esta ronda, sección 10) | `agx` | Por organización | Usuario × Organización × Rol, con unicidad conceptual (usuario, organización) | **Inexistente** | Nueva tabla, con restricción de unicidad conceptual |
| Rol | Catálogo de roles aplicables a una membresía (ADR-007, sección 8.1), incluyendo la posibilidad de roles compuestos creados mediante decisión controlada (sección 10) | `agx` | Global (catálogo) | Referenciado por membresía (uno por membresía) | **Inexistente** | Nueva tabla o enumeración |
| Permiso | Capacidad concreta derivada de un rol | `agx` | Global o por rol | Asociado a rol | **Inexistente** | A definir en diseño de seguimiento |
| Rol interno CRH | Rol de personal de CRH (superadministrador, Administrador CRH, Soporte) | `agx` | Global (no ligado a una organización de cliente) | Habilita **solicitar/aprobar/usar** Concesiones de acceso interno, nunca acceso directo | **Inexistente** | Nueva tabla o extensión del modelo de rol |
| Concesión de acceso interno | Autoriza, de forma temporal y auditada, que un usuario interno consulte datos de una organización específica **sin omitir RLS** (corrección de esta ronda, sección 15) | `agx` | Vincula un usuario interno con una organización, por un período acotado | Usuario interno × Organización × Alcance × Ticket/incidente × Aprobador × Vigencia × Estado | **Inexistente** | Nueva tabla |
| Predio | Unidad productiva (finca) | `agx` | Por organización | `organizacion_id` directo; tiene potreros | **Existente** (`agx.predios`), sin columna de organización | Requiere columna `organizacion_id` directa + backfill |
| Potrero | Subdivisión de un predio | `agx` | Por organización | `organizacion_id` directo, además de `predio_id`; debe coincidir con la organización del predio padre | **Existente** (`agx.potreros`) | Requiere columna `organizacion_id` directa + backfill + validación de consistencia |
| Animal | Individuo bovino trazado | `agx` | Por organización | `organizacion_id` directo, además de `predio_id`/`potrero_id` | **Existente** (`agx.animales`) | Requiere columna `organizacion_id` directa + backfill + validación de consistencia |
| QR | Código físico/digital, con ciclo de vida propio (sección 13) | `agx` | Global mientras esté en inventario de plataforma; por organización una vez reservado o asignado | `organizacion_id` directo, nullable | **Existente** (`agx.qr_codes`) | Requiere columna `organizacion_id` directa (nullable) + modelo de estados |
| Pesaje | Registro de peso de un animal | `agx` | Por organización | `organizacion_id` directo, además de `animal_id` | **Existente** (`agx.pesajes`) | Requiere columna `organizacion_id` directa + backfill |
| Vacunación | Aplicación de vacuna a un animal | `agx` | Por organización | `organizacion_id` directo, además de `animal_id`; catálogo de vacunas permanece global | **Existente** (`agx.vacunaciones`) | Requiere columna `organizacion_id` directa + backfill |
| Tratamiento | Registro médico/sanitario | `agx` | Por organización | `organizacion_id` directo, además de `animal_id` | **Existente**, opcional (`agx.tratamientos`) | Requiere columna `organizacion_id` directa + backfill |
| Reproducción | Evento reproductivo | `agx` | Por organización | `organizacion_id` directo, además de `animal_id` | **Existente**, opcional (`agx.reproduccion`) | Requiere columna `organizacion_id` directa + backfill |
| Animal-raza (relación) | Composición racial de un animal | `agx` | Por organización | `organizacion_id` directo, además de `animal_id`/`raza_id`; `razas` permanece global | **Existente** (`agx.animal_razas`) | Requiere columna `organizacion_id` directa + backfill |
| Catálogo de razas | Catálogo de referencia genética | `agx` | Global — sin `organizacion_id` | Referenciado por `animal_razas` | **Existente** (`agx.razas`), API de solo lectura hoy | Se mantiene global (sección 16) |
| Catálogo de vacunas | Catálogo de referencia sanitaria | `agx` | Global — sin `organizacion_id` | Referenciado por `vacunaciones` | **Existente** (`agx.catalogo_vacunas`), API de lectura y escritura hoy sin control | Se mantiene global, requiere control de escritura (sección 16) |
| Evento de auditoría | Registro de negocio/seguridad, incluido el uso de Concesiones de acceso interno | `agx` (nueva) | Transversal | Referencia actor, organización, recurso, acción, y opcionalmente la Concesión bajo la cual se actuó | **Inexistente** | Nueva tabla |
| Invitación | Solicitud de alta de un usuario a una organización | `agx` (nueva) | Por organización | Vinculada a la organización que invita y al correo/identidad invitada | **Inexistente** | Nueva tabla |
| Sesión o versión de autorización | Mecanismo para invalidar autorización sin depender solo de la expiración del token (ADR-007, sección 9.2) | `agx` (nueva, condicional) | Por usuario/membresía | Referencia al usuario/membresía afectada | **Inexistente** — condicional a la alternativa de revocación que se seleccione | No decidido aquí |
| Estado de organización | Activa/suspendida/etc. | `agx` (nueva) | Por organización | Atributo de la organización | **Inexistente** | Parte de la tabla de organización |
| Plan o suscripción | Solo si resulta necesario para decisiones de acceso | `agx` (nueva, si aplica) | Por organización | Atributo de la organización | **Inexistente**, no determinado si es necesario | No decidido; NO VERIFICADO si existe ya un modelo comercial de planes |

## 9. Organización y propiedad de datos

- **Una organización puede tener varios predios**: sí.
- **Un predio no debería pertenecer a más de una organización simultáneamente** en el modelo base; el caso de predio compartido queda como decisión de seguimiento (sección 27).
- **Un usuario puede pertenecer a varias organizaciones**: sí, mediante membresías distintas — cada una con exactamente un rol, y **como máximo una membresía vigente por organización** (sección 10).
- **Propietario legal del predio vs. cliente SaaS**: deben mantenerse explícitamente separados. `agx.predios.propietario` describe al dueño legal/productivo real; la organización (entidad SaaS) es quien tiene acceso y control de los datos en la plataforma — no se asume que coincidan.
- **Qué representa una organización**: persona natural, empresa, asociación de productores o cliente contractual, indistintamente. No se asume que "organización" equivalga a "finca".
- **Cliente que administra varias fincas**: sus predios existen bajo la misma organización; la membresía determina qué usuarios pueden ver/administrar cuáles predios; una segmentación más fina que "toda la organización" queda como decisión de seguimiento (sección 27).

## 10. Usuarios y membresías

- **Relación usuario ↔ organización**: many-to-many, mediada por una membresía.
- **Unicidad de membresía — decisión resuelta en esta ronda**: **existe como máximo una membresía vigente por combinación (usuario, organización).** Se registra conceptualmente una restricción de unicidad sobre el par (usuario, organización) — sin escribir DDL definitivo, el diseño técnico posterior debe garantizar que no pueda existir más de una membresía activa simultánea del mismo usuario en la misma organización.
- **Un rol por membresía — sin cambios respecto de la ronda anterior**: cada membresía tiene exactamente un rol en la fase inicial.
- **Se elimina explícitamente, en esta corrección, la posibilidad de resolver una necesidad de capacidades adicionales creando una segunda membresía del mismo usuario en la misma organización** — esa vía, presente en una versión anterior de este documento, queda revertida. Si un usuario necesita capacidades adicionales dentro de la **misma** organización, las únicas vías válidas son:
  1. **Seleccionar un rol predefinido adecuado** que ya cubra esas capacidades, si existe en el catálogo de roles (ADR-007, sección 8.1);
  2. **Crear, mediante una decisión controlada y documentada, un nuevo rol compuesto** que agrupe explícitamente el conjunto de capacidades necesario, incorporado al catálogo de roles como una opción más — nunca como una combinación ad-hoc de dos membresías paralelas;
  3. **Revisar formalmente este ADR** si la necesidad revela una limitación estructural del modelo de "un rol por membresía" que no pueda resolverse razonablemente con las dos vías anteriores.
- Un usuario **puede** tener membresías distintas en **organizaciones diferentes** (por ejemplo, propietario en la Organización A y solo-lectura en la Organización B) — esto no cambia; lo que se elimina es la posibilidad de duplicar membresías dentro de la **misma** organización.
- **Activación, suspensión y retiro de membresías**: estados conceptuales (activa/suspendida/retirada); una membresía suspendida no otorga acceso, sin perder trazabilidad histórica (sección 17); al estar retirada o suspendida, no cuenta como "vigente" a efectos de la restricción de unicidad, permitiendo, si el negocio lo requiere, crear una nueva membresía vigente para ese mismo par (usuario, organización) una vez cerrada la anterior.
- **Vigencia temporal**: una membresía puede tener fecha de inicio y, opcionalmente, de expiración/revisión.
- **Invitaciones**: alta por invitación (ADR-007, sección 7), con estado (pendiente/aceptada/expirada/revocada).
- **Aceptación de invitación**: al autenticarse/iniciar sesión, el usuario invitado acepta y se crea la membresía (con su único rol) — sujeta a la misma restricción de unicidad (si ya existe una membresía vigente para ese par, la invitación no puede aceptarse creando una segunda).
- **Revocación**: acción auditada, de una invitación pendiente o de una membresía activa.
- **Transferencia de administración**: mecanismo para reasignar el rol de mayor privilegio sin dejar una organización sin administrador — no diseñado en detalle aquí (sección 27); dado que ahora una membresía es única por par (usuario, organización), esta transferencia implica cambiar el rol de la membresía existente del nuevo administrador, no crear una membresía adicional.
- **Usuario interno de CRH**: no se modela como una membresía a una organización de cliente — su acceso a datos de clientes pasa exclusivamente por una Concesión de acceso interno (sección 15), nunca por una membresía ordinaria.

**Roles de ADR-007 y su pertenencia al modelo ganadero multicliente**:

| Rol (ADR-007) | ¿Pertenece al modelo de membresía ganadera de este ADR? |
|---|---|
| Superadministrador | No — rol interno de plataforma (sección 15), acceso solo vía Concesión |
| Administrador CRH | No — rol interno de plataforma (sección 15), acceso solo vía Concesión |
| Soporte | No — rol interno de plataforma (sección 15), acceso solo vía Concesión |
| Administrador/propietario de finca | **Sí** — rol de membresía única por organización |
| Técnico/colaborador | **Sí** — rol de membresía única por organización; puede tener membresías en organizaciones distintas |
| Usuario de solo lectura | **Sí** — rol de membresía única por organización |
| Comprador CatastroX sin cuenta | No — fuera del modelo ganadero (CatastroX público) |
| Comprador CatastroX con cuenta futura | No — mismo motivo |
| Usuario demo | No — no requiere identidad |

## 11. Roles y permisos

- **Fuente de verdad**: `agx`.
- **Modelo recomendado**: RBAC con restricciones contextuales (rol de la membresía + organización activa validada).
- **Nivel de granularidad**: por rol.
- **Relación rol → permisos**: catálogo fijo y auditable; con una membresía única por organización y un único rol por membresía (sección 10), esta relación es directa: **el conjunto de permisos de un usuario en una organización es exactamente el del rol de su única membresía vigente en esa organización**, sin necesidad de resolver combinaciones ni conflictos entre membresías paralelas.
- **Excepciones individuales**: no se recomiendan en la fase inicial.
- **Roles compuestos**: si un caso de negocio requiere un conjunto de capacidades que no corresponde a ningún rol predefinido, se resuelve incorporando un nuevo rol compuesto al catálogo (sección 10), mediante decisión controlada — nunca mediante una segunda membresía.
- **Validación de la organización activa**: según las reglas explícitas de la sección 12.
- **Cómo se evita confiar en un `organizacion_id` enviado libremente por el frontend**: el backend nunca acepta el `organizacion_id` como dato de entrada libre — lo asigna él mismo en creación y lo trata como inmutable en actualización (sección 12), validando siempre contra la única membresía activa del `sub` autenticado en esa organización.

## 12. Contexto de organización activa

Alternativas ya evaluadas (sin cambios): `organizacion_id` en URL/body, header dedicado, claim de token, sesión de backend (BFF), selección persistida en frontend, resolución por recurso.

**Reglas obligatorias, aplicables sin excepción**:

- La organización activa puede llegar como header o como parámetro de contexto en la solicitud, **pero nunca se trata como una credencial**.
- El backend siempre valida la organización activa declarada contra la (única) membresía activa real del `sub` autenticado en `agx`. Si no coincide, la solicitud se rechaza (`403`).
- **En operaciones de creación**: el backend asigna el `organizacion_id` él mismo, derivado de la membresía activa validada del usuario — nunca acepta que el cliente lo imponga libremente en el cuerpo de la solicitud.
- **En operaciones de actualización**: `organizacion_id` no es un campo modificable por el cliente.
- **Las consultas por identificador** deben validar simultáneamente el identificador del recurso y la organización autorizada, dentro de la misma consulta (sección 14).
- **Los recursos de otra organización siguen la política uniforme de `403`/`404`** que ADR-007 deja pendiente de definir (sección 9.4/20 de ADR-007) — este ADR no la fija, pero exige su aplicación consistente.

## 13. Propagación de `organizacion_id`

*Nombres conceptuales — sujetos a diseño técnico posterior.*

**`organizacion_id` directo es obligatorio en todas las tablas de negocio organizacionales**, no derivado exclusivamente por relación.

| Tabla | `organizacion_id` | Justificación |
|---|---|---|
| `predios` | **Directo, obligatorio** | Entidad raíz de propiedad de datos operativos |
| `potreros` | **Directo, obligatorio** (además de `predio_id`) | Simplifica el filtro, los índices y las políticas de RLS; evita depender de un `join` en cada autorización |
| `animales` | **Directo, obligatorio** (además de `predio_id`/`potrero_id`) | Tabla más consultada del sistema y del hallazgo de IDOR más directo (sección 3) |
| `qr_codes` | **Directo, nullable** (nulo = inventario de plataforma) | Necesario para el ciclo de vida de QR (sección 8/13/18/23) |
| `animal_razas` | **Directo, obligatorio** (además de `animal_id`/`raza_id`) | Consistencia con el resto de las tablas de detalle; `razas` en sí permanece global |
| `pesajes` | **Directo, obligatorio** (además de `animal_id`) | Simplifica filtros, auditoría y pruebas de aislamiento |
| `vacunaciones` | **Directo, obligatorio** (además de `animal_id`); `catalogo_vacunas` permanece global | Igual razón |
| `tratamientos` | **Directo, obligatorio** (además de `animal_id`) | Igual razón |
| `reproduccion` | **Directo, obligatorio** (además de `animal_id`) | Igual razón |
| `razas` | **Sin `organizacion_id`** | Catálogo global oficial (sección 16) |
| `catalogo_vacunas` | **Sin `organizacion_id`** | Catálogo global oficial, con control de escritura (sección 16) |

**Justificación general**: simplifica los filtros de autorización a una condición directa por tabla en vez de una cadena de `joins`; **facilita las políticas de RLS** (una política sobre una columna directa es sustancialmente más simple y eficiente que una que dependa de subconsultas contra tablas padre — condición reforzada por los requisitos de pooling de la sección 14); reduce el riesgo de IDOR; permite índices por organización; simplifica auditoría y pruebas.

**Control de la duplicación**: relaciones compuestas o restricciones equivalentes; validaciones de igualdad organizacional entre padre e hijo; transacciones atómicas; pruebas automáticas de consistencia — ninguno de estos mecanismos se fija como DDL definitivo en este documento (acciones requeridas, sección 24; decisiones de seguimiento, sección 27).

## 14. Defensa en profundidad y RLS

**Principio obligatorio** (sin cambios): toda fila de negocio debe ser atribuible inequívocamente a una organización; ninguna consulta autenticada puede ejecutarse sin resolver primero el contexto de organización; el backend nunca confía únicamente en un filtro enviado por el cliente; la autorización se resuelve antes de leer o modificar cualquier recurso; las relaciones hijas heredan o validan la pertenencia organizacional de su padre.

### Comparación de capas de defensa (sin cambios en el análisis)

| Enfoque | Descripción | Ventaja | Riesgo |
|---|---|---|---|
| Solo filtros en Express | Cada ruta añade explícitamente el filtro de organización | Simple, patrón ya usado hoy para `?predio_id=` | Depende de que cada desarrollador aplique el filtro correctamente en cada ruta |
| Solo PostgreSQL RLS | Políticas a nivel de base de datos | Protege incluso si una ruta "olvida" el filtro | No existe hoy en `agx`; requiere rediseñar el manejo de conexiones |
| Defensa en profundidad: Express + RLS | Ambas capas activas | Un fallo en una capa no expone datos si la otra sigue activa | Mayor complejidad de implementación y depuración |

### RLS como requisito obligatorio antes de producción

- El middleware centralizado de Express es requisito inmediato, exigible desde el primer desarrollo funcional en staging.
- PostgreSQL RLS es requisito obligatorio antes de operar producción multicliente con datos reales.
- **Defensa en profundidad obligatoria en producción**: Express valida identidad, membresía (única y vigente), rol y recurso como primera capa; PostgreSQL RLS actúa como segunda barrera.
- RLS no bloquea el primer desarrollo en staging; sí bloquea el corte productivo multicliente.

### Condiciones vinculantes de aislamiento transaccional y de privilegios (corrección de esta ronda)

Para que RLS sea efectivo y no evitable, se establecen las siguientes condiciones **vinculantes**, aplicables desde el diseño técnico posterior, sin excepción:

- **El contexto de usuario y organización utilizado por las políticas de RLS debe establecerse dentro de la misma transacción que ejecuta las consultas autorizadas** — nunca antes de abrir la transacción ni fuera de su alcance.
- **Toda solicitud debe finalizar con `COMMIT` o `ROLLBACK` antes de devolver la conexión al pool** — ninguna solicitud puede dejar una transacción abierta al terminar.
- **Ninguna conexión puede conservar contexto de organización entre solicitudes** — el contexto se establece de nuevo en cada transacción; una conexión reutilizada por el pool para una solicitud distinta no puede "heredar" el contexto de organización de la solicitud anterior.
- **El rol de PostgreSQL usado por la aplicación no puede**:
  - ser propietario (`OWNER`) de las tablas protegidas por RLS;
  - tener el atributo `BYPASSRLS`;
  - desactivar RLS sobre ninguna tabla;
  - operar con privilegios administrativos de ningún tipo.
- **El rol de aplicación debe estar sujeto a las políticas de RLS en todo momento** y aplicar el principio de mínimo privilegio (solo los permisos de tabla/columna estrictamente necesarios para las operaciones de negocio).
- **El rol de migraciones/administración debe ser un rol de PostgreSQL distinto del rol de aplicación, y nunca debe ser utilizado por solicitudes normales del backend** — las migraciones y tareas administrativas se ejecutan bajo su propio rol, separado y no expuesto a la superficie de la API.
- **El mecanismo técnico exacto** (uso de `SET LOCAL` para variables de sesión, el diseño preciso de las transacciones por solicitud, y la configuración del pool de conexiones compatible con estas reglas) **continúa pendiente** — no se fija en este documento (decisión de seguimiento, sección 27).

## 15. Usuarios internos CRH y accesos excepcionales

Consistente con ADR-007 (sección 8.1), con la entidad conceptual **Concesión de acceso interno** ya introducida y, en esta ronda, **explícitamente sujeta a RLS**:

- **El rol interno (superadministrador, Administrador CRH, Soporte) no otorga, por sí mismo, acceso automático a datos de ninguna organización de cliente.**
- El rol interno determina si un usuario puede **solicitar, aprobar o utilizar** Concesiones de acceso interno, según el modelo de responsabilidades del diseño de seguimiento.
- **Una Concesión de acceso interno no omite ni desactiva RLS bajo ninguna circunstancia.** La concesión **amplía temporalmente el conjunto autorizado** del usuario interno — es decir, hace que, para efectos de las políticas de RLS y del middleware de Express, ese usuario interno sea tratado como autorizado **únicamente para la organización y el alcance definidos en la concesión activa**, durante su vigencia. No es un mecanismo que rodee o suspenda las capas de autorización — es una fuente adicional y temporal de autorización, evaluada por esas mismas capas.
- **Toda consulta interna sobre datos de una organización de cliente continúa pasando, sin excepción, por las seis etapas siguientes**:
  1. **Autenticación** (validación del access token de Cognito, ADR-007 sección 9.1).
  2. **Middleware de autorización** (resolución de identidad y, para un usuario interno, de su rol interno).
  3. **Validación de Concesión activa** (existe una Concesión de acceso interno vigente, no expirada ni revocada, para ese usuario interno y esa organización específica).
  4. **Contexto transaccional** (el contexto de organización autorizado, incluyendo el otorgado por la Concesión, se establece dentro de la transacción de la solicitud, sección 14).
  5. **RLS** (las políticas de base de datos aplican sobre ese contexto exactamente igual que para cualquier otra solicitud — sin distinción de "modo interno").
  6. **Auditoría** (la consulta y su resultado quedan registrados, referenciando la Concesión bajo la cual se ejecutó, sección 17).
- **Una Concesión para una organización no habilita acceso a ninguna otra organización** — su alcance es estrictamente el declarado, nunca extensible por inferencia o conveniencia.
- **No se permite utilizar una conexión administrativa ni un rol de PostgreSQL con `BYPASSRLS` para atender un caso de soporte** — el acceso de soporte, bajo Concesión, se realiza siempre con el mismo rol de aplicación sujeto a RLS que cualquier otra solicitud (sección 14), nunca con el rol de migraciones/administración.
- **Un futuro mecanismo de "break-glass" (acceso de emergencia) tampoco implica automáticamente `BYPASSRLS` ni una conexión administrativa** — si se diseña en el futuro, debe operar igualmente dentro de las seis etapas anteriores, con una Concesión de emergencia sujeta a las mismas reglas, no como una vía paralela que sortee RLS. Su diseño exacto no se resuelve en este documento (sección 27).
- **No se aprueba impersonación en este documento.** Permanece como decisión separada, explícita y auditada, pendiente (ADR-007, sección 20).
- **Exportación masiva global**: prohibida salvo un procedimiento excepcional formal, distinto e independiente de una Concesión ordinaria.

## 16. Catálogos globales y privados

Sin cambios respecto de la ronda anterior:

- **`agx.razas`**: catálogo global, sin `organizacion_id`, de solo lectura vía API hoy — se recomienda mantener así, reservando creación/edición a un procedimiento administrado por un rol interno.
- **`agx.catalogo_vacunas`**: catálogo global, sin `organizacion_id`. Hallazgo confirmado: `POST /api/vacunaciones/catalogo-vacunas` permite hoy insertar sin control. Se recomienda restringir su escritura a un rol interno.
- **Extensiones privadas por organización**: patrón posible a futuro, no diseñado aquí.
- **Clasificación de GET/POST de razas y vacunas**: `GET /api/razas` y `GET /api/vacunaciones/catalogo-vacunas` se recomiendan **Autenticada**; `POST /api/vacunaciones/catalogo-vacunas` se recomienda reclasificar a **Administrativa**.

## 17. Auditoría de negocio y seguridad

**Eventos mínimos a registrar**:

- Creación y modificación de una organización.
- Envío, aceptación, expiración y revocación de una invitación.
- Cambios de rol dentro de una membresía (dado el modelo de membresía única, un "cambio de rol" es el reemplazo del rol vigente de esa única membresía).
- Suspensión o retiro de un usuario de una organización.
- **Solicitud, aprobación, activación, uso y expiración/revocación de una Concesión de acceso interno** — cada consulta ejecutada bajo una concesión activa se registra referenciando esa concesión, **incluyendo que la consulta pasó por RLS igual que cualquier otra** (sección 15).
- Lectura o exportación de datos clasificados como sensibles.
- Creación, modificación y eliminación de predios.
- Reserva, transferencia, liberación y retiro de un código QR.
- Asociación de un código QR a un animal.
- Operaciones masivas.
- Cambios administrativos.

**Atributos mínimos por evento**: actor (`sub` + rol/membresía o Concesión bajo la cual actuó), organización afectada, recurso afectado, acción, fecha/hora, resultado, IP, user agent, identificador de correlación, motivo, estado anterior y posterior cuando aplique.

**Retención y protección frente a modificación**: pendientes de definición técnica (sección 27), con el principio de que los registros son, como mínimo, de solo-append desde la aplicación.

## 18. Integridad referencial

- **Claves foráneas**: el diseño de seguimiento debe mantener la disciplina actual al incorporar `organizacion_id` directo, más las validaciones de consistencia organizacional padre-hijo (sección 13).
- **Restricción de unicidad de membresía**: se registra conceptualmente una restricción de unicidad sobre el par (usuario, organización) para las membresías vigentes (sección 10) — sin DDL definitivo.
- **Restricciones únicas por organización**: a evaluar caso por caso en el diseño técnico posterior.
- **Eliminación lógica vs. física**: se recomienda eliminación lógica para entidades con valor histórico (predios, animales, membresías, organizaciones, Concesiones de acceso interno).
- **Cascadas**: se preserva el patrón actual (`cascade` para detalle operativo, `restrict` para relaciones estructurales).
- **Protección de históricos**: los registros operativos no deben perderse por una reorganización administrativa.
- **Transferencia de recursos**: operación explícita y auditada; una transferencia de predio entre organizaciones implica actualizar de forma atómica el `organizacion_id` directo del predio y de todas sus filas dependientes.
- **Ciclo de vida de QR** (sin cambios respecto de la ronda anterior): inventario de plataforma (sin `organizacion_id`) → reservado (con `organizacion_id`, sin `animal_id`) → asignado (con `organizacion_id` y `animal_id`, validando igualdad de `organizacion_id` entre QR y animal) → retirado/anulado. Un cliente no puede tomar cualquier QR libre; solo puede usar QR reservados/asignados a su organización; reserva, transferencia, liberación y retiro son operaciones auditadas; `codigo_qr` continúa siendo único globalmente.
- **Unicidad de identificadores de animales**: sin restricción hoy; si se requiere, se recomienda que sea por organización.
- **Auditoría ante cambios de propiedad**: toda transferencia de un predio genera un evento de auditoría explícito.

## 19. Estrategia conceptual de migración

*Estrategia conceptual, no ejecutable.*

1. **Inventario y backup**: contar y clasificar cada fila de `agx` contra el estado real de la base de datos en ejecución, distinguiendo datos reales, datos del seed `002_agx_seed_demo.sql` (catálogos) y datos del seed `003_agx_seed_demo_optional.sql` (demo). Respaldo completo y verificado antes de cualquier cambio.
2. **Clasificación de datos**: real / catálogo global / demo-prueba / ambigua (NO VERIFICADO, resolución manual obligatoria).
3. **Creación de organizaciones**: decisión de negocio, no técnica, no determinada aquí. Cada organización creada obtiene, desde su creación, membresías con la restricción de unicidad (usuario, organización) ya activa.
4. **Backfill de `organizacion_id`**: poblar la columna directa en las 9 tablas de negocio organizacionales, solo para filas clasificadas sin ambigüedad.
5. **Validación de igualdad organizacional padre-hijo**: verificar que cada fila hija coincide con la organización de su entidad padre; cualquier discrepancia detiene el proceso para esa fila.
6. **Detección y resolución de huérfanos**: reporte explícito y resolución manual — prohibida la asignación automática o el borrado silencioso.
7. **Activación de restricciones NOT NULL (o equivalentes)**: una vez completado el backfill y resueltos los huérfanos.
8. **Activación de RLS**: con las condiciones vinculantes de la sección 14 (transacción, pooling, privilegios de rol) ya implementadas y verificadas — no solo con las políticas escritas, sino con el rol de aplicación confirmado sin `BYPASSRLS` ni privilegios administrativos.
9. **Pruebas automatizadas de aislamiento**: con RLS y el middleware de Express ambos activos, incluyendo pruebas específicas de que ninguna conexión conserva contexto entre solicitudes y de que el rol de aplicación no puede sortear las políticas.
10. **Corte productivo**: solo después de completar exitosamente los 9 pasos anteriores.

**Prohibición explícita, sin excepción**: no se autoriza operar producción multicliente mientras exista una sola fila en una tabla organizacional sin una organización válida asignada, ni mientras el rol de aplicación conserve `BYPASSRLS`, privilegios administrativos, o propiedad sobre las tablas protegidas.

## 20. Matriz de acceso

*Matriz conceptual.*

| Rol | Tipo | Predios/potreros/animales/registros de SU organización | Predios/potreros/animales/registros de OTRA organización | Catálogos globales | Administración de miembros | Acceso de soporte |
|---|---|---|---|---|---|---|
| Administrador/propietario de finca | Cliente | Lectura, creación, edición, eliminación (lógica), exportación | Sin acceso | Lectura | Sí, de su organización (una membresía única, un rol) | No aplica |
| Técnico/colaborador | Cliente | Lectura, creación, edición operativa | Sin acceso | Lectura | No | No aplica |
| Usuario de solo lectura | Cliente | Solo lectura | Sin acceso | Lectura | No | No aplica |
| Superadministrador | Interno | **Sin acceso, salvo Concesión de acceso interno activa y válida — sujeta a RLS igual que cualquier solicitud (sección 15)** | Sin acceso, mismo requisito | Lectura y administración | No aplica a organizaciones de cliente; sí a identidades internas | Puede aprobar Concesiones; nunca impersonar; nunca vía rol `BYPASSRLS` |
| Administrador CRH | Interno | **Sin acceso, salvo Concesión activa y válida, sujeta a RLS** | Sin acceso, mismo requisito | Lectura y administración | Sí, de las organizaciones bajo Concesión activa | Puede solicitar/usar Concesiones; nunca impersonar; nunca vía rol `BYPASSRLS` |
| Soporte | Interno | **Sin acceso, salvo Concesión activa y válida, acotada al caso, sujeta a RLS** | Sin acceso, mismo requisito | Lectura | No | Puede solicitar/usar Concesiones; nunca impersonar; nunca vía rol `BYPASSRLS` |
| Comprador CatastroX sin cuenta | Público | No aplica (fuera del modelo ganadero) | No aplica | No aplica | No aplica | No aplica |
| Comprador CatastroX con cuenta futura | Cliente (dominio distinto) | No aplica | No aplica | No aplica | No aplica | No aplica |
| Usuario demo | Público (sin identidad) | No aplica — la demo no toca `agx` | No aplica | No aplica | No aplica | No aplica |

## 21. Consecuencias positivas

- Cierra la brecha estructural de la sección 3 mediante dos capas obligatorias (Express + RLS antes de producción).
- `organizacion_id` directo simplifica filtros, índices, auditoría y pruebas.
- **La membresía única por organización elimina, desde el diseño, cualquier ambigüedad sobre qué rol aplica a un usuario en una organización** — nunca hay dos membresías compitiendo ni superponiéndose.
- Las condiciones vinculantes de la sección 14 (transacción, pooling, privilegios de rol) hacen que RLS sea una barrera real y no evitable, no solo un conjunto de políticas potencialmente sorteables.
- La Concesión de acceso interno, ahora explícitamente sujeta a RLS, formaliza el mínimo privilegio para roles internos sin crear una vía paralela de mayor riesgo.
- Sigue aprovechando la infraestructura ya aprobada (ADR-001).

## 22. Consecuencias negativas

- `organizacion_id` directo en 9 tablas introduce duplicación y esfuerzo de consistencia (sección 13).
- RLS obligatorio antes de producción, con las condiciones vinculantes de la sección 14, adelanta un trabajo de diseño e implementación no trivial (roles de PostgreSQL separados para aplicación y migraciones, gestión de contexto transaccional por solicitud, verificación de que el pool de conexiones no filtra contexto entre solicitudes).
- La prohibición explícita de crear una segunda membresía para resolver capacidades adicionales (sección 10) traslada esa necesidad a un proceso más formal (selección de rol predefinido, creación controlada de rol compuesto, o revisión del ADR) — más lento que "simplemente añadir una membresía", pero más auditable y consistente.
- El ciclo de vida de QR y la Concesión de acceso interno añaden superficie de diseño (estados, transiciones, auditoría).

## 23. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| Filtración de datos entre organizaciones por una ruta que "olvida" el filtro | Confirmado hoy en múltiples rutas | Middleware de Express obligatorio más RLS obligatorio antes de producción |
| Producción multicliente operando sin RLS activo | Riesgo explícito | Bloqueo formal (paso 10, sección 19) |
| **RLS activo pero evitable por un rol de PostgreSQL con `BYPASSRLS`, privilegios administrativos, o propiedad de las tablas** | Riesgo nuevo, corrección de esta ronda (sección 14) | Prohibición explícita de estos atributos en el rol de aplicación; rol de migraciones/administración separado y nunca usado por solicitudes normales |
| **Contexto de organización filtrado entre solicitudes por reutilización de conexión del pool** | Riesgo nuevo, corrección de esta ronda (sección 14) | Contexto establecido dentro de la misma transacción de cada solicitud; `COMMIT`/`ROLLBACK` obligatorio antes de devolver la conexión al pool; ninguna conexión conserva contexto entre solicitudes |
| **Acceso de soporte servido mediante una conexión administrativa o rol `BYPASSRLS`, sorteando RLS** | Riesgo nuevo, corrección de esta ronda (sección 15) | Prohibición explícita; toda consulta interna, incluso bajo Concesión, usa el rol de aplicación sujeto a RLS |
| **Ambigüedad de rol por membresías duplicadas del mismo usuario en la misma organización** | Riesgo eliminado por la corrección de esta ronda (sección 10) | Restricción conceptual de unicidad (usuario, organización); vías formales (rol predefinido, rol compuesto, revisión de ADR) para capacidades adicionales |
| IDOR (acceso a un recurso ajeno mediante un ID adivinado) | Confirmado hoy | Validación simultánea de identificador y organización, reforzada por `organizacion_id` directo |
| Confianza en un `organizacion_id` enviado por el frontend | Riesgo de diseño | Reglas de creación/actualización de la sección 12 |
| Inconsistencia entre `organizacion_id` directo de una fila hija y el de su entidad padre | Riesgo de la propagación directa | Validaciones de igualdad, transacciones atómicas, pruebas de consistencia (sección 13) |
| QR tomado de organización incorrecta | Riesgo ya resuelto conceptualmente por el ciclo de vida (sección 13/18) | Validación de igualdad `organizacion_id` en la asociación QR-animal |
| Datos huérfanos tras la migración | Ambigüedad de `predios.propietario` | Detección explícita y resolución manual obligatoria |
| Migración incorrecta o corte productivo prematuro | Complejidad del proceso | Secuencia de 10 pasos obligatoria (sección 19) |
| Acceso interno no auditado a datos de clientes | Riesgo si el rol interno se trata como acceso automático | Concesión de acceso interno activa y válida, sujeta a RLS, para toda consulta interna |
| Catálogos globales modificados por un cliente | Confirmado hoy | Restringir la escritura a roles internos |
| Seeds ejecutados en producción | Riesgo de ADR-004; mecanismo técnico cerrado por ADR-014 | `003_agx_seed_demo_optional.sql` queda excluido de staging/producción y solo se conservan fixtures equivalentes en demo standalone/local |
| Autorización autenticada pero sin aislamiento real | Problema central de este ADR | Implementación completa de las secciones 12-15 y 19 antes de producción |
| Impersonación implementada sin aprobación | Capacidad técnicamente posible pero no aprobada | No implementar bajo ninguna circunstancia sin decisión separada, explícita y auditada |
| **Un futuro "break-glass" implementado como `BYPASSRLS` o conexión administrativa** | Riesgo nuevo, corrección de esta ronda (sección 15) | Cualquier break-glass futuro debe operar dentro de las seis etapas de la sección 15, nunca como vía paralela |
| **Ruta "congelada" usada como excusa para no corregir una consulta insegura** | Riesgo de interpretación errónea de la sección 4 | Precisión explícita: "congelada" aplica a URLs/contratos públicos, nunca a la implementación interna insegura |

## 24. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Diseñar el DDL definitivo de organización, membresía (única por par usuario-organización, con restricción de unicidad conceptual), rol (incluyendo roles compuestos), permiso, invitación, evento de auditoría, rol interno CRH y Concesión de acceso interno.
- Diseñar el middleware de autorización centralizado en Express (identidad, membresía única, rol, contexto, recurso) como requisito inmediato de staging.
- Diseñar la columna `organizacion_id` directa en las 9 tablas de negocio organizacionales, junto con los mecanismos de control de duplicación.
- **Diseñar las políticas de RLS y el mecanismo técnico exacto de `SET LOCAL`/variables de sesión/transacciones/configuración del pool**, garantizando las condiciones vinculantes de la sección 14 (contexto dentro de la transacción, `COMMIT`/`ROLLBACK` obligatorio, sin contexto persistente entre solicitudes, rol de aplicación sin `BYPASSRLS` ni privilegios administrativos, rol de migraciones separado).
- Diseñar el modelo de estados y transiciones del ciclo de vida de QR, con sus eventos de auditoría.
- Diseñar el flujo completo de la Concesión de acceso interno (solicitud, aprobación, activación, uso dentro de las seis etapas de la sección 15, expiración, revocación) y su registro de auditoría.
- Reescribir la **implementación interna** de las rutas existentes para pasar por el middleware de autorización y por el contexto transaccional de RLS, sin cambiar sus URLs ni contratos públicos (precisión de la sección 4).
- Restringir la escritura del catálogo de vacunas a roles internos.
- Ejecutar la secuencia de 10 pasos de la sección 19 en staging antes de considerar el corte productivo.

## 25. Criterios de aceptación

- Ninguna ruta de negocio ganadero ejecuta una consulta a `agx` sin pasar por el middleware de autorización centralizado.
- Toda tabla de negocio organizacional tiene la columna `organizacion_id` poblada y con restricción NOT NULL (o equivalente) activa antes del corte productivo.
- **No existe, en ningún momento posterior al corte productivo, más de una membresía vigente para el mismo par (usuario, organización)**, verificable mediante prueba automatizada.
- RLS está activo y las pruebas automatizadas de aislamiento pasan antes de autorizar producción multicliente con datos reales.
- **El rol de PostgreSQL usado por la aplicación no tiene `BYPASSRLS`, no es propietario de las tablas protegidas y no tiene privilegios administrativos, verificable por inspección de la configuración de la base de datos.**
- **Ninguna conexión del pool conserva contexto de organización entre solicitudes, verificable mediante prueba automatizada que simule reutilización de conexión.**
- El `organizacion_id` declarado por el frontend nunca se acepta sin verificar la membresía activa del `sub`; en creación lo asigna el backend; en actualización no es modificable por el cliente.
- `POST /api/vacunaciones/catalogo-vacunas` deja de ser accesible sin control de rol.
- El ciclo de vida de QR impide que una organización reserve o use un QR que no le ha sido asignado.
- **Ninguna consulta interna sobre datos de una organización de cliente se ejecuta sin una Concesión de acceso interno activa y válida, y esa consulta pasa por las mismas políticas de RLS que cualquier otra solicitud — nunca mediante una conexión administrativa o rol `BYPASSRLS`.**
- Existe un inventario y un plan de migración revisado, con detección explícita de huérfanos y sin asignaciones automáticas silenciosas.
- La demo de Ganadería permanece sin conexión al backend y a la base de datos, conforme a ADR-014.

## 26. Elementos fuera de alcance

- DDL definitivo y migraciones ejecutables.
- Implementación de código de cualquier tipo.
- Ejecución de cualquier inventario contra una base de datos real.
- Diseño técnico exacto de las políticas de RLS y de la configuración de roles/pooling de PostgreSQL.
- Implementación completa de ADR-014 — la decisión técnica ya está cerrada, pero su verificación operativa sigue fuera de este ADR.
- Diseño exacto del mecanismo de revocación inmediata de ADR-007 (sección 9.2).
- Aprobación de impersonación de soporte.
- Diseño exacto de un futuro mecanismo de "break-glass".
- Decisión sobre si existe o se requiere un modelo de planes/suscripción.
- Cambios a las URLs o contratos públicos de las interfaces o rutas congeladas actuales (sí se espera, y se exige, cambiar su implementación interna, sección 4).

## 27. Decisiones de seguimiento

1. Diseño técnico detallado y DDL de organización, membresía (con restricción de unicidad usuario-organización), rol, permiso, invitación, auditoría, rol interno CRH y Concesión de acceso interno.
2. **Diseño técnico exacto de RLS y de las condiciones de pooling/transacción/privilegios de rol** de la sección 14.
3. Mecanismo exacto de control de duplicación de `organizacion_id` entre tablas padre e hijo.
4. Mecanismo exacto de transferencia de administración dentro de una organización.
5. Si se requiere segmentación de acceso más fina que "toda la organización".
6. Diseño exacto del flujo de Concesión de acceso interno, incluyendo si se requiere aprobación de una segunda persona.
7. Mecanismo exacto de reserva/transferencia/liberación de QR.
8. Si se permiten extensiones privadas de catálogo por organización.
9. Retención y mecanismo técnico exacto de protección del log de auditoría.
10. Restricciones de unicidad exactas (código de predio, identificadores de animal).
11. Coordinación explícita con ADR-014 para impedir demo persistente dentro del plano real.
12. Si "organización" y "plan/suscripción" requieren modelarse juntos.
13. **Criterio exacto para decidir entre seleccionar un rol predefinido y crear un rol compuesto** cuando un usuario requiere capacidades adicionales dentro de una organización (sección 10) — y el procedimiento formal para revisar este ADR si ninguna de las dos vías resulta suficiente.
14. **Diseño exacto de un futuro mecanismo de "break-glass"**, garantizando que opere dentro de las seis etapas de la sección 15 y nunca mediante `BYPASSRLS`.

## 28. Relación con ADR anteriores

- **ADR-002**: se preserva `agx` como fuente de verdad de Ganadería; este ADR-008 lo extiende.
- **ADR-004/ADR-014**: ADR-014 cerró el mecanismo técnico de separación demo/staging/producción; ADR-008 conserva la regla multicliente del plano real.
- **ADR-005**: los tres niveles de ruta se preservan; este ADR-008 añade la dimensión de organización dentro del nivel "autenticada".
- **ADR-007**: ADR-008 es el ADR de seguimiento que ADR-007 dejó pendiente; hereda y refuerza las reglas de acceso interno auditado (formalizadas como Concesión de acceso interno, ahora explícitamente sujeta a RLS) y la no aprobación de impersonación. Hereda la política uniforme de `403`/`404` de ADR-007, aún no fijada.
- **ADR-001**: la elevación de RLS a requisito de producción, junto con las condiciones vinculantes de pooling/transacción/privilegios de rol (sección 14), es relevante para el diseño de la instancia RDS de Ganadería que ADR-001 ya aprobó — no contradice esa decisión, la complementa con requisitos de configuración de base de datos adicionales antes del corte productivo.

---

## Anexo A. Inventario de tablas actuales de `agx`

| Tabla | PK | FKs salientes | ¿Requiere `organizacion_id` directo? | Filas de ejemplo insertadas por seeds |
|---|---|---|---|---|
| `predios` | `predio_id` (bigserial) | — | **Sí, obligatorio** | 1 fila demo (seed 003) |
| `potreros` | `potrero_id` (bigserial) | `predio_id → predios` (restrict) | **Sí, obligatorio** | 2 filas demo (seed 003) |
| `razas` | `raza_id` (bigserial) | — | No — catálogo global | 7 filas catálogo (seed 002) |
| `qr_codes` | `qr_id` (bigserial) | `animal_id → animales` (set null, diferida) | **Sí, nullable** (ciclo de vida, sección 13) | 4 filas catálogo (seed 002); 1 marcada "asignado" por seed 003 |
| `animales` | `animal_id` (bigserial) | `predio_id → predios` (restrict), `potrero_id → potreros` (restrict), `qr_id → qr_codes` (unique, restrict) | **Sí, obligatorio** | 1 fila demo (seed 003) |
| `animal_razas` | `animal_raza_id` (bigserial) | `animal_id → animales` (cascade), `raza_id → razas` (restrict) | **Sí, obligatorio** | 1 fila demo (seed 003) |
| `pesajes` | `pesaje_id` (bigserial) | `animal_id → animales` (cascade) | **Sí, obligatorio** | 2 filas demo (seed 003) |
| `catalogo_vacunas` | `catalogo_vacuna_id` (bigserial) | — | No — catálogo global | 1 fila catálogo (seed 002) |
| `vacunaciones` | `vacunacion_id` (bigserial) | `animal_id → animales` (cascade), `catalogo_vacuna_id → catalogo_vacunas` (restrict) | **Sí, obligatorio** | 1 fila demo (seed 003) |
| `tratamientos` | `tratamiento_id` (bigserial), opcional | `animal_id → animales` (cascade) | **Sí, obligatorio** | Ninguna |
| `reproduccion` | `reproduccion_id` (bigserial), opcional | `animal_id → animales` (cascade) | **Sí, obligatorio** | Ninguna |

## Anexo B. Clasificación de tablas: categorías corregidas

| Categoría | Entidades |
|---|---|
| **Raíz multicliente** | Organización |
| **Control de acceso** | Usuario de aplicación, Membresía (única por par usuario-organización), Rol, Invitación |
| **Datos organizacionales** | `predios`, `potreros`, `animales`, `animal_razas`, `pesajes`, `vacunaciones`, `tratamientos`, `reproduccion` |
| **Inventario de plataforma** | `qr_codes` en estado "inventario" (sin `organizacion_id`) |
| **Catálogos globales** | `razas`, `catalogo_vacunas` |
| **Gobierno interno** | Rol interno CRH, Concesión de acceso interno (sujeta a RLS, sección 15) |
| **Auditoría transversal** | Evento de auditoría |

*Nota: `qr_codes` en estado "reservado" o "asignado" pasa a clasificarse como dato organizacional; su categoría depende de su estado en el ciclo de vida.*

## Anexo C. Propagación conceptual de `organizacion_id`

```
Organización (nueva) — raíz multicliente
   │
   ├─ Membresía (única por par usuario-organización, un rol) → Usuario (control de acceso)
   │
   ├─ predios.organizacion_id (DIRECTO, obligatorio)
   │     │
   │     ├─ potreros.organizacion_id (DIRECTO, obligatorio)
   │     │     — debe coincidir con predios.organizacion_id vía predio_id
   │     │
   │     └─ animales.organizacion_id (DIRECTO, obligatorio)
   │           — debe coincidir con predios/potreros.organizacion_id
   │           │
   │           ├─ animal_razas.organizacion_id (DIRECTO, obligatorio)
   │           ├─ pesajes.organizacion_id (DIRECTO, obligatorio)
   │           ├─ vacunaciones.organizacion_id (DIRECTO, obligatorio)
   │           ├─ tratamientos.organizacion_id (DIRECTO, obligatorio)
   │           ├─ reproduccion.organizacion_id (DIRECTO, obligatorio)
   │           └─ qr_codes.organizacion_id (DIRECTO, cuando asignado —
   │                 debe coincidir con animales.organizacion_id)
   │
   └─ Rol interno CRH ──requiere──▶ Concesión de acceso interno (activa, con
                                     alcance, motivo, ticket, aprobador,
                                     vigencia) ──sujeta a RLS──▶ acceso
                                     auditado, solo a la organización y
                                     alcance de la concesión (sección 15)

qr_codes.organizacion_id = NULL → inventario de plataforma
qr_codes.organizacion_id = X, animal_id = NULL → reservado a la organización X
qr_codes.organizacion_id = X, animal_id = Y (Y pertenece a X) → asignado
qr_codes retirado/anulado → conserva organizacion_id histórico

razas — GLOBAL, sin organizacion_id
catalogo_vacunas — GLOBAL, sin organizacion_id, escritura restringida
```

## Anexo D. Matriz de roles y permisos

| Rol | Fuente de definición | Pertenece al modelo de este ADR | Membresías por organización |
|---|---|---|---|
| Superadministrador | ADR-007, sección 8.1 | Sí, como rol interno; acceso solo vía Concesión sujeta a RLS | No aplica (no tiene membresía ordinaria) |
| Administrador CRH | ADR-007, sección 8.1 | Sí, como rol interno; acceso solo vía Concesión sujeta a RLS | No aplica |
| Soporte | ADR-007, sección 8.1 | Sí, como rol interno; acceso solo vía Concesión sujeta a RLS | No aplica |
| Administrador/propietario de finca | ADR-007, sección 8.1 | Sí, como rol de membresía | **Como máximo una membresía vigente por organización** (sección 10) |
| Técnico/colaborador | ADR-007, sección 8.1 | Sí, como rol de membresía | Como máximo una membresía vigente por organización; puede tener membresías en organizaciones distintas |
| Usuario de solo lectura | ADR-007, sección 8.1 | Sí, como rol de membresía | Como máximo una membresía vigente por organización |
| Comprador CatastroX sin cuenta | ADR-007, sección 8.1 | No — fuera de alcance | No aplica |
| Comprador CatastroX con cuenta futura | ADR-007, sección 8.1 | No — fuera de alcance | No aplica |
| Usuario demo | ADR-007, sección 8.1 | No — no requiere identidad | No aplica |

## Anexo E. Matriz de migración de datos existentes

| Origen de datos | Clasificación | Tratamiento propuesto (secuencia de 10 pasos, sección 19) |
|---|---|---|
| Filas insertadas por `002_agx_seed_demo.sql` (razas, QR libres, vacuna base) | Datos catálogo | Permanecen globales (paso 2), sin `organizacion_id`; QR libres permanecen en estado "inventario de plataforma" |
| Filas insertadas por `003_agx_seed_demo_optional.sql` | Datos de prueba/demo | Excluidas completamente de cualquier migración a staging o producción; el archivo se conserva solo como artefacto histórico no ejecutable y fixtures equivalentes pertenecen exclusivamente al bundle local standalone de demo |
| Datos reales de cliente en una base en ejecución | Datos reales — NO VERIFICADO si existen | Requiere inventario contra la base real (paso 1) antes de cualquier decisión |
| Filas cuyo origen no puede determinarse | Información NO VERIFICADA / huérfanos | Resolución manual obligatoria (pasos 2 y 6); bloquea el paso 7 (activación de restricciones) hasta resolverse |

## Anexo F. Matriz de trazabilidad ADR-002/004/005/007 → ADR-008

| ADR | Relación con ADR-008 |
|---|---|
| ADR-002 | `agx` como fuente de verdad se hereda y se extiende |
| ADR-004/ADR-014 | ADR-014 cerró el mecanismo técnico de separación demo/staging/producción; ADR-008 no crea organización demo ni incorpora fixtures al plano real |
| ADR-005 | El nivel "autenticada" se refina con la dimensión de organización |
| ADR-007 | ADR-008 es el ADR de seguimiento ya aceptado; hereda y formaliza las reglas de acceso interno auditado; hereda la política uniforme 403/404 pendiente |
| ADR-001/ADR-011 | La elevación de RLS a requisito de producción, con condiciones de pooling/transacción/privilegios, complementa RDS y el backend Express en ECS Express Mode |
