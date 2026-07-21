# Políticas IAM administradas reutilizables (ADR-010 §9.1/15, sección G del
# lote). No se crean usuarios, grupos, roles, instance profiles, proveedor
# OIDC, trust policies ni attachments: quedan listas para consumo de un lote
# OIDC posterior.

locals {
  state_object_arns = [for k in local.state_keys : "${aws_s3_bucket.state.arn}/${k}"]
  lock_object_arns  = [for k in local.lock_keys : "${aws_s3_bucket.state.arn}/${k}"]

  # Lista exacta de las 12 claves autorizadas para ListBucket (6 state +
  # 6 lock): evita el comodín "*" y los prefijos amplios bootstrap/*,
  # shared/*, staging/*, limitando el listado a las claves realmente
  # definidas (ADR-010 §11).
  authorized_keys = concat(local.state_keys, local.lock_keys)
}

# --- Política de plan ---
# Lee terraform.tfstate; nunca escribe ni elimina terraform.tfstate; opera
# exclusivamente el objeto .tflock; uso criptográfico de la CMK sin
# administración (ADR-010 §9.1/15, corrección 1).
data "aws_iam_policy_document" "plan" {
  statement {
    sid       = "ListAuthorizedPrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = local.authorized_keys
    }
  }

  statement {
    sid       = "ReadStateOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = local.state_object_arns
  }

  statement {
    sid    = "OperateLockObjectsOnly"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = local.lock_object_arns
  }

  statement {
    sid    = "CmkCryptographicUseOnly"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:Encrypt",
    ]
    resources = [aws_kms_key.state.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    # S3 Bucket Key está habilitada en el bucket: el contexto de cifrado que
    # S3 envía a KMS es el ARN del bucket (no el ARN del objeto individual).
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.state.arn]
    }
  }
  statement {
    sid       = "DescribeStateKeyOnly"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.state.arn]
  }
}

resource "aws_iam_policy" "plan" {
  name        = "${var.project_name}-${var.environment}-terraform-plan"
  description = "Rol de plan (ADR-010 §9.1/15): lectura de terraform.tfstate; nunca PutObject/DeleteObject sobre terraform.tfstate; operación exclusiva del objeto .tflock; uso criptográfico de la CMK sin administración."
  policy      = data.aws_iam_policy_document.plan.json

  tags = local.mandatory_tags
}

# --- Política de apply ---
# Lee y escribe terraform.tfstate, nunca lo elimina; opera completamente el
# objeto .tflock; mismos límites criptográficos que plan.
data "aws_iam_policy_document" "apply" {
  statement {
    sid       = "ListAuthorizedPrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = local.authorized_keys
    }
  }

  statement {
    sid    = "ReadWriteStateNeverDelete"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = local.state_object_arns
  }

  statement {
    sid    = "OperateLockObjectsOnly"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = local.lock_object_arns
  }

  statement {
    sid    = "CmkCryptographicUseOnly"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:Encrypt",
    ]
    resources = [aws_kms_key.state.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    # S3 Bucket Key está habilitada en el bucket: el contexto de cifrado que
    # S3 envía a KMS es el ARN del bucket (no el ARN del objeto individual).
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.state.arn]
    }
  }
  statement {
    sid       = "DescribeStateKeyOnly"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.state.arn]
  }
}

resource "aws_iam_policy" "apply" {
  name        = "${var.project_name}-${var.environment}-terraform-apply"
  description = "Rol de apply (ADR-010 §9.1/15): lectura/escritura de terraform.tfstate sin DeleteObject; operación completa del objeto .tflock; uso criptográfico de la CMK sin administración."
  policy      = data.aws_iam_policy_document.apply.json

  tags = local.mandatory_tags
}
