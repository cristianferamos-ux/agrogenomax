# Runbook — Bootstrap de estado remoto Terraform (staging/compartido)

> **ESTE DOCUMENTO Y EL CÓDIGO DE LOTE-016 NO AUTORIZAN `terraform apply` NI
> NINGUNA CONEXIÓN A AWS.** Todo lo aquí descrito como "futuro" queda
> **NO AUTORIZADO** hasta la aprobación explícita de un lote operativo
> separado (ADR-010 §14, §26, §28; sección "Gate posterior" de LOTE-016).

Referencias: ADR-010 (`docs/adr/ADR-010-estado-remoto-bloqueo-terraform.md`),
código en `infra/terraform/bootstrap/staging/`.

## 1. Alcance de LOTE-016

LOTE-016 entrega únicamente código Terraform reproducible y validable
localmente. No ejecuta `init` contra un backend real, no ejecuta `plan`,
`apply`, `destroy`, `import`, `state` ni `force-unlock`, no usa credenciales
AWS y no crea ningún recurso. El único código versionado es el de
`infra/terraform/bootstrap/staging/`, `infra/terraform/.terraform-version` y
este runbook.

## 2. Versión de Terraform y compatibilidad de `use_lockfile`

- Versión fijada: **Terraform 1.15.8, windows_amd64**, instalada y verificada
  localmente (`terraform version`), y registrada en
  `infra/terraform/.terraform-version` y en `versions.tf`
  (`required_version = "= 1.15.8"`).
- El backend `s3` nativo soporta `use_lockfile` (locking sin DynamoDB) desde
  las versiones de Terraform en las que HashiCorp lo documentó en las notas
  de la serie 1.10+ del backend S3; 1.15.8 es posterior a esa introducción.
  Antes del bootstrap real, se debe volver a verificar esta compatibilidad
  contra la documentación oficial vigente de HashiCorp para el backend `s3`
  (ADR-010 §12, §26, §29.1) — este runbook no sustituye esa verificación.

## 3. Validaciones locales autorizadas (futura ejecución)

Ninguna de las siguientes requiere credenciales ni consulta AWS:

```
terraform -chdir=infra/terraform/bootstrap/staging fmt -check -recursive
terraform -chdir=infra/terraform/bootstrap/staging init -backend=false
terraform -chdir=infra/terraform/bootstrap/staging validate
```

`terraform init -backend=false` también genera `.terraform.lock.hcl`, que
debe versionarse (no está ignorado por `.gitignore`). LOTE-016 no ejecuta
estos comandos; quedan documentados para la validación posterior.

## 4. Separación `terraform.tfstate` vs. `.tflock`

Cada clave de state definida en `main.tf` (`local.state_keys`) tiene un
objeto de lock nativo derivado (`local.lock_keys`, sufijo `.tflock`), ambos
cifrados con la misma CMK del bucket (ADR-010 §8/9.1/12):

```
bootstrap/terraform.tfstate              bootstrap/terraform.tfstate.tflock
shared/identidad/terraform.tfstate       shared/identidad/terraform.tfstate.tflock
shared/red/terraform.tfstate             shared/red/terraform.tfstate.tflock
staging/ganaderia/terraform.tfstate      staging/ganaderia/terraform.tfstate.tflock
staging/catastrox/terraform.tfstate      staging/catastrox/terraform.tfstate.tflock
staging/observabilidad/terraform.tfstate staging/observabilidad/terraform.tfstate.tflock
```

El rol de **plan** solo lee `terraform.tfstate` y opera (crea/lee/elimina)
el objeto `.tflock`; nunca escribe ni elimina `terraform.tfstate`. El rol de
**apply** lee y escribe `terraform.tfstate` (nunca lo elimina) y opera
completamente el objeto `.tflock`. Ambas políticas están codificadas en
`iam.tf` como `aws_iam_policy.plan` / `aws_iam_policy.apply`, sin roles ni
attachments (ADR-010 §9.1/15).

`s3:ListBucket` en ambas políticas está acotado por una condición
`StringEquals` sobre `s3:prefix` a la lista exacta de las 12 claves
anteriores (`local.state_keys` + `local.lock_keys`), no a los prefijos
amplios `bootstrap/*`, `shared/*` ni `staging/*`. El uso criptográfico de la
CMK (`kms:Decrypt`, `kms:GenerateDataKey` y
`kms:Encrypt`) queda limitado tanto por `kms:ViaService` (solo a través de S3
en la región configurada) como por una condición `StringEquals` adicional
sobre `kms:EncryptionContext:aws:s3:arn` igual al ARN del bucket. Como el
bucket tiene S3 Bucket Key habilitada, S3 envía a KMS el ARN del bucket como
contexto de cifrado (no el ARN de cada objeto individual).

`kms:DescribeKey` se mantiene separado en el statement
`DescribeStateKeyOnly`, limitado exclusivamente a `aws_kms_key.state.arn` y
sin condiciones. Esta separación es necesaria porque `DescribeKey` puede ser
invocado directamente por el SDK y no admite condiciones basadas en
`kms:EncryptionContext`.

## 5. Backend local vs. plantillas versionadas

- `backend.tf.example` y `backend.staging.hcl.example` son plantillas
  versionadas, sin valores reales.
- Los archivos reales `backend.tf` y `backend.staging.hcl` se copian
  manualmente a partir de esas plantillas **solo en el lote operativo
  posterior**, permanecen locales y están explícitamente ignorados por
  `.gitignore`. Nunca se versionan.

## 6. Ciclo completo futuro (NO AUTORIZADO en LOTE-016)

Todos los pasos siguientes son **FUTUROS / NO AUTORIZADOS** hasta la
aprobación de un lote operativo separado con credenciales administrativas
temporales, revisión final de costo y registro de aprobación:

1. **Validación local** — `fmt -check`, `init -backend=false`, `validate`
   sobre el código ya versionado (sección 3), sin AWS.
2. **Aprobación del lote operativo** — autorización explícita separada de
   LOTE-016, con credenciales administrativas temporales y revisión de
   costo (sección 7).
3. **Bootstrap con state local temporal** — la identidad administrativa
   humana ejecuta el bootstrap con state local temporal, tratado conforme a
   ADR-010 §14.1/14.3: cifrado en reposo, acceso restringido a esa
   identidad, nunca versionado en git.
4. **Creación del backend** — el `apply` de ese bootstrap crea el bucket S3,
   la CMK, la configuración de locking nativo y las políticas IAM de este
   módulo.
5. **Copia local de plantillas** — se copian `backend.tf.example` →
   `backend.tf` y `backend.staging.hcl.example` → `backend.staging.hcl`,
   reemplazando los placeholders con los valores reales recién creados
   (bucket, CMK). Ambos archivos permanecen locales e ignorados por git.
6. **`terraform init -migrate-state`** — migra el state local temporal al
   backend S3 recién creado.
7. **Verificación** — se confirma que el state migrado es íntegro y
   accesible (`terraform plan` de verificación sin cambios inesperados)
   antes de continuar.
8. **Higiene del state temporal (ADR-010 §14.3)** — una vez verificada la
   migración: se eliminan las copias accesibles del state local; se
   verifica que no quedó retenido en sincronización en la nube, backups o
   logs del equipo local; no se promete borrado forense absoluto; ante
   cualquier duda razonable de acceso no controlado, se rota cualquier
   secreto que el state temporal hubiera contenido, en vez de asumir que la
   eliminación del archivo fue suficiente.

Producción **requiere un bootstrap totalmente independiente** (ADR-010
§10.2/14.2): bucket, CMK, políticas y aprobación separados, sin heredar
nada del bootstrap de staging, y ninguna identidad de staging con acceso al
backend de producción.

## 7. Revisión de costo preoperativa

LOTE-016 no genera costo AWS porque no conecta ni aprovisiona nada. Antes
del lote operativo posterior debe recalcularse el costo en AWS Pricing
Calculator, desglosado al menos en:

- Bucket S3 (almacenamiento, versionado, requests).
- CMK (cargo mensual de la clave + uso de API KMS).
- Auditoría futura (CloudTrail de eventos de datos, sección 8) — a costear
  antes de habilitarse, no incluida en este cálculo inicial.

El estimado debe mantenerse dentro del presupuesto total de staging de
**USD 25/mes**. Ningún costo de este runbook debe tratarse como cifra
inmutable; se recalcula en cada revisión previa a un `apply` real.

## 8. CloudTrail — fuera de alcance de LOTE-016

CloudTrail de eventos de datos sobre el bucket de state queda para un lote
posterior (ADR-010, sección de auditoría) y debe costearse explícitamente
antes de habilitarse, dentro del presupuesto de la sección 7.

## 9. Rollback

- **Código**: `git revert` del commit de LOTE-016.
- **AWS**: no existe rollback de infraestructura en LOTE-016, porque este
  lote no crea ningún recurso AWS.

## 10. Estado de este runbook

Documento entregado como parte de LOTE-016, **pendiente de validación**
por el usuario. No declara LOTE-016 completado.
