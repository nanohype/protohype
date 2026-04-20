/**
 * Dispatch — AWS CDK Stack
 * Agent: eng-infra
 *
 * DST-correct scheduling: two EventBridge rules
 *   PST (Nov-Mar): cron(30 17 ? * FRI * 1-3,11-12) — 9:30am UTC-8
 *   PDT (Apr-Oct): cron(30 16 ? * FRI * 4-10)     — 9:30am UTC-7
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface DispatchStackProps extends cdk.StackProps {
  environment: 'staging' | 'production';
  domainName: string;
  /** WorkOS API issuer (default https://api.workos.com) */
  workosIssuer?: string;
  /** WorkOS client ID — used as the JWT audience */
  workosClientId: string;
  /** Bedrock Claude model ID used by the generator */
  bedrockModelId?: string;
}

export class DispatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DispatchStackProps) {
    super(scope, id, props);
    const {
      environment,
      domainName,
      workosIssuer = 'https://api.workos.com',
      workosClientId,
      bedrockModelId = 'anthropic.claude-sonnet-4-6',
    } = props;
    const isProd = environment === 'production';

    // Deploy-populated secret references. CDK doesn't create these — the
    // operator runs `aws secretsmanager create-secret ...` per OPERATIONS.md
    // before first deploy. We only wire IAM + injection.
    const refSecret = (id: string, name: string) =>
      secretsmanager.Secret.fromSecretNameV2(this, id, name);
    const approversSecret = refSecret('ApproversSecret', `dispatch/${environment}/approvers`);
    const workosDirectorySecret = refSecret('WorkOsDirectorySecret', `dispatch/${environment}/workos-directory`);
    const githubSecret = refSecret('GitHubSecret', `dispatch/${environment}/github`);
    const linearSecret = refSecret('LinearSecret', `dispatch/${environment}/linear`);
    const slackSecret = refSecret('SlackSecret', `dispatch/${environment}/slack`);
    const notionSecret = refSecret('NotionSecret', `dispatch/${environment}/notion`);
    const webConfigSecret = refSecret('WebConfigSecret', `dispatch/${environment}/web-config`);
    // Runtime config: { slackReviewChannelId, sesFromAddress, newsletterRecipients }
    const runtimeConfigSecret = refSecret('RuntimeConfig', `dispatch/${environment}/runtime-config`);
    // Grafana Cloud: { instanceId, apiToken, otlpEndpoint, lokiEndpoint, authHeader }
    // The operator pre-computes authHeader = "Basic " + base64("instanceId:apiToken").
    const grafanaCloudSecret = refSecret('GrafanaCloudSecret', `dispatch/${environment}/grafana-cloud`);

    // ADOT Collector sidecar — receives OTLP/HTTP on localhost:4318 and ships
    // traces + metrics to Grafana Cloud (Tempo / Mimir). Logs are NOT shipped
    // through the collector: apps emit JSON to stdout, the ECS awslogs driver
    // ships to CloudWatch (the universal interface), and Grafana queries
    // CloudWatch directly via its native data source. This keeps log routing
    // out of the app and out of the OTel pipeline — adding subsystems in
    // any language is a "emit JSON to stdout" change with zero infra work.
    const collectorConfig = [
      'receivers:',
      '  otlp:',
      '    protocols:',
      '      http:',
      '        endpoint: 0.0.0.0:4318',
      'processors:',
      '  batch:',
      '    timeout: 10s',
      '  resourcedetection/ecs:',
      '    detectors: [env, ecs]',
      'exporters:',
      '  otlphttp/grafana:',
      '    endpoint: ${env:GRAFANA_OTLP_ENDPOINT}',
      '    headers:',
      '      Authorization: ${env:GRAFANA_AUTH_HEADER}',
      'service:',
      '  pipelines:',
      '    traces:',
      '      receivers: [otlp]',
      '      processors: [batch, resourcedetection/ecs]',
      '      exporters: [otlphttp/grafana]',
      '    metrics:',
      '      receivers: [otlp]',
      '      processors: [batch, resourcedetection/ecs]',
      '      exporters: [otlphttp/grafana]',
      '',
    ].join('\n');

    const addCollectorSidecar = (
      taskDef: ecs.TaskDefinition,
      opts: { essential: boolean; suffix: string }
    ): ecs.ContainerDefinition =>
      taskDef.addContainer('aws-otel-collector', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:latest'),
        essential: opts.essential,
        memoryLimitMiB: 256,
        cpu: 128,
        environment: { AOT_CONFIG_CONTENT: collectorConfig },
        secrets: {
          GRAFANA_OTLP_ENDPOINT: ecs.Secret.fromSecretsManager(grafanaCloudSecret, 'otlpEndpoint'),
          GRAFANA_AUTH_HEADER: ecs.Secret.fromSecretsManager(grafanaCloudSecret, 'authHeader'),
        },
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'otel-collector',
          logGroup: new logs.LogGroup(this, `OtelCollectorLogGroup${opts.suffix}`, {
            logGroupName: `/dispatch/${environment}/otel-collector-${opts.suffix.toLowerCase()}`,
            retention: logs.RetentionDays.ONE_WEEK,
          }),
        }),
      });

    const otelEnvFor = (serviceName: string): Record<string, string> => ({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: serviceName,
      OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${environment},service.namespace=dispatch`,
    });

    // VPC
    const vpc = new ec2.Vpc(this, 'DispatchVpc', {
      maxAzs: 2, natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
      ],
    });

    // Aurora Serverless v2
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: `dispatch/${environment}/db-credentials`,
      generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'dispatch_app' }), generateStringKey: 'password', excludePunctuation: true },
    });
    const dbCluster = new rds.DatabaseCluster(this, 'DispatchDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_15_4 }),
      serverlessV2MinCapacity: 0.5, serverlessV2MaxCapacity: isProd ? 8 : 2,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: isProd ? [rds.ClusterInstance.serverlessV2('reader')] : [],
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'dispatch', storageEncrypted: true,
      deletionProtection: isProd, backup: { retention: cdk.Duration.days(isProd ? 14 : 3) },
    });

    // S3 Buckets
    const voiceBaselineBucket = new s3.Bucket(this, 'VoiceBaselineBucket', {
      bucketName: `dispatch-voice-baseline-${this.account}-${environment}`,
      encryption: s3.BucketEncryption.S3_MANAGED, versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const rawAggregationsBucket = new s3.Bucket(this, 'RawAggregationsBucket', {
      bucketName: `dispatch-raw-aggregations-${this.account}-${environment}`,
      encryption: s3.BucketEncryption.S3_MANAGED, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(90), id: 'expire-raw-aggregations' }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'DispatchCluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Pipeline task role (least privilege)
    const pipelineTaskRole = new iam.Role(this, 'PipelineTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        dispatch: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['secretsmanager:GetSecretValue'], resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:dispatch/${environment}/*`] }),
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['s3:GetObject', 's3:ListBucket'], resources: [voiceBaselineBucket.bucketArn, `${voiceBaselineBucket.bucketArn}/*`] }),
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['s3:PutObject'], resources: [`${rawAggregationsBucket.bucketArn}/*`] }),
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['bedrock:InvokeModel'], resources: [`arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`] }),
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: ['*'] }),
          ],
        }),
      },
    });
    dbCluster.grantConnect(pipelineTaskRole, 'dispatch_app');

    const pipelineTaskDef = new ecs.FargateTaskDefinition(this, 'PipelineTask', {
      cpu: 1024, memoryLimitMiB: 2048, taskRole: pipelineTaskRole,
    });
    // Sidecar first so the app container can declare a START dependency.
    const pipelineCollector = addCollectorSidecar(pipelineTaskDef, {
      essential: false, // weekly task: app exit terminates the run; collector follows
      suffix: 'Pipeline',
    });
    const pipelineApp = pipelineTaskDef.addContainer('pipeline', {
      image: ecs.ContainerImage.fromAsset('../', { file: 'Dockerfile.pipeline' }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'pipeline', logGroup: new logs.LogGroup(this, 'PipelineLogGroup', { logGroupName: `/dispatch/${environment}/pipeline`, retention: isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_WEEK }) }),
      environment: {
        NODE_ENV: environment,
        AWS_REGION: this.region,
        BEDROCK_MODEL_ID: bedrockModelId,
        VOICE_BASELINE_BUCKET: voiceBaselineBucket.bucketName,
        RAW_AGGREGATIONS_BUCKET: rawAggregationsBucket.bucketName,
        DATABASE_SECRET_ID: dbSecret.secretName,
        WORKOS_DIRECTORY_SECRET_ID: workosDirectorySecret.secretName,
        GITHUB_SECRET_ID: githubSecret.secretName,
        LINEAR_SECRET_ID: linearSecret.secretName,
        SLACK_SECRET_ID: slackSecret.secretName,
        NOTION_SECRET_ID: notionSecret.secretName,
        ...otelEnvFor('dispatch-pipeline'),
      },
      secrets: {
        SLACK_REVIEW_CHANNEL_ID: ecs.Secret.fromSecretsManager(runtimeConfigSecret, 'slackReviewChannelId'),
      },
    });
    pipelineApp.addContainerDependencies({
      container: pipelineCollector,
      condition: ecs.ContainerDependencyCondition.START,
    });
    // Keep a handle on the security group the pipeline tasks will run with so
    // we can authorize Aurora ingress below. EcsTask picks one at run time; we
    // pre-create it so the SG reference is stable.
    const pipelineSg = new ec2.SecurityGroup(this, 'PipelineTaskSg', { vpc, description: 'Dispatch pipeline task', allowAllOutbound: true });
    dbCluster.connections.allowDefaultPortFrom(pipelineSg, 'Pipeline task → Aurora');

    // EventBridge — DST-correct: two rules (PST + PDT)
    const ecsTaskTarget = (_label: string) => new targets.EcsTask({ cluster, taskDefinition: pipelineTaskDef, subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, taskCount: 1, securityGroups: [pipelineSg] });

    // PST rule: Nov-Mar — 9:30am UTC-8 = 17:30 UTC
    const pipelineRulePst = new events.Rule(this, 'PipelineSchedulePST', {
      schedule: events.Schedule.cron({ minute: '30', hour: '17', weekDay: 'FRI', month: '1-3,11-12' }),
      description: 'Dispatch pipeline — Friday 9:30am PST (Nov-Mar)',
      enabled: isProd,
    });
    pipelineRulePst.addTarget(ecsTaskTarget('pst'));

    // PDT rule: Apr-Oct — 9:30am UTC-7 = 16:30 UTC
    const pipelineRulePdt = new events.Rule(this, 'PipelineSchedulePDT', {
      schedule: events.Schedule.cron({ minute: '30', hour: '16', weekDay: 'FRI', month: '4-10' }),
      description: 'Dispatch pipeline — Friday 9:30am PDT (Apr-Oct)',
      enabled: isProd,
    });
    pipelineRulePdt.addTarget(ecsTaskTarget('pdt'));

    // API service — custom task role so it can read Secrets Manager
    // (approvers, db credentials, slack token) and send via SES.
    const apiTaskRole = new iam.Role(this, 'ApiTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        dispatch: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['secretsmanager:GetSecretValue'], resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:dispatch/${environment}/*`] }),
            new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`] }),
          ],
        }),
      },
    });
    dbCluster.grantConnect(apiTaskRole, 'dispatch_app');

    const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: apiTaskRole,
    });
    apiTaskDef.addContainer('api', {
      image: ecs.ContainerImage.fromAsset('../', { file: 'Dockerfile.api' }),
      portMappings: [{ containerPort: 3001 }],
      environment: {
        NODE_ENV: environment,
        PORT: '3001',
        AWS_REGION: this.region,
        WEB_ORIGIN: `https://${domainName}`,
        WORKOS_ISSUER: workosIssuer,
        WORKOS_CLIENT_ID: workosClientId,
        APPROVERS_SECRET_ID: approversSecret.secretName,
        DATABASE_SECRET_ID: dbSecret.secretName,
        SLACK_SECRET_ID: slackSecret.secretName,
        ...otelEnvFor('dispatch-api'),
      },
      secrets: {
        SLACK_REVIEW_CHANNEL_ID: ecs.Secret.fromSecretsManager(runtimeConfigSecret, 'slackReviewChannelId'),
        SES_FROM_ADDRESS: ecs.Secret.fromSecretsManager(runtimeConfigSecret, 'sesFromAddress'),
        NEWSLETTER_RECIPIENT_LIST: ecs.Secret.fromSecretsManager(runtimeConfigSecret, 'newsletterRecipients'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'api',
        logGroup: new logs.LogGroup(this, 'ApiLogGroup', {
          logGroupName: `/dispatch/${environment}/api`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
      }),
    });
    addCollectorSidecar(apiTaskDef, { essential: true, suffix: 'Api' });

    const apiService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: isProd ? 2 : 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      publicLoadBalancer: false,
    });
    dbCluster.connections.allowDefaultPortFrom(apiService.service, 'API service → Aurora');
    apiService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyHttpCodes: '200',
    });

    // Web service — WorkOS AuthKit secrets injected by ECS from
    // dispatch/${env}/web-config (populated out-of-band by ops).
    // Shape: { workosApiKey, workosClientId, cookiePassword, redirectUri }
    const webTaskRole = new iam.Role(this, 'WebTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: webTaskRole,
    });
    webTaskDef.addContainer('web', {
      image: ecs.ContainerImage.fromAsset('../', { file: 'Dockerfile.web' }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NODE_ENV: environment,
        API_BASE_URL: `https://api.${domainName}`,
        ...otelEnvFor('dispatch-web'),
      },
      secrets: {
        WORKOS_API_KEY: ecs.Secret.fromSecretsManager(webConfigSecret, 'workosApiKey'),
        WORKOS_CLIENT_ID: ecs.Secret.fromSecretsManager(webConfigSecret, 'workosClientId'),
        WORKOS_COOKIE_PASSWORD: ecs.Secret.fromSecretsManager(webConfigSecret, 'cookiePassword'),
        WORKOS_REDIRECT_URI: ecs.Secret.fromSecretsManager(webConfigSecret, 'redirectUri'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'web',
        logGroup: new logs.LogGroup(this, 'WebLogGroup', {
          logGroupName: `/dispatch/${environment}/web`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
      }),
    });
    addCollectorSidecar(webTaskDef, { essential: true, suffix: 'Web' });

    const webService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'WebService', {
      cluster,
      taskDefinition: webTaskDef,
      desiredCount: isProd ? 2 : 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      publicLoadBalancer: true,
    });
    webService.targetGroup.configureHealthCheck({
      path: '/api/health',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyHttpCodes: '200',
    });

    // CloudWatch alarms
    new cloudwatch.Alarm(this, 'ApiErrorRate', {
      metric: apiService.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: cdk.Duration.minutes(5),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 5,
      evaluationPeriods: 2,
      alarmDescription: 'Dispatch API returning 5xx errors',
    });

    new cdk.CfnOutput(this, 'WebUrl', { value: `https://${webService.loadBalancer.loadBalancerDnsName}`, description: 'Dispatch web approval UI URL' });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `https://${apiService.loadBalancer.loadBalancerDnsName}`, description: 'Dispatch API URL' });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: dbCluster.clusterEndpoint.hostname, description: 'Aurora cluster endpoint' });
  }
}
