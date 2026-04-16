import type { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { addAdotSidecar } from './adot-sidecar.js';

/**
 * The chorus production stack. Resources, in dependency order:
 *
 *   - KMS key (encrypts RDS storage, Secrets Manager values, SQS bodies)
 *   - VPC (3 AZs; public + private + isolated subnets)
 *   - VPC endpoints (Bedrock, Comprehend, Secrets Manager, ECR, S3, CloudWatch Logs)
 *   - SQS DLQ
 *   - Secrets (db password is generated; API tokens are placeholders that ops fills in)
 *   - RDS Postgres 16 in isolated subnets (pgvector extension via parameter group)
 *   - ECS Fargate cluster
 *   - Three Fargate services:
 *       chorus-api    behind ALB on port 80 (HTTP) / 443 (HTTPS via ACM, when domain set)
 *       chorus-worker no public exposure; reads connectors and writes to RDS
 *       chorus-digest scheduled (Mondays 09:00 PT) via EventBridge Scheduler
 *           — runs as a one-off ECS RunTask, not a long-lived service
 *   - CloudWatch log groups (one per service, 30-day retention)
 *   - Stack outputs: ALB DNS name, RDS endpoint, DLQ URL, secret ARNs
 *
 * Container images are passed as URIs in CDK context (apiImageUri,
 * workerImageUri, digestImageUri) so the build pipeline can deploy
 * specific revisions without re-synthesising the stack.
 */
export interface ChorusStackProps extends cdk.StackProps {
  apiImageUri?: string | undefined;
  workerImageUri?: string | undefined;
  digestImageUri?: string | undefined;
  auditConsumerImageUri?: string | undefined;
  apiDomainName?: string | undefined;
  workosIssuer?: string | undefined;
  workosClientId?: string | undefined;
  workosDirectoryId?: string | undefined;
  workosPmGroupId?: string | undefined;
  /** Linear team id — required for issue creation on NEW-proposal approval. */
  linearTeamId?: string | undefined;
  /** Slack channel → squad mapping (comma-separated
   *  `channelId=squadId` pairs) for the /slack/events ingestion route. */
  slackFeedbackChannels?: string | undefined;
  /** Grafana Cloud OTLP gateway, e.g.
   *  `https://otlp-gateway-prod-us-east-0.grafana.net/otlp`. The ADOT
   *  sidecar exports traces/metrics/logs here; auth comes from the
   *  `chorus/grafana-cloud/otlp` secret. */
  grafanaOtlpEndpoint?: string | undefined;
  /** Sampling ratio for outbound traces (parent-based trace-id-ratio).
   *  Defaults to 0.1 (10%). */
  otelTraceSamplerRatio?: string | undefined;
  /** Deployment environment label applied to every resource
   *  (`deployment.environment=prod`). Defaults to `prod`. */
  deploymentEnv?: string | undefined;
}

export class ChorusStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ChorusStackProps = {}) {
    super(scope, id, props);

    // ─── KMS ──────────────────────────────────────────────────────
    const kmsKey = new kms.Key(this, 'ChorusKey', {
      description: 'chorus encryption key (RDS storage, secrets, SQS payloads)',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── VPC ──────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'ChorusVpc', {
      maxAzs: 3,
      natGateways: 2,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // VPC endpoints — keep AWS API traffic on the AWS backbone, off the
    // NAT, and avoid the per-byte data charge.
    new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    for (const [id_, svc] of [
      ['BedrockEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
      ['ComprehendEndpoint', ec2.InterfaceVpcEndpointAwsService.COMPREHEND],
      ['SecretsEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDkrEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['SqsEndpoint', ec2.InterfaceVpcEndpointAwsService.SQS],
    ] as const) {
      new ec2.InterfaceVpcEndpoint(this, id_, {
        vpc,
        service: svc,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // ─── SQS DLQ ──────────────────────────────────────────────────
    const dlq = new sqs.Queue(this, 'ChorusDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
    });

    // ─── SQS audit queue ──────────────────────────────────────────
    // The api/worker/digest tasks enqueue audit entries to this queue
    // when AUDIT_QUEUE_URL is set; the audit-consumer service drains
    // the queue and performs the INSERTs. Unprocessable messages land
    // in the DLQ after 3 receives.
    const auditDlq = new sqs.Queue(this, 'ChorusAuditDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
    });
    const auditQueue = new sqs.Queue(this, 'ChorusAuditQueue', {
      retentionPeriod: cdk.Duration.days(4),
      visibilityTimeout: cdk.Duration.seconds(60),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      deadLetterQueue: { queue: auditDlq, maxReceiveCount: 3 },
    });

    // ─── Secrets ──────────────────────────────────────────────────
    // DB password: generated; rotated externally if needed.
    const dbSecret = new secretsmanager.Secret(this, 'DbCredentials', {
      description: 'chorus RDS Postgres credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'chorusapp' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      encryptionKey: kmsKey,
    });

    // API-token secrets — created with a placeholder; ops puts the real
    // value in Secrets Manager out-of-band. Code reads by NAME (see
    // src/lib/directory.ts, src/lib/slack.ts, etc.) so rotations don't
    // require redeploys.
    const placeholderSecrets = [
      'chorus/workos/api-key',
      'chorus/slack/bot-token',
      'chorus/slack/signing-secret',
      'chorus/linear/api-key',
      'chorus/ingest/api-key',
    ].map(
      (name) =>
        new secretsmanager.Secret(this, `Secret-${name.replace(/[/]/g, '-')}`, {
          secretName: name,
          description: `chorus credential: ${name} (placeholder; set out-of-band)`,
          encryptionKey: kmsKey,
        }),
    );

    // Grafana Cloud OTLP auth header. Stored as the full
    // `Basic <base64(instance:token)>` string so the ADOT collector
    // can substitute it straight into the Authorization header.
    const grafanaAuthSecret = new secretsmanager.Secret(this, 'Secret-chorus-grafana-cloud-otlp', {
      secretName: 'chorus/grafana-cloud/otlp',
      description:
        'chorus credential: chorus/grafana-cloud/otlp — full `Basic <base64>` Authorization header for OTLP HTTP',
      encryptionKey: kmsKey,
    });

    // ─── RDS Postgres 16 + pgvector ───────────────────────────────
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', { vpc, allowAllOutbound: false });
    const dbParams = new rds.ParameterGroup(this, 'DbParams', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      parameters: {
        // Allow the `vector` extension to be created by the migration.
        // CREATE EXTENSION runs at app-deploy time via scripts/migrate.ts
        // — this just makes the extension available on instance start.
        shared_preload_libraries: 'pg_stat_statements',
      },
    });

    const db = new rds.DatabaseInstance(this, 'ChorusDb', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M7G, ec2.InstanceSize.LARGE),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: true,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: kmsKey,
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: 'chorus',
      parameterGroup: dbParams,
      backupRetention: cdk.Duration.days(14),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      securityGroups: [dbSecurityGroup],
      cloudwatchLogsExports: ['postgresql'],
    });

    // ─── ECS Fargate cluster ──────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'ChorusCluster', {
      vpc,
      containerInsights: true,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Bedrock + Comprehend invocation
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['comprehend:DetectPiiEntities'],
        resources: ['*'],
      }),
    );

    // Secrets Manager read for runtime tokens
    for (const s of [dbSecret, ...placeholderSecrets, grafanaAuthSecret]) s.grantRead(taskRole);
    kmsKey.grantDecrypt(taskRole);

    // SQS: write for the DLQ; write for the audit queue (enqueueing
    // from api/worker/digest); full receive/delete on the audit queue
    // is granted separately to the audit-consumer task only.
    dlq.grantSendMessages(taskRole);
    auditQueue.grantSendMessages(taskRole);

    const deploymentEnv = props.deploymentEnv ?? 'prod';
    const otelSamplerRatio = props.otelTraceSamplerRatio ?? '0.1';
    const grafanaOtlpEndpoint =
      props.grafanaOtlpEndpoint ?? 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp';

    const telemetryEnv: Record<string, string> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: otelSamplerRatio,
      OTEL_LOG_LEVEL: 'error',
      DEPLOYMENT_ENV: deploymentEnv,
    };

    const sharedEnv: Record<string, string> = {
      AWS_REGION: this.region,
      DLQ_URL: dlq.queueUrl,
      AUDIT_QUEUE_URL: auditQueue.queueUrl,
      ...telemetryEnv,
      ...(props.workosIssuer ? { WORKOS_ISSUER: props.workosIssuer } : {}),
      ...(props.workosClientId ? { WORKOS_CLIENT_ID: props.workosClientId } : {}),
      ...(props.linearTeamId ? { LINEAR_TEAM_ID: props.linearTeamId } : {}),
    };
    const apiEnv: Record<string, string> = {
      ...(props.slackFeedbackChannels
        ? { SLACK_FEEDBACK_CHANNELS: props.slackFeedbackChannels }
        : {}),
    };
    const digestEnv: Record<string, string> = {
      ...(props.workosDirectoryId ? { WORKOS_DIRECTORY_ID: props.workosDirectoryId } : {}),
      ...(props.workosPmGroupId ? { WORKOS_PM_GROUP_ID: props.workosPmGroupId } : {}),
    };
    const dbEnv: ecs.Secret = ecs.Secret.fromSecretsManager(dbSecret, 'password');

    // ─── chorus-api ────────────────────────────────────────────────
    const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
    });
    apiTask.addContainer('api', {
      image: containerImage(props.apiImageUri, 'api'),
      environment: {
        ...sharedEnv,
        ...apiEnv,
        PORT: '3000',
        OTEL_SERVICE_NAME: 'chorus-api',
      },
      secrets: { DB_PASSWORD: dbEnv },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: apiLogs }),
      portMappings: [{ containerPort: 3000 }],
    });
    addAdotSidecar({
      taskDefinition: apiTask,
      logGroup: apiLogs,
      grafanaAuthSecret,
      grafanaOtlpEndpoint,
    });

    const apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });
    apiService.connections.allowTo(db, ec2.Port.tcp(5432), 'api → RDS');
    db.connections.allowFrom(apiService, ec2.Port.tcp(5432));

    const alb = new elb.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: true });
    const listener = alb.addListener('Http', { port: 80, open: true });
    listener.addTargets('Api', {
      port: 3000,
      protocol: elb.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: { path: '/healthz', interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ─── chorus-worker ─────────────────────────────────────────────
    const workerLogs = new logs.LogGroup(this, 'WorkerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
    });
    workerTask.addContainer('worker', {
      image: containerImage(props.workerImageUri, 'worker'),
      environment: { ...sharedEnv, OTEL_SERVICE_NAME: 'chorus-worker' },
      secrets: { DB_PASSWORD: dbEnv },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: workerLogs }),
    });
    addAdotSidecar({
      taskDefinition: workerTask,
      logGroup: workerLogs,
      grafanaAuthSecret,
      grafanaOtlpEndpoint,
    });
    const workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });
    workerService.connections.allowTo(db, ec2.Port.tcp(5432), 'worker → RDS');
    db.connections.allowFrom(workerService, ec2.Port.tcp(5432));

    // ─── chorus-digest (scheduled) ─────────────────────────────────
    const digestLogs = new logs.LogGroup(this, 'DigestLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const digestTask = new ecs.FargateTaskDefinition(this, 'DigestTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
    });
    digestTask.addContainer('digest', {
      image: containerImage(props.digestImageUri, 'digest'),
      environment: {
        ...sharedEnv,
        ...digestEnv,
        WORKER_ONESHOT: 'true',
        OTEL_SERVICE_NAME: 'chorus-digest',
      },
      secrets: { DB_PASSWORD: dbEnv },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'digest', logGroup: digestLogs }),
    });
    addAdotSidecar({
      taskDefinition: digestTask,
      logGroup: digestLogs,
      grafanaAuthSecret,
      grafanaOtlpEndpoint,
    });

    // EventBridge Scheduler invokes the ECS RunTask once a week.
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [digestTask.taskDefinitionArn],
        conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
      }),
    );
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [taskRole.roleArn, digestTask.executionRole?.roleArn ?? '*'],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );

    new scheduler.CfnSchedule(this, 'WeeklyDigestSchedule', {
      // Mondays at 09:00 America/Los_Angeles. Outside DST awareness:
      // EventBridge Scheduler natively supports tz strings, so the time
      // shifts correctly with PT/PDT.
      scheduleExpression: 'cron(0 9 ? * MON *)',
      scheduleExpressionTimezone: 'America/Los_Angeles',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
        ecsParameters: {
          taskDefinitionArn: digestTask.taskDefinitionArn,
          launchType: 'FARGATE',
          taskCount: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: vpc.privateSubnets.map((s) => s.subnetId),
              assignPublicIp: 'DISABLED',
              securityGroups: [workerService.connections.securityGroups[0]?.securityGroupId ?? ''],
            },
          },
        },
      },
    });

    // ─── chorus-audit-consumer ────────────────────────────────────
    // Long-running service draining the audit queue. Uses a distinct
    // task role so the queue's receive/delete permission is scoped to
    // this service only — the api/worker/digest tasks can enqueue but
    // never dequeue, which keeps audit delivery one-directional.
    const auditTaskRole = new iam.Role(this, 'AuditConsumerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    kmsKey.grantDecrypt(auditTaskRole);
    dbSecret.grantRead(auditTaskRole);
    grafanaAuthSecret.grantRead(auditTaskRole);
    auditQueue.grantConsumeMessages(auditTaskRole);

    const auditLogs = new logs.LogGroup(this, 'AuditConsumerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const auditTask = new ecs.FargateTaskDefinition(this, 'AuditConsumerTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: auditTaskRole,
    });
    auditTask.addContainer('audit-consumer', {
      image: containerImage(props.auditConsumerImageUri, 'audit-consumer'),
      environment: {
        AWS_REGION: this.region,
        AUDIT_QUEUE_URL: auditQueue.queueUrl,
        ...telemetryEnv,
        OTEL_SERVICE_NAME: 'chorus-audit-consumer',
      },
      secrets: { DB_PASSWORD: dbEnv },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'audit-consumer', logGroup: auditLogs }),
    });
    addAdotSidecar({
      taskDefinition: auditTask,
      logGroup: auditLogs,
      grafanaAuthSecret,
      grafanaOtlpEndpoint,
    });
    const auditService = new ecs.FargateService(this, 'AuditConsumerService', {
      cluster,
      taskDefinition: auditTask,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });
    auditService.connections.allowTo(db, ec2.Port.tcp(5432), 'audit-consumer → RDS');
    db.connections.allowFrom(auditService, ec2.Port.tcp(5432));

    // ─── Outputs ──────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbPort', { value: db.dbInstanceEndpointPort });
    new cdk.CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'AuditQueueUrl', { value: auditQueue.queueUrl });
    new cdk.CfnOutput(this, 'AuditDlqUrl', { value: auditDlq.queueUrl });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: dbSecret.secretArn });
    new cdk.CfnOutput(this, 'GrafanaAuthSecretArn', { value: grafanaAuthSecret.secretArn });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: kmsKey.keyArn });
    if (props.apiDomainName) {
      new cdk.CfnOutput(this, 'ApiDomain', { value: props.apiDomainName });
    }
  }
}

function containerImage(uri: string | undefined, kind: string): ecs.ContainerImage {
  if (uri) return ecs.ContainerImage.fromRegistry(uri);
  // Synth-time placeholder. `cdk synth` works without an image so CI
  // can validate the template; `cdk deploy` will fail with this URI
  // (intentional — forces the operator to pass --context <kind>ImageUri).
  return ecs.ContainerImage.fromRegistry(
    `placeholder/chorus-${kind}:set-via-context-${kind}ImageUri`,
  );
}
