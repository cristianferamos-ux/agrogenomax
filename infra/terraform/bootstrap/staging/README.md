# Bootstrap Terraform — staging/compartido (AgroGenomaX)

**LOTE-016 NO AUTORIZA `apply` NI CONEXIÓN A AWS.** Este módulo es código
validable localmente (`fmt`, `init -backend=false`, `validate`). No crea
ningún recurso real hasta que se apruebe un lote operativo separado
(ADR-010 §14, §26, §28).

## Contenido

| Archivo | Propósito |
|---|---|
| `versions.tf` | Terraform `= 1.15.8`; provider `hashicorp/aws` serie `~> 6.0`. |
| `providers.tf` | Provider `aws` parametrizado por `var.aws_region`, con `default_tags`. |
| `variables.tf` | Variables sin valor real por defecto (`aws_account_id`, `state_bucket_name`, `kms_administrator_arns`) y con default seguro (`aws_region`, `project_name`, `environment=staging`). |
| `main.tf` | Bucket S3 de state (bloqueo público, `BucketOwnerEnforced`, versionado, SSE-KMS, TLS obligatorio), CMK dedicada con rotación y alias, claves conceptuales de state/lock (ADR-010 §11). |
| `iam.tf` | Políticas IAM administradas `plan` y `apply`, mínimo privilegio, sin usuarios/roles/OIDC. `s3:ListBucket` restringido por `StringEquals` sobre `s3:prefix` a las 12 claves exactas de state/lock (no a prefijos `bootstrap/*`, `shared/*`, `staging/*`); uso criptográfico de la CMK (`kms:Decrypt`, `kms:GenerateDataKey`, `kms:Encrypt`) limitado por `kms:ViaService` y por `kms:EncryptionContext:aws:s3:arn` igual al ARN del bucket (S3 Bucket Key habilitada). `kms:DescribeKey` se autoriza en un statement independiente, limitado a la misma CMK y sin condiciones, porque puede ser invocado directamente por el SDK y no admite contexto de cifrado. |
| `outputs.tf` | Identificadores no sensibles (ARNs, alias, listas de claves) para el lote operativo posterior. |
| `backend.tf.example` / `backend.staging.hcl.example` | Plantillas. Los archivos reales (`backend.tf`, `backend.staging.hcl`) son locales, generados manualmente en el futuro y están ignorados por git. |

## Recursos declarados (no creados en este lote)

- 1 bucket S3 (`aws_s3_bucket.state`) + ownership controls, public access
  block, versionado, cifrado por defecto SSE-KMS, política TLS-only.
- 1 CMK (`aws_kms_key.state`) con rotación automática y alias.
- 2 `aws_iam_policy` administradas (`plan`, `apply`), sin roles ni attachments.

No se declara DynamoDB, CloudTrail, ECR, ECS, RDS, Secrets Manager, OIDC ni
ningún recurso productivo.

## Validación local autorizada (futura ejecución, no realizada en LOTE-016)

```
terraform -chdir=infra/terraform/bootstrap/staging fmt -check -recursive
terraform -chdir=infra/terraform/bootstrap/staging init -backend=false
terraform -chdir=infra/terraform/bootstrap/staging validate
```

Ninguno de estos comandos consulta AWS ni requiere credenciales.

## Ciclo operativo completo

Ver `docs/runbooks/terraform-bootstrap-staging.md`.
