# ADR-010: Estado remoto y bloqueo de Terraform

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-010 sigue gobernando S3, `use_lockfile`, CMK, OIDC, CI en dos etapas, bootstraps independientes y la prohibición de `apply` automático productivo. ADR-011 gobierna la plataforma de ejecución y ADR-014 gobierna la separación de ambientes; por tanto, el mapa de state debe usar componentes vigentes.

## 1. Contexto

ADR-003 (Aceptada) estableció Terraform como herramienta oficial de IaC, con reglas de gobernanza vinculantes: sin `apply` automático en producción, aprobación humana obligatoria vía pull request, GitHub Actions condicionado a confirmar el alojamiento del repositorio, OIDC obligatorio (prohibidas las Access Keys permanentes), y el estado remoto en un bucket S3 privado, cifrado y versionado, con el mecanismo de bloqueo dejado explícitamente pendiente. Este ADR-010 resuelve esa decisión pendiente adoptando **locking nativo del backend S3 (`use_lockfile`)** como mecanismo oficial, cifrado mediante una **clave KMS administrada por el cliente (CMK)** con un modelo de permisos criptográficos preciso por rol, una **separación de producción por fases con un gate obligatorio y bootstraps completamente independientes**, y un **flujo de CI en dos etapas** que impide que cualquier pull request obtenga automáticamente acceso privilegiado al estado remoto.

**Hallazgo ya verificado**: el repositorio vive en GitHub (`git remote -v` → `github.com/cristianferamos-ux/agrogenomax`), confirmando la condición que ADR-003 dejó pendiente para adoptar GitHub Actions.

## 2. Problema

ADR-003 dejó el mecanismo de *lock* pendiente. La resolución debe basarse en la recomendación vigente de la herramienta, no en un patrón heredado sin justificación de compatibilidad. Además, el diseño debe: precisar exactamente qué permisos criptográficos (no solo de S3) requiere cada rol sobre la CMK, distinguiendo uso de administración; evitar que cualquier pull request, incluido uno de un colaborador no confiable o de un fork, obtenga automáticamente credenciales OIDC con acceso real al estado remoto antes de una revisión humana; y garantizar que el bootstrap de producción sea un proceso administrativo completamente separado del de staging, sin dependencia de su state ni de sus identidades.

## 3. Estado actual verificado

*(Confirmado por búsqueda exhaustiva en el repositorio — sin nueva verificación de código en esta ronda de correcciones respecto de la anterior.)*

- No existe ningún código Terraform, ningún directorio `terraform/`/`infra/`/`infrastructure/`/`iac/`, ningún archivo `*.tf`/`*.tfvars`/`*.tfbackend`/`*.hcl`.
- No existe ningún workflow de GitHub Actions ni directorio `.github/`.
- El repositorio está alojado en GitHub — CONFIRMADO.
- No existe ningún estado de Terraform, local ni remoto.
- `.gitignore` no contiene ninguna entrada relacionada con Terraform — su corrección permanece como acción requerida (sección 26); **esta tarea no modifica `.gitignore`**.
- No existe ninguna credencial de AWS en uso, ninguna política IAM, ningún rol, ninguna configuración de OIDC.
- `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md` no menciona Terraform, backend de estado, S3 para IaC, DynamoDB ni OIDC.

**Discrepancia documental (sin cambios)**: el archivo `docs/adr/ADR-006-migracion-catastrox-reproducibilidad-gis.md` referenciado en las fuentes obligatorias originales no existe; el archivo real es `docs/adr/ADR-006-migracion-datos-geoespaciales.md`, efectivamente consultado.

**NO VERIFICADO**: versión de Terraform a fijar; existencia de una o varias cuentas AWS; tarifario oficial vigente de S3/KMS/CloudTrail; requisitos de cumplimiento normativo/contractual específicos.

## 4. Requisitos obligatorios

1. Terraform es la herramienta oficial de IaC para todos los recursos de AWS.
2. El estado remoto es privado, cifrado y versionado.
3. El mecanismo de bloqueo es el locking nativo del backend S3 (`use_lockfile`), no DynamoDB, salvo contingencia justificada y acotada en el tiempo.
4. No se inicia ningún bootstrap sin haber fijado y verificado, localmente y en CI, una versión mínima de Terraform compatible con `use_lockfile`.
5. Ningún `terraform apply` es automático en producción; todo `apply` requiere aprobación humana explícita.
6. GitHub Actions es la plataforma de CI/CD, con autenticación exclusivamente vía OIDC — prohibidas las Access Keys permanentes.
7. `.terraform.lock.hcl` se versiona obligatoriamente; los `.tfvars` con secretos nunca se versionan.
8. **El rol de plan lee el objeto `terraform.tfstate` y solo crea/elimina el objeto de lock `<state-key>.tflock`; nunca escribe ni elimina `terraform.tfstate`** (corrección 1).
9. **El rol de plan recibe exclusivamente los permisos criptográficos mínimos de uso de la CMK (descifrar, generar clave de datos, cifrar cuando el mecanismo lo requiera, describir la clave) — nunca permisos de administración de la clave** (corrección 1).
10. El cifrado del estado usa una CMK dedicada al backend de Terraform, con política mínima y rotación automática.
11. **Ningún pull request obtiene automáticamente credenciales OIDC ni acceso al state antes de una barrera de confianza humana o un evento confiable explícito** (corrección 2).
12. **Los forks nunca reciben OIDC, acceso al state ni secretos, bajo ninguna circunstancia, incluido mediante `pull_request_target` con privilegios** (corrección 2).
13. **El bootstrap de producción es un proceso administrativo completamente independiente del bootstrap de staging, con su propio state temporal, sus propias credenciales y su propia aprobación** (corrección 3).
14. Ningún `apply` se ejecuta sin verificar la integridad y vigencia del artefacto de plan; **cualquier cambio relevante invalida el plan, que nunca se reutiliza ni se actualiza — se genera uno nuevo y vuelve a revisión**.
15. El presupuesto de USD 25/mes aplica exclusivamente a staging.
16. No se autoriza el despliegue de ningún recurso de infraestructura como parte de este ADR.
17. Ninguna interfaz ni lógica funcional de AgroGenomaX se modifica.
18. La migración de CatastroX permanece condicionada por ADR-006.
19. Ningún ADR anterior se modifica.

## 5. Alternativas de backend

Sin cambios respecto de la ronda anterior: estado local descartado; Amazon S3 seleccionado (sección 7); Terraform Cloud/HCP descartado por introducir una dependencia de proveedor nueva y no contemplada.

## 6. Matriz comparativa

Sin cambios respecto de la ronda anterior.

## 7. Decisión de backend

Se mantiene Amazon S3 como backend de estado remoto, con locking nativo (sección 12), cifrado mediante CMK dedicada con permisos criptográficos precisos por rol (sección 9/15, corrección 1), separación de producción por fases con bootstraps completamente independientes (sección 10/14, corrección 3), y un flujo de CI en dos etapas que impide el acceso privilegiado automático al state desde cualquier pull request (sección 16/17, corrección 2).

## 8. Diseño conceptual del bucket

Sin cambios de fondo respecto de la ronda anterior: bucket dedicado exclusivamente al estado; en la fase actual corresponde a staging/compartido (sección 10); bloqueo de acceso público obligatorio; cifrado SSE-KMS con CMK dedicada; S3 Bucket Key habilitada cuando corresponda; versionado obligatorio; `Bucket owner enforced`; política de bucket con TLS obligatorio y denegación de `s3:DeleteBucket` salvo identidad administrativa. El objeto de lock nativo (`<clave-de-estado>.tflock`, nombre conceptual) coexiste, para cada clave de estado, junto al objeto `terraform.tfstate` correspondiente — **ambos objetos quedan cifrados por la misma CMK del bucket**, lo cual es la razón directa por la que el rol de plan necesita permisos criptográficos, no solo de S3, para poder operar el objeto de lock (sección 9.1/12).

## 9. Cifrado

*Corrección obligatoria de esta ronda (corrección 1): se detalla el modelo de permisos criptográficos por rol, distinguiendo uso de administración.*

Se mantiene la decisión de la ronda anterior: **SSE-KMS con una clave administrada por el cliente (CMK), dedicada exclusivamente al backend de Terraform**. SSE-S3 y SSE-KMS con clave administrada por AWS (`aws/s3`) permanecen como alternativas evaluadas, no seleccionadas.

### 9.1 Modelo de permisos criptográficos por rol (corrección 1)

**El objeto de lock nativo (`<state-key>.tflock`) queda cifrado con la misma CMK que el objeto `terraform.tfstate`** — por lo tanto, cualquier rol que necesite crear, leer o eliminar ese objeto de lock necesita, además de los permisos de S3 correspondientes, los permisos criptográficos de uso de la CMK que esa operación requiera. Se distingue explícitamente **uso criptográfico** de **administración de clave**:

**Uso criptográfico (operacional, necesario para leer/escribir objetos cifrados)**:
- `kms:Decrypt` — para leer (descifrar) el objeto `terraform.tfstate`.
- `kms:GenerateDataKey` — necesario para escribir el objeto de lock (`<state-key>.tflock`), dado que su creación como objeto cifrado con SSE-KMS requiere generar una clave de datos.
- `kms:Encrypt` — cuando el mecanismo técnico exacto de escritura del objeto de lock lo requiera (dependiente del comportamiento específico de la implementación del backend `s3`, a verificar en el diseño técnico posterior — no se asume un único patrón de llamada fijo en este documento).
- `kms:DescribeKey` — habitualmente requerido por los SDK antes de usar la clave.

**Administración de clave (nunca otorgada a roles de ejecución de Terraform, ni de plan ni de apply)**:
- `kms:PutKeyPolicy`
- `kms:DisableKey`
- `kms:ScheduleKeyDeletion`
- `kms:EnableKeyRotation`
- Administración de *grants* no controlada (creación/revocación de *grants* fuera del control explícito de la identidad administrativa)

**Rol de plan**: recibe **exclusivamente** los permisos de uso criptográfico listados arriba (`Decrypt`, `GenerateDataKey`, `Encrypt` cuando el mecanismo lo requiera, `DescribeKey`) — **nunca** ninguno de los permisos de administración de clave. Esto es coherente con que el rol de plan solo lee `terraform.tfstate` y solo crea/elimina el objeto de lock — nunca escribe ni elimina `terraform.tfstate` en sí (sección 12/15).

**Rol de apply**: recibe los mismos permisos de uso criptográfico que el rol de plan, sobre la CMK de su propio ambiente — necesarios tanto para leer el estado como para escribirlo tras un `apply` exitoso — **pero tampoco recibe ningún permiso de administración de la clave**. La administración de la CMK (rotación manual si se requiere fuera de la automática, cambios de política, eliminación) permanece exclusiva de la identidad administrativa humana (sección 15).

**Restricciones obligatorias de alcance sobre el uso de la CMK, para cualquier rol**:
- **A la clave específica**: el permiso se otorga sobre el ARN exacto de la CMK del ambiente correspondiente, nunca mediante un comodín que abarque cualquier clave de la cuenta.
- **Vía S3**: se restringe el uso de la clave a invocaciones realizadas a través de S3 (`kms:ViaService`), impidiendo que la misma credencial invoque la clave directamente contra el servicio KMS fuera del contexto de una operación de S3 sobre el bucket de estado.
- **Para el bucket/prefijo autorizado**: el uso combinado de IAM (qué puede hacer el rol) y la configuración de cifrado por defecto del bucket (qué clave protege qué objetos) limita, en conjunto, el uso efectivo de la clave a las operaciones sobre el bucket/prefijo que ese rol tiene autorizado tocar.
- **Al ambiente correspondiente**: el rol de staging solo puede usar la CMK de staging; el rol de producción solo puede usar la CMK de producción (sección 10.2) — nunca cruzadas.

### 9.2 Precisión que se mantiene, sin excepción

Ninguna de las tres alternativas de cifrado impide que un principal ya autorizado a leer el objeto de estado vea su contenido en claro. `sensitive` sigue sin eliminar ningún valor del contenido del estado (sección 18). El control de acceso IAM (combinado con la política de la propia clave, sección 26.A) sigue siendo el control fundamental, no el cifrado en sí.

## 10. Separación por ambiente

Sin cambios de fondo respecto de la ronda anterior en la estructura de fases — reforzada por la corrección 3 en la sección 14 (bootstrap productivo completamente independiente).

### 10.1 Fase inicial — staging (vigente ahora)

Un bucket dedicado a staging y a los componentes compartidos/bootstrap; states independientes por dominio; una única cuenta AWS puede mantenerse temporalmente mientras no exista producción real.

### 10.2 Gate obligatorio antes de producción — bloqueante

Antes del primer `apply` productivo: bucket de estado de producción independiente; CMK de producción independiente (con su propio modelo de permisos criptográficos por rol, sección 9.1, replicado pero nunca compartido con staging); roles OIDC de producción independientes; políticas independientes; ninguna identidad de staging accede al bucket ni al state de producción; **el bootstrap de producción se ejecuta como proceso administrativo completamente separado** (sección 14) — nunca como una extensión del bootstrap de staging; evaluación formal, antes del primer `apply` productivo, de si además se requiere una cuenta AWS de producción separada.

### 10.3 Aclaración obligatoria

Los prefijos de clave de estado reducen el blast radius lógico dentro de un mismo bucket y una misma cuenta — no equivalen a una frontera de seguridad de bucket ni de cuenta. Producción no puede inaugurarse heredando silenciosamente el bucket, la clave, los roles, **ni el bootstrap** de staging.

## 11. División de estados y claves

*Convención conceptual — nombres no definitivos. Actualizada con la independencia total de los bootstraps (corrección 3).*

```
[Bucket de staging/compartido — vigente ahora, creado por el bootstrap de staging]
  bootstrap/terraform.tfstate         (administra el backend de STAGING exclusivamente)
  shared/identidad/terraform.tfstate
  shared/red/terraform.tfstate
  staging/ganaderia/terraform.tfstate
  staging/catastrox/terraform.tfstate      (condicionado a ADR-006)
  staging/observabilidad/terraform.tfstate

[Bucket de producción — creado únicamente por un bootstrap PRODUCTIVO SEPARADO,
 al superar el gate de la sección 10.2]
  bootstrap-produccion/terraform.tfstate   (administra el backend de PRODUCCIÓN
                                             exclusivamente — nunca el mismo
                                             archivo ni la misma ejecución que
                                             bootstrap/terraform.tfstate de staging)
  production/ganaderia/terraform.tfstate
  production/catastrox/terraform.tfstate   (condicionado a ADR-006)
  production/observabilidad/terraform.tfstate
```

**Regla explícita de esta ronda**: `bootstrap/terraform.tfstate` (el del bucket de staging) **nunca administra ordinariamente** el bucket ni la CMK de producción — son dos configuraciones y dos ejecuciones de bootstrap completamente distintas (sección 14), cada una con su propio state de bootstrap, nunca uno solo parametrizado por ambiente.

### 11.1 Disciplina de integración entre stacks

Sin cambios respecto de la ronda anterior: minimización de `terraform_remote_state`; preferencia por Parameter Store/Secrets Manager/tags/data sources cuando sea viable; ningún *output* sensible compartido mediante un mecanismo público o ampliamente legible.

## 12. Mecanismo de locking

*Reforzado por la corrección 1: el objeto de lock nativo también requiere permisos criptográficos, no solo de S3.*

Se mantiene la decisión de la ronda anterior: **locking nativo del backend S3 (`use_lockfile`)**, seleccionado sobre DynamoDB — declarado obsoleto en la documentación vigente de Terraform frente a este mecanismo, sin que AgroGenomaX tenga ningún backend heredado que justifique crearlo. Gate obligatorio antes del bootstrap: fijar y verificar, local y en CI, una versión mínima de Terraform compatible con `use_lockfile`. DynamoDB queda únicamente como contingencia temporal, justificada, acotada en el tiempo y revisada documentalmente. El pipeline serializado se mantiene como defensa adicional, nunca sustituto del lock.

**Precisión de esta ronda**: el objeto de lock nativo (`<state-key>.tflock`) es, en sí mismo, un objeto S3 sujeto al cifrado por defecto del bucket (CMK, sección 9) — su creación y eliminación por parte del rol de plan requiere, además del permiso de S3 correspondiente, los permisos criptográficos de uso de la CMK detallados en la sección 9.1, nunca permisos de administración de la clave.

## 13. Recuperación de bloqueos huérfanos

Sin cambios respecto de la ronda anterior: detección, confirmación de que no existe otro `apply` activo, evidencia mínima, identificación exacta del lock, registro del incidente, respaldo previo, uso restringido a la identidad administrativa, distinción entre liberación normal y `force-unlock` excepcional, procedimiento posterior de `plan` de verificación.

## 14. Bootstrap inicial

**No se autoriza la ejecución de nada de lo descrito en esta sección como parte de este ADR.**

### 14.1 Bootstrap de staging

Decisión definitiva: stack Terraform mínimo con estado local temporal, ejecutado por la identidad administrativa humana. Crea el bucket de staging/compartido, la CMK de staging (con su política y modelo de permisos, sección 9.1), la configuración de locking nativo, y el IAM mínimo de staging (sección 15). Migra su propio state al backend de staging que acaba de crear, verifica la migración, y trata el state local temporal conforme a las reglas de la sección 14.3 (corrección complementaria B) — nunca conforme a una promesa de "eliminación segura absoluta".

### 14.2 Bootstrap de producción — proceso administrativo completamente independiente (corrección 3)

- **State local temporal propio, independiente del de staging** — nunca el mismo archivo, nunca una continuación del bootstrap de staging.
- **Credenciales y aprobación independientes** de las usadas para el bootstrap de staging — la identidad administrativa que lo ejecuta, y la aprobación que lo autoriza, se registran de forma separada (pueden coincidir en la persona física, pero no en la sesión de credenciales ni en el registro de aprobación).
- **Crea, de forma independiente**: el bucket de estado de producción, la CMK de producción (con su propio modelo de permisos, réplica del patrón de la sección 9.1 pero nunca la misma clave), las políticas correspondientes, y los roles OIDC productivos (sección 10.2/16).
- **Migra su state a su propio backend productivo**, verificado de forma independiente del backend de staging.
- **No depende, en ningún punto de su ejecución, del state de bootstrap de staging** — es una configuración Terraform distinta, ejecutada de forma distinta, con su propio ciclo de vida.
- **Ninguna identidad de staging puede leer ni modificar el bootstrap productivo**, ni durante su ejecución ni después.
- **Si se decide una cuenta AWS de producción separada** (evaluación pendiente, sección 10.2), el bootstrap de producción se ejecuta directamente en esa cuenta, no en la cuenta de staging con una simple separación lógica.

**Prohibiciones explícitas**: `bootstrap/terraform.tfstate` del bucket de staging **nunca administra ordinariamente** el bucket ni la CMK de producción; **ningún rol de staging tiene permisos sobre ningún recurso del backend productivo**, bajo ninguna circunstancia.

### 14.3 Tratamiento del state local temporal (corrección complementaria B)

- **No se promete un borrado físico absoluto** del archivo de state local temporal — eliminar un archivo de un sistema de archivos no garantiza, por sí solo, que sea forense e irrecuperablemente inaccesible; este documento no afirma esa garantía.
- **Mientras exista, el state temporal se mantiene cifrado (en reposo, en el medio donde resida) y con acceso restringido** exclusivamente a la identidad administrativa que ejecuta el bootstrap correspondiente.
- **Nunca se versiona** en git ni en ningún otro sistema de control de versiones.
- **Se migra al backend remoto correspondiente y se verifica** esa migración antes de continuar.
- **Se eliminan las copias accesibles** del archivo local una vez verificada la migración — como medida de higiene operativa, no como garantía forense.
- **Se verifica explícitamente que el archivo no quedó retenido** en herramientas de sincronización en la nube del equipo local (por ejemplo, una carpeta sincronizada automáticamente), en sistemas de backup del equipo, ni en logs que pudieran haber capturado su contenido.
- **Si existe cualquier duda razonable** sobre si el contenido del state temporal (que puede incluir valores sensibles, sección 18) fue accedido por una vía no controlada, **se rota cualquier secreto que ese state temporal hubiera contenido**, en vez de asumir que la eliminación del archivo fue suficiente.

## 15. Identidades y permisos IAM

*Corregida por la corrección 1 (permisos criptográficos del rol de plan) y por la independencia total de producción (corrección 3).*

| Actor | Rol | Permisos S3/lock | Permisos KMS |
|---|---|---|---|
| **Administrador humano (staging)** | Bootstrap de staging; `force-unlock`; administración de la CMK de staging | Acceso administrativo acotado al backend de staging | Único autorizado para administración de la CMK de staging (incluida `kms:ScheduleKeyDeletion`) |
| **Administrador humano (producción)** | Bootstrap de producción, independiente (sección 14.2); `force-unlock` de producción; administración de la CMK de producción | Acceso administrativo acotado al backend de producción, sin superposición con el de staging | Único autorizado para administración de la CMK de producción |
| **Operador de staging** | `plan`/`apply` sobre `staging/*`, tras revisión | Lectura/escritura de `staging/*`; sin acceso a `production/*` | Uso criptográfico (sección 9.1) sobre la CMK de staging únicamente |
| **Rol de plan (CI, por ambiente)** | Calcula `plan`, nunca aplica; solo se asume tras la barrera de confianza (sección 16/17) | **Lee `terraform.tfstate`; crea/elimina únicamente el objeto de lock (`<state-key>.tflock`); nunca `PutObject`/`DeleteObject` sobre `terraform.tfstate`** | **Exclusivamente uso criptográfico** (`Decrypt`, `GenerateDataKey`, `Encrypt` cuando el mecanismo lo requiera, `DescribeKey`) sobre la CMK de su ambiente — **nunca `PutKeyPolicy`/`DisableKey`/`ScheduleKeyDeletion`/`EnableKeyRotation`/administración de grants** |
| **Rol de apply (staging)** | Ejecuta `apply` sobre `staging/*`, tras aprobación | Lectura/escritura de `terraform.tfstate` de `staging/*`; operación completa del objeto de lock | Uso criptográfico sobre la CMK de staging — **sin administración de la clave** |
| **Rol de apply (producción)** | Ejecuta `apply` sobre `production/*`, tras aprobación separada | Lectura/escritura de `terraform.tfstate` de `production/*` exclusivamente; operación del objeto de lock de producción | Uso criptográfico sobre la CMK de producción exclusivamente — **sin administración de la clave**; identidad y credenciales completamente distintas de las de staging |

**Reglas reforzadas en esta ronda**: prohibido `AdministratorAccess` permanente para CI; prohibidas Access Keys de larga duración; prohibido compartir identidad entre humanos y automatizaciones; prohibido que el rol de plan tenga cualquier capacidad de escritura sobre `terraform.tfstate`, incluso indirectamente vía permisos KMS que excedan el uso operacional mínimo; prohibido que cualquier rol de ejecución (plan o apply, de cualquier ambiente) reciba permisos de administración de la CMK; ninguna identidad de staging accede jamás al bucket, la clave, los roles ni el bootstrap de producción (sección 14.2).

## 16. GitHub Actions y OIDC

*Corrección obligatoria de esta ronda (corrección 2): reemplaza el modelo de "plan automático en todo pull request" por un flujo en dos etapas.*

### 16.1 Etapa 1 — Validación estática, sin AWS, sobre cualquier pull request

Se ejecuta automáticamente sobre **cualquier** pull request, incluidos los originados en forks, precisamente porque no requiere ninguna credencial de nube:

- `terraform fmt -check`.
- `terraform validate`, únicamente en la medida en que pueda ejecutarse sin necesitar credenciales reales (validación de sintaxis y consistencia interna del código, no una validación que dependa de inicializar el backend remoto real).
- *Lint* (herramienta exacta no decidida en este documento).
- Escaneo de seguridad estático sobre el código IaC.
- Revisión de `.terraform.lock.hcl` (presencia, consistencia).
- Comprobaciones estáticas generales adicionales que el diseño técnico posterior determine.

**Reglas, sin excepción, para esta etapa**: **sin OIDC** asumido en ningún momento; **sin credenciales de AWS** de ningún tipo; **sin acceso al backend remoto**; **sin lectura del state**; **sin secretos** expuestos al workflow; **sin `apply`**.

### 16.2 Etapa 2 — Plan real privilegiado, solo tras una barrera de confianza

**Nunca se dispara automáticamente por la sola apertura o actualización de un pull request.** Se ejecuta únicamente después de una barrera humana o un evento explícitamente confiable (por ejemplo, la aprobación de un revisor autorizado, o un disparo manual por parte de una identidad con permiso para ello) — el mecanismo exacto de esa barrera es una decisión de diseño técnico posterior (sección 29), pero su existencia como condición previa es obligatoria, no opcional.

En esta etapa: se usa **el commit SHA exacto ya revisado** (fijado, no "el último de la rama", que podría haber cambiado entre la revisión y la ejecución); se asume el **rol OIDC de plan** (sección 15) — nunca antes de este punto; se accede al **state real**; se genera el **plan real**; se produce el **artefacto sensible** correspondiente (sección 17.1); y se **vincula ese artefacto a la aprobación y al commit** que lo originaron.

### 16.3 Forks

**Los forks nunca reciben OIDC, nunca reciben acceso al state, y nunca reciben secretos**, bajo ninguna circunstancia. **Nunca se ejecuta código proveniente de un fork mediante `pull_request_target` con privilegios** — este patrón (ejecutar, con los secretos y permisos del repositorio base, código que proviene de un fork no confiable) es un vector de inyección conocido y queda explícitamente prohibido en el diseño de cualquier workflow de este proyecto.

### 16.4 Ramas del mismo repositorio

**No estar en un fork no es, por sí solo, suficiente para obtener acceso privilegiado al state.** Una rama del propio repositorio tampoco recibe automáticamente la Etapa 2 antes de superar la misma barrera de confianza exigida a cualquier otro pull request — la distinción relevante no es "fork vs. no fork", sino "ha superado la barrera de confianza definida vs. no la ha superado".

### 16.5 Diseño de OIDC (sin cambios de fondo respecto de la ronda anterior)

Proveedor OIDC confiando en `token.actions.githubusercontent.com`; *trust policy* restringida por repositorio, rama y *Environment*; roles separados plan/apply por ambiente; *Environments* protegidos con revisores requeridos para el rol de apply de cualquier ambiente, y especialmente para producción (independiente de staging, sección 10.2); *audience* `sts.amazonaws.com`; duración de sesión mínima viable.

## 17. Flujo de plan y apply

### Desarrollo local

`fmt` → `validate` → *lint* → `plan` — sujeto al gate de versión de Terraform de la sección 12; sin `apply` productivo.

### Pull request

**Etapa 1** (sección 16.1) se ejecuta automáticamente sobre cualquier PR, sin AWS. **Etapa 2** (sección 16.2) se ejecuta únicamente tras la barrera de confianza, con el commit exacto ya revisado — nunca antes.

### Staging

`apply` manual, tras aprobación, ejecutado bajo el rol de apply de staging, aplicando exactamente el artefacto de la Etapa 2, verificado conforme a la sección 17.1.

### Producción

`apply` manual, con aprobación explícita y separada, ejecutado bajo el rol de apply de producción (identidad completamente distinta, backend completamente independiente desde su propio bootstrap, sección 14.2), aplicando exactamente el artefacto verificado.

### 17.1 Integridad y vigencia del artefacto de plan

Sin cambios de fondo respecto de la ronda anterior en la lista de vínculos obligatorios (commit SHA, stack, ambiente, clave de estado, versión de Terraform, contenido de `.terraform.lock.hcl`, hashes de módulos/providers, identificador de ejecución de workflow, registro de aprobación, fecha de creación) y en las ocho verificaciones previas a cualquier `apply`.

**Invalidación del plan (corrección complementaria C)**: **cualquier cambio de código, del archivo de lock, del backend, del state, de un módulo, de un provider, del ambiente objetivo, del rol asumido, o el vencimiento de su ventana de vigencia, invalida el plan.** **Un plan inválido nunca se actualiza ni se reutiliza** — ante cualquiera de estas condiciones, se genera un plan completamente nuevo, que vuelve a pasar por la Etapa 1 y la Etapa 2 de revisión (sección 16), nunca se "repara" o se aplica parcialmente un plan que dejó de ser válido.

El binario del plan se mantiene como artefacto sensible: no se publica ampliamente, retención limitada, nunca impreso íntegramente en logs, eliminado conforme a la política definida (sección 29).

## 18. Tratamiento de secretos en el state

Sin cambios de fondo respecto de la ronda anterior — reforzado por la sección 14.3: el state temporal de bootstrap recibe el mismo tratamiento de sensibilidad que cualquier otro state, con la precisión de que su eliminación local es una medida de higiene operativa, no una garantía forense.

## 19. Protección contra eliminación y corrupción

Sin cambios respecto de la ronda anterior — aplicable de forma independiente y separada tanto al bucket de staging como al de producción, nunca a un backend compartido.

## 20. Drift y reconciliación

Sin cambios respecto de la ronda anterior.

## 21. Observabilidad y auditoría

Sin cambios respecto de la ronda anterior — CloudTrail de eventos de datos de S3 como fuente principal; Server Access Logging como complemento opcional en bucket separado.

## 22. Costos

Sin cambios de fondo respecto de la ronda anterior — se añade que el **bootstrap de producción, al ser un proceso completamente independiente (sección 14.2), implica un segundo conjunto de costos de bucket/CMK/CloudTrail** a estimar de forma separada del de staging, no como una simple extensión marginal del presupuesto ya estimado para staging.

## 23. Consecuencias positivas

- El modelo de permisos criptográficos por rol (corrección 1) cierra la posibilidad de que el rol de plan, aun sin permisos de S3 de escritura, pudiera de alguna forma influir en el estado mediante un permiso KMS mal acotado.
- El flujo en dos etapas (corrección 2) elimina el riesgo de que cualquier pull request, incluido uno malicioso o de un fork, obtenga automáticamente credenciales reales de AWS.
- La independencia total del bootstrap de producción (corrección 3) hace estructuralmente imposible que un descuido en el backend de staging comprometa el de producción.

## 24. Consecuencias negativas

- El modelo de permisos KMS granular por rol añade complejidad de configuración de política de clave.
- El flujo en dos etapas introduce latencia adicional en el ciclo de revisión (un `plan` real ya no está disponible de inmediato al abrir un PR, solo tras la barrera de confianza).
- Ejecutar dos bootstraps completamente independientes (staging y, más adelante, producción) duplica el esfuerzo operativo del proceso de bootstrap respecto de un modelo que hubiera reutilizado la misma configuración parametrizada.

## 25. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| Rol de plan con permisos KMS que excedan el uso operacional mínimo | Corrección 1 | Distinción explícita uso criptográfico vs. administración; nunca `PutKeyPolicy`/`DisableKey`/`ScheduleKeyDeletion`/`EnableKeyRotation` para roles de ejecución (sección 9.1/15) |
| Uso de la CMK fuera del contexto de S3 o desde un bucket no autorizado | Corrección complementaria A | `kms:ViaService`, restricciones de recurso/contexto de cifrado (sección 26.A) |
| Pull request (incluido de un fork) obteniendo automáticamente OIDC y acceso al state | Corrección 2 | Flujo en dos etapas; Etapa 1 sin AWS; Etapa 2 solo tras barrera de confianza (sección 16) |
| Ejecución de código de un fork con privilegios vía `pull_request_target` | Corrección 2 | Prohibido explícitamente (sección 16.3) |
| Bootstrap de producción dependiendo, aunque sea parcialmente, del state o las credenciales de staging | Corrección 3 | Independencia total exigida (sección 14.2) |
| Identidad de staging con acceso residual al backend de producción | Corrección 3 | Prohibición explícita (sección 14.2/15) |
| Plan reutilizado o "actualizado" tras un cambio relevante en vez de regenerado | Corrección complementaria C | Invalidación explícita ante cualquier cambio de código/lock/backend/state/módulo/provider/ambiente/rol/vencimiento (sección 17.1) |
| Promesa de borrado físico absoluto del state temporal de bootstrap | Corrección complementaria B | Aclarado explícitamente que no se garantiza; medidas de higiene operativa en su lugar (sección 14.3) |

## 26. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR. La corrección de `.gitignore` sigue pendiente y no se ejecuta en esta tarea.)*

- Diseñar la política exacta de `.gitignore` para Terraform (definida conceptualmente en la ronda anterior de este ADR) — su aplicación queda como acción separada, no ejecutada aquí.
- Diseñar la política de la CMK combinando *key policy* e IAM (corrección complementaria A): usar `kms:ViaService` para limitar el uso vía S3; usar contexto de cifrado o restricciones de recurso cuando sean técnicamente viables; impedir el uso de la CMK desde buckets o servicios no autorizados.
- Fijar y verificar la versión mínima de Terraform compatible con `use_lockfile`, local y en CI, antes de cualquier bootstrap.
- Diseñar el mecanismo exacto de la barrera de confianza entre la Etapa 1 y la Etapa 2 del flujo de CI.
- Diseñar los workflows de GitHub Actions respetando la separación estricta de las dos etapas y la prohibición de `pull_request_target` privilegiado sobre código de forks.
- Diseñar el proceso de bootstrap de staging (sección 14.1) y, de forma completamente separada y posterior, el de producción (sección 14.2).
- Diseñar el procedimiento operativo de tratamiento del state temporal de bootstrap conforme a la sección 14.3.
- Diseñar el mecanismo exacto de invalidación y regeneración de planes (sección 17.1).

## 27. Criterios de aceptación

- El rol de plan, en cualquier ambiente, no tiene ningún permiso de administración de la CMK (`PutKeyPolicy`/`DisableKey`/`ScheduleKeyDeletion`/`EnableKeyRotation`) ni permiso de escritura/eliminación sobre `terraform.tfstate`, verificable por inspección de política.
- Ningún workflow de CI asume el rol OIDC de plan ni de apply antes de que la barrera de confianza de la Etapa 2 se haya superado — verificable por revisión del diseño del workflow.
- Ningún workflow de este proyecto ejecuta código de un fork mediante `pull_request_target` con acceso a secretos o a OIDC.
- El bootstrap de producción, cuando se ejecute, no depende del state de bootstrap de staging, verificable por inspección de las dos configuraciones.
- Ninguna identidad de staging tiene, en ningún momento, permisos sobre el bucket, la CMK o los roles del backend de producción.
- Ningún plan se aplica tras haber sufrido un cambio de código/lock/backend/state/módulo/provider/ambiente/rol, o tras vencer su ventana de vigencia, sin haber sido regenerado y revuelto a pasar por ambas etapas de revisión.
- Ninguna afirmación de este ADR ni de su implementación posterior promete la eliminación física forense del state temporal de bootstrap.

## 28. Elementos fuera de alcance

Sin cambios de fondo respecto de la ronda anterior — creación de cualquier recurso de AWS; ejecución de `terraform init`/`plan`/`apply`/`force-unlock`; creación de workflows de GitHub Actions; redacción de código Terraform; modificación de `.gitignore`; decisión final sobre cuenta AWS de producción separada; resolución de CatastroX (ADR-006); modificación de cualquier ADR anterior o del TAH.

## 29. Decisiones de seguimiento

1. Versión exacta de Terraform a fijar, compatible con `use_lockfile`.
2. Mecanismo exacto de la barrera de confianza entre la Etapa 1 y la Etapa 2 del flujo de CI.
3. Diseño técnico exacto de la política de la CMK (staging y, por separado, producción) y de las políticas IAM por actor.
4. Diseño e implementación de los workflows de GitHub Actions en dos etapas.
5. Decisión formal sobre cuenta AWS de producción separada.
6. Diseño detallado del bootstrap de producción, completamente independiente del de staging.
7. Política de retención del artefacto de plan.
8. Estimación de costo de la CMK dedicada (staging y producción por separado) y de CloudTrail de eventos de datos.
9. Aplicación efectiva de la política de `.gitignore` para Terraform.
10. Procedimiento detallado de rollback/recuperación de producción.

## 30. Relación con ADR anteriores

Sin cambios de fondo respecto de la ronda anterior.

---

## Anexo A. Diagrama de backend Terraform

```
┌───────────────────────────────────────────────────────────────────┐
│ STAGING — bootstrap propio, credenciales propias                    │
│                                                                     │
│  Bucket S3 staging/compartido (SSE-KMS, CMK de staging, versionado) │
│  Locking nativo de S3 (.tflock, cifrado con la CMK de staging)      │
│  CMK de staging — rotación automática, política mínima              │
│    - Rol de plan (staging): Decrypt/GenerateDataKey/Encrypt/        │
│      DescribeKey únicamente; SIN administración de la clave         │
│    - Rol de apply (staging): mismo uso criptográfico + escritura    │
│      de state; SIN administración de la clave                       │
│  Roles OIDC de staging (plan/apply) — solo asumibles tras la        │
│  Etapa 2 del flujo de CI (barrera de confianza, sección 16)          │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│ PRODUCCIÓN — [GATE, sección 10.2] bootstrap COMPLETAMENTE           │
│ INDEPENDIENTE (sección 14.2): state temporal propio, credenciales   │
│ y aprobación propias, sin dependencia del bootstrap de staging       │
│                                                                     │
│  Bucket S3 de producción (independiente) + CMK de producción         │
│  (independiente) + roles OIDC de producción (independientes)         │
│  Ninguna identidad de staging tiene acceso a este contexto           │
└───────────────────────────────────────────────────────────────────┘
                              ▲
                              │ OIDC — solo tras Etapa 2 (nunca en Etapa 1,
                              │ nunca desde forks, nunca vía
                              │ pull_request_target privilegiado)
┌───────────────────────────────────────────────────────────────────┐
│ GitHub Actions (repositorio confirmado)                             │
│  Etapa 1 (cualquier PR, incluidos forks): fmt/validate/lint/scan —  │
│  SIN AWS, SIN OIDC, SIN state                                       │
│  Etapa 2 (solo tras barrera de confianza): plan real, commit fijado,│
│  artefacto sensible vinculado a aprobación                          │
└───────────────────────────────────────────────────────────────────┘
```

## Anexo B. Convención conceptual de states y claves

| Prefijo conceptual | Contenido | Bucket | Bootstrap que lo crea |
|---|---|---|---|
| `bootstrap/` | Bucket de staging, CMK de staging, IAM mínimo de staging | Staging/compartido | Bootstrap de staging (14.1) |
| `shared/identidad/` | Roles transversales de staging | Staging/compartido | Bootstrap de staging |
| `staging/ganaderia/` | ECS Express Mode + RDS de Ganadería, staging | Staging/compartido | — |
| `staging/catastrox/` | Condicionado a ADR-006 | Staging/compartido | — |
| `bootstrap-produccion/` | Bucket de producción, CMK de producción, IAM mínimo de producción | **Bucket de producción, independiente** | **Bootstrap de producción, completamente separado (14.2)** |
| `production/ganaderia/` | Futuro | Bucket de producción | — |
| `production/catastrox/` | Futuro, condicionado a ADR-006 | Bucket de producción | — |

## Anexo C. Matriz de actores y permisos

| Actor | Leer `terraform.tfstate` | Escribir `terraform.tfstate` | Crear/eliminar `.tflock` | KMS: uso criptográfico | KMS: administración | `force-unlock` |
|---|---|---|---|---|---|---|
| Administrador humano (staging) | Todas las claves de staging | Todas | Sí | Sí, CMK de staging | **Sí, único autorizado (staging)** | Sí, único autorizado (staging) |
| Administrador humano (producción) | Todas las claves de producción | Todas | Sí | Sí, CMK de producción | **Sí, único autorizado (producción)** | Sí, único autorizado (producción) |
| Operador de staging | `staging/*` | `staging/*` | Sí, sobre `staging/*` | Sí, CMK de staging | No | No |
| **Rol de plan (staging)** | `staging/*`, solo lectura | **No** | **Sí, exclusivamente el objeto `.tflock`** | **Sí, exclusivamente uso criptográfico** (`Decrypt`/`GenerateDataKey`/`Encrypt` si aplica/`DescribeKey`) | **No** | No |
| **Rol de plan (producción)** | `production/*`, solo lectura | **No** | **Sí, exclusivamente el objeto `.tflock`** | **Sí, exclusivamente uso criptográfico, CMK de producción** | **No** | No |
| Rol de apply (staging) | `staging/*` | `staging/*` | Sí | Sí, CMK de staging | No | No |
| Rol de apply (producción) | `production/*` únicamente | `production/*` únicamente | Sí, sobre `production/*` | Sí, CMK de producción únicamente | No | No |

## Anexo D. Flujo plan/apply por ambiente

```
Cualquier pull request (incluidos forks):
    ETAPA 1 — automática, sin AWS
    fmt -check → validate (sin backend real) → lint → escaneo de
    seguridad → revisión de .terraform.lock.hcl
    [sin OIDC, sin credenciales, sin acceso al backend, sin state,
     sin secretos, sin apply]
        │
        ▼ (barrera de confianza — aprobación humana o evento confiable)
    ETAPA 2 — plan real privilegiado
    commit SHA exacto ya revisado → asume rol OIDC de plan (staging o
    producción, nunca ambos) → lee el state real → genera el plan
    real → produce artefacto sensible vinculado a commit/aprobación
        │
        ▼ (aprobación de PR)
Staging:  apply manual (rol de apply staging) → aplica EXACTAMENTE el
          artefacto de la Etapa 2 → validación posterior
        │
        ▼ (aprobación separada; gate de producción superado —
        │  bootstrap de producción ya completado de forma
        │  independiente, sección 14.2)
Producción: apply manual (rol de apply producción, backend
            completamente independiente) → nunca automático
```

## Anexo E. Runbook conceptual de bloqueo huérfano

Sin cambios respecto de la ronda anterior, con la precisión de que el lock nativo referenciado en el paso 1 es el objeto `.tflock` cifrado con la CMK del ambiente correspondiente (sección 9.1/12), y que solo la identidad administrativa de ese mismo ambiente (staging o producción, nunca la del otro) puede ejecutar el `force-unlock`.

## Anexo F. Matriz de amenazas del state

*Actualizada con las amenazas de esta ronda.*

| Amenaza | Mitigación |
|---|---|
| Rol de plan con permisos KMS que exceden el uso operacional mínimo | Distinción explícita uso criptográfico vs. administración (sección 9.1) |
| Uso de la CMK desde un servicio o bucket no autorizado | `kms:ViaService`, restricciones de recurso/contexto (sección 26.A) |
| Pull request no confiable obteniendo OIDC y acceso al state automáticamente | Flujo en dos etapas (sección 16) |
| Código de fork ejecutado con privilegios vía `pull_request_target` | Prohibido explícitamente (sección 16.3) |
| Bootstrap de producción dependiente del de staging | Independencia total exigida (sección 14.2) |
| Plan reutilizado tras un cambio relevante | Invalidación explícita, sin excepción (sección 17.1) |
| Promesa de eliminación forense del state temporal | Aclarado que no se garantiza; higiene operativa en su lugar (sección 14.3) |

## Anexo G. Matriz de trazabilidad ADR-001/003/006/008/009 → ADR-010

Sin cambios respecto de la ronda anterior.

---

## Cierre

### 1. Recomendación ejecutiva

Backend Amazon S3 con locking nativo (`use_lockfile`), cifrado mediante CMK dedicada. **El rol de plan recibe exclusivamente permisos de lectura de `terraform.tfstate` y de creación/eliminación del objeto de lock, con permisos KMS acotados al uso criptográfico operacional — nunca a la administración de la clave.** **Ningún pull request obtiene automáticamente OIDC ni acceso al state**: un flujo en dos etapas separa las comprobaciones estáticas sin AWS (ejecutables sobre cualquier PR, incluidos forks) del `plan` real privilegiado (solo tras una barrera de confianza, usando el commit exacto revisado); los forks nunca reciben OIDC, state ni secretos, y `pull_request_target` privilegiado sobre código de fork queda prohibido. **El bootstrap de producción es un proceso administrativo completamente independiente del de staging**, con su propio state temporal, sus propias credenciales y su propia aprobación, sin que ninguna identidad de staging tenga acceso al backend productivo. Cualquier cambio relevante invalida el plan, que nunca se reutiliza.

### 2. Riesgos críticos

1. Un permiso KMS mal acotado en el rol de plan (por ejemplo, otorgado de forma amplia en vez de restringido a uso criptográfico) anularía la separación de privilegios que esta corrección exige.
2. Un workflow mal diseñado que dispare la Etapa 2 automáticamente en cualquier PR, o que use `pull_request_target` con código de fork, reintroduciría exactamente el riesgo que esta corrección busca cerrar.
3. Compartir, aunque sea parcialmente, el bootstrap o las credenciales entre staging y producción anularía la independencia exigida por la corrección 3.

### 3. Decisiones pendientes

Ver sección 29 (10 ítems).

### 4. Información NO VERIFICADA

Sin cambios respecto de la ronda anterior.

### 5. Archivos consultados

Los mismos de la ronda anterior — sin nueva verificación de código en esta corrección: `docs/adr/ADR-001-arquitectura-aws-inicial.md`, `docs/adr/ADR-003-estrategia-infraestructura-como-codigo.md`, `docs/adr/ADR-006-migracion-datos-geoespaciales.md`, `docs/adr/ADR-008-modelo-multicliente-organizaciones-membresias-aislamiento-datos.md`, `docs/adr/ADR-009-patron-sesion-spa-pkce-vs-bff.md`, `docs/architecture/AGROGENOMAX_TECHNICAL_ARCHITECTURE_HANDBOOK_V1.md`, `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`, `.gitignore`, `.env.example`, `server/.env.example`.

### 6. Contradicciones detectadas

Ninguna nueva respecto de la ronda anterior.

### 7. Confirmación

No se creó ni modificó ningún archivo del repositorio como parte de esta tarea salvo el archivo final indicado. No se modificó `.gitignore`. No se ejecutó ningún comando de escritura, instalación, prueba, migración, ni conexión a AWS. No se creó ningún bucket S3, clave KMS, rol IAM, proveedor OIDC, tabla DynamoDB, workflow de GitHub Actions, ni código Terraform. No se ejecutó `terraform init`, `plan`, `apply` ni `force-unlock`.
