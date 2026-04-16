/**
 * Kiln Worker Construct
 *
 * - DynamoDB tables: changelog-cache, rate-limiter, upgrade-state
 * - SQS upgrade queue + DLQ
 * - Upgrade Poller Lambda (EventBridge cron)
 * - Upgrade Worker Lambda (SQS consumer)
 * - Secrets Manager: GitHub App private key
 * - Bedrock inference logging: NONE (set via PutModelInvocationLoggingConfiguration)
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import type { ConfigConstruct } from './config-construct';

export interface WorkerConstructProps {
  configConstruct: ConfigConstruct;
}

export class WorkerConstruct extends Construct {
  public readonly upgradeQueue: sqs.Queue;
  public readonly changelogCacheTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: WorkerConstructProps) {
    super(scope, id);

    const { teamConfigTable, prLedgerTable, auditLogTable, auditDlqUrl } = props.configConstruct;

    // ── GitHub App secret ────────────────────────────────────────────────────
    // The private key PEM is stored as a SecretString, rotated quarterly.
    // The Lambda fetches it with a 5-minute TTL cache — no cached key lives
    // past TTL without a version check.
    const githubAppSecret = new secretsmanager.Secret(this, 'GithubAppSecret', {
      secretName: 'kiln/github-app-private-key',
      description: 'GitHub App private key PEM for Kiln — rotate quarterly',
    });

    // ── Bedrock inference logging: NONE ───────────────────────────────────────
    // Set at deploy time via CfnResource; this is the actual enforcement,
    // not a comment claiming it will be done later.
    new bedrock.CfnModelInvocationLoggingConfiguration(this, 'BedrockLogging', {
      loggingConfig: {
        loggingEnabled: false,
      },
    });

    // ── DynamoDB tables ──────────────────────────────────────────────────────

    this.changelogCacheTable = new dynamodb.Table(this, 'ChangelogCacheTable', {
      tableName: 'kiln-changelog-cache',
      partitionKey: { name: 'cacheKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,  // cache is ephemeral
      timeToLiveAttribute: 'expiresAt',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    const rateLimiterTable = new dynamodb.Table(this, 'RateLimiterTable', {
      tableName: 'kiln-rate-limiter',
      partitionKey: { name: 'bucketKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // ── SQS upgrade queue + DLQ ──────────────────────────────────────────────
    const upgradeDlq = new sqs.Queue(this, 'UpgradeDlq', {
      queueName: 'kiln-upgrade-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    this.upgradeQueue = new sqs.Queue(this, 'UpgradeQueue', {
      queueName: 'kiln-upgrade-queue.fifo',
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(300),  // 5 min — matches worker timeout
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      deadLetterQueue: { queue: upgradeDlq, maxReceiveCount: 3 },
    });

    // ── Shared worker environment ─────────────────────────────────────────────
    const sharedEnv: Record<string, string> = {
      KILN_TEAM_CONFIG_TABLE: teamConfigTable.tableName,
      KILN_PR_LEDGER_TABLE: prLedgerTable.tableName,
      KILN_AUDIT_LOG_TABLE: auditLogTable.tableName,
      KILN_CHANGELOG_CACHE_TABLE: this.changelogCacheTable.tableName,
      KILN_RATE_LIMITER_TABLE: rateLimiterTable.tableName,
      KILN_AUDIT_DLQ_URL: auditDlqUrl,
      KILN_UPGRADE_QUEUE_URL: this.upgradeQueue.queueUrl,
      KILN_GITHUB_APP_SECRET_ARN: githubAppSecret.secretArn,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };

    // ── Upgrade Poller Lambda ─────────────────────────────────────────────────

    const pollerRole = new iam.Role(this, 'PollerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    pollerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Scan'],
      resources: [teamConfigTable.tableArn],
    }));
    pollerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [prLedgerTable.tableArn],
    }));
    pollerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [auditLogTable.tableArn],
    }));
    pollerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [this.upgradeQueue.queueArn, upgradeDlq.queueArn],
    }));

    const pollerLogGroup = new logs.LogGroup(this, 'PollerLogs', {
      logGroupName: '/aws/lambda/kiln-upgrade-poller',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pollerFn = new lambda.Function(this, 'UpgradePollerFn', {
      functionName: 'kiln-upgrade-poller',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'lambda/upgrade-poller/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm ci && npx esbuild lambda/upgrade-poller/index.ts --bundle --platform=node --target=node24 --outfile=/asset-output/index.js --external:@aws-sdk/*',
          ],
          environment: { NODE_ENV: 'production' },
        },
      }),
      role: pollerRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: pollerLogGroup,
      environment: sharedEnv,
    });

    // EventBridge cron — every 15 minutes
    new events.Rule(this, 'PollerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      description: 'Trigger Kiln upgrade poller to check for new npm versions',
      targets: [new eventsTargets.LambdaFunction(pollerFn, { retryAttempts: 2 })],
    });

    // ── Upgrade Worker Lambda ─────────────────────────────────────────────────

    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [teamConfigTable.tableArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
      resources: [prLedgerTable.tableArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [auditLogTable.tableArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [this.changelogCacheTable.tableArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [rateLimiterTable.tableArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [githubAppSecret.secretArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5`,
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-4-6`,
      ],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      resources: [this.upgradeQueue.queueArn],
    }));
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [upgradeDlq.queueArn],
    }));

    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogs', {
      logGroupName: '/aws/lambda/kiln-upgrade-worker',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const workerFn = new lambda.Function(this, 'UpgradeWorkerFn', {
      functionName: 'kiln-upgrade-worker',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'lambda/upgrade-worker/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm ci && npx esbuild lambda/upgrade-worker/index.ts --bundle --platform=node --target=node24 --outfile=/asset-output/index.js --external:@aws-sdk/*',
          ],
          environment: { NODE_ENV: 'production' },
        },
      }),
      role: workerRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      logGroup: workerLogGroup,
      environment: sharedEnv,
      reservedConcurrentExecutions: 10,  // cap concurrency to respect GitHub rate limits
    });

    // SQS event source (batch size 1 for isolation — one upgrade job per invocation)
    workerFn.addEventSource(new lambdaEventSources.SqsEventSource(this.upgradeQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));
  }
}
