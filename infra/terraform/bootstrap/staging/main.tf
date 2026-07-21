locals {
  mandatory_tags = merge(
    var.tags,
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      CostCenter  = "staging"
    }
  )

  # Claves conceptuales de terraform.tfstate en el bucket de staging/compartido
  # (ADR-010 §11). No incluye producción: el bootstrap productivo es un
  # proceso completamente independiente (ADR-010 §14.2).
  state_keys = [
    "bootstrap/terraform.tfstate",
    "shared/identidad/terraform.tfstate",
    "shared/red/terraform.tfstate",
    "staging/ganaderia/terraform.tfstate",
    "staging/catastrox/terraform.tfstate",
    "staging/observabilidad/terraform.tfstate",
  ]

  # Objeto de lock nativo derivado de cada state key (ADR-010 §11/12).
  lock_keys = [for k in local.state_keys : "${k}.tflock"]
}

# Bucket exclusivo del state de staging/compartido (ADR-010 §8).
resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket_name
  force_destroy = false

  tags = local.mandatory_tags

  # Protección contra eliminación accidental, coherente con versionado y
  # force_destroy=false (ADR-010 §8).
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

# TLS obligatorio para cualquier operación sobre el bucket o sus objetos
# (ADR-010 §8), incluidos terraform.tfstate y los objetos .tflock.
data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
}

# CMK dedicada exclusivamente al backend de Terraform (ADR-010 §9). El objeto
# de lock (.tflock) queda cifrado con la misma clave que terraform.tfstate.
resource "aws_kms_key" "state" {
  description             = "CMK dedicada al backend de Terraform state de staging/compartido (ADR-010 §9)."
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms_key_policy.json

  tags = local.mandatory_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = "alias/${var.project_name}-${var.environment}-terraform-state"
  target_key_id = aws_kms_key.state.key_id
}

# Política de la CMK (ADR-010 §9.1/26.A, sección E del lote):
# - El principal root de la cuenta se declara únicamente como mecanismo de
#   recuperación/delegación a IAM (nunca como credencial embebida): permite
#   que las políticas IAM adjuntas a identidades reales sean las que otorguen
#   el uso operacional efectivo, sin abrir la clave públicamente.
# - Solo `var.kms_administrator_arns` recibe acciones de administración de
#   la clave. Ningún rol de plan/apply aparece en esta política: su acceso
#   criptográfico se define exclusivamente en las políticas IAM (iam.tf),
#   nunca con permisos de administración.
data "aws_iam_policy_document" "kms_key_policy" {
  statement {
    sid    = "RootAccountRecoveryDelegatesToIam"
    effect = "Allow"

    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }
  }

  statement {
    sid    = "ExplicitKeyAdministrators"
    effect = "Allow"

    actions = [
      "kms:Create*",
      "kms:Describe*",
      "kms:Enable*",
      "kms:List*",
      "kms:Put*",
      "kms:Update*",
      "kms:Revoke*",
      "kms:Disable*",
      "kms:Get*",
      "kms:Delete*",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = var.kms_administrator_arns
    }
  }
}
