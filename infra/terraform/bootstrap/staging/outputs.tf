output "state_bucket_name" {
  description = "Nombre del bucket S3 de state (staging/compartido)."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_arn" {
  description = "ARN del bucket S3 de state (staging/compartido)."
  value       = aws_s3_bucket.state.arn
}

output "kms_key_arn" {
  description = "ARN de la CMK dedicada al backend de Terraform state."
  value       = aws_kms_key.state.arn
}

output "kms_key_alias" {
  description = "Alias de la CMK dedicada al backend de Terraform state."
  value       = aws_kms_alias.state.name
}

output "plan_policy_arn" {
  description = "ARN de la política IAM administrada de plan (consumo futuro por el lote OIDC)."
  value       = aws_iam_policy.plan.arn
}

output "apply_policy_arn" {
  description = "ARN de la política IAM administrada de apply (consumo futuro por el lote OIDC)."
  value       = aws_iam_policy.apply.arn
}

output "state_keys" {
  description = "Claves conceptuales de terraform.tfstate definidas para staging/compartido (ADR-010 §11)."
  value       = local.state_keys
}

output "lock_keys" {
  description = "Claves conceptuales de los objetos .tflock derivados de cada state key (ADR-010 §11/12)."
  value       = local.lock_keys
}
