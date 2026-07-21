# LOTE-017 — Operación del bootstrap Terraform de staging

> **ESTADO: PLANIFICACIÓN. NO AUTORIZA CONEXIÓN A AWS, `terraform plan`,
> `terraform apply`, migración de state ni creación de recursos.**
>
> La ejecución operativa requiere aprobación explícita posterior, revisión
> completa de este runbook y disponibilidad de credenciales administrativas
> temporales.

## 1. Objetivo

Ejecutar de forma controlada el código aprobado en LOTE-016 para crear el
backend remoto Terraform de staging/compartido:

- bucket S3 exclusivo para state;
- versionado y bloqueo público;
- cifrado SSE-KMS y S3 Bucket Key;
- CMK dedicada;
- políticas IAM administradas de `plan` y `apply`;
- locking nativo mediante objetos `.tflock`;
- migración verificable del state local temporal al backend remoto.

## 2. Fuera de alcance

LOTE-017 no debe:

- crear infraestructura de producción;
- modificar aplicaciones, bases de datos o servicios existentes;
- crear roles OIDC;
- habilitar CloudTrail de eventos de datos;
- ejecutar Docker, SQL o Cloudflare;
- almacenar credenciales o valores reales en Git;
- versionar `backend.tf`, `backend.staging.hcl`, `*.tfvars` o archivos state;
- usar credenciales permanentes;
- eliminar recursos AWS sin aprobación expresa.

## 3. Prerrequisitos obligatorios

Antes de autorizar cualquier operación:

1. `main` debe contener el resultado aprobado de LOTE-016.
2. El árbol de trabajo debe estar limpio, excepto archivos no rastreados
   expresamente preservados.
3. Terraform debe ser exactamente `1.15.8`.
4. El provider AWS debe permanecer bloqueado en `6.55.0`.
5. Deben repetirse:
   - `terraform fmt -check -recursive`;
   - `terraform validate`;
   - comprobación estática IAM/state/lock/KMS;
   - Trivy `HIGH,CRITICAL`;
   - revisión negativa de secretos;
   - `git diff --check`.
6. Debe aprobarse el nombre definitivo del bucket.
7. Debe identificarse la cuenta y región AWS correctas.
8. Debe identificarse al menos un ARN administrador de la CMK.
9. Debe verificarse que no existan recursos con nombres incompatibles.
10. Debe aprobarse el costo estimado actualizado.
11. Debe definirse una ventana operativa y un responsable humano.
12. Debe existir autorización explícita para usar credenciales temporales.

## 4. Datos operativos requeridos

Los siguientes valores no se almacenarán en Git:

| Dato | Estado |
|---|---|
| ID de cuenta AWS | Pendiente |
| Región AWS | Pendiente de confirmación |
| Nombre globalmente único del bucket | Pendiente |
| ARN administrador de la CMK | Pendiente |
| Identidad temporal que ejecutará el bootstrap | Pendiente |
| Duración máxima de la sesión | Pendiente |
| Presupuesto autorizado | Pendiente |
| Fecha y ventana de ejecución | Pendiente |
| Aprobador | Pendiente |

## 5. Gates de autorización

### Gate A — aprobación técnica

Requiere:

- revisión final del código;
- validaciones locales en limpio;
- confirmación de que las políticas IAM conservan mínimo privilegio;
- confirmación de que `kms:DescribeKey` permanece separado y sin condiciones;
- confirmación de que no se modificaron permisos S3.

### Gate B — costo

Debe documentarse un estimado actualizado para:

- CMK de AWS KMS;
- almacenamiento y solicitudes S3;
- versionado;
- operaciones KMS;
- margen razonable para crecimiento y pruebas.

El total previsto debe permanecer dentro del presupuesto aprobado de staging.

### Gate C — identidad y credenciales

La operación requiere:

- credenciales administrativas temporales;
- MFA cuando corresponda;
- ausencia de claves permanentes en archivos, variables persistentes o logs;
- eliminación de variables de sesión al finalizar;
- registro de identidad ejecutora y hora de inicio/fin.

### Gate D — autorización de ejecución

Solo después de aprobar los gates A, B y C puede autorizarse expresamente:

- conexión a AWS;
- bootstrap con state local temporal;
- `terraform plan`;
- `terraform apply`;
- creación de archivos locales reales del backend;
- `terraform init -migrate-state`.

## 6. Secuencia operativa propuesta

La secuencia definitiva debe ejecutarse comando por comando:

1. Verificar rama, commit y estado del repositorio.
2. Repetir validaciones locales.
3. Confirmar identidad AWS activa y cuenta esperada.
4. Confirmar región.
5. Preparar valores operativos exclusivamente en memoria o archivos locales
   ignorados.
6. Ejecutar `terraform plan` del bootstrap y guardar evidencia no sensible.
7. Revisar el plan completo.
8. Autorizar expresamente el `apply`.
9. Ejecutar el bootstrap.
10. Verificar bucket, CMK, alias y políticas creadas.
11. Copiar localmente las plantillas del backend.
12. Completar valores reales en archivos ignorados.
13. Ejecutar `terraform init -migrate-state`.
14. Verificar integridad y accesibilidad del state remoto.
15. Ejecutar un plan de verificación sin cambios inesperados.
16. Retirar y sanear el state local temporal.
17. Revocar o dejar expirar las credenciales temporales.
18. Registrar resultados, incidencias y costos observados.

## 7. Rollback

Antes de `apply`, el rollback consiste en cancelar la operación.

Después de crear recursos y antes de migrar state:

- detener la operación;
- conservar evidencia del estado;
- revisar dependencias;
- no destruir bucket ni CMK automáticamente;
- requerir aprobación específica para cualquier destrucción.

Después de migrar state:

- no eliminar el backend remoto;
- no regresar al state local sin un procedimiento aprobado;
- investigar y corregir cualquier inconsistencia antes de continuar.

La CMK y el bucket tienen protección contra destrucción accidental. Cualquier
retiro posterior debe ejecutarse mediante un lote independiente.

## 8. Evidencias mínimas

LOTE-017 debe conservar evidencia no sensible de:

- versión de Terraform;
- checksums/provider lock;
- validaciones locales;
- resultado de Trivy;
- revisión de secretos;
- identidad y cuenta AWS confirmadas;
- plan revisado;
- aprobación del apply;
- outputs no sensibles;
- migración del state;
- plan final sin cambios inesperados;
- revocación o expiración de credenciales;
- costo observado inicial.

## 9. Criterios de cierre

LOTE-017 solo puede cerrarse cuando:

- el backend remoto esté creado;
- el state esté migrado y verificado;
- el locking nativo funcione;
- las políticas `plan` y `apply` estén creadas;
- no existan secretos versionados;
- los archivos reales del backend permanezcan ignorados;
- no quede state local accesible sin control;
- las credenciales temporales hayan sido retiradas;
- exista evidencia de validación y aprobación.

## 10. Estado actual

Documento de planificación creado. Ninguna operación AWS está autorizada ni
ha sido ejecutada como parte de esta rama.
