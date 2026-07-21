provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.mandatory_tags
  }
}
