# ADR-003: Terraform como infraestructura como código; GitHub Actions como base futura de CI/CD, con OIDC y sin apply automático en producción

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-003 conserva vigencia como decisión marco: Terraform es la herramienta oficial de infraestructura como código y GitHub Actions es la base aprobada de CI/CD. ADR-010 es la especificación vinculante posterior para state, locking, KMS, CI y GitHub:

- ADR-010 cierra las decisiones pendientes de state, locking, KMS, CI y GitHub.
- El repositorio queda confirmado en GitHub.
- OIDC es obligatorio para GitHub Actions hacia AWS.
- `apply` de producción no es automático.
- El backend remoto de Terraform usa S3 con locking nativo `use_lockfile`.
- El state usa CMK dedicada.
- CI opera en dos etapas: validación estática sin AWS en pull request y plan/apply privilegiado solo tras gate humano.
- Los bootstraps de staging y producción son independientes.

## Contexto

La auditoría técnica confirmó que **no existe ningún pipeline de CI/CD versionado** (`.github/workflows/` no existe) ni ninguna herramienta de infraestructura como código en el repositorio (sin Terraform, CloudFormation, CDK ni Pulumi). El despliegue actual se gestiona manualmente desde los paneles de Cloudflare Pages y Railway. El plan AWS ya aprobado (`docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`) impone reglas estrictas de control de costos: todo recurso facturable por hora debe tener responsable, propósito, fecha de creación y fecha máxima de eliminación registrados de antemano, con presupuesto tope de USD 25/mes en staging.

**Nota histórica de alcance**: al aprobar ADR-003, la auditoría técnica no había verificado de forma independiente en qué plataforma de control de versiones/alojamiento vivía el repositorio. ADR-010 confirmó GitHub y cerró esa incertidumbre.

## Problema

La creación manual de recursos en AWS, sin control de versiones ni revisión, es incompatible con la disciplina de control de costos ya aprobada y con la necesidad de un proceso de migración reproducible y auditable (crear staging, validar, desmontar, repetir), y con la exigencia de que ningún cambio de infraestructura de producción ocurra sin aprobación humana explícita.

## Opciones consideradas

- **Configuración manual vía consola de AWS**: descartada — no deja registro auditable, alto riesgo de recursos olvidados encendidos (el riesgo principal ya identificado en el plan aprobado).
- **AWS CloudFormation / CDK**: no seleccionada — acopla la definición de infraestructura al proveedor de forma más profunda que Terraform, sin ventaja clara dado que la migración es de un único proveedor de destino.
- **Pulumi**: no seleccionada — introduce una dependencia de lenguaje de programación general y un ecosistema menos extendido en el equipo actual que Terraform (HCL declarativo, mayor disponibilidad de documentación/comunidad para AWS).
- **Terraform** (elegida): declarativo, ampliamente documentado para los servicios vigentes o previstos (ECS Express Mode, contingencia ECS + Fargate directo, ECR, RDS, Secrets Manager, IAM, VPC/ALB, Cognito cuando aplique, CloudWatch y S3/KMS para state), y permite revisión de cambios vía `terraform plan` antes de crear cualquier recurso facturable.

## Decisión

**Terraform** será la herramienta de infraestructura como código para todos los recursos de AWS de este proyecto. **GitHub Actions** será la base futura de CI/CD (build, test, y eventualmente `terraform plan`/`apply` gestionado). ADR-010 confirma GitHub y define las reglas vinculantes de backend remoto, locking, KMS, CI y bootstraps.

Reglas obligatorias de gobernanza, sin excepción:

- **Producción nunca tendrá `terraform apply` automático.** Todo cambio de infraestructura en producción requiere ejecución manual o disparada explícitamente, nunca como consecuencia automática de un merge o push.
- **Toda ejecución de `terraform apply`, en cualquier entorno, requiere aprobación humana explícita mediante pull request** revisado y aprobado por al menos una persona distinta de quien propone el cambio.
- **La autenticación de GitHub Actions hacia AWS se realiza mediante federación OIDC.** Queda **prohibido almacenar Access Keys de AWS permanentes como secretos en GitHub** — no debe existir ninguna credencial de larga duración fuera de AWS IAM.
- **El estado remoto de Terraform se almacena en un bucket S3 privado, cifrado en reposo y con versionado habilitado.** ADR-010 precisa que el bloqueo usa `use_lockfile`, CMK dedicada y bootstraps independientes.

## Justificación

- Terraform permite que cada recurso facturable declare explícitamente sus atributos (nombre, tags de responsable/propósito/fecha) como código versionado, aplicando por diseño la regla ya aprobada de "ningún recurso se crea sin esos cuatro datos definidos de antemano".
- El flujo `plan` → revisión vía pull request → `apply` manual introduce una compuerta de aprobación humana antes de que se genere costo o se modifique producción, mitigando directamente el riesgo principal ya identificado ("sobrecosto por recursos olvidados encendidos") y el riesgo de cambios no revisados en producción.
- OIDC elimina la necesidad de credenciales de AWS de larga duración almacenadas en GitHub, reduciendo drásticamente el radio de impacto de una fuga de secretos del repositorio.
- Un backend de estado en S3 privado, cifrado, versionado y con `use_lockfile` permite recuperar versiones anteriores del estado y evita ejecuciones concurrentes inseguras, conforme a ADR-010.

## Consecuencias positivas

- Historial completo y auditable de qué infraestructura existió, cuándo y por qué (vía git log sobre los archivos `.tf` y el historial de pull requests aprobados).
- Reduce a cero la posibilidad de que un cambio de infraestructura en producción ocurra sin revisión humana.
- Elimina el riesgo de credenciales AWS permanentes filtradas desde GitHub.
- Facilita el ciclo "crear ventana de prueba → validar → desmontar" que ya exige el plan aprobado, mediante `terraform apply`/`terraform destroy` reproducibles y revisados.

## Consecuencias negativas

- Curva de aprendizaje y tiempo de preparación antes de crear el primer recurso real (escribir y probar los módulos de Terraform, configurar OIDC, configurar el backend S3).
- El requisito de aprobación humana por pull request en cada `apply` añade fricción/latencia operativa, incluso para cambios menores.
- Introduce una herramienta y un flujo de trabajo nuevos que el equipo debe mantener y versionar junto con el código de aplicación.

## Riesgos

- Riesgo de soporte/proveedor de recursos para ECS Express Mode: si el soporte no es suficiente, ADR-011 permite usar ECS + Fargate directo como contingencia AWS.
- Riesgo de mezclar bootstrap y workload: los bootstraps independientes de ADR-010 deben mantenerse separados de las pilas aplicativas.
- Permisos incorrectos de KMS/S3 pueden bloquear state, exponer metadatos o impedir recuperación.
- Locking mal configurado puede permitir ejecuciones concurrentes de Terraform que corrompan el estado.
- Riesgo de *drift*: si alguien crea o modifica recursos manualmente en la consola de AWS por fuera de Terraform, el estado se desincroniza y las próximas ejecuciones pueden tener efectos no deseados.
- Costos persistentes como ALB, KMS, almacenamiento, Secrets Manager y CloudWatch pueden quedar activos si no se gobierna el desmontaje.
- Destrucción accidental de recursos: requiere revisión humana, separación de ambientes y políticas de protección donde aplique.
- Una configuración incorrecta de la federación OIDC (condiciones de confianza demasiado amplias) podría permitir que workflows no autorizados asuman el rol de AWS — requiere revisión cuidadosa de las condiciones del proveedor OIDC.

## Acciones requeridas

- Diseñar (sin aplicar) el rol/política IAM mínimo necesario para el pipeline de Terraform, incluyendo la configuración del proveedor OIDC de GitHub Actions, como ya contempla la Fase 0A del plan aprobado.
- Crear el bucket S3 de state remoto (privado, cifrado, versionado), CMK dedicada y locking `use_lockfile` según ADR-010.
- Crear el esqueleto de workflows de GitHub Actions para validación (`terraform fmt -check`, `terraform validate`, `terraform plan`) sin habilitar `apply` automático en ningún entorno.
- Configurar la federación OIDC entre GitHub Actions y AWS IAM; confirmar que no queda ninguna Access Key permanente almacenada como secreto de GitHub.
- Definir convención de nombres y de tags obligatorios (responsable, propósito, fecha de creación, fecha máxima de eliminación) como estándar en todos los módulos.

## Criterios de aceptación

- `terraform plan` puede ejecutarse contra la cuenta de AWS y producir un plan coherente con los recursos vigentes descritos por ADR-001 y sus precedencias posteriores, sin crear ningún recurso real todavía.
- Ningún secreto ni credencial de larga duración queda expuesto en el repositorio de Terraform ni en los workflows de GitHub Actions; la autenticación hacia AWS se realiza exclusivamente vía OIDC.
- Existe un flujo de pull request obligatorio, con al menos una aprobación humana, antes de cualquier `terraform apply` que genere costo o modifique cualquier entorno.
- Ningún `terraform apply` en producción ocurre de forma automática bajo ninguna circunstancia.
- El backend de estado remoto está en S3, privado, cifrado, versionado, con CMK dedicada y locking `use_lockfile` antes del primer `apply` real.

## Elementos fuera de alcance

- Primera ejecución real de `terraform apply` contra la cuenta de AWS.
- Implementación completa de pipelines de build/test/deploy de la aplicación en GitHub Actions (esta ADR solo establece la herramienta base y las reglas de gobernanza, no el pipeline completo).
- Migración de los pipelines de build actuales de Cloudflare Pages/Railway.
- Detalle de implementación de módulos reutilizables; ADR-010 ya cierra el mecanismo general de state, locking, KMS y CI.
