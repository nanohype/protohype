// Upgrader Lambda — SQS consumer. No reservedConcurrentExecutions by design:
// FIFO group-id fanout provides per-(team, repo, pkg) serialization while
// letting unrelated groups run concurrently. A global cap would be a tenant
// fairness bomb — a single team with 200 pending upgrades would starve others.
// Per-team cost ceilings are enforced by the DDB-backed token bucket instead.

import { Duration } from "aws-cdk-lib";
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import { createKilnLambda } from "./lambda-factory.js";
import type { SecretsConstruct } from "./secrets-construct.js";
import type { StorageConstruct } from "./storage-construct.js";

export interface WorkerConstructProps {
  storage: StorageConstruct;
  secrets: SecretsConstruct;
  sharedEnv: Record<string, string>;
  bedrockModelArns: string[];
}

export class WorkerConstruct extends Construct {
  constructor(scope: Construct, id: string, props: WorkerConstructProps) {
    super(scope, id);

    const role = new Role(this, "WorkerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });

    role.addToPolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
        resources: [
          props.storage.teamConfigTable.tableArn,
          props.storage.prLedgerTable.tableArn,
          props.storage.auditLogTable.tableArn,
          props.storage.changelogCacheTable.tableArn,
          props.storage.rateLimiterTable.tableArn,
          props.storage.githubTokenCacheTable.tableArn,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          props.secrets.githubAppSecret.secretArn,
          props.secrets.grafanaCloudOtlpSecret.secretArn,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: props.bedrockModelArns,
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        resources: [props.storage.upgradeQueue.queueArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [props.storage.upgradeDlq.queueArn],
      }),
    );

    const fn = createKilnLambda(this, {
      handlerId: "WorkerFn",
      entrypoint: "upgrader",
      role,
      env: props.sharedEnv,
      memoryMb: 1024,
      timeout: Duration.minutes(9),
    });

    fn.addEventSource(
      new SqsEventSource(props.storage.upgradeQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
  }
}
