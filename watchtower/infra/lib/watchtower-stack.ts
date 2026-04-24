/**
 * Watchtower CDK stack.
 *
 * Composition of @nanohype/cdk-constructs for the worker-service +
 * Bedrock + OTel shape. Deploy target: AWS — region driven by
 * CDK_DEFAULT_REGION / AWS_REGION env vars (fallback us-west-2). Set
 * in infra/bin/app.ts.
 *
 * Resources provisioned:
 *   - VPC with public + private-egress subnets (NAT: 1 staging / 2 prod)
 *   - RDS Postgres 16 with pgvector (rule corpus). Extension created
 *     app-side on boot — almanac's idempotent pattern.
 *   - DynamoDB x4: per-client config, dedup state, memos (envelope-
 *     encrypted), audit hot table (90d TTL, lifecycles to S3 via Lambda)
 *   - SQS + DLQ x4: crawl → classify → publish → audit stage handoff.
 *     Audit is FIFO so dedup is exactly-once per (clientId, eventHash).
 *   - EventBridge Scheduler: per-source crawl cadence, targets the
 *     crawl queue with `{source}` payload.
 *   - S3 audit archive (1y lifecycle, intelligent tiering after 90d)
 *   - KMS customer-managed envelope key (for memos DDB SSE)
 *   - Secrets Manager: OAuth + notification credentials, seed-
 *     placeholder on CREATE + preserve-on-UPDATE.
 *   - Bedrock invocation logging disabled (account+region setting
 *     owned by this stack).
 *   - ECS Fargate cluster + WorkerService (no ALB — pure worker)
 *   - ADOT collector sidecar — traces → X-Ray, metrics →
 *     CloudWatch EMF.
 *   - Lambda audit consumer (SQS → DDB + S3) — composing SqsWithDlq
 *     with a handwritten Lambda since the library doesn't ship one yet.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  AppSecrets,
  ArchiveBucket,
  BedrockLoggingDisabled,
  containerFromAsset,
  CronSchedule,
  DynamoTable,
  EnvelopeKey,
  OtelSidecar,
  PgvectorDatabase,
  SqsWithDlq,
  WorkerService,
} from "@nanohype/cdk-constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const infraRoot = path.join(__dirname, "..");

export interface WatchtowerStackProps extends cdk.StackProps {
  readonly environment: "staging" | "production";
}

interface CrawlSource {
  readonly id: string;
  readonly scheduleExpression: string;
  readonly sourceName: string;
}

// Seed set; extend as feed adapters land in src/crawlers/.
const CRAWL_SOURCES: readonly CrawlSource[] = [
  { id: "SecEdgar", scheduleExpression: "rate(1 hour)", sourceName: "sec-edgar" },
  { id: "Cfpb", scheduleExpression: "rate(1 hour)", sourceName: "cfpb" },
  { id: "Ofac", scheduleExpression: "rate(30 minutes)", sourceName: "ofac" },
  { id: "Edpb", scheduleExpression: "rate(6 hours)", sourceName: "edpb" },
];

export class WatchtowerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WatchtowerStackProps) {
    super(scope, id, props);
    const { environment } = props;
    const isProd = environment === "production";

    // ─── Bedrock posture ────────────────────────────────────────────
    // Account+region scoped. Source content must never reach CloudWatch
    // or S3 logs. This stack owns the setting and asserts disabled on
    // every deploy.
    new BedrockLoggingDisabled(this, "BedrockLoggingDisabled", {
      identifier: `watchtower-${environment}`,
    });

    // ─── Networking ─────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // ─── KMS envelope key ────────────────────────────────────────────
    // Used for DDB CUSTOMER_MANAGED encryption of the memos table,
    // which can carry classifier rationales and draft memo bodies
    // containing per-client sensitive mappings.
    const envelopeKey = new EnvelopeKey(this, "EnvelopeKey", {
      purpose: "watchtower per-client sensitive payload envelope",
      aliasName: `watchtower-envelope-${environment}`,
    });

    // ─── Rule corpus (pgvector) ─────────────────────────────────────
    // The CREATE EXTENSION vector bootstrap runs app-side on boot —
    // almanac's pattern, idempotent, no CDK custom resource needed.
    const corpus = new PgvectorDatabase(this, "Corpus", {
      vpc,
      databaseName: `watchtower_${environment}`,
      credentialSecretName: `watchtower/${environment}/db-credentials`,
      isProd,
    });

    // ─── Domain tables ──────────────────────────────────────────────

    // Per-client config — products × jurisdictions × frameworks. Read-
    // heavy; the worker loads active clients on startup and on signal.
    const clientsTable = new DynamoTable(this, "Clients", {
      tableName: `watchtower-clients-${environment}`,
      partitionKey: { name: "clientId", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: null,
      isProd,
    });

    // Crawler dedup — (sourceId, contentHash) → firstSeenAt. Guards
    // against re-emitting the same rule change across crawl runs.
    const dedupTable = new DynamoTable(this, "Dedup", {
      tableName: `watchtower-dedup-${environment}`,
      partitionKey: { name: "sourceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "contentHash", type: dynamodb.AttributeType.STRING },
      isProd,
    });

    // Memo lifecycle — one row per (memoId, clientId). byStatus GSI
    // surfaces a filterable queue for human reviewers and the
    // approval-gate consumer.
    const memosTable = new DynamoTable(this, "Memos", {
      tableName: `watchtower-memos-${environment}`,
      partitionKey: { name: "memoId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "clientId", type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: envelopeKey.key,
      isProd,
      globalSecondaryIndexes: [
        {
          indexName: "byStatus",
          partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
    });

    // Audit hot table — 90d TTL; the Lambda consumer below also writes
    // each event to the audit archive bucket for long-term retention.
    const auditTable = new DynamoTable(this, "AuditLog", {
      tableName: `watchtower-audit-${environment}`,
      partitionKey: { name: "clientId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      isProd,
    });

    // ─── Audit archive (S3) ─────────────────────────────────────────
    const auditBucket = new ArchiveBucket(this, "AuditArchive", {
      bucketName: `watchtower-audit-${environment}-${this.account}`,
      isProd,
    });

    // ─── Stage handoff queues (SQS + DLQ) ───────────────────────────
    // Visibility timeouts size to each stage's p99 processing time + a
    // buffer. Audit is FIFO so deduplication is exactly-once per
    // (clientId, eventHash) — compliance records must not double-count.
    const crawlQueue = new SqsWithDlq(this, "CrawlQueue", {
      queueName: `watchtower-crawl-${environment}`,
      visibilityTimeout: cdk.Duration.minutes(5),
    });
    const classifyQueue = new SqsWithDlq(this, "ClassifyQueue", {
      queueName: `watchtower-classify-${environment}`,
      visibilityTimeout: cdk.Duration.minutes(2),
    });
    const publishQueue = new SqsWithDlq(this, "PublishQueue", {
      queueName: `watchtower-publish-${environment}`,
      visibilityTimeout: cdk.Duration.minutes(2),
    });
    const auditQueue = new SqsWithDlq(this, "AuditQueue", {
      queueName: `watchtower-audit-${environment}`,
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    // ─── App secrets ────────────────────────────────────────────────
    // OAuth client credentials for the service's Notion/Confluence
    // integrations, outbound notification API keys, and a random HMAC
    // signing secret for any signed URLs the app emits. Manual keys
    // ship as placeholders on CREATE; operators replace them via
    // `aws secretsmanager put-secret-value` and then force-new-deploy.
    const appSecrets = new AppSecrets(this, "AppSecrets", {
      secretName: `watchtower/${environment}/app-secrets`,
      manualKeys: [
        "NOTION_OAUTH_CLIENT_ID",
        "NOTION_OAUTH_CLIENT_SECRET",
        "CONFLUENCE_OAUTH_CLIENT_ID",
        "CONFLUENCE_OAUTH_CLIENT_SECRET",
        "SLACK_WEBHOOK_URL",
        "RESEND_API_KEY",
      ],
      generatedKeys: {
        STATE_SIGNING_SECRET: { length: 64 },
      },
    });

    // ─── Compute ────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `watchtower-${environment}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const worker = new WorkerService(this, "Worker", {
      cluster,
      serviceName: `watchtower-${environment}`,
      // `containerFromAsset` pins LINUX_AMD64 so builds on Apple
      // Silicon don't produce ARM images that fail on Fargate x86_64.
      // Exclusions keep `cdk.out/`, nested `node_modules/`, build
      // output, and editor junk out of the asset tarball so asset
      // packaging doesn't recurse through `infra/cdk.out/` into itself.
      image: containerFromAsset(projectRoot, {
        exclude: [
          ".git",
          ".env",
          ".env.*",
          "cdk.out",
          "coverage",
          "**/coverage",
          "dist",
          "**/dist",
          "infra",
          "node_modules",
          "**/node_modules",
        ],
      }),
      environment: {
        NODE_ENV: "production",
        AWS_REGION: this.region,
        CLIENTS_TABLE: clientsTable.table.tableName,
        DEDUP_TABLE: dedupTable.table.tableName,
        MEMOS_TABLE: memosTable.table.tableName,
        AUDIT_TABLE: auditTable.table.tableName,
        AUDIT_BUCKET: auditBucket.bucket.bucketName,
        CRAWL_QUEUE_URL: crawlQueue.queue.queueUrl,
        CLASSIFY_QUEUE_URL: classifyQueue.queue.queueUrl,
        PUBLISH_QUEUE_URL: publishQueue.queue.queueUrl,
        AUDIT_QUEUE_URL: auditQueue.queue.queueUrl,
        CORPUS_HOST: corpus.instance.instanceEndpoint.hostname,
        CORPUS_PORT: corpus.instance.instanceEndpoint.port.toString(),
        CORPUS_DATABASE: `watchtower_${environment}`,
        ENVELOPE_KMS_KEY_ID: envelopeKey.key.keyId,
      },
      secrets: {
        CORPUS_USER: ecs.Secret.fromSecretsManager(corpus.credentialSecret, "username"),
        CORPUS_PASSWORD: ecs.Secret.fromSecretsManager(corpus.credentialSecret, "password"),
        NOTION_OAUTH_CLIENT_ID: ecs.Secret.fromSecretsManager(
          appSecrets.secret,
          "NOTION_OAUTH_CLIENT_ID",
        ),
        NOTION_OAUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets.secret,
          "NOTION_OAUTH_CLIENT_SECRET",
        ),
        CONFLUENCE_OAUTH_CLIENT_ID: ecs.Secret.fromSecretsManager(
          appSecrets.secret,
          "CONFLUENCE_OAUTH_CLIENT_ID",
        ),
        CONFLUENCE_OAUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets.secret,
          "CONFLUENCE_OAUTH_CLIENT_SECRET",
        ),
        SLACK_WEBHOOK_URL: ecs.Secret.fromSecretsManager(appSecrets.secret, "SLACK_WEBHOOK_URL"),
        RESEND_API_KEY: ecs.Secret.fromSecretsManager(appSecrets.secret, "RESEND_API_KEY"),
        STATE_SIGNING_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets.secret,
          "STATE_SIGNING_SECRET",
        ),
      },
      cpu: isProd ? 1024 : 512,
      memoryLimitMiB: isProd ? 2048 : 1024,
      desiredCount: isProd ? 2 : 1,
      enableExecute: !isProd,
      additionalSecurityGroups: [corpus.securityGroup],
    });

    // ─── Telemetry sidecar ──────────────────────────────────────────
    // App emits OTLP to localhost:4317 (gRPC) or localhost:4318 (HTTP).
    // Traces → X-Ray, metrics → CloudWatch EMF.
    new OtelSidecar(this, "OtelSidecar", {
      taskDefinition: worker.taskDefinition,
      serviceName: "watchtower",
      environment,
    });

    // ─── Worker IAM (least-privilege) ───────────────────────────────
    clientsTable.table.grantReadData(worker.taskDefinition.taskRole);
    dedupTable.table.grantReadWriteData(worker.taskDefinition.taskRole);
    memosTable.table.grantReadWriteData(worker.taskDefinition.taskRole);
    auditTable.table.grantReadWriteData(worker.taskDefinition.taskRole);
    auditBucket.bucket.grantReadWrite(worker.taskDefinition.taskRole);
    crawlQueue.queue.grantSendMessages(worker.taskDefinition.taskRole);
    crawlQueue.queue.grantConsumeMessages(worker.taskDefinition.taskRole);
    classifyQueue.queue.grantSendMessages(worker.taskDefinition.taskRole);
    classifyQueue.queue.grantConsumeMessages(worker.taskDefinition.taskRole);
    publishQueue.queue.grantSendMessages(worker.taskDefinition.taskRole);
    publishQueue.queue.grantConsumeMessages(worker.taskDefinition.taskRole);
    auditQueue.queue.grantSendMessages(worker.taskDefinition.taskRole);
    envelopeKey.key.grantEncryptDecrypt(worker.taskDefinition.taskRole);

    // Bedrock — Claude Sonnet 4.6 via cross-region inference profile;
    // Titan embeddings for the rule corpus. Version suffix wildcarded
    // so model bumps don't require a stack update.
    worker.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvoke",
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2*`,
        ],
      }),
    );

    // CloudWatch metrics — namespace-scoped; PutMetricData has no ARN
    // so resource="*" is the canonical pattern.
    worker.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchPutMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "Watchtower" } },
      }),
    );

    // ─── Audit consumer Lambda (SQS → DDB + S3) ─────────────────────
    // Not yet covered by @nanohype/cdk-constructs. Source lives at
    // `infra/lambda/audit-consumer.ts` and is bundled by esbuild via
    // `NodejsFunction` — AWS SDK v3 is provided by the NODEJS_24_X
    // runtime, so it's marked as external and not bundled.
    const auditConsumerLogGroup = new logs.LogGroup(this, "AuditConsumerLogGroup", {
      logGroupName: `/aws/lambda/watchtower-audit-consumer-${environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const auditConsumer = new lambdaNodejs.NodejsFunction(this, "AuditConsumer", {
      functionName: `watchtower-audit-consumer-${environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(infraRoot, "lambda", "audit-consumer.ts"),
      projectRoot: infraRoot,
      depsLockFilePath: path.join(infraRoot, "package-lock.json"),
      handler: "handler",
      environment: {
        AUDIT_TABLE: auditTable.table.tableName,
        AUDIT_BUCKET: auditBucket.bucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: auditConsumerLogGroup,
      bundling: {
        target: "node24",
        format: lambdaNodejs.OutputFormat.ESM,
        // Node 24 Lambda runtime ships the AWS SDK v3 in the managed
        // execution environment; bundling it would waste cold-start time
        // and image size.
        externalModules: ["@aws-sdk/*"],
      },
    });

    auditTable.table.grantWriteData(auditConsumer);
    auditBucket.bucket.grantPut(auditConsumer);

    auditConsumer.addEventSource(
      new lambdaEventSources.SqsEventSource(auditQueue.queue, {
        batchSize: 10,
        // Per-record failure reporting — lets SQS redrive only the
        // failures in a partial batch, not the whole batch.
        reportBatchItemFailures: true,
      }),
    );

    // ─── Per-source crawl schedules ─────────────────────────────────
    // Each schedule enqueues `{source}` onto the crawl queue; the
    // shared crawler worker fans out to the right adapter via the
    // registry in src/crawlers/.
    for (const src of CRAWL_SOURCES) {
      new CronSchedule(this, `Crawl${src.id}`, {
        scheduleName: `watchtower-crawl-${src.sourceName}-${environment}`,
        scheduleExpression: src.scheduleExpression,
        target: {
          arn: crawlQueue.queue.queueArn,
          input: JSON.stringify({ source: src.sourceName }),
          actions: ["sqs:SendMessage"],
        },
      });
    }

    // ─── Stack outputs ──────────────────────────────────────────────
    // `ServiceName` + `ClusterName` make post-deploy smoke scripts
    // deterministic. `CorpusEndpoint` + `AppSecretsName` surface the
    // two endpoints operators need for seed / migrate workflows.
    new cdk.CfnOutput(this, "ServiceName", { value: worker.service.serviceName });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "CorpusEndpoint", {
      value: corpus.instance.instanceEndpoint.hostname,
    });
    new cdk.CfnOutput(this, "AppSecretsName", { value: appSecrets.secret.secretName });
    new cdk.CfnOutput(this, "AuditBucketName", { value: auditBucket.bucket.bucketName });
    new cdk.CfnOutput(this, "MemosTableName", { value: memosTable.table.tableName });
  }
}
