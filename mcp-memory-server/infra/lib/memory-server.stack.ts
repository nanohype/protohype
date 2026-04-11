import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";
import { MemoryTable, MemoryTableProps } from "./memory-table.construct";

export interface MemoryServerProps extends MemoryTableProps {
  /**
   * Existing RestApi to attach the /memory route to.
   * If omitted a new RestApi is created (useful for standalone deploys).
   */
  existingApi?: apigateway.IRestApi;

  /**
   * ARN of the embedding Lambda function.
   * Can be deployed separately (container image) or passed in from the same stack.
   * If omitted the handler will skip embedding — text-only store mode.
   */
  embeddingFunctionArn?: string;

  /** Lambda memory in MB. Default: 512 */
  lambdaMemoryMb?: number;

  /** Lambda timeout. Default: 29 seconds (APIGW max) */
  lambdaTimeoutSec?: number;

  /** Log retention. Default: ONE_WEEK */
  logRetention?: logs.RetentionDays;
}

/**
 * Attaches an MCP-compatible /memory route to an existing (or new)
 * API Gateway REST API backed by a stateless Lambda function.
 *
 * Drop this construct into any existing CDK stack:
 *
 *   new MemoryServerStack(this, "MemoryServer", {
 *     existingApi: myApi,
 *     embeddingFunctionArn: embeddingFn.functionArn,
 *   });
 */
export class MemoryServerStack extends cdk.Stack {
  public readonly handler: lambda.Function;
  public readonly table: MemoryTable;

  constructor(scope: Construct, id: string, props: MemoryServerProps = {}) {
    super(scope, id);

    // ── 1. DynamoDB table ────────────────────────────────────────────────
    this.table = new MemoryTable(this, "MemoryTable", {
      removalPolicy: props.removalPolicy,
      ssmPrefix: props.ssmPrefix,
    });

    // ── 2. Lambda execution role (least-privilege) ───────────────────────
    const role = new iam.Role(this, "HandlerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Only the four DynamoDB operations the handler actually uses
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DynamoDBMemoryOps",
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:DeleteItem",
          "dynamodb:UpdateItem",
        ],
        resources: [
          this.table.table.tableArn,
          `${this.table.table.tableArn}/index/*`,
        ],
      })
    );

    // Invoke the embedding Lambda if provided
    if (props.embeddingFunctionArn) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: "InvokeEmbeddingFn",
          effect: iam.Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [props.embeddingFunctionArn],
        })
      );
    }

    // ── 3. Lambda function ───────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, "HandlerLogs", {
      retention: props.logRetention ?? logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.handler = new lambda.Function(this, "Handler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, "../../src"), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            "bash",
            "-c",
            "npm ci --production && cp -rT . /asset-output",
          ],
        },
      }),
      handler: "handler.handler",
      role,
      memorySize: props.lambdaMemoryMb ?? 512,
      timeout: cdk.Duration.seconds(props.lambdaTimeoutSec ?? 29),
      logGroup,
      environment: {
        TABLE_NAME: this.table.table.tableName,
        EMBEDDING_FUNCTION_ARN: props.embeddingFunctionArn ?? "",
        NODE_OPTIONS: "--enable-source-maps",
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // ── 4. API Gateway integration ───────────────────────────────────────
    const api =
      props.existingApi ??
      new apigateway.RestApi(this, "Api", {
        restApiName: "mcp-memory-api",
        description: "MCP Memory Server",
        deployOptions: { stageName: "v1" },
      });

    // Attach as a new resource on the existing RestApi
    // Works whether existingApi is provided or we created our own above
    const restApi = api instanceof apigateway.RestApi ? api : undefined;
    const memoryResource = restApi
      ? restApi.root.addResource("memory")
      : // For IRestApi we use the low-level CfnResource
        ((): apigateway.Resource => {
          throw new Error(
            "Provide a RestApi instance (not IRestApi) to add routes programmatically. " +
              "Use RestApi.fromRestApiAttributes() to get a mutable reference."
          );
        })();

    const proxyResource = memoryResource.addResource("{proxy+}");
    const integration = new apigateway.LambdaIntegration(this.handler, {
      proxy: true,
    });

    // Allow all HTTP methods — MCP uses POST for tool calls
    for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
      proxyResource.addMethod(method, integration);
    }
    // Also handle /memory directly (tools/list, etc.)
    for (const method of ["GET", "POST", "OPTIONS"]) {
      memoryResource.addMethod(method, integration);
    }

    // ── 5. Outputs ───────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "MemoryEndpoint", {
      value: `${
        api instanceof apigateway.RestApi
          ? api.url
          : "https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/"
      }memory`,
      description: "MCP Memory Server endpoint",
    });

    new cdk.CfnOutput(this, "HandlerArn", {
      value: this.handler.functionArn,
      description: "MCP Memory Lambda ARN",
    });
  }
}
