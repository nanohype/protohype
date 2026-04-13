import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface AlmanacComputeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  tokenTable: dynamodb.ITable;
  auditLogTable: dynamodb.ITable;
  aclCacheTable: dynamodb.ITable;
  auditDlq: sqs.IQueue;
}

export class AlmanacComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlmanacComputeStackProps) {
    super(scope, id, props);
    const { vpc, tokenTable, auditLogTable, aclCacheTable, auditDlq } = props;

    // ONE shared encryption secret (not per-user Secrets Manager -- costs $4k/mo at 10k users)
    const tokenSecret = new secretsmanager.Secret(this, "TokenSecret", {
      secretName: "almanac/token-encryption-key",
      generateSecretString: { secretStringTemplate: JSON.stringify({ key: "" }), generateStringKey: "key", excludePunctuation: true, passwordLength: 64 },
    });
    const oauthSecret = new secretsmanager.Secret(this, "OAuthSecret", { secretName: "almanac/oauth-credentials" });
    const slackSecret = new secretsmanager.Secret(this, "SlackSecret", { secretName: "almanac/slack-credentials" });

    const cluster = new ecs.Cluster(this, "Cluster", { clusterName: "almanac", vpc, containerInsights: true });

    // bot-service: PutItem only on audit log (no Delete/Update)
    const botRole = new iam.Role(this, "BotRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
    botRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["dynamodb:PutItem"], resources: [auditLogTable.tableArn] }));
    botRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["sqs:SendMessage"], resources: [auditDlq.queueArn] }));
    botRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));
    botRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["aoss:APIAccessAll"], resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/almanac-chunks`] }));

    // identity-service: token table only
    const idRole = new iam.Role(this, "IdentityRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
    idRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], resources: [tokenTable.tableArn] }));
    tokenSecret.grantRead(idRole);

    // connector: token + acl-cache tables, bedrock embed, opensearch
    const connRole = new iam.Role(this, "ConnectorRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
    connRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"], resources: [tokenTable.tableArn, aclCacheTable.tableArn] }));
    connRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["bedrock:InvokeModel"], resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`] }));
    connRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ["aoss:APIAccessAll"], resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/almanac-chunks`] }));
    tokenSecret.grantRead(connRole);

    // bot-service Fargate (ALB-fronted, 2-6 tasks)
    const botSvc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "BotService", {
      cluster,
      serviceName: "almanac-bot",
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset("../packages/bot-service"),
        containerPort: 3000,
        taskRole: botRole,
        environment: { NODE_ENV: "production", AWS_REGION: this.region, AUDIT_LOG_TABLE: auditLogTable.tableName, AUDIT_DLQ_URL: auditDlq.queueUrl },
        secrets: {
          SLACK_BOT_TOKEN: ecs.Secret.fromSecretsManager(slackSecret, "bot_token"),
          SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(slackSecret, "signing_secret"),
        },
      },
      publicLoadBalancer: true,
    });
    const scaling = botSvc.service.autoScaleTaskCount({ maxCapacity: 6, minCapacity: 2 });
    scaling.scaleOnCpuUtilization("CpuScaling", { targetUtilizationPercent: 60 });

    // Connector scheduled tasks (EventBridge, every 15 min)
    for (const source of ["notion", "confluence", "gdrive"] as const) {
      const td = new ecs.FargateTaskDefinition(this, `Connector${source}`, { cpu: 256, memoryLimitMiB: 512, taskRole: connRole });
      td.addContainer(`connector-${source}`, {
        image: ecs.ContainerImage.fromAsset(`../packages/connector-${source}`),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: `connector-${source}` }),
        environment: { SOURCE_SYSTEM: source, AWS_REGION: this.region, TOKEN_TABLE: tokenTable.tableName, ACL_CACHE_TABLE: aclCacheTable.tableName },
        secrets: { TOKEN_ENCRYPTION_SECRET_ID: ecs.Secret.fromSecretsManager(tokenSecret) },
      });
      new events.Rule(this, `${source}Schedule`, {
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        ruleName: `almanac-${source}-connector`,
      }).addTarget(new targets.EcsTask({ cluster, taskDefinition: td, subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } }));
    }

    new cdk.CfnOutput(this, "BotServiceUrl", { value: botSvc.loadBalancer.loadBalancerDnsName });
  }
}
