variable "aws_region" {
  description = "Región AWS del bootstrap de staging/compartido."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "ID de cuenta AWS (12 dígitos) propietaria del bootstrap. Sin valor real por defecto: debe suministrarse explícitamente antes de cualquier ejecución futura."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id debe contener exactamente 12 dígitos numéricos."
  }
}

variable "state_bucket_name" {
  description = "Nombre del bucket S3 exclusivo para el state de staging/compartido. Sin valor real por defecto."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name)) &&
      !can(regex("\\.\\.", var.state_bucket_name))
    )
    error_message = "state_bucket_name debe cumplir las reglas de nombre de bucket S3 (3-63 caracteres, minúsculas/dígitos/puntos/guiones, sin puntos consecutivos, inicio y fin alfanumérico)."
  }
}

variable "project_name" {
  description = "Nombre del proyecto, usado en etiquetas obligatorias y en nombres de recursos."
  type        = string
  default     = "agrogenomax"
}

variable "environment" {
  description = "Ambiente gestionado por este root module. Restringido a staging (ADR-010 §10.1/10.3): el bootstrap de producción es un proceso completamente independiente."
  type        = string
  default     = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "Este root module de bootstrap gestiona exclusivamente el ambiente staging (ADR-010 §10.1/10.3). Producción requiere un bootstrap independiente."
  }
}

variable "kms_administrator_arns" {
  description = "ARN de IAM autorizados como administradores de la CMK de staging (ADR-010 §9.1/15), además del principal root de recuperación de la cuenta. Sin identidades reales incluidas en este lote; requerido para la futura ejecución."
  type        = list(string)

  validation {
    condition     = length(var.kms_administrator_arns) > 0
    error_message = "Debe declararse al menos un ARN administrador de la CMK antes de ejecutar el bootstrap."
  }

  validation {
    condition = alltrue([
      for arn in var.kms_administrator_arns :
      can(regex("^arn:aws:iam::${var.aws_account_id}:(user|role)/[A-Za-z0-9+=,.@_-]+(/[A-Za-z0-9+=,.@_-]+)*$", arn))
    ])
    error_message = "Cada elemento de kms_administrator_arns debe ser un ARN IAM de user o role perteneciente exclusivamente a la cuenta declarada en var.aws_account_id (arn:aws:iam::<aws_account_id>:user/... o :role/...). No se aceptan ARN assumed-role de STS, comodines, cuentas distintas, grupos, service principals ni el usuario root (gestionado por separado como recuperación/delegación)."
  }
}

variable "tags" {
  description = "Etiquetas adicionales opcionales. Las etiquetas obligatorias (Project, Environment, ManagedBy, CostCenter) siempre tienen precedencia."
  type        = map(string)
  default     = {}
}
