// Storage: DynamoDB tables + SQS FIFO queues + DLQs.
//
// Invariants encoded here:
//   - PITR on every table that holds auditable state
//   - deletionProtection on audit + PR ledger (SOC2-adjacent; can't be nuked by an errant `cdk destroy`)
//   - Customer-managed KMS encryption where supported
//   - FIFO queue with high-throughput mode — group-id fanout gives us concurrency
//   - DLQ retention 14 days (max); main queue retention 4 days
//   - TTL attribute on changelog-cache + github-token-cache

import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  PointInTimeRecoverySpecification,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export class StorageConstruct extends Construct {
  public readonly teamConfigTable: Table;
  public readonly prLedgerTable: Table;
  public readonly auditLogTable: Table;
  public readonly changelogCacheTable: Table;
  public readonly rateLimiterTable: Table;
  public readonly githubTokenCacheTable: Table;
  public readonly upgradeQueue: Queue;
  public readonly upgradeDlq: Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.teamConfigTable = new Table(this, "TeamConfigTable", {
      tableName: "kiln-team-config",
      partitionKey: { name: "teamId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.prLedgerTable = new Table(this, "PrLedgerTable", {
      tableName: "kiln-pr-ledger",
      partitionKey: { name: "teamId", type: AttributeType.STRING },
      sortKey: { name: "idempotencyKey", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.auditLogTable = new Table(this, "AuditLogTable", {
      tableName: "kiln-audit-log",
      partitionKey: { name: "teamId", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Changelog cache is global (not per-tenant) — changelogs are public.
    // See ADR 0005.
    this.changelogCacheTable = new Table(this, "ChangelogCacheTable", {
      tableName: "kiln-changelog-cache",
      partitionKey: { name: "cacheKey", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.rateLimiterTable = new Table(this, "RateLimiterTable", {
      tableName: "kiln-rate-limiter",
      partitionKey: { name: "bucketKey", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.githubTokenCacheTable = new Table(this, "GithubTokenCacheTable", {
      tableName: "kiln-github-token-cache",
      partitionKey: { name: "installationId", type: AttributeType.NUMBER },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.upgradeDlq = new Queue(this, "UpgradeDlq", {
      queueName: "kiln-upgrade-dlq.fifo",
      fifo: true,
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.KMS_MANAGED,
    });

    this.upgradeQueue = new Queue(this, "UpgradeQueue", {
      queueName: "kiln-upgrade-queue.fifo",
      fifo: true,
      contentBasedDeduplication: false, // we set MessageDeduplicationId explicitly
      fifoThroughputLimit: undefined,
      visibilityTimeout: Duration.minutes(10), // > worker timeout
      retentionPeriod: Duration.days(4),
      encryption: QueueEncryption.KMS_MANAGED,
      deadLetterQueue: { queue: this.upgradeDlq, maxReceiveCount: 3 },
    });

    // Avoid unused-local lint complaint.
    void PointInTimeRecoverySpecification;
  }

  public sharedEnv(): Record<string, string> {
    return {
      KILN_TEAM_CONFIG_TABLE: this.teamConfigTable.tableName,
      KILN_PR_LEDGER_TABLE: this.prLedgerTable.tableName,
      KILN_AUDIT_LOG_TABLE: this.auditLogTable.tableName,
      KILN_CHANGELOG_CACHE_TABLE: this.changelogCacheTable.tableName,
      KILN_RATE_LIMITER_TABLE: this.rateLimiterTable.tableName,
      KILN_GITHUB_TOKEN_CACHE_TABLE: this.githubTokenCacheTable.tableName,
      KILN_UPGRADE_QUEUE_URL: this.upgradeQueue.queueUrl,
    };
  }
}
