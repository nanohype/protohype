/**
 * Palisade CDK Stack
 * Deploy target: AWS — region driven by CDK_DEFAULT_REGION env var
 * (fallback us-west-2). Set in infra/bin/app.ts.
 *
 * Built on @nanohype/cdk-constructs v0.1.0 for the shared shapes
 * (pgvector, DDB, Redis, SQS+DLQ, ArchiveBucket, EnvelopeKey,
 * AppSecrets, BedrockLoggingDisabled, OtelSidecar, AlbWithTls,
 * containerFromAsset, grantEcsExec).
 *
 * Hand-rolled because the library doesn't cover them yet:
 *   - Lambda SQS → S3 attack-log consumer
 *   - CloudWatch app-metric alarms (palisade-specific namespace)
 *   - Task role policies (palisade-specific resource ARNs)
 *   - The ECS FargateService itself — WorkerService is ALB-less by
 *     design; palisade needs ALB routing, so we construct our own
 *     FargateService and attach target groups from AlbWithTls.
 *
 * The label-approval gate stays bespoke in src/gate/ — it's a palisade
 * business primitive, not a reusable CDK shape.
 */
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import {
  AlbWithTls,
  AppSecrets,
  ArchiveBucket,
  BedrockLoggingDisabled,
  DynamoTable,
  EnvelopeKey,
  OtelSidecar,
  PgvectorDatabase,
  RedisCluster,
  SqsWithDlq,
  containerFromAsset,
  grantEcsExec,
  type AlbTlsMode,
} from "@nanohype/cdk-constructs";

export interface PalisadeStackProps extends cdk.StackProps {
  environment: "staging" | "production";
  /** ACM cert ARN (BYO); mutually exclusive with `hostedZoneId`. */
  certArn?: string;
  /** Public domain, e.g. palisade-staging.example.com. */
  domainName?: string;
  /** Route 53 hosted zone for the apex. Triggers managed cert + alias when set with domainName. */
  hostedZoneId?: string;
  /** Apex zone name for the managed-cert shape, e.g. `example.com`. */
  hostedZoneName?: string;
}

export class PalisadeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PalisadeStackProps) {
    super(scope, id, props);
    const isProd = props.environment === "production";
    const envName = props.environment;

    // ── Bedrock invocation logging: disabled at deploy time ─────────
    new BedrockLoggingDisabled(this, "DisableBedrockLogging", {
      identifier: `palisade-${envName}`,
    });

    // ── KMS envelope key (for future audit-metadata encryption) ─────
    const envelopeKey = new EnvelopeKey(this, "AuditKey", {
      purpose: "palisade audit payload envelope encryption",
      aliasName: `palisade-audit-${envName}`,
    });

    // ── VPC ─────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "PalisadeVpc", {
      maxAzs: 2,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // ── Audit log table (DDB, single-table, marshal shape) ──────────
    // PK=ATTEMPT#<id>, SK=AUDIT#<ts>#<type>. `TTL` attribute matches
    // the capitalization in src/audit/audit-log.ts's AuditEvent shape.
    const auditTable = new DynamoTable(this, "AuditLog", {
      tableName: `palisade-audit-${envName}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "TTL",
      isProd,
    });

    // ── Label queue table (DDB + status-index GSI) ──────────────────
    // PK=DRAFT#<id>, SK=META. Reviewers query by status via the GSI.
    const labelQueueTable = new DynamoTable(this, "LabelQueue", {
      tableName: `palisade-label-queue-${envName}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      isProd,
      globalSecondaryIndexes: [
        {
          indexName: "status-index",
          partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "proposedAt", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
    });

    // ── S3 attack archive ──────────────────────────────────────────
    const archiveBucket = new ArchiveBucket(this, "AttackArchive", {
      bucketName: `palisade-attack-archive-${envName}-${this.account}`,
      isProd,
      intelligentTieringAfterDays: 30,
      expirationDays: 365,
    });

    // ── SQS + DLQ: attack-log fan-out ──────────────────────────────
    const attackQueue = new SqsWithDlq(this, "AttackLog", {
      queueName: `palisade-attack-log-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      dlqDepthAlarmThreshold: 1,
    });

    // ── Lambda: attack-log → S3 consumer ───────────────────────────
    // Not yet in @nanohype/cdk-constructs — hand-rolled for now.
    const consumerRole = new iam.Role(this, "AttackConsumerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    archiveBucket.bucket.grantPut(consumerRole);

    const consumerLogGroup = new logs.LogGroup(this, "AttackConsumerLogGroup", {
      logGroupName: `/aws/lambda/palisade-attack-consumer-${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const attackConsumer = new lambda.Function(this, "AttackConsumer", {
      functionName: `palisade-attack-consumer-${envName}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
        const s3 = new S3Client({});
        exports.handler = async (event) => {
          for (const record of event.Records) {
            const ev = JSON.parse(record.body);
            const date = (ev.timestamp || new Date().toISOString()).slice(0, 10);
            const key = 'attack/' + date + '/' + (ev.attemptId || record.messageId) + '.json';
            await s3.send(new PutObjectCommand({ Bucket: process.env.ARCHIVE_BUCKET, Key: key, Body: JSON.stringify(ev), ContentType: 'application/json' }));
          }
        };
      `),
      environment: { ARCHIVE_BUCKET: archiveBucket.bucket.bucketName },
      role: consumerRole,
      timeout: cdk.Duration.seconds(30),
      logGroup: consumerLogGroup,
    });
    attackConsumer.addEventSource(
      new lambdaEventSources.SqsEventSource(attackQueue.queue, { batchSize: 10 })
    );

    // ── Detection-rate alarms (namespace "Palisade") ───────────────
    // Hand-rolled — palisade-specific metric names. A dashboard-helper
    // construct is not yet in the library.
    const envDim = { Environment: envName };
    const appMetric = (name: string, stat = "Average") =>
      new cloudwatch.Metric({
        namespace: "Palisade",
        metricName: name,
        dimensionsMap: envDim,
        statistic: stat,
        period: cdk.Duration.minutes(5),
      });

    new cloudwatch.Alarm(this, "FalsePositiveSpikeAlarm", {
      metric: appMetric("palisade.detection.blocked", "Sum"),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription:
        "Palisade detection.blocked > 100 in 5 min — either a real attack burst or a bad heuristic deployment",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, "GateVerificationFailedAlarm", {
      metric: appMetric("palisade.gate.verification_failed", "Sum"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Palisade: corpus write blocked by missing LABEL_APPROVED — investigate immediately",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, "UpstreamLatencyP95Alarm", {
      metric: appMetric("palisade.upstream.latency_ms", "p95"),
      threshold: 15_000,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: "Palisade upstream p95 > 15s for 15 minutes",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── Compute (ECS Fargate, ALB-bound — ALB routing needed) ──────
    const cluster = new ecs.Cluster(this, "PalisadeCluster", {
      vpc,
      clusterName: `palisade-${envName}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const serviceSg = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc,
      description: "Palisade Fargate service SG",
      allowAllOutbound: true,
    });

    // ── Shared data-plane (depend on serviceSg for ingress wiring) ─
    const redis = new RedisCluster(this, "Redis", {
      vpc,
      computeSecurityGroup: serviceSg,
      replicationGroupId: `palisade-rl-${envName}`,
      isProd,
    });

    const db = new PgvectorDatabase(this, "Corpus", {
      vpc,
      computeSecurityGroup: serviceSg,
      databaseName: "palisade",
      isProd,
    });
    // pgvector `CREATE EXTENSION vector` + attack_corpus schema are
    // bootstrapped idempotently by the app on startup — see docs/runbook.md.

    // ── Secrets Manager (seed-on-create, preserve-on-update) ───────
    const appSecrets = new AppSecrets(this, "AppSecrets", {
      secretName: `palisade/${envName}/app-secrets`,
      manualKeys: ["ADMIN_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS"],
      generatedKeys: { INTERNAL_SIGNING_SECRET: { length: 64 } },
    });

    // ── Task definition, role, and container ─────────────────────
    const taskRole = new iam.Role(this, "PalisadeTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    auditTable.table.grantReadWriteData(taskRole);
    labelQueueTable.table.grantReadWriteData(taskRole);
    attackQueue.queue.grantSendMessages(taskRole);
    attackQueue.dlq.grantSendMessages(taskRole);
    envelopeKey.key.grantEncryptDecrypt(taskRole);
    appSecrets.secret.grantRead(taskRole);

    // Bedrock: classifier + embedding models only. Wildcard the
    // version suffix so bumping doesn't require a stack update.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5*`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*`,
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2*`,
        ],
      })
    );

    // CloudWatch PutMetricData — namespace-scoped
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "Palisade" } },
      })
    );

    const taskDef = new ecs.FargateTaskDefinition(this, "PalisadeTask", {
      cpu: isProd ? 1024 : 512,
      memoryLimitMiB: isProd ? 2048 : 1024,
      taskRole,
    });

    // App container. App-side OTel SDK points at `http://localhost:4318`;
    // the ADOT sidecar (added below) terminates OTLP.
    const container = taskDef.addContainer("palisade", {
      image: containerFromAsset(path.join(__dirname, "..", "..")),
      environment: {
        AWS_REGION: this.region,
        DDB_TABLE_AUDIT: auditTable.table.tableName,
        DDB_TABLE_LABEL_QUEUE: labelQueueTable.table.tableName,
        SQS_ATTACK_LOG_URL: attackQueue.queue.queueUrl,
        SQS_ATTACK_LOG_DLQ_URL: attackQueue.dlq.queueUrl,
        S3_ARCHIVE_BUCKET: archiveBucket.bucket.bucketName,
        REDIS_URL: `rediss://${redis.primaryEndpointAddress}:${redis.primaryEndpointPort}`,
        BEDROCK_REGION: this.region,
        PGHOST: db.instance.instanceEndpoint.hostname,
        PGPORT: db.instance.instanceEndpoint.port.toString(),
        PGDATABASE: "palisade",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_SERVICE_NAME: "palisade",
        NODE_ENV: "production",
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(db.credentialSecret, "username"),
        PGPASSWORD: ecs.Secret.fromSecretsManager(db.credentialSecret, "password"),
        ADMIN_API_KEY: ecs.Secret.fromSecretsManager(appSecrets.secret, "ADMIN_API_KEY"),
        INTERNAL_SIGNING_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets.secret,
          "INTERNAL_SIGNING_SECRET"
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "palisade",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"require('http').get('http://localhost:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
      portMappings: [{ containerPort: 8080 }],
    });

    // ADOT sidecar — one span per detection layer → X-Ray + metrics → CW.
    new OtelSidecar(this, "Otel", {
      taskDefinition: taskDef,
      serviceName: "palisade",
      environment: envName,
    });

    // ECS Exec in staging only — live-debug the service.
    if (!isProd) grantEcsExec(taskDef);

    const service = new ecs.FargateService(this, "PalisadeService", {
      cluster,
      serviceName: `palisade-${envName}`,
      taskDefinition: taskDef,
      desiredCount: isProd ? 2 : 1,
      minHealthyPercent: isProd ? 100 : 0,
      maxHealthyPercent: isProd ? 150 : 100,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSg],
      enableExecuteCommand: !isProd,
      circuitBreaker: { rollback: true },
    });

    // ── Public edge: ALB with env-driven TLS ────────────────────────
    const tls: AlbTlsMode =
      props.hostedZoneId && props.domainName && props.hostedZoneName
        ? {
            mode: "managed-cert",
            domainName: props.domainName,
            hostedZoneId: props.hostedZoneId,
            hostedZoneName: props.hostedZoneName,
          }
        : props.certArn && props.domainName
          ? { mode: "byo-cert", domainName: props.domainName, certArn: props.certArn }
          : { mode: "http-only" };

    const front = new AlbWithTls(this, "PalisadeFront", {
      vpc,
      tls,
      internetFacing: true,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "PalisadeTargetGroup", {
      vpc,
      port: 8080,
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

    // Attach the target group to whichever listener the TLS shape produced.
    if (front.httpsListener) {
      front.httpsListener.addTargetGroups("Default", { targetGroups: [targetGroup] });
    } else {
      front.httpListener.addTargetGroups("Default", { targetGroups: [targetGroup] });
    }

    const serviceUrl = props.domainName
      ? `https://${props.domainName}`
      : front.httpsListener
        ? `https://${front.alb.loadBalancerDnsName}`
        : `http://${front.alb.loadBalancerDnsName}`;
    container.addEnvironment("PALISADE_BASE_URL", serviceUrl);

    new cloudwatch.Dashboard(this, "PalisadeDashboard", { dashboardName: `Palisade-${envName}` });

    // ── Outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "AuditTableName", { value: auditTable.table.tableName });
    new cdk.CfnOutput(this, "LabelQueueTableName", { value: labelQueueTable.table.tableName });
    new cdk.CfnOutput(this, "AttackQueueUrl", { value: attackQueue.queue.queueUrl });
    new cdk.CfnOutput(this, "AttackDlqUrl", { value: attackQueue.dlq.queueUrl });
    new cdk.CfnOutput(this, "ArchiveBucketName", { value: archiveBucket.bucket.bucketName });
    new cdk.CfnOutput(this, "AuditKmsKeyId", { value: envelopeKey.key.keyId });
    new cdk.CfnOutput(this, "AppSecretsArn", { value: appSecrets.secret.secretArn });
    new cdk.CfnOutput(this, "DatabaseEndpoint", { value: db.instance.instanceEndpoint.hostname });
    new cdk.CfnOutput(this, "DatabaseSecretArn", { value: db.credentialSecret.secretArn });
    new cdk.CfnOutput(this, "RedisEndpoint", { value: redis.primaryEndpointAddress });
    new cdk.CfnOutput(this, "AlbDnsName", { value: front.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "ServiceUrl", {
      value: serviceUrl,
      description: "Public base URL — used by smoke tests",
    });
    new cdk.CfnOutput(this, "ServiceName", { value: service.serviceName });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
  }
}
