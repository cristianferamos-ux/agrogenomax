# Versión fijada y verificada localmente (windows_amd64). Compatible con
# `use_lockfile` del backend S3 nativo (ADR-010 §12).
terraform {
  required_version = "= 1.15.8"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
