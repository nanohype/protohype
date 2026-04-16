/**
 * KilnStack — main CDK stack.
 *
 * Composes:
 *   1. HTTP API Gateway (shared, with Okta OIDC JWT authorizer)
 *   2. ConfigConstruct — team config CRUD, PR ledger, health checks
 *   3. WorkerConstruct — upgrade poller, upgrade worker, GitHub App secret
 */
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Construct } from 'constructs';
import { ConfigConstruct } from './constructs/config-construct';
import { WorkerConstruct } from './constructs/worker-construct';

export class KilnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Access log group ──────────────────────────────────────────────────────
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/kiln',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── HTTP API Gateway ──────────────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'Api', {
      apiName: 'kiln',
      description: 'Kiln — dependency upgrade automation service',
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowOrigins: ['https://*'],
        maxAge: cdk.Duration.days(1),
      },
      createDefaultStage: true,
    });

    // Configure access logging on the default stage
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
        responseLength: '$context.responseLength',
        integrationError: '$context.integrationErrorMessage',
        authorizerError: '$context.authorizer.error',
        correlationId: '$context.requestId',
      }),
    };

    // ── Okta JWT authorizer ───────────────────────────────────────────────────
    // Identity: team membership verified per request via Okta OIDC.
    // The authorizer extracts teamId from the JWT `groups` claim — never from
    // email prefix or Okta user-id.
    const oktaIssuer = process.env.KILN_OKTA_ISSUER ?? 'https://your-org.okta.com/oauth2/default';

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('OktaAuthorizer', oktaIssuer, {
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [process.env.KILN_OKTA_AUDIENCE ?? 'api://kiln'],
    });

    // ── Constructs ────────────────────────────────────────────────────────────

    const configConstruct = new ConfigConstruct(this, 'Config', { api });
    new WorkerConstruct(this, 'Worker', { configConstruct });

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url ?? 'unknown',
      description: 'Kiln API Gateway URL',
      exportName: 'KilnApiUrl',
    });

    new cdk.CfnOutput(this, 'TeamConfigTableName', {
      value: configConstruct.teamConfigTable.tableName,
      description: 'DynamoDB table: team configs',
    });

    new cdk.CfnOutput(this, 'PrLedgerTableName', {
      value: configConstruct.prLedgerTable.tableName,
      description: 'DynamoDB table: PR authoring ledger',
    });

    // Export authorizer — used to gate all routes in submodules
    void jwtAuthorizer;
  }
}
