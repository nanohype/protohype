import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export type MarshalEnvironment = 'staging' | 'production';

export interface MarshalStackProps extends cdk.StackProps {
  /** Which logical environment this stack instance represents. Drives resource naming + OTel `deployment.environment` + tag. */
  environment: MarshalEnvironment;
}

/**
 * Every AWS resource carries the environment in its name so staging and
 * production can coexist in the same account/region. Export names, secret
 * paths, and OTel `deployment.environment` all derive from this helper.
 */
function namer(environment: MarshalEnvironment) {
  const titleCase = environment === 'staging' ? 'Staging' : 'Production';
  return {
    env: environment,
    // Kebab-case prefix for resources named by AWS (tables, queues, cluster, service, log groups, alarms).
    prefix: `marshal-${environment}`,
    // PascalCase prefix for CloudFormation export names (`MarshalStaging…`, `MarshalProduction…`).
    exportPrefix: `Marshal${titleCase}`,
    // Forward-slash prefix for Secrets Manager paths — matches the convention in docs/secrets.md.
    secret: (rest: string): string => `marshal/${environment}/${rest}`,
  };
}

/**
 * Import a Secrets Manager secret by name, resolving its full ARN (with the
 * 6-char random suffix AWS appends at creation) at **deploy time** via
 * `DescribeSecret`. Required because ECS task definitions reject partial ARNs
 * in `secrets[].valueFrom` — they demand the full suffixed ARN, and
 * `Secret.fromSecretNameV2(...)` only produces the partial form.
 *
 * The lookup runs as an `AwsCustomResource` Lambda during `cdk deploy`, so the
 * secret MUST already exist at that point — which is exactly the invariant
 * Marshal's deploy flow encodes ("seed before deploy"). A missing secret fails
 * the deploy with a clear DescribeSecret error, never with a silently-broken
 * task that only fails at runtime.
 */
function importSecretByName(scope: Construct, id: string, secretName: string): secretsmanager.ISecret {
  const stack = cdk.Stack.of(scope);
  const lookup = new cr.AwsCustomResource(scope, `${id}Lookup`, {
    onCreate: {
      service: 'SecretsManager',
      action: 'DescribeSecret',
      parameters: { SecretId: secretName },
      physicalResourceId: cr.PhysicalResourceId.of(`lookup-${secretName.replace(/\W/g, '-')}`),
    },
    onUpdate: {
      service: 'SecretsManager',
      action: 'DescribeSecret',
      parameters: { SecretId: secretName },
      physicalResourceId: cr.PhysicalResourceId.of(`lookup-${secretName.replace(/\W/g, '-')}`),
    },
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['secretsmanager:DescribeSecret'],
        resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${secretName}*`],
      }),
    ]),
    // Use the Lambda runtime's built-in AWS SDK. DescribeSecret is ancient
    // (Secrets Manager launched 2018), every supported runtime has it. Skip
    // the install-latest-sdk dance to shave ~15s off each of the 14 lookups.
    installLatestAwsSdk: false,
  });
  return secretsmanager.Secret.fromSecretCompleteArn(scope, id, lookup.getResponseField('ARN'));
}

export class MarshalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarshalStackProps) {
    super(scope, id, props);

    const name = namer(props.environment);

    // Secrets Manager — every integration secret is operator-provisioned via
    // `scripts/seed-secrets.sh` (fed from a gitignored `marshal-secrets.{env}.json`).
    // CDK imports by name rather than owning creation: the lifecycle belongs to
    // the operator, and the secret value never transits CloudFormation at all
    // (`fromSecretNameV2` emits the ARN, not the value). This also makes the
    // pre-deploy-seed invariant universal — no per-secret special casing.
    //
    // The inventory below, `scripts/seed-secrets.sh` REQUIRED_KEYS,
    // `scripts/smoke.sh` REQUIRED_SECRETS, and `secrets.template.json` keys must
    // match exactly; a CI grep-gate fails the build on any drift.
    const slackBotTokenSecret = importSecretByName(this, 'SlackBotToken', name.secret('slack/bot-token'));
    const slackSigningSecretSecret = importSecretByName(this, 'SlackSigningSecret', name.secret('slack/signing-secret'));
    const slackAppTokenSecret = importSecretByName(this, 'SlackAppToken', name.secret('slack/app-token'));
    const grafanaOnCallTokenSecret = importSecretByName(this, 'GrafanaOnCallToken', name.secret('grafana/oncall-token'));
    const grafanaCloudTokenSecret = importSecretByName(this, 'GrafanaCloudToken', name.secret('grafana/cloud-token'));
    const grafanaCloudOrgIdSecret = importSecretByName(this, 'GrafanaCloudOrgId', name.secret('grafana/cloud-org-id'));
    const statuspageApiKeySecret = importSecretByName(this, 'StatuspageApiKey', name.secret('statuspage/api-key'));
    const statuspagePageIdSecret = importSecretByName(this, 'StatuspagePageId', name.secret('statuspage/page-id'));
    const githubTokenSecret = importSecretByName(this, 'GithubToken', name.secret('github/token'));
    const linearApiKeySecret = importSecretByName(this, 'LinearApiKey', name.secret('linear/api-key'));
    const linearProjectIdSecret = importSecretByName(this, 'LinearProjectId', name.secret('linear/project-id'));
    const linearTeamIdSecret = importSecretByName(this, 'LinearTeamId', name.secret('linear/team-id'));
    const workosApiKeySecret = importSecretByName(this, 'WorkOSApiKey', name.secret('workos/api-key'));
    const grafanaOnCallWebhookHmacSecret = importSecretByName(this, 'GrafanaOnCallWebhookHmac', name.secret('grafana/oncall-webhook-hmac'));

    // Grafana Cloud auth — JSON payload carrying credentials for all three
    // telemetry destinations (OTLP collector, Lambda OTel, Loki forwarder).
    // See docs/secrets.md for the field shape.
    const grafanaCloudOtlpAuthSecret = importSecretByName(this, 'GrafanaCloudOtlpAuth', name.secret('grafana-cloud/otlp-auth'));

    const allSecrets: secretsmanager.ISecret[] = [
      slackBotTokenSecret,
      slackSigningSecretSecret,
      slackAppTokenSecret,
      grafanaOnCallTokenSecret,
      grafanaCloudTokenSecret,
      grafanaCloudOrgIdSecret,
      statuspageApiKeySecret,
      statuspagePageIdSecret,
      githubTokenSecret,
      linearApiKeySecret,
      linearProjectIdSecret,
      linearTeamIdSecret,
      workosApiKeySecret,
      grafanaOnCallWebhookHmacSecret,
      grafanaCloudOtlpAuthSecret,
    ];

    // DynamoDB — event-sourced single-table + separate audit table
    const incidentsTable = new dynamodb.Table(this, 'IncidentsTable', {
      tableName: `${name.prefix}-incidents`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'TTL',
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    incidentsTable.addGlobalSecondaryIndex({
      indexName: 'event-type-index',
      partitionKey: { name: 'event_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    incidentsTable.addGlobalSecondaryIndex({
      indexName: 'incident-id-index',
      partitionKey: { name: 'incident_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Resolves war-room channel_id → canonical incident_id for slash-command
    // dispatch (commands arrive with channel_id only; the PK is INCIDENT#<id>).
    // Sparse: only items with slack_channel_id set (i.e. after ROOM_ASSEMBLED)
    // are indexed. Sort by created_at desc to get the newest if a channel
    // somehow has multiple records.
    incidentsTable.addGlobalSecondaryIndex({
      indexName: 'slack-channel-index',
      partitionKey: { name: 'slack_channel_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: `${name.prefix}-audit`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'TTL',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // GSI for 100% approval gate verification queries
    auditTable.addGlobalSecondaryIndex({
      indexName: 'published-without-approval-index',
      partitionKey: { name: 'action_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // SQS FIFO queues
    const incidentEventsDLQ = new sqs.Queue(this, 'IncidentEventsDLQ', {
      queueName: `${name.prefix}-incident-events-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const incidentEventsQueue = new sqs.Queue(this, 'IncidentEventsQueue', {
      queueName: `${name.prefix}-incident-events.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(7),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: incidentEventsDLQ, maxReceiveCount: 3 },
    });
    const nudgeEventsQueue = new sqs.Queue(this, 'NudgeEventsQueue', {
      queueName: `${name.prefix}-nudge-events`,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const slaCheckQueue = new sqs.Queue(this, 'SlaCheckQueue', {
      queueName: `${name.prefix}-sla-check-events`,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(3),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // IAM — least privilege + explicit DENY for production system mutations.
    //
    // Secret ARN wildcards: `secretsmanager.Secret.fromSecretNameV2(...)` returns
    // a `secretArn` *without* the 6-char random suffix Secrets Manager appends
    // at creation. When ECS/Lambda asks IAM for GetSecretValue, the request ARN
    // is the partial form (no suffix) — IAM exact-matches against the policy,
    // so policies that reference `s.secretArn` alone don't match. Using an
    // env-scoped path wildcard (`marshal/${env}/*`) sidesteps the suffix issue
    // entirely and stays env-isolated — staging's execution role still cannot
    // read production's secrets.
    const secretsPathArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:marshal/${name.env}/*`;
    void allSecrets; // retained as the canonical inventory; IAM uses the path wildcard above
    const secretsReadPolicy = new iam.Policy(this, 'SecretsReadPolicy', {
      statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['secretsmanager:GetSecretValue'], resources: [secretsPathArn] }),
      ],
    });
    const noRemediationDenyPolicy = new iam.Policy(this, 'NoRemediationDenyPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: [
            'ec2:*',
            'rds:*',
            'eks:*',
            's3:Put*',
            's3:Delete*',
            's3:Create*',
            'elasticloadbalancing:*',
            'ecs:UpdateService',
            'lambda:UpdateFunctionCode',
            'lambda:UpdateFunctionConfiguration',
          ],
          resources: ['*'],
        }),
      ],
    });

    const ingressLambdaRole = new iam.Role(this, 'IngressLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    ingressLambdaRole.attachInlinePolicy(
      new iam.Policy(this, 'IngressLambdaSqsPolicy', {
        statements: [
          new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['sqs:SendMessage'], resources: [incidentEventsQueue.queueArn] }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
            resources: [incidentsTable.tableArn],
          }),
        ],
      }),
    );
    // Lambda only reads two specific secrets; keep its policy narrow with
    // per-secret path wildcards rather than the env-wide pattern.
    const ingressLambdaSecretsArns = [
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${name.secret('grafana/oncall-webhook-hmac')}*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${name.secret('grafana-cloud/otlp-auth')}*`,
    ];
    ingressLambdaRole.attachInlinePolicy(
      new iam.Policy(this, 'IngressLambdaSecretsPolicy', {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: ingressLambdaSecretsArns,
          }),
        ],
      }),
    );
    ingressLambdaRole.attachInlinePolicy(noRemediationDenyPolicy);

    const processorTaskRole = new iam.Role(this, 'ProcessorTaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    processorTaskRole.attachInlinePolicy(secretsReadPolicy);
    processorTaskRole.attachInlinePolicy(noRemediationDenyPolicy);
    processorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'],
        resources: [incidentsTable.tableArn, `${incidentsTable.tableArn}/index/*`, auditTable.tableArn, `${auditTable.tableArn}/index/*`],
      }),
    );
    processorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [incidentEventsQueue.queueArn, nudgeEventsQueue.queueArn, slaCheckQueue.queueArn],
      }),
    );
    processorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-4-6`,
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-opus-4-6-v1`,
        ],
      }),
    );
    // CloudWatch PutMetricData permission intentionally removed — Marshal now emits metrics
    // via OTLP to the ADOT sidecar, which ships to Grafana Cloud Mimir. Smaller attack surface.

    const schedulerRole = new iam.Role(this, 'SchedulerRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [nudgeEventsQueue.queueArn, slaCheckQueue.queueArn],
      }),
    );
    // EventBridge Scheduler group — MUST exist before the processor calls
    // CreateSchedule. Named after the env-prefix so staging + production
    // schedules don't collide, and matches `SCHEDULER_GROUP_NAME` passed to
    // the processor env. Without this group, CreateSchedule fails with
    // ResourceNotFoundException and the nudge schedule is silently dropped.
    const schedulerGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: name.prefix });
    // Scheduler group is named after the env-prefix, so staging + production schedules don't collide.
    processorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'iam:PassRole',
        ],
        resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/${name.prefix}/*`, schedulerRole.roleArn],
      }),
    );

    // Bedrock invocation logging = NONE (security requirement, enforced at deploy time)
    const marshalRoot = path.join(__dirname, '../..');
    const bedrockLoggingNoneLogGroup = new logs.LogGroup(this, 'BedrockLoggingNoneLogGroup', {
      logGroupName: `/aws/lambda/${name.prefix}-bedrock-logging-none`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const bedrockLoggingNoneFunction = new lambda_nodejs.NodejsFunction(this, 'BedrockLoggingNone', {
      entry: path.join(marshalRoot, 'src/handlers/bedrock-logging-none.ts'),
      projectRoot: marshalRoot,
      depsLockFilePath: path.join(marshalRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      logGroup: bedrockLoggingNoneLogGroup,
    });
    bedrockLoggingNoneFunction.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['bedrock:PutModelInvocationLoggingConfiguration'], resources: ['*'] }),
    );
    const bedrockLoggingProvider = new cr.Provider(this, 'BedrockLoggingProvider', { onEventHandler: bedrockLoggingNoneFunction });
    new cdk.CustomResource(this, 'BedrockInvocationLoggingNone', {
      serviceToken: bedrockLoggingProvider.serviceToken,
      resourceType: 'Custom::BedrockInvocationLoggingNone',
      properties: { Region: this.region, Timestamp: new Date().toISOString().split('T')[0] },
    });

    // Lambda webhook ingress.
    //
    // OTel is initialised IN the handler at cold start (see
    // `src/handlers/webhook-otel-init.ts`), not via the AWS-managed ADOT
    // Lambda layer. The layer reads its config — including the Grafana Cloud
    // basic-auth header — from env vars at layer-load time, which would force
    // the plaintext credential into the Lambda's function configuration
    // (readable by any principal with `lambda:GetFunctionConfiguration` and
    // logged in CloudTrail on every describe). Init-in-handler uses the
    // Lambda's existing `secretsmanager:GetSecretValue` permission to fetch
    // the `basic_auth` field at runtime — the value never appears in the
    // Lambda resource's `environment:` map.
    const ingressFunctionLogGroup = new logs.LogGroup(this, 'IngressFunctionLogGroup', {
      logGroupName: `/aws/lambda/${name.prefix}-ingress`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ingressFunction = new lambda_nodejs.NodejsFunction(this, 'IngressFunction', {
      entry: path.join(marshalRoot, 'src/handlers/webhook-ingress.ts'),
      projectRoot: marshalRoot,
      depsLockFilePath: path.join(marshalRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      role: ingressLambdaRole,
      environment: {
        INCIDENT_EVENTS_QUEUE_URL: incidentEventsQueue.queueUrl,
        INCIDENTS_TABLE_NAME: incidentsTable.tableName,
        GRAFANA_ONCALL_HMAC_SECRET_ARN: grafanaOnCallWebhookHmacSecret.secretArn,
        // ARN — NOT the secret value. The init module fetches via the AWS SDK
        // using the Lambda's task role, so the plaintext credential stays
        // inside Secrets Manager.
        GRAFANA_CLOUD_OTLP_SECRET_ARN: grafanaCloudOtlpAuthSecret.secretArn,
        LOG_LEVEL: 'info',
        NODE_ENV: 'production',
        OTEL_SERVICE_NAME: `marshal-${name.env}-webhook`,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_RESOURCE_ATTRIBUTES: `service.namespace=marshal,service.version=0.1.0,deployment.environment=${name.env},aws.region=${this.region}`,
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_PROPAGATORS: 'tracecontext,baggage',
        OTEL_METRIC_EXPORT_INTERVAL: '60000',
      },
      // Lambda logs stay on CloudWatch — volume is trivial (~10 invocations/month).
      // OTel traces + metrics ship to Grafana Cloud; logs don't.
      logGroup: ingressFunctionLogGroup,
      // esbuild bundles the OTel SDK + exporters + auto-instrumentations into
      // the Lambda asset. @aws-sdk is externalised to use the runtime's copy.
      // sourceMap: false — OTel ships broken/truncated .js.map files that
      // esbuild refuses to follow when sourcemap generation is enabled.
      // Stack traces in Lambda logs lose line numbers; file names remain.
      bundling: { minify: true, sourceMap: false, externalModules: ['@aws-sdk/*'] },
    });

    // API Gateway HTTP API
    const httpApi = new apigateway.HttpApi(this, 'MarshalWebhookApi', {
      apiName: `${name.prefix}-webhook-api`,
      description: `Marshal webhook ingress — Grafana OnCall alerts (${name.env})`,
      defaultIntegration: new apigatewayIntegrations.HttpLambdaIntegration('IngressIntegration', ingressFunction),
    });
    httpApi.addRoutes({
      path: '/webhook/grafana-oncall',
      methods: [apigateway.HttpMethod.POST],
      integration: new apigatewayIntegrations.HttpLambdaIntegration('GrafanaOnCallIntegration', ingressFunction),
    });

    // ECS Fargate — core incident processor
    const cluster = new ecs.Cluster(this, 'MarshalCluster', {
      clusterName: name.prefix,
      // containerInsightsV2 supersedes the deprecated `containerInsights: true`.
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    // Log-group retention policy is env-scoped:
    //   - staging    → DESTROY: clears automatically on rollback so failed
    //                  deploys don't leave orphans that block the next create
    //                  (observed: log-group name collisions after every
    //                  failed staging retry). For live diagnosis during a
    //                  deploy, `aws logs tail --follow /marshal/staging/<group>`
    //                  captures logs in real time before rollback tears the
    //                  group down.
    //   - production → RETAIN: operational diagnostics stay available across
    //                  stack rebuilds (compliance + post-incident review).
    const logRemovalPolicy = props.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // Meta-log group: Fluent Bit's OWN stderr (bootstrap errors, Loki push
    // failures) land here. Only consumed when the production sidecars are
    // present, but declared in both envs so the reference is uniform.
    const forwarderDiagnosticsLogGroup = new logs.LogGroup(this, 'ForwarderDiagnosticsLogGroup', {
      logGroupName: `/marshal/${name.env}/forwarder-diagnostics`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: logRemovalPolicy,
    });
    // Processor log group — used only in staging (production uses firelens →
    // Loki). Created in both envs for CDK template symmetry; production's is
    // empty but the resource reference keeps the stack shape consistent.
    const processorLogGroup = new logs.LogGroup(this, 'ProcessorLogGroup', {
      logGroupName: `/marshal/${name.env}/processor`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: logRemovalPolicy,
    });
    const processorTaskDefinition = new ecs.FargateTaskDefinition(this, 'ProcessorTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      taskRole: processorTaskRole,
      family: `${name.prefix}-processor`,
      // Graviton (arm64) for matched parity with the Lambda ingress (also ARM64)
      // + ~20% cost reduction vs x86 Fargate. All base images (node:24-alpine,
      // aws-for-fluent-bit:stable, aws-otel-collector:latest) publish arm64
      // variants, so no Dockerfile changes are required. Locking the arch here
      // prevents the classic "built on Apple Silicon, runs on x86 Fargate →
      // exec format error" cross-compile mismatch.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    // The TASK EXECUTION ROLE (not the task role) is what ECS uses to pull
    // secrets from Secrets Manager before the container starts. Without this
    // grant the task never reaches ContainerStart — deploys trip the circuit
    // breaker with `ResourceInitializationError: ... AccessDeniedException`
    // on `secretsmanager:GetSecretValue`. The same env-path wildcard policy
    // works here since the task def references secrets under `marshal/${env}/*`.
    processorTaskDefinition.obtainExecutionRole().attachInlinePolicy(secretsReadPolicy);
    const processorImage = new ecr_assets.DockerImageAsset(this, 'ProcessorImage', {
      directory: marshalRoot,
      file: 'Dockerfile',
      // Explicit ARM64 so CI builders on x86 still produce an arm64 image that
      // Fargate (pinned to ARM64 above) can actually execute. On Apple Silicon
      // builders this is native; on x86 it uses buildx/QEMU emulation.
      platform: ecr_assets.Platform.LINUX_ARM64,
      exclude: ['node_modules', 'infra/node_modules', 'infra/cdk.out', 'dist', 'coverage', 'test', 'artifacts', '.git'],
    });
    processorTaskDefinition.addContainer('MarshalProcessor', {
      image: ecs.ContainerImage.fromDockerImageAsset(processorImage),
      // Log driver — env-conditional.
      // * production: firelens → Fluent Bit sidecar → Grafana Cloud Loki (the
      //   designed observability pipeline).
      // * staging:    awsLogs → CloudWatch. Fluent Bit is essential:true and
      //   has been the iteration-breaking crash source during initial
      //   bring-up; routing to CloudWatch means the processor's stderr is
      //   visible even when the forwarder is down. Swap back to firelens on
      //   staging once the sidecar is stable if you want parity with prod.
      logging:
        props.environment === 'production'
          ? ecs.LogDrivers.firelens({})
          : ecs.LogDrivers.awsLogs({ streamPrefix: 'processor', logGroup: processorLogGroup }),
      environment: {
        INCIDENTS_TABLE_NAME: incidentsTable.tableName,
        AUDIT_TABLE_NAME: auditTable.tableName,
        INCIDENT_EVENTS_QUEUE_URL: incidentEventsQueue.queueUrl,
        NUDGE_EVENTS_QUEUE_URL: nudgeEventsQueue.queueUrl,
        // EventBridge Scheduler targets want an ARN, not a URL — see wiring/dependencies.ts.
        NUDGE_EVENTS_QUEUE_ARN: nudgeEventsQueue.queueArn,
        SLA_CHECK_QUEUE_URL: slaCheckQueue.queueUrl,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        SCHEDULER_GROUP_NAME: name.prefix,
        DEPLOYMENT_ENV: name.env,
        AWS_REGION: this.region,
        LOG_LEVEL: 'info',
        NODE_ENV: 'production',
        // OTel export → ADOT sidecar on localhost (defined below). Auto-instrumentation is
        // activated via NODE_OPTIONS --require in the Dockerfile entrypoint once the app
        // depends on @opentelemetry/auto-instrumentations-node; in Phase 1 only the pipe is wired.
        OTEL_SERVICE_NAME: `marshal-${name.env}-processor`,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_RESOURCE_ATTRIBUTES: `service.namespace=marshal,service.version=0.1.0,deployment.environment=${name.env},aws.region=${this.region}`,
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_METRIC_EXPORT_INTERVAL: '60000',
      },
      secrets: {
        SLACK_BOT_TOKEN: ecs.Secret.fromSecretsManager(slackBotTokenSecret),
        SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(slackSigningSecretSecret),
        SLACK_APP_TOKEN: ecs.Secret.fromSecretsManager(slackAppTokenSecret),
        GRAFANA_ONCALL_TOKEN: ecs.Secret.fromSecretsManager(grafanaOnCallTokenSecret),
        GRAFANA_CLOUD_TOKEN: ecs.Secret.fromSecretsManager(grafanaCloudTokenSecret),
        GRAFANA_CLOUD_ORG_ID: ecs.Secret.fromSecretsManager(grafanaCloudOrgIdSecret),
        STATUSPAGE_API_KEY: ecs.Secret.fromSecretsManager(statuspageApiKeySecret),
        STATUSPAGE_PAGE_ID: ecs.Secret.fromSecretsManager(statuspagePageIdSecret),
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(githubTokenSecret),
        LINEAR_API_KEY: ecs.Secret.fromSecretsManager(linearApiKeySecret),
        LINEAR_PROJECT_ID: ecs.Secret.fromSecretsManager(linearProjectIdSecret),
        LINEAR_TEAM_ID: ecs.Secret.fromSecretsManager(linearTeamIdSecret),
        WORKOS_API_KEY: ecs.Secret.fromSecretsManager(workosApiKeySecret),
      },
      // `wget` (not `curl`) — the processor image is `node:24-alpine`, which
      // ships busybox wget but not curl. Using curl here made every health
      // check probe exit with "curl: not found" → ECS marked the container
      // unhealthy after 3 failures → task killed with exit 0 (clean SIGTERM)
      // and "Task failed container health checks". Matches the HEALTHCHECK
      // directive in the Dockerfile for consistency.
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q --spider http://localhost:3001/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Sidecars (ADOT collector + Fluent Bit firelens router) are PRODUCTION-ONLY
    // during early bring-up. Staging runs the processor container alone, logging
    // directly to CloudWatch. Rationale:
    //
    //   1. Both sidecars have `essential: true` and have been the crash source
    //      during repeated staging bring-up attempts (ADOT exit 2, Fluent Bit
    //      exit 133). Removing them from staging decouples "get the main app
    //      healthy" from "get the observability pipeline healthy" — staging
    //      becomes a clean app-only loop, production keeps the full stack.
    //
    //   2. With Fluent Bit gone in staging, the processor's `logging: awsLogs`
    //      above satisfies ECS's validation (no firelens log router = no
    //      required awsfirelens consumer). Leaving Fluent Bit in place with a
    //      main container that doesn't use it fails with
    //      `firelensConfiguration … at least one container has to be
    //      configured with the awsfirelens log driver`.
    //
    //   3. Processor OTLP exporter pointing at `localhost:4318` when no
    //      collector is listening is a graceful no-op in OTel SDK (connection
    //      refused → warn-log, buffered send retries fail silently). No app
    //      crash, just dark telemetry on staging — which is fine because
    //      staging isn't paged.
    //
    // Bring sidecars back to staging once they're stable in production.
    if (props.environment === 'production') {
      // ADOT Collector sidecar — receives OTLP on localhost:4318 from the app container and
      // ships traces + metrics to Grafana Cloud Tempo/Mimir via the basicauth extension.
      // Config is loaded from infra/otel/collector-ecs.yaml and embedded via AOT_CONFIG_CONTENT.
      const collectorConfig = fs.readFileSync(path.join(__dirname, '../otel/collector-ecs.yaml'), 'utf8');
      processorTaskDefinition.addContainer('OtelCollector', {
        containerName: 'otel-collector',
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:latest'),
        essential: true,
        memoryReservationMiB: 128,
        // Collector's own diagnostics land in the meta-log group on CloudWatch, not Loki —
        // when Grafana Cloud is unreachable, we need to see WHY without relying on Grafana.
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'otel', logGroup: forwarderDiagnosticsLogGroup }),
        environment: {
          AOT_CONFIG_CONTENT: collectorConfig,
          DEPLOYMENT_ENVIRONMENT: name.env,
        },
        secrets: {
          GRAFANA_INSTANCE_ID: ecs.Secret.fromSecretsManager(grafanaCloudOtlpAuthSecret, 'instance_id'),
          GRAFANA_API_TOKEN: ecs.Secret.fromSecretsManager(grafanaCloudOtlpAuthSecret, 'api_token'),
        },
        healthCheck: {
          command: ['CMD', '/healthcheck'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(30),
        },
        portMappings: [
          { containerPort: 4317, protocol: ecs.Protocol.TCP }, // OTLP gRPC
          { containerPort: 4318, protocol: ecs.Protocol.TCP }, // OTLP HTTP
          { containerPort: 13133, protocol: ecs.Protocol.TCP }, // health_check extension
        ],
      });

      // Fluent Bit sidecar — receives app stdout via the firelens forward protocol, parses
      // the structured JSON, and ships to Grafana Cloud Loki via the built-in loki output.
      // Image is built from infra/otel/fluent-bit/ (Dockerfile + fluent-bit.conf + parsers.conf)
      // so the config ships reproducibly with the stack. Its OWN stderr lands in the meta-log
      // group on CloudWatch — when Loki is unreachable, we need to see the forwarder error
      // somewhere other than the thing that isn't working.
      const fluentBitImage = new ecr_assets.DockerImageAsset(this, 'FluentBitImage', {
        directory: path.join(marshalRoot, 'infra/otel/fluent-bit'),
        // Match the task def's ARM64 platform (see processorTaskDefinition above).
        // `aws-for-fluent-bit:stable` publishes a multi-arch manifest that covers
        // arm64, so no Dockerfile changes are needed.
        platform: ecr_assets.Platform.LINUX_ARM64,
      });
      processorTaskDefinition.addFirelensLogRouter('LogRouter', {
        image: ecs.ContainerImage.fromDockerImageAsset(fluentBitImage),
        firelensConfig: {
          type: ecs.FirelensLogRouterType.FLUENTBIT,
          options: { configFileType: ecs.FirelensConfigFileType.FILE, configFileValue: '/fluent-bit/etc/fluent-bit.conf' },
        },
        essential: true,
        memoryReservationMiB: 64,
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fluent-bit', logGroup: forwarderDiagnosticsLogGroup }),
        environment: {
          // Loki host is per-Grafana-Cloud-region; operator sets the matching value in the
          // shared OTLP/Loki auth secret (loki_host field). Default points at us-west-0 Loki.
        },
        secrets: {
          LOKI_USERNAME: ecs.Secret.fromSecretsManager(grafanaCloudOtlpAuthSecret, 'loki_username'),
          LOKI_API_TOKEN: ecs.Secret.fromSecretsManager(grafanaCloudOtlpAuthSecret, 'api_token'),
          LOKI_HOST: ecs.Secret.fromSecretsManager(grafanaCloudOtlpAuthSecret, 'loki_host'),
        },
      });
    }

    const processorService = new ecs.FargateService(this, 'ProcessorService', {
      cluster,
      taskDefinition: processorTaskDefinition,
      serviceName: `${name.prefix}-processor`,
      desiredCount: 1,
      assignPublicIp: true,
      // Circuit breaker stops a failing deploy in both envs. Rollback is ON in
      // production (auto-revert to last healthy task def) and OFF in staging so
      // operators can inspect the failed service + container logs without
      // racing CloudFormation's teardown. Staging's diagnosis window is hours,
      // not minutes.
      circuitBreaker: { enable: true, rollback: props.environment === 'production' },
      // Single-task service: during a rollover, tolerate the old task
      // stopping before the new one is healthy (minHealthy=0) but never
      // double-book (maxHealthy=100 = desiredCount). Marshal's assembly SLO
      // is 5 min after alert-fire, so a ~30s deploy gap is acceptable.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      enableExecuteCommand: true,
    });
    // Make sure the EventBridge Scheduler group is up before the processor
    // starts accepting alerts — otherwise the first assembly's nudge-create
    // call races a not-yet-ready group and gets swallowed.
    processorService.node.addDependency(schedulerGroup);

    // CloudWatch alarms — infrastructure health only. Application metrics (assembly duration,
    // approval-gate latency, directory failures, statuspage outcomes) and the ops dashboard
    // live in Grafana Cloud; see infra/dashboards/marshal.json and infra/alerts/marshal-rules.yaml.
    new cloudwatch.Alarm(this, 'DLQDepthAlarm', {
      alarmName: `${name.prefix}-incident-events-dlq-depth`,
      alarmDescription: `Messages in ${name.env} DLQ indicate failed incident processing`,
      metric: incidentEventsDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'ProcessorStoppedAlarm', {
      alarmName: `${name.prefix}-processor-stopped`,
      alarmDescription: `Marshal ${name.env} processor ECS task stopped`,
      metric: new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: processorService.serviceName },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // Outputs — named to match `scripts/smoke.sh` deterministic lookups via CFN.
    // Export names are env-scoped so staging + production outputs don't collide.
    new cdk.CfnOutput(this, 'WebhookApiUrl', {
      exportName: `${name.exportPrefix}WebhookApiUrl`,
      value: httpApi.apiEndpoint,
      description: 'Configure this URL in Grafana OnCall webhook integration',
    });
    new cdk.CfnOutput(this, 'IncidentsTableName', {
      exportName: `${name.exportPrefix}IncidentsTableName`,
      value: incidentsTable.tableName,
    });
    new cdk.CfnOutput(this, 'AuditTableName', { exportName: `${name.exportPrefix}AuditTableName`, value: auditTable.tableName });
    new cdk.CfnOutput(this, 'ClusterName', {
      exportName: `${name.exportPrefix}ClusterName`,
      value: cluster.clusterName,
      description: 'ECS cluster name — used by scripts/smoke.sh to wait for service stability',
    });
    new cdk.CfnOutput(this, 'ProcessorServiceName', {
      exportName: `${name.exportPrefix}ProcessorServiceName`,
      value: processorService.serviceName,
    });
    new cdk.CfnOutput(this, 'IncidentEventsQueueUrl', {
      exportName: `${name.exportPrefix}IncidentEventsQueueUrl`,
      value: incidentEventsQueue.queueUrl,
      description: 'SQS FIFO queue for incident events — smoke checks depth = 0 after test webhook',
    });
    new cdk.CfnOutput(this, 'IncidentEventsDlqUrl', {
      exportName: `${name.exportPrefix}IncidentEventsDlqUrl`,
      value: incidentEventsDLQ.queueUrl,
      description: 'DLQ for the incident events queue — smoke asserts this stays empty',
    });
    new cdk.CfnOutput(this, 'Environment', {
      exportName: `${name.exportPrefix}Environment`,
      value: name.env,
      description: 'Logical environment — staging or production',
    });
  }
}
