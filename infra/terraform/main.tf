# AWS infrastructure skeleton (deliverable 9). Illustrative — wire to real
# modules (terraform-aws-modules/vpc, /rds, /ecs) before production use.
#
# Realizes: HA (Multi-AZ), auto scaling, automatic backups, DR. See
# docs/ARCHITECTURE.md §9 for the full topology.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # backend "s3" { bucket = "tradealgo-tfstate" key = "prod/terraform.tfstate" region = "us-east-1" dynamodb_table = "tf-locks" }
}

provider "aws" {
  region = var.region
}

variable "region" { default = "us-east-1" }
variable "env"    { default = "prod" }

# --- Networking: VPC across 3 AZs, public + private subnets ---
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "tradealgo-${var.env}"
  cidr   = "10.0.0.0/16"

  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  public_subnets  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnets = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = false # one NAT per AZ for HA
}

# --- Data tier (private subnets) ---
# RDS PostgreSQL Multi-AZ + automated backups + PITR.
resource "aws_db_instance" "postgres" {
  identifier              = "tradealgo-${var.env}"
  engine                  = "postgres"
  engine_version          = "15"
  instance_class          = "db.r6g.large"
  allocated_storage       = 100
  max_allocated_storage   = 1000
  multi_az                = true
  storage_encrypted       = true
  backup_retention_period = 14          # automatic backups
  deletion_protection     = true
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.data.id]
  username                = "trade"
  manage_master_user_password = true     # Secrets Manager managed
}

resource "aws_db_subnet_group" "main" {
  name       = "tradealgo-${var.env}"
  subnet_ids = module.vpc.private_subnets
}

# ElastiCache Redis (cluster mode, Multi-AZ).
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "tradealgo-${var.env}"
  description                = "TradeAlgo cache/pubsub/streams"
  engine                     = "redis"
  node_type                  = "cache.r6g.large"
  num_node_groups            = 2
  replicas_per_node_group    = 1
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "tradealgo-${var.env}"
  subnet_ids = module.vpc.private_subnets
}

# --- Object storage: backups, backtest results, DR (cross-region replicated) ---
resource "aws_s3_bucket" "data" {
  bucket = "tradealgo-${var.env}-data"
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration { status = "Enabled" }
}

# --- Compute: ECS Fargate cluster (api, ws, engine, market-data, workers) ---
resource "aws_ecs_cluster" "main" {
  name = "tradealgo-${var.env}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# Security groups
resource "aws_security_group" "data" {
  name   = "tradealgo-${var.env}-data"
  vpc_id = module.vpc.vpc_id
  # Ingress restricted to the app security group only (least privilege).
}

# NOTE: ALB, ECS services + task defs, auto-scaling policies, CloudWatch alarms,
# WAF, KMS keys and Secrets Manager entries are added per service. See README.
