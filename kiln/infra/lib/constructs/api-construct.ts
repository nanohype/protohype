// API: HTTP API Gateway + WorkOS JWT authorizer + api Lambda.
// CORS is empty by default (machine-to-machine API). Loosen only for an
// authenticated admin UI origin.
//
// API Gateway performs a first-line JWT verify (issuer + audience + signature
// via remote JWKS). The Lambda then re-verifies in application code using the
// Result-returning IdentityPort so every call site is consistently typed and
// the teamId claim is enforced.

import { CfnOutput, Duration } from "aws-cdk-lib";
import { CfnStage, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { createKilnLambda } from "./lambda-factory.js";
import type { SecretsConstruct } from "./secrets-construct.js";
import type { StorageConstruct } from "./storage-construct.js";

export interface ApiConstructProps {
  storage: StorageConstruct;
  secrets: SecretsConstruct;
  workosIssuer: string;
  workosClientId: string;
  sharedEnv: Record<string, string>;
}

export class ApiConstruct extends Construct {
  public readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    const role = new Role(this, "ApiRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"],
        resources: [props.storage.teamConfigTable.tableArn, props.storage.prLedgerTable.tableArn],
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

    const apiFn = createKilnLambda(this, {
      handlerId: "ApiFn",
      entrypoint: "api",
      role,
      env: props.sharedEnv,
      memoryMb: 512,
      timeout: Duration.seconds(29),
    });

    const authorizer = new HttpJwtAuthorizer("WorkOSAuthorizer", props.workosIssuer, {
      identitySource: ["$request.header.Authorization"],
      jwtAudience: [props.workosClientId],
    });

    const accessLogs = new LogGroup(this, "ApiAccessLogs", {
      logGroupName: "/aws/apigateway/kiln",
      retention: RetentionDays.THREE_MONTHS,
    });

    this.api = new HttpApi(this, "Api", {
      apiName: "kiln",
      description: "kiln — dependency upgrade automation service",
      // Empty allowOrigins by design — this API is machine-to-machine. If an
      // admin UI is introduced, scope its origin explicitly.
      defaultAuthorizer: authorizer,
      defaultIntegration: new HttpLambdaIntegration("ApiIntegration", apiFn),
    });

    const stage = this.api.defaultStage?.node.defaultChild as CfnStage;
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        status: "$context.status",
        responseLength: "$context.responseLength",
        authorizerError: "$context.authorizer.error",
      }),
    };

    new CfnOutput(this, "ApiUrl", {
      value: this.api.url ?? "unknown",
      description: "kiln API Gateway URL",
    });
  }
}
