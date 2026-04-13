terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  backend "s3" {
    bucket         = "acme-terraform-state"
    key            = "acmeask/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "acme-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "AcmeAsk"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# --------------------------------------------------------------------------
# Variables
# --------------------------------------------------------------------------
variable "aws_region" {
  default = "us-east-1"
}
variable "environment" {
  default = "production"
}
variable "app_image" {
  description = "ECR image URI for acmeask"
  type        = string
}
variable "vpc_id" {
  description = "Existing Acme VPC ID"
  type        = string
}
variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks"
  type        = list(string)
}
variable "public_subnet_ids" {
  description = "Public subnet IDs for ALB"
  type        = list(string)
}

# --------------------------------------------------------------------------
# ECS Cluster
# --------------------------------------------------------------------------
resource "aws_ecs_cluster" "acmeask" {
  name = "acmeask"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "acmeask" {
  cluster_name       = aws_ecs_cluster.acmeask.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# --------------------------------------------------------------------------
# IAM Role for ECS Task
# --------------------------------------------------------------------------
resource "aws_iam_role" "acmeask_task" {
  name = "acmeask-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "acmeask_task_policy" {
  name = "acmeask-task-policy"
  role = aws_iam_role.acmeask_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Secrets Manager — read/write user tokens (scoped to acmeask prefix)
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:TagResource",
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:*:secret:acmeask/*"
      },
      {
        # CloudWatch Logs — audit log writes
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/acmeask/*"
      },
      {
        # SSM Parameter Store — app config (read-only)
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter/acmeask/*"
      },
    ]
  })
}

resource "aws_iam_role" "acmeask_execution" {
  name = "acmeask-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "acmeask_execution_ecr" {
  role       = aws_iam_role.acmeask_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --------------------------------------------------------------------------
# Security Groups
# --------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "acmeask-alb-sg"
  description = "ALB security group — only HTTPS from internet"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "acmeask_task" {
  name        = "acmeask-task-sg"
  description = "ECS task security group — only from ALB + outbound"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --------------------------------------------------------------------------
# CloudWatch Log Groups
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "acmeask_app" {
  name              = "/acmeask/app"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "acmeask_audit" {
  name              = "/acmeask/audit"
  retention_in_days = 365  # 1-year audit log retention (compliance requirement)

  # Prevent accidental deletion
  lifecycle {
    prevent_destroy = true
  }
}

# --------------------------------------------------------------------------
# ECS Task Definition
# --------------------------------------------------------------------------
resource "aws_ecs_task_definition" "acmeask" {
  family                   = "acmeask"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.acmeask_execution.arn
  task_role_arn            = aws_iam_role.acmeask_task.arn

  container_definitions = jsonencode([
    {
      name      = "acmeask"
      image     = var.app_image
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "CLOUDWATCH_LOG_GROUP", value = "/acmeask/audit" },
        { name = "PORT", value = "3000" },
      ]

      secrets = [
        { name = "SLACK_BOT_TOKEN", valueFrom = "/acmeask/slack/bot-token" },
        { name = "SLACK_APP_TOKEN", valueFrom = "/acmeask/slack/app-token" },
        { name = "SLACK_SIGNING_SECRET", valueFrom = "/acmeask/slack/signing-secret" },
        { name = "OKTA_DOMAIN", valueFrom = "/acmeask/okta/domain" },
        { name = "OKTA_CLIENT_ID", valueFrom = "/acmeask/okta/client-id" },
        { name = "OKTA_CLIENT_SECRET", valueFrom = "/acmeask/okta/client-secret" },
        { name = "NOTION_CLIENT_ID", valueFrom = "/acmeask/notion/client-id" },
        { name = "NOTION_CLIENT_SECRET", valueFrom = "/acmeask/notion/client-secret" },
        { name = "NOTION_REDIRECT_URI", valueFrom = "/acmeask/notion/redirect-uri" },
        { name = "CONFLUENCE_CLIENT_ID", valueFrom = "/acmeask/confluence/client-id" },
        { name = "CONFLUENCE_CLIENT_SECRET", valueFrom = "/acmeask/confluence/client-secret" },
        { name = "CONFLUENCE_REDIRECT_URI", valueFrom = "/acmeask/confluence/redirect-uri" },
        { name = "CONFLUENCE_BASE_URL", valueFrom = "/acmeask/confluence/base-url" },
        { name = "GOOGLE_CLIENT_ID", valueFrom = "/acmeask/google/client-id" },
        { name = "GOOGLE_CLIENT_SECRET", valueFrom = "/acmeask/google/client-secret" },
        { name = "GOOGLE_REDIRECT_URI", valueFrom = "/acmeask/google/redirect-uri" },
        { name = "OPENAI_API_KEY", valueFrom = "/acmeask/llm/openai-api-key" },
        { name = "ANTHROPIC_API_KEY", valueFrom = "/acmeask/llm/anthropic-api-key" },
        { name = "COHERE_API_KEY", valueFrom = "/acmeask/llm/cohere-api-key" },
        { name = "BASE_URL", valueFrom = "/acmeask/app/base-url" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = "/acmeask/app"
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])
}

# --------------------------------------------------------------------------
# ALB for OAuth Callbacks
# --------------------------------------------------------------------------
resource "aws_lb" "acmeask" {
  name               = "acmeask-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = true
}

resource "aws_lb_target_group" "acmeask" {
  name        = "acmeask-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# --------------------------------------------------------------------------
# ECS Service
# --------------------------------------------------------------------------
resource "aws_ecs_service" "acmeask" {
  name            = "acmeask"
  cluster         = aws_ecs_cluster.acmeask.id
  task_definition = aws_ecs_task_definition.acmeask.arn
  desired_count   = 2  # 2 tasks for HA
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.acmeask_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.acmeask.arn
    container_name   = "acmeask"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_iam_role_policy_attachment.acmeask_execution_ecr]
}

# --------------------------------------------------------------------------
# Auto Scaling
# --------------------------------------------------------------------------
resource "aws_appautoscaling_target" "acmeask" {
  max_capacity       = 5
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.acmeask.name}/${aws_ecs_service.acmeask.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "acmeask_cpu" {
  name               = "acmeask-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.acmeask.resource_id
  scalable_dimension = aws_appautoscaling_target.acmeask.scalable_dimension
  service_namespace  = aws_appautoscaling_target.acmeask.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 70.0
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# --------------------------------------------------------------------------
# CloudWatch Alarms
# --------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "audit_log_errors" {
  alarm_name          = "acmeask-audit-log-write-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "AuditLogWriteFailures"
  namespace           = "AcmeAsk"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "CRITICAL: Audit log write failures — investigate immediately"
  alarm_actions       = [] # Wire to SNS topic for pagerduty in production
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "latency_p50" {
  alarm_name          = "acmeask-latency-p50-over-3s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "PipelineLatencyMs"
  namespace           = "AcmeAsk"
  period              = 300
  extended_statistic  = "p50"
  threshold           = 3000
  alarm_description   = "AcmeAsk P50 latency exceeded 3s SLA"
  treat_missing_data  = "notBreaching"
}

# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------
output "alb_dns_name" {
  value = aws_lb.acmeask.dns_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.acmeask.name
}

output "audit_log_group" {
  value = aws_cloudwatch_log_group.acmeask_audit.name
}
