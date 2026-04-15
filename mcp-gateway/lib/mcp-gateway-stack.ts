import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AuthorizerConstruct } from './constructs/authorizer-construct';
import { SwitchboardConstruct } from './constructs/switchboard-construct';
import { MemoryConstruct } from './constructs/memory-construct';
import { DashboardConstruct } from './constructs/dashboard-construct';

/**
 * McpGatewayStack
 *
 * Single CDK stack composing:
 *   1. Shared HTTP API Gateway with bearer token Lambda authorizer
 *   2. MCP Switchboard — routes to third-party services
 *   3. MCP Memory Server — DynamoDB-backed semantic memory
 *   4. Cost Dashboard — token usage and spend tracking
 *
 * Single deploy command: `npm run deploy`
 * Single entry point for Claude managed agents: API Gateway URL
 */
export class McpGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/mcp-gateway',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigatewayv2.HttpApi(this, 'Api', {
      apiName: 'mcp-gateway',
      description: 'MCP Gateway — MCP Switchboard, Memory, Cost Dashboard',
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type', 'X-Agent-Id', 'X-Session-Id'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowOrigins: ['https://*'], // Lock to CloudFront domain post-deploy via SSM parameter
        maxAge: cdk.Duration.days(1),
      },
      createDefaultStage: true,
    });

    const defaultStage = api.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        integrationError: '$context.integrationErrorMessage',
        authorizerError: '$context.authorizer.error',
        userAgent: '$context.identity.userAgent',
      }),
    };

    // 1. Bearer token authorizer — shared across all routes
    const authConstruct = new AuthorizerConstruct(this, 'Authorizer');

    // 2. MCP Switchboard
    new SwitchboardConstruct(this, 'Switchboard', {
      api,
      authorizer: authConstruct.authorizer,
    });

    // 3. MCP Memory Server
    new MemoryConstruct(this, 'Memory', {
      api,
      authorizer: authConstruct.authorizer,
    });

    // 4. Cost Dashboard
    new DashboardConstruct(this, 'Dashboard', {
      api,
      authorizer: authConstruct.authorizer,
    });

    // Health check Lambda — no auth, returns 200 + stack version
    const healthFn = new lambda.Function(this, 'HealthFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      code: lambda.Code.fromInline(`
        exports.handler = async () => ({
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ok', service: 'mcp-gateway', ts: new Date().toISOString() })
        });
      `),
    });

    api.addRoutes({
      path: '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HealthIntegration', healthFn),
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.apiEndpoint,
      description: 'MCP Gateway API Gateway endpoint — use as base URL for MCP clients',
      exportName: 'McpGateway-ApiEndpoint',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: api.apiId,
      description: 'API Gateway ID',
      exportName: 'McpGateway-ApiId',
    });
  }
}
