/**
 * CDK Stack: MCP Switchboard
 *
 * Resources:
 *   - API Gateway HTTP API with routes for each service
 *   - Lambda function (NodejsFunction with esbuild bundling)
 *   - Secrets Manager secrets (one per service, pre-created with placeholder values)
 *   - IAM: Lambda can read Secrets Manager secrets under the mcp-switchboard/* prefix
 *   - CloudWatch Log Group with 30-day retention
 *
 * After deploy, populate each secret in the AWS Console or via CLI:
 *   aws secretsmanager put-secret-value --secret-id mcp-switchboard/hubspot --secret-string '{"apiKey":"..."}'
 */

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Service definitions ──────────────────────────────────────────────────────

const SERVICES = ['hubspot', 'gdrive', 'gcal', 'analytics', 'gcse', 'stripe'] as const;
type Service = (typeof SERVICES)[number];

/** Placeholder secret values — operator must replace these after deploy. */
const PLACEHOLDER_SECRETS: Record<Service, Record<string, string>> = {
  hubspot: { apiKey: 'REPLACE_ME' },
  gdrive: { serviceAccountKey: '{}' },
  gcal: { serviceAccountKey: '{}', impersonateEmail: 'REPLACE_ME' },
  analytics: { serviceAccountKey: '{}', propertyId: 'REPLACE_ME' },
  gcse: { apiKey: 'REPLACE_ME', engineId: 'REPLACE_ME' },
  stripe: { secretKey: 'REPLACE_ME' },
};

// ─── Stack ────────────────────────────────────────────────────────────────────

export interface McpSwitchboardStackProps extends cdk.StackProps {
  /** Secret prefix in Secrets Manager. Default: "mcp-switchboard" */
  secretPrefix?: string;
  /** Memory allocated to Lambda. Default: 512 */
  lambdaMemoryMb?: number;
  /** Lambda timeout in seconds. Default: 30 */
  lambdaTimeoutSec?: number;
}

export class McpSwitchboardStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: McpSwitchboardStackProps = {}) {
    super(scope, id, props);

    const secretPrefix = props.secretPrefix ?? 'mcp-switchboard';
    const lambdaMemoryMb = props.lambdaMemoryMb ?? 512;
    const lambdaTimeoutSec = props.lambdaTimeoutSec ?? 30;

    // ─── Secrets Manager — one secret per service ───────────────────────────

    const secrets: Record<Service, secretsmanager.Secret> = {} as Record<Service, secretsmanager.Secret>;

    for (const service of SERVICES) {
      secrets[service] = new secretsmanager.Secret(this, `Secret${capitalize(service)}`, {
        secretName: `${secretPrefix}/${service}`,
        description: `MCP Switchboard credentials for ${service}`,
        secretObjectValue: Object.fromEntries(
          Object.entries(PLACEHOLDER_SECRETS[service]).map(([k, v]) => [k, cdk.SecretValue.unsafePlainText(v)])
        ),
        removalPolicy: cdk.RemovalPolicy.RETAIN, // never delete secrets on stack destroy
      });
    }

    // ─── Lambda — NodejsFunction with esbuild bundling ──────────────────────

    const logGroup = new logs.LogGroup(this, 'LambdaLogs', {
      logGroupName: `/aws/lambda/mcp-switchboard`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new nodejs.NodejsFunction(this, 'McpSwitchboardLambda', {
      functionName: 'mcp-switchboard',
      // Entry point is relative to the CDK project root (infra/)
      // We point to the compiled source two directories up
      entry: path.resolve(__dirname, '../../src/lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: lambdaMemoryMb,
      timeout: cdk.Duration.seconds(lambdaTimeoutSec),
      logGroup,
      bundling: {
        // esbuild bundles everything except @aws-sdk/* (available in Lambda runtime)
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: false,
        target: 'node22',
        format: nodejs.OutputFormat.CJS,
        // Ensure googleapis grpc is handled correctly
        esbuildArgs: {
          '--conditions': 'require,node',
        },
      },
      environment: {
        SECRET_PREFIX: secretPrefix,
        LOG_LEVEL: 'info',
      },
    });

    // ─── IAM — grant Lambda read access to all mcp-switchboard/* secrets ──────────

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: SERVICES.map(s => `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretPrefix}/${s}-*`),
      })
    );

    // ─── API Gateway HTTP API ────────────────────────────────────────────────

    const httpApi = new apigateway.HttpApi(this, 'McpSwitchboardApi', {
      apiName: 'mcp-switchboard',
      description: 'MCP Switchboard — remote MCP servers for HubSpot, Google Drive, Calendar, Analytics, CSE, Stripe',
      corsPreflight: {
        allowHeaders: ['content-type', 'mcp-session-id'],
        allowMethods: [apigateway.CorsHttpMethod.POST, apigateway.CorsHttpMethod.GET, apigateway.CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'], // restrict to specific origins in production
      },
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration('McpSwitchboardIntegration', fn, {
      payloadFormatVersion: apigateway.PayloadFormatVersion.VERSION_2_0,
    });

    // Add a route for each service (POST /{service})
    for (const service of SERVICES) {
      httpApi.addRoutes({
        path: `/${service}`,
        methods: [apigateway.HttpMethod.POST],
        integration: lambdaIntegration,
      });
    }

    this.apiUrl = httpApi.apiEndpoint;

    // ─── Outputs ─────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'MCP Switchboard API endpoint',
      exportName: 'McpSwitchboardApiEndpoint',
    });

    for (const service of SERVICES) {
      new cdk.CfnOutput(this, `${capitalize(service)}Url`, {
        value: `${httpApi.apiEndpoint}/${service}`,
        description: `MCP Streamable HTTP endpoint for ${service}`,
      });
    }

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });

    // ─── Tags ─────────────────────────────────────────────────────────────────

    cdk.Tags.of(this).add('project', 'mcp-switchboard');
    cdk.Tags.of(this).add('managed-by', 'cdk');
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
