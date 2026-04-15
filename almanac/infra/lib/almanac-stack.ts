/**
 * Almanac CDK Stack
 * Deploy target: AWS — region driven by CDK_DEFAULT_REGION env var
 * (fallback us-west-2). Set in infra/bin/almanac.ts.
 *
 * Resources provisioned:
 * - ECS Fargate cluster (Almanac service, multi-instance in prod)
 * - Application Load Balancer (internet-facing) fronting the service — serves
 *   /health for smoke tests and /oauth/:provider/{start,callback} for real
 *   OAuth flows. HTTPS when `certArn` is provided; HTTP-only otherwise.
 * - DynamoDB x3: token store, audit log (hot), identity cache
 * - ElastiCache Redis: rate limiting shared state (REQUIRED for multi-instance)
 * - RDS Postgres (pgvector): k-NN + BM25 hybrid search
 * - SQS + DLQ: audit event queue with retry/dead-letter
 * - Lambda: audit log consumer (SQS -> DDB + S3)
 * - S3: long-term audit log (1-year lifecycle)
 * - KMS: token store envelope encryption
 * - Secrets Manager: app-level secrets (NOT per-user tokens)
 * - VPC: private subnets, NAT gateway
 * - CloudWatch: alarms, dashboard
 */
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface AlmanacStackProps extends cdk.StackProps {
  environment: "staging" | "production";
  /**
   * ACM certificate ARN for the public HTTPS listener. Optional —
   * BYO-cert escape hatch for orgs whose platform team owns ACM.
   * Mutually exclusive with `hostedZoneId` (let CDK create the cert).
   */
  certArn?: string;
  /**
   * Custom public domain (e.g. `almanac-staging.example.com`).
   *   - With `hostedZoneId`: CDK creates the cert + Route 53 alias.
   *   - With `certArn`: domain is used for `APP_BASE_URL` and you own
   *     the alias record.
   *   - Without either: `APP_BASE_URL` falls back to the ALB DNS
   *     (HTTP-only smoke mode; OAuth providers will reject callbacks).
   */
  domainName?: string;
  /**
   * Route 53 hosted zone ID for `domainName`. When set together with
   * `domainName`, CDK provisions an ACM cert via DNS validation and
   * an alias A record pointing the domain at the ALB — no manual
   * cert creation, no manual DNS record. Skip if you'd rather BYO
   * the cert (set `certArn`) or run HTTP-only.
   */
  hostedZoneId?: string;
}

export class AlmanacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlmanacStackProps) {
    super(scope, id, props);
    const isProd = props.environment === "production";

    // KMS: token store envelope encryption
    const tokenKmsKey = new kms.Key(this, "TokenStoreKey", {
      description: "Almanac per-user OAuth token encryption",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Bedrock model invocation logging is an account+region scoped setting
    // (PutModelInvocationLoggingConfiguration). Source content must never reach
    // CloudWatch or S3 logs. This stack owns the regional setting and asserts
    // it disabled on every deploy. If another app in this account needs Bedrock
    // logging in this region, that's incompatible with Almanac's posture and
    // must be resolved at the account level.
    new cr.AwsCustomResource(this, "DisableBedrockInvocationLogging", {
      onCreate: {
        service: "Bedrock",
        action: "deleteModelInvocationLoggingConfiguration",
        physicalResourceId: cr.PhysicalResourceId.of(`almanac-bedrock-logging-${this.region}`),
        region: this.region,
      },
      onUpdate: {
        service: "Bedrock",
        action: "deleteModelInvocationLoggingConfiguration",
        physicalResourceId: cr.PhysicalResourceId.of(`almanac-bedrock-logging-${this.region}`),
        region: this.region,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            "bedrock:DeleteModelInvocationLoggingConfiguration",
            "bedrock:GetModelInvocationLoggingConfiguration",
          ],
          resources: ["*"],
        }),
      ]),
    });

    // VPC: private subnets, no public ECS ingress
    const vpc = new ec2.Vpc(this, "AlmanacVpc", {
      maxAzs: 2,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // DynamoDB: per-(user, provider) OAuth token store
    // Key design: (userId, provider) composite key; one row per provider grant.
    // Schema expected by almanac-oauth / module-oauth-delegation's
    // DDBKmsTokenStorage — KMS-encrypted payload with an EncryptionContext
    // binding the ciphertext to the user+provider so a leaked blob can't be
    // decrypted for a different pair. Scales to 10k users × N providers.
    const tokenTable = new dynamodb.Table(this, "TokenStore", {
      tableName: `almanac-tokens-${props.environment}`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "provider", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB: audit log (hot, 90d TTL, then lifecycle to S3)
    const auditTable = new dynamodb.Table(this, "AuditLog", {
      tableName: `almanac-audit-${props.environment}`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB: Slack -> workforce-directory identity cache (1h TTL)
    const identityCacheTable = new dynamodb.Table(this, "IdentityCache", {
      tableName: `almanac-identity-cache-${props.environment}`,
      partitionKey: { name: "slackUserId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3: long-term audit log (1-year lifecycle, Intelligent Tiering after 90d)
    const auditBucket = new s3.Bucket(this, "AuditBucket", {
      bucketName: `almanac-audit-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(365),
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // SQS: audit DLQ first (referenced by main queue). FIFO because
    // the main audit queue is FIFO — an SQS FIFO queue can only
    // DLQ to another FIFO queue.
    const auditDlq = new sqs.Queue(this, "AuditDlq", {
      queueName: `almanac-audit-dlq-${props.environment}.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // SQS: main audit queue (retry 3x, then DLQ). FIFO so dedup
    // is exactly-once per (userId, eventHash) — compliance records
    // must not double-count. `MessageGroupId=userId` keeps per-user
    // events ordered without serializing across users.
    const auditQueue = new sqs.Queue(this, "AuditQueue", {
      queueName: `almanac-audit-${props.environment}.fifo`,
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: auditDlq, maxReceiveCount: 3 },
    });

    // CloudWatch alarm: DLQ depth > 0 (compliance requirement)
    new cloudwatch.Alarm(this, "AuditDlqDepthAlarm", {
      metric: auditDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "Almanac audit DLQ has messages - audit log delivery failing",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // App-level SLO alarms against metrics emitted by src/metrics.ts.
    // Environment dimension lets staging and production alarms stay separate.
    const environmentDimension = { Environment: props.environment };
    const appMetric = (metricName: string, statistic = "Average") =>
      new cloudwatch.Metric({
        namespace: "Almanac",
        metricName,
        dimensionsMap: environmentDimension,
        statistic,
        period: cdk.Duration.minutes(5),
      });

    new cloudwatch.Alarm(this, "QueryP95LatencyAlarm", {
      metric: appMetric("QueryLatency", "p95"),
      threshold: 5000, // 5s
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: "Almanac query p95 latency > 5s for 15 minutes",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, "LLMErrorAlarm", {
      metric: appMetric("LLMError", "Sum"),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "Almanac Bedrock LLM errors >= 5 in 5 minutes",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // AuditTotalLoss fires only when BOTH the primary queue AND the DLQ
    // SendMessage failed — a genuinely-lost compliance event. Page immediately.
    new cloudwatch.Alarm(this, "AuditTotalLossAlarm", {
      metric: appMetric("AuditTotalLoss", "Sum"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Almanac lost audit event(s) — primary SQS and DLQ both failed. Compliance-critical.",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda: audit consumer (SQS -> DDB -> S3)
    const auditLogRole = new iam.Role(this, "AuditLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    auditLogRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [auditTable.tableArn] }),
    );
    auditLogRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${auditBucket.bucketArn}/*`],
      }),
    );

    const auditLambdaLogGroup = new logs.LogGroup(this, "AuditConsumerLogGroup", {
      logGroupName: `/aws/lambda/almanac-audit-consumer-${props.environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const auditLambda = new lambda.Function(this, "AuditConsumer", {
      functionName: `almanac-audit-consumer-${props.environment}`,
      // Pinned to the app container's Node 24 LTS — keeps app + Lambda +
      // CDK on one major, tracks LTS-to-LTS migrations.
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
        const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
        const ddb = new DynamoDBClient({});
        const s3 = new S3Client({});
        exports.handler = async (event) => {
          for (const record of event.Records) {
            const ev = JSON.parse(record.body);
            const ttl = Math.floor(Date.now() / 1000) + (90 * 24 * 3600);
            await ddb.send(new PutItemCommand({
              TableName: process.env.AUDIT_TABLE,
              Item: { userId: { S: ev.userId }, timestamp: { S: ev.timestamp }, eventData: { S: JSON.stringify(ev) }, ttl: { N: String(ttl) } }
            }));
            const key = 'audit/' + ev.userId + '/' + ev.timestamp.split('T')[0] + '/' + ev.queryHash + '.json';
            await s3.send(new PutObjectCommand({ Bucket: process.env.AUDIT_BUCKET, Key: key, Body: JSON.stringify(ev), ContentType: 'application/json' }));
          }
        };
      `),
      environment: { AUDIT_TABLE: auditTable.tableName, AUDIT_BUCKET: auditBucket.bucketName },
      role: auditLogRole,
      timeout: cdk.Duration.seconds(30),
      logGroup: auditLambdaLogGroup,
    });
    auditLambda.addEventSource(
      // FIFO queues don't support a batching window — they batch by
      // MessageGroupId and deliver as soon as a group has messages.
      new lambdaEventSources.SqsEventSource(auditQueue, {
        batchSize: 10,
      }),
    );

    // ElastiCache Redis: rate limiting shared state
    // REQUIRED: Multi-instance ECS cannot use in-memory Maps
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, "RedisSubnetGroup", {
      description: "Almanac Redis subnet group",
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });
    const redisSg = new ec2.SecurityGroup(this, "RedisSg", {
      vpc,
      description: "Almanac Redis SG",
    });
    const redisCacheCluster = new elasticache.CfnReplicationGroup(this, "Redis", {
      replicationGroupDescription: "Almanac rate-limiting Redis",
      numCacheClusters: isProd ? 2 : 1,
      cacheNodeType: "cache.t3.micro",
      engine: "redis",
      engineVersion: "7.1",
      automaticFailoverEnabled: isProd,
      multiAzEnabled: isProd,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
    });

    // RDS Postgres — retrieval backend (pgvector). db.t4g.micro is the
    // cheapest instance class (~$12/mo on-demand in us-west-2). Single-AZ
    // for staging; dial up for production by setting multiAz: true. Master
    // credentials are auto-generated into Secrets Manager; the ECS task
    // composes `RETRIEVAL_BACKEND_URL` from individual fields pulled via
    // `ecs.Secret.fromSecretsManager`. Schema bootstrap (CREATE EXTENSION
    // vector + tables) happens idempotently on app startup — no CDK
    // custom resource needed.
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "Almanac Postgres SG",
    });

    const dbCredentials = rds.Credentials.fromGeneratedSecret("almanac_admin", {
      secretName: `almanac/${props.environment}/db-credentials`,
    });

    const database = new rds.DatabaseInstance(this, "AlmanacDb", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      credentials: dbCredentials,
      databaseName: "almanac",
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: isProd,
      backupRetention: cdk.Duration.days(isProd ? 14 : 7),
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
      publiclyAccessible: false,
    });

    // Secrets Manager: app-level secrets (NOT per-user tokens)
    // Per-user tokens live in DynamoDB + KMS (see TokenStore above).
    //
    // `generateSecretString` seeds the secret with placeholder values on
    // CREATE only. This unblocks the first `cdk deploy`: ECS tasks can
    // resolve every key the task-def references, so they pass the Zod
    // env check and come healthy; the ECS Deployment Circuit Breaker
    // doesn't trip; CFN finishes. Operators then replace the placeholders
    // via `aws secretsmanager put-secret-value` (see docs/secrets.md) and
    // `--force-new-deployment` picks up the real values.
    //
    // `STATE_SIGNING_SECRET` is generated as a real random 64-char string
    // here, so the HMAC schema's ≥32-byte check in src/config is satisfied
    // out of the box and doesn't have to be rotated on first seed.
    //
    // Subsequent `cdk deploy` calls do NOT overwrite the secret — AWS
    // ignores `GenerateSecretString` on UPDATE and preserves existing
    // content.
    const appSecrets = new secretsmanager.Secret(this, "AppSecrets", {
      secretName: `almanac/${props.environment}/app-secrets`,
      description: "Almanac app secrets (Slack, OAuth app credentials, WorkOS).",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          SLACK_BOT_TOKEN: "placeholder-replace-me",
          SLACK_SIGNING_SECRET: "placeholder-replace-me",
          SLACK_APP_TOKEN: "placeholder-replace-me",
          WORKOS_API_KEY: "placeholder-replace-me",
          WORKOS_DIRECTORY_ID: "placeholder-replace-me",
          NOTION_OAUTH_CLIENT_ID: "placeholder-replace-me",
          NOTION_OAUTH_CLIENT_SECRET: "placeholder-replace-me",
          CONFLUENCE_OAUTH_CLIENT_ID: "placeholder-replace-me",
          CONFLUENCE_OAUTH_CLIENT_SECRET: "placeholder-replace-me",
          GOOGLE_OAUTH_CLIENT_ID: "placeholder-replace-me",
          GOOGLE_OAUTH_CLIENT_SECRET: "placeholder-replace-me",
        }),
        generateStringKey: "STATE_SIGNING_SECRET",
        passwordLength: 64,
        excludePunctuation: false,
      },
    });

    // ECS Fargate cluster
    const cluster = new ecs.Cluster(this, "AlmanacCluster", {
      vpc,
      clusterName: `almanac-${props.environment}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ECS Task IAM Role — least-privilege: GetItem/PutItem/DeleteItem on
    // specific tables, SendMessage on specific queues, Encrypt/Decrypt on
    // the token KMS key, and InvokeModel on specific Bedrock model ARNs.
    // No Scan, no wildcards.
    const taskRole = new iam.Role(this, "AlmanacTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Least-privilege DDB access (GetItem/PutItem/DeleteItem only - no Scan)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "TokenStoreAccess",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [tokenTable.tableArn],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IdentityCacheAccess",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [identityCacheTable.tableArn],
      }),
    );
    auditQueue.grantSendMessages(taskRole);
    auditDlq.grantSendMessages(taskRole);
    tokenKmsKey.grantEncryptDecrypt(taskRole);
    appSecrets.grantRead(taskRole);

    // Bedrock: specific model ARNs only. Wildcard the Sonnet 4.6
    // version suffix so bumping the model doesn't require a stack update.
    //
    // Claude Sonnet 4.6 must be invoked via a cross-region inference
    // profile (`us.anthropic.…`) — the bare foundation-model ARN
    // returns "on-demand throughput isn't supported". The profile ARN
    // lives in the caller's own account; the profile in turn fans out
    // to foundation-model ARNs in multiple regions, so both ARNs need
    // to be in the policy.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2*`,
        ],
      }),
    );

    // Retrieval backend — pgvector on RDS is the default (provisioned
    // above as `database`). The retriever is port-injected via
    // `RetrievalBackend`, so a client fork can swap to Pinecone,
    // Qdrant, OpenSearch, or a custom backend by pointing
    // `RETRIEVAL_BACKEND_URL` at a different scheme and wiring a new
    // adapter in `src/index.ts`. When both `RETRIEVAL_BACKEND_URL`
    // and the `PG*` env fields are blank, bootstrap falls back to a
    // null backend (retriever returns empty hits) — useful for
    // infra-smoke deploys.

    // CloudWatch metrics — resource="*" is the canonical pattern for
    // PutMetricData because metric data doesn't have an ARN.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "Almanac" } },
      }),
    );

    // ECS Exec (`aws ecs execute-command`) for staging debugging: seed data
    // into pgvector, inspect DDB, tail logs inside the VPC. The SSM-messages
    // channel is the transport the Fargate host uses to proxy the exec
    // session into the container. Production has `enableExecuteCommand=false`
    // so these grants are harmless there but unused.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcsExecSsmMessages",
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(this, "AlmanacTask", {
      cpu: isProd ? 1024 : 512,
      memoryLimitMiB: isProd ? 2048 : 1024,
      taskRole,
    });

    const redisEndpoint = `rediss://${redisCacheCluster.attrPrimaryEndPointAddress}:${redisCacheCluster.attrPrimaryEndPointPort}`;

    // Container image built and published by CDK on every deploy. The asset
    // digest becomes part of the task definition, so `cdk deploy` rolls the
    // ECS service automatically — no separate `docker push` + `update-service
    // --force-new-deployment` dance. Platform is pinned to LINUX_AMD64
    // because Fargate's default runtime architecture is x86_64 and dev
    // machines are often arm64 (Apple Silicon).
    const container = taskDef.addContainer("almanac", {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", ".."), {
        platform: Platform.LINUX_AMD64,
      }),
      environment: {
        AWS_REGION: this.region,
        DYNAMODB_TABLE_TOKENS: tokenTable.tableName,
        DYNAMODB_TABLE_AUDIT: auditTable.tableName,
        DYNAMODB_TABLE_IDENTITY_CACHE: identityCacheTable.tableName,
        SQS_AUDIT_QUEUE_URL: auditQueue.queueUrl,
        SQS_AUDIT_DLQ_URL: auditDlq.queueUrl,
        REDIS_URL: redisEndpoint,
        // Retrieval backend — PG* fields let the app compose
        // RETRIEVAL_BACKEND_URL. PGHOST + PGPORT are non-secret (RDS
        // endpoint); PGUSER + PGPASSWORD come from the credentials
        // secret below. If you want to point at an external backend
        // instead, set RETRIEVAL_BACKEND_URL directly and leave PG*
        // blank — the URL takes precedence.
        PGHOST: database.instanceEndpoint.hostname,
        PGPORT: database.instanceEndpoint.port.toString(),
        PGDATABASE: "almanac",
        KMS_KEY_ID: tokenKmsKey.keyId,
        NODE_ENV: "production",
      },
      secrets: {
        SLACK_BOT_TOKEN: ecs.Secret.fromSecretsManager(appSecrets, "SLACK_BOT_TOKEN"),
        SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(appSecrets, "SLACK_SIGNING_SECRET"),
        SLACK_APP_TOKEN: ecs.Secret.fromSecretsManager(appSecrets, "SLACK_APP_TOKEN"),
        WORKOS_API_KEY: ecs.Secret.fromSecretsManager(appSecrets, "WORKOS_API_KEY"),
        // WORKOS_DIRECTORY_ID isn't cryptographically sensitive, but
        // pulling it from the same secret as the API key keeps deploys
        // operator-env-independent — one file seeds both.
        WORKOS_DIRECTORY_ID: ecs.Secret.fromSecretsManager(appSecrets, "WORKOS_DIRECTORY_ID"),
        NOTION_OAUTH_CLIENT_ID: ecs.Secret.fromSecretsManager(appSecrets, "NOTION_OAUTH_CLIENT_ID"),
        NOTION_OAUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets,
          "NOTION_OAUTH_CLIENT_SECRET",
        ),
        CONFLUENCE_OAUTH_CLIENT_ID: ecs.Secret.fromSecretsManager(
          appSecrets,
          "CONFLUENCE_OAUTH_CLIENT_ID",
        ),
        CONFLUENCE_OAUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets,
          "CONFLUENCE_OAUTH_CLIENT_SECRET",
        ),
        GOOGLE_OAUTH_CLIENT_ID: ecs.Secret.fromSecretsManager(appSecrets, "GOOGLE_OAUTH_CLIENT_ID"),
        GOOGLE_OAUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets,
          "GOOGLE_OAUTH_CLIENT_SECRET",
        ),
        STATE_SIGNING_SECRET: ecs.Secret.fromSecretsManager(appSecrets, "STATE_SIGNING_SECRET"),
        // RDS master credentials — rotated independently of the app
        // secret. `.secret!` is safe here: fromGeneratedSecret always
        // populates the underlying Secrets Manager secret.
        PGUSER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "almanac",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      healthCheck: {
        // `curl` is not in node:20-alpine — use the same node one-liner
        // the Dockerfile HEALTHCHECK uses.
        command: [
          "CMD-SHELL",
          "node -e \"require('http').get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
      portMappings: [{ containerPort: 3001 }],
    });

    // Multi-instance in prod - REQUIRES Redis for shared rate-limit state.
    // `serviceName` is pinned so the smoke script can find it deterministically.
    const service = new ecs.FargateService(this, "AlmanacService", {
      cluster,
      serviceName: `almanac-${props.environment}`,
      taskDefinition: taskDef,
      desiredCount: isProd ? 2 : 1,
      // Rolling deploy window: prod keeps ≥1 task serving (100% min healthy
      // across 2 desired) and can briefly run 3 tasks to avoid capacity
      // dips. Staging (1 desired) allows a full cut-over.
      minHealthyPercent: isProd ? 100 : 0,
      maxHealthyPercent: isProd ? 150 : 100,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: !isProd,
      circuitBreaker: { rollback: true },
    });

    redisSg.addIngressRule(
      ec2.Peer.securityGroupId(service.connections.securityGroups[0]?.securityGroupId ?? ""),
      ec2.Port.tcp(6379),
      "Almanac ECS to Redis",
    );

    dbSg.addIngressRule(
      ec2.Peer.securityGroupId(service.connections.securityGroups[0]?.securityGroupId ?? ""),
      ec2.Port.tcp(5432),
      "Almanac ECS to Postgres",
    );

    // ─── Public edge ────────────────────────────────────────────────
    // Internet-facing ALB in the VPC's public subnets, forwarding 80/443
    // to the ECS task's container port 3001. The ALB is the public entry
    // for /health (smoke) and /oauth/:provider/{start,callback} (real OAuth).
    //
    // Security posture: the ALB's SG is open to 0.0.0.0/0 on 80 (and 443
    // when HTTPS is configured); the ECS service SG only allows ingress
    // from the ALB SG on 3001 — tasks remain unreachable from the
    // internet directly.
    const alb = new elbv2.ApplicationLoadBalancer(this, "AlmanacAlb", {
      vpc,
      internetFacing: true,
      loadBalancerName: `almanac-${props.environment}`,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "AlmanacTargetGroup", {
      vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    service.attachToApplicationTargetGroup(targetGroup);

    // ─── HTTPS resolution ──────────────────────────────────────────
    // Three deploy shapes, in descending preference:
    //   1. CDK-managed cert + Route 53 alias  (hostedZoneId + domainName)
    //   2. BYO cert ARN                       (certArn [+ optional domainName])
    //   3. HTTP-only smoke mode               (neither)
    // Sources are mutually checked in that order — the most-managed wins.
    let listenerCertificate: elbv2.IListenerCertificate | undefined;
    if (props.hostedZoneId && props.domainName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "AlmanacHostedZone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: parentZoneName(props.domainName),
      });
      const cert = new acm.Certificate(this, "AlmanacCert", {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
      listenerCertificate = elbv2.ListenerCertificate.fromCertificateManager(cert);
      // Alias the domain at the ALB so users hit `https://<domainName>`.
      new route53.ARecord(this, "AlmanacAlias", {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
      });
    } else if (props.certArn) {
      listenerCertificate = elbv2.ListenerCertificate.fromArn(props.certArn);
    }

    if (listenerCertificate) {
      alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [listenerCertificate],
        defaultTargetGroups: [targetGroup],
      });
      alb.addListener("HttpRedirect", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      // Smoke / dev shape: plain HTTP. Real OAuth callbacks will not work
      // in this mode — most providers (Notion, Google, Atlassian) reject
      // non-HTTPS redirect URIs.
      alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
      });
    }

    const appBaseUrl = props.domainName
      ? `https://${props.domainName}`
      : listenerCertificate
        ? `https://${alb.loadBalancerDnsName}`
        : `http://${alb.loadBalancerDnsName}`;

    container.addEnvironment("APP_BASE_URL", appBaseUrl);

    new cloudwatch.Dashboard(this, "AlmanacDashboard", {
      dashboardName: `Almanac-${props.environment}`,
    });

    // Outputs
    new cdk.CfnOutput(this, "TokenTableName", { value: tokenTable.tableName });
    new cdk.CfnOutput(this, "AuditTableName", { value: auditTable.tableName });
    new cdk.CfnOutput(this, "AuditQueueUrl", { value: auditQueue.queueUrl });
    new cdk.CfnOutput(this, "AuditDlqUrl", { value: auditDlq.queueUrl });
    new cdk.CfnOutput(this, "AuditBucketName", { value: auditBucket.bucketName });
    new cdk.CfnOutput(this, "TokenKmsKeyId", { value: tokenKmsKey.keyId });
    new cdk.CfnOutput(this, "AppSecretsArn", { value: appSecrets.secretArn });
    new cdk.CfnOutput(this, "DatabaseEndpoint", { value: database.instanceEndpoint.hostname });
    new cdk.CfnOutput(this, "DatabaseSecretArn", { value: database.secret!.secretArn });
    new cdk.CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "ServiceUrl", {
      value: appBaseUrl,
      description: "Public base URL — used by smoke tests and as APP_BASE_URL",
    });
    new cdk.CfnOutput(this, "ServiceName", { value: service.serviceName });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
  }
}

/**
 * Strip the leftmost label from a fully-qualified subdomain to get the
 * apex zone (`almanac-staging.example.com` → `example.com`). Apex
 * deployments (`example.com` itself) return unchanged.
 */
function parentZoneName(fqdn: string): string {
  const parts = fqdn.split(".");
  return parts.length <= 2 ? fqdn : parts.slice(1).join(".");
}
