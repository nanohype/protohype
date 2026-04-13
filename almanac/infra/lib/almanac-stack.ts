import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface AlmanacStackProps extends cdk.StackProps {
  environment: 'production' | 'staging';
}

export class AlmanacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlmanacStackProps) {
    super(scope, id, props);

    const isProd = props.environment === 'production';

    // ─── VPC ───────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'AlmanacVpc', {
      maxAzs: 2,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // VPC Endpoints — keep traffic off public internet
    vpc.addGatewayEndpoint('DynamoDBEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
    vpc.addInterfaceEndpoint('SQSEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SQS, privateDnsEnabled: true });
    vpc.addInterfaceEndpoint('SecretsManagerEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER, privateDnsEnabled: true });
    vpc.addInterfaceEndpoint('BedrockEndpoint', { service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.bedrock-runtime`, 443), privateDnsEnabled: true });

    // ─── KMS CMK ──────────────────────────────────────────────────────────
    const tokenKey = new kms.Key(this, 'AlmanacTokenKey', {
      alias: 'almanac/token-key',
      description: 'CMK for Almanac per-user OAuth token envelope encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── DynamoDB: tokens ──────────────────────────────────────────────────
    const tokensTable = new dynamodb.Table(this, 'AlmanacTokensTable', {
      tableName: 'almanac-tokens',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ─── DynamoDB: audit log ───────────────────────────────────────────────
    const auditTable = new dynamodb.Table(this, 'AlmanacAuditTable', {
      tableName: 'almanac-audit-log',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    auditTable.addGlobalSecondaryIndex({
      indexName: 'gsi-user-queries',
      partitionKey: { name: 'slackUserId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─── SQS: audit queue + DLQ ────────────────────────────────────────────
    const auditDlq = new sqs.Queue(this, 'AlmanacAuditDlq', {
      queueName: 'almanac-audit-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const auditQueue = new sqs.Queue(this, 'AlmanacAuditQueue', {
      queueName: 'almanac-audit-queue',
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: auditDlq, maxReceiveCount: 3 },
    });

    // ─── Lambda: audit writer ──────────────────────────────────────────────
    const auditWriterRole = new iam.Role(this, 'AuditWriterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    });
    auditTable.grantWriteData(auditWriterRole);
    auditQueue.grantConsumeMessages(auditWriterRole);

    const auditWriterFn = new lambda.Function(this, 'AuditWriter', {
      functionName: 'almanac-audit-writer',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
        const dynamo = new DynamoDBClient({});
        exports.handler = async (event) => {
          for (const record of event.Records) {
            const audit = JSON.parse(record.body);
            const ttl = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
            await dynamo.send(new PutItemCommand({
              TableName: process.env.AUDIT_TABLE,
              Item: {
                pk: { S: 'QUERY#' + audit.queryId },
                sk: { S: 'TS#' + audit.timestamp },
                slackUserId: { S: audit.slackUserId },
                oktaUserId: { S: audit.oktaUserId },
                questionHash: { S: audit.questionHash },
                retrievedDocIds: { SS: audit.retrievedDocIds.length ? audit.retrievedDocIds : ['NONE'] },
                answerHash: { S: audit.answerHash },
                latencyMs: { N: String(audit.latencyMs) },
                timestamp: { S: audit.timestamp },
                ttl: { N: String(ttl) },
              },
            }));
          }
        };
      `),
      environment: { AUDIT_TABLE: auditTable.tableName },
      role: auditWriterRole,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    auditWriterFn.addEventSource(new lambdaEventSources.SqsEventSource(auditQueue, { batchSize: 10 }));

    // ─── ElastiCache Redis ─────────────────────────────────────────────────
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'Almanac Redis SG', allowAllOutbound: false });

    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'AlmanacCacheSubnetGroup', {
      description: 'Almanac ElastiCache subnet group',
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: 'almanac-cache-subnet-group',
    });

    const redisCluster = new elasticache.CfnReplicationGroup(this, 'AlmanacRedis', {
      replicationGroupDescription: 'Almanac rate-limiter Redis',
      numCacheClusters: 2,
      cacheNodeType: 'cache.t4g.small',
      engine: 'redis',
      engineVersion: '7.1',
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      cacheSubnetGroupName: cacheSubnetGroup.cacheSubnetGroupName,
      securityGroupIds: [redisSg.securityGroupId],
    });
    redisCluster.addDependency(cacheSubnetGroup);

    // ─── Secrets ───────────────────────────────────────────────────────────
    const slackSigningSecret = new secretsmanager.Secret(this, 'SlackSigningSecret', { secretName: 'almanac/slack-signing-secret', description: 'Slack app signing secret' });
    const oktaApiToken = new secretsmanager.Secret(this, 'OktaApiToken', { secretName: 'almanac/okta-api-token', description: 'Okta service account API token (SCIM)' });
    const oauthSecrets = new secretsmanager.Secret(this, 'OauthSecrets', { secretName: 'almanac/oauth-client-secrets', description: 'OAuth2 client IDs+secrets for Notion, Confluence, Google + Slack bot token + BASE_URL' });

    // ─── ECR ───────────────────────────────────────────────────────────────
    const ecrRepo = new ecr.Repository(this, 'AlmanacApiRepo', {
      repositoryName: 'almanac-api',
      lifecycleRules: [{ maxImageCount: 10 }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── ECS Cluster + Fargate ─────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'AlmanacCluster', { vpc, clusterName: 'almanac', containerInsights: true });

    const taskRole = new iam.Role(this, 'AlmanacTaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'), roleName: 'almanac-task-role' });
    tokensTable.grantReadWriteData(taskRole);
    auditQueue.grantSendMessages(taskRole);
    tokenKey.grantEncryptDecrypt(taskRole);
    slackSigningSecret.grantRead(taskRole);
    oktaApiToken.grantRead(taskRole);
    oauthSecrets.grantRead(taskRole);
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/us.anthropic.claude-3-haiku-20240307-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.rerank-v1:0`,
      ],
    }));

    const taskDef = new ecs.FargateTaskDefinition(this, 'AlmanacTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      runtimePlatform: { operatingSystemFamily: ecs.OperatingSystemFamily.LINUX, cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    taskDef.addContainer('almanac-api', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'almanac-api', logRetention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        AWS_REGION: this.region,
        DYNAMO_TOKENS_TABLE: tokensTable.tableName,
        AUDIT_SQS_QUEUE_URL: auditQueue.queueUrl,
        KMS_KEY_ID: tokenKey.keyId,
        REDIS_URL: `rediss://${redisCluster.attrPrimaryEndPointAddress}:${redisCluster.attrPrimaryEndPointPort}`,
        CONFLUENCE_BASE_URL: 'https://nanocorp.atlassian.net',
        NODE_ENV: props.environment,
      },
      secrets: {
        SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(slackSigningSecret),
        SLACK_BOT_TOKEN: ecs.Secret.fromSecretsManager(oauthSecrets, 'slack_bot_token'),
        OKTA_API_TOKEN: ecs.Secret.fromSecretsManager(oktaApiToken),
        OKTA_SCIM_BASE_URL: ecs.Secret.fromSecretsManager(oktaApiToken, 'scim_base_url'),
        NOTION_CLIENT_ID: ecs.Secret.fromSecretsManager(oauthSecrets, 'notion_client_id'),
        NOTION_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthSecrets, 'notion_client_secret'),
        CONFLUENCE_CLIENT_ID: ecs.Secret.fromSecretsManager(oauthSecrets, 'confluence_client_id'),
        CONFLUENCE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthSecrets, 'confluence_client_secret'),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(oauthSecrets, 'google_client_id'),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthSecrets, 'google_client_secret'),
        BASE_URL: ecs.Secret.fromSecretsManager(oauthSecrets, 'base_url'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', { vpc, description: 'Almanac ECS task SG', allowAllOutbound: true });
    redisSg.addIngressRule(ecsSg, ec2.Port.tcp(6379), 'ECS to Redis');

    const fargateService = new ecs.FargateService(this, 'AlmanacService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: !isProd,
      circuitBreaker: { rollback: true },
    });

    const scaling = fargateService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 });
    scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70, scaleInCooldown: cdk.Duration.seconds(300), scaleOutCooldown: cdk.Duration.seconds(120) });

    // ─── ALB ───────────────────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AlmanacAlb', { vpc, internetFacing: true, loadBalancerName: 'almanac-alb' });

    const listener = alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      // TODO: replace with actual ACM cert ARN before deploy
      certificates: [elbv2.ListenerCertificate.fromArn(`arn:aws:acm:${this.region}:${this.account}:certificate/REPLACE_WITH_CERT_ARN`)],
      defaultAction: elbv2.ListenerAction.fixedResponse(404),
    });

    listener.addTargets('AlmanacTargets', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [fargateService],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ─── WAF ───────────────────────────────────────────────────────────────
    const waf = new wafv2.CfnWebACL(this, 'AlmanacWaf', {
      name: 'almanac-waf',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: [{
        name: 'AWSManagedRulesCommonRuleSet',
        priority: 1,
        overrideAction: { none: {} },
        statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
        visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'CommonRuleSet' },
      }],
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'AlmanacWaf' },
    });

    new wafv2.CfnWebACLAssociation(this, 'WafAlbAssociation', { resourceArn: alb.loadBalancerArn, webAclArn: waf.attrArn });

    // ─── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName, description: 'ALB DNS — point almanac.nanocorp.internal CNAME here' });
    new cdk.CfnOutput(this, 'EcrRepoUri', { value: ecrRepo.repositoryUri, description: 'ECR repo URI for CI/CD image push' });
    new cdk.CfnOutput(this, 'TokensTableName', { value: tokensTable.tableName });
    new cdk.CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
    new cdk.CfnOutput(this, 'AuditQueueUrl', { value: auditQueue.queueUrl });
    new cdk.CfnOutput(this, 'KmsKeyId', { value: tokenKey.keyId });
  }
}
