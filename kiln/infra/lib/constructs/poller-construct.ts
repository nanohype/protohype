// Poller Lambda on an EventBridge cron.

import { Duration } from "aws-cdk-lib";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { createKilnLambda } from "./lambda-factory.js";
import type { SecretsConstruct } from "./secrets-construct.js";
import type { StorageConstruct } from "./storage-construct.js";

export interface PollerConstructProps {
  storage: StorageConstruct;
  secrets: SecretsConstruct;
  sharedEnv: Record<string, string>;
  intervalMinutes: number;
}

export class PollerConstruct extends Construct {
  constructor(scope: Construct, id: string, props: PollerConstructProps) {
    super(scope, id);

    const role = new Role(this, "PollerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ["dynamodb:Scan", "dynamodb:Query"],
        resources: [props.storage.teamConfigTable.tableArn, props.storage.prLedgerTable.tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [props.storage.auditLogTable.tableArn, props.storage.rateLimiterTable.tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [props.storage.upgradeQueue.queueArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.secrets.grafanaCloudOtlpSecret.secretArn],
      }),
    );

    const fn = createKilnLambda(this, {
      handlerId: "PollerFn",
      entrypoint: "poller",
      role,
      env: { ...props.sharedEnv, KILN_POLLER_INTERVAL_MINUTES: String(props.intervalMinutes) },
      memoryMb: 512,
      timeout: Duration.minutes(5),
    });

    new Rule(this, "PollerSchedule", {
      schedule: Schedule.rate(Duration.minutes(props.intervalMinutes)),
      description: "kiln upgrade poller cron",
      targets: [new LambdaTarget(fn, { retryAttempts: 2 })],
    });
  }
}
