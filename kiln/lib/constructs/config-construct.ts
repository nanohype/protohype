/**
 * Kiln Config Construct
 *
 * - DynamoDB tables: team-config, pr-ledger, audit-log
 * - Config API Lambda + HTTP API Gateway
 * - Health check Lambda
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ConfigConstructProps {
  api: apigatewayv2.HttpApi;
}

export class ConfigConstruct extends Construct {
  public readonly teamConfigTable: dynamodb.Table;
  public readonly prLedgerTable: dynamodb.Table;
  public readonly auditLogTable: dynamodb.Table;
  public readonly auditDlqUrl: string;

  constructor(scope: Construct, id: string, props: ConfigConstructProps) {
    super(scope, id);

    // ── DynamoDB tables ──────────────────────────────────────────────────────

    this.teamConfigTable = new dynamodb.Table(this, 'TeamConfigTable', {
      tableName: 'kiln-team-config',
      partitionKey: { name: 'teamId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.prLedgerTable = new dynamodb.Table(this, 'PrLedgerTable', {
      tableName: 'kiln-pr-ledger',
      partitionKey: { name: 'teamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'prId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
      tableName: 'kiln-audit-log',
      partitionKey: { name: 'teamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
    });

    // Audit DLQ (SQS) — routing target when DynamoDB is throttled
    const auditDlq = new cdk.aws_sqs.Queue(this, 'AuditDlq', {
      queueName: 'kiln-audit-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: cdk.aws_sqs.QueueEncryption.KMS_MANAGED,
    });
    this.auditDlqUrl = auditDlq.queueUrl;

    // ── Lambda execution role ─────────────────────────────────────────────────
    const configRole = new iam.Role(this, 'ConfigApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Least-privilege: only operations this Lambda actually performs, scoped to specific tables
    configRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [
        this.teamConfigTable.tableArn,
        this.prLedgerTable.tableArn,
        this.auditLogTable.tableArn,
      ],
    }));

    configRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [auditDlq.queueArn],
    }));

    // IAM condition key: enforce teamId scope (defence in depth)
    configRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['dynamodb:*'],
      // If a caller attempts to access a table without a teamId condition,
      // this DENY does not match (no condition), so it only fires when someone
      // explicitly crafts a cross-tenant query. The explicit scope in code is the
      // primary control; IAM is the defence-in-depth layer.
      resources: ['*'],
      conditions: {
        StringNotEquals: {
          'dynamodb:LeadingKeys': '${aws:PrincipalTag/teamId}',
        },
      },
      sid: 'DenyNonTeamDynamoAccess',
    }));

    // ── Config API Lambda ─────────────────────────────────────────────────────

    const logGroup = new logs.LogGroup(this, 'ConfigApiLogs', {
      logGroupName: '/aws/lambda/kiln-config-api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const configFn = new lambda.Function(this, 'ConfigApiFn', {
      functionName: 'kiln-config-api',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'lambda/config-api/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm ci && npx esbuild lambda/config-api/index.ts --bundle --platform=node --target=node24 --outfile=/asset-output/index.js --external:@aws-sdk/*',
          ],
          environment: { NODE_ENV: 'production' },
        },
      }),
      role: configRole,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup,
      environment: {
        KILN_TEAM_CONFIG_TABLE: this.teamConfigTable.tableName,
        KILN_PR_LEDGER_TABLE: this.prLedgerTable.tableName,
        KILN_AUDIT_LOG_TABLE: this.auditLogTable.tableName,
        KILN_AUDIT_DLQ_URL: auditDlq.queueUrl,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });

    props.api.addRoutes({
      path: '/teams/{teamId}/config',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.PUT,
        apigatewayv2.HttpMethod.DELETE,
      ],
      integration: new integrations.HttpLambdaIntegration('ConfigApiIntegration', configFn),
    });

    // ── PR Ledger routes ──────────────────────────────────────────────────────

    props.api.addRoutes({
      path: '/teams/{teamId}/prs',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('PrListIntegration', configFn),
    });

    props.api.addRoutes({
      path: '/teams/{teamId}/prs/{prId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('PrGetIntegration', configFn),
    });

    // ── Health checks ──────────────────────────────────────────────────────────

    const healthRole = new iam.Role(this, 'HealthRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    healthRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [this.teamConfigTable.tableArn],
    }));

    const healthFn = new lambda.Function(this, 'HealthFn', {
      functionName: 'kiln-health',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'lambda/health/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm ci && npx esbuild lambda/health/index.ts --bundle --platform=node --target=node24 --outfile=/asset-output/index.js --external:@aws-sdk/*',
          ],
        },
      }),
      role: healthRole,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      environment: {
        KILN_TEAM_CONFIG_TABLE: this.teamConfigTable.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });

    for (const p of ['/healthz', '/readyz']) {
      props.api.addRoutes({
        path: p,
        methods: [apigatewayv2.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration(`HealthIntegration${p.replace('/', '')}`, healthFn),
      });
    }
  }
}
