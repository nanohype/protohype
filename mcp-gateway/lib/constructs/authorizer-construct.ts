import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Construct } from 'constructs';
import * as path from 'path';

export class AuthorizerConstruct extends Construct {
  public readonly authorizer: authorizers.HttpLambdaAuthorizer;
  public readonly gatewaySecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.gatewaySecret = new secretsmanager.Secret(this, 'GatewaySecret', {
      secretName: '/mcp-gateway/gateway-bearer-token',
      description: 'Bearer token for MCP Gateway API Gateway',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const authorizerFn = new nodejs.NodejsFunction(this, 'AuthorizerFn', {
      entry: path.join(__dirname, '../../lambda/authorizer/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      environment: {
        GATEWAY_SECRET_ARN: this.gatewaySecret.secretArn,
        POWERTOOLS_SERVICE_NAME: 'mcp-gateway-authorizer',
        LOG_LEVEL: 'INFO',
      },
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    authorizerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [this.gatewaySecret.secretArn],
      conditions: { StringEquals: { 'aws:ResourceAccount': cdk.Stack.of(this).account } },
    }));

    this.authorizer = new authorizers.HttpLambdaAuthorizer('BearerTokenAuthorizer', authorizerFn, {
      responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    new cdk.CfnOutput(this, 'GatewaySecretArn', {
      value: this.gatewaySecret.secretArn,
      description: 'ARN of the gateway bearer token secret',
      exportName: 'McpGateway-GatewaySecretArn',
    });
  }
}
