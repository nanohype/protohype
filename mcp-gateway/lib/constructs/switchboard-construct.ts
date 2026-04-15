import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { IHttpRouteAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export interface SwitchboardConstructProps {
  readonly api: apigatewayv2.HttpApi;
  readonly authorizer: IHttpRouteAuthorizer;
}

export class SwitchboardConstruct extends Construct {
  public readonly switchboardFn: lambda.Function;
  private static readonly SERVICES = ['hubspot','google-drive','google-calendar','google-analytics','google-custom-search','stripe'] as const;

  constructor(scope: Construct, id: string, props: SwitchboardConstructProps) {
    super(scope, id);

    const serviceSecretArns: Record<string, string> = {};
    const serviceSecrets: secretsmanager.Secret[] = [];

    for (const svc of SwitchboardConstruct.SERVICES) {
      const secret = new secretsmanager.Secret(this, `Secret-${svc}`, {
        secretName: `/mcp-gateway/mcp-switchboard/${svc}`,
        description: `Credentials for MCP Switchboard service: ${svc}`,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      serviceSecretArns[svc] = secret.secretArn;
      serviceSecrets.push(secret);
    }

    const secretEnv: Record<string, string> = {};
    for (const [svc, arn] of Object.entries(serviceSecretArns)) {
      secretEnv[`SECRET_ARN_${svc.toUpperCase().replace(/-/g, '_')}`] = arn;
    }

    this.switchboardFn = new nodejs.NodejsFunction(this, 'SwitchboardFn', {
      entry: path.join(__dirname, '../../lambda/switchboard/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: { ...secretEnv, POWERTOOLS_SERVICE_NAME: 'mcp-switchboard', LOG_LEVEL: 'INFO' },
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    for (const secret of serviceSecrets) { secret.grantRead(this.switchboardFn); }
    this.switchboardFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: serviceSecrets.map((s) => s.secretArn),
    }));

    const integration = new integrations.HttpLambdaIntegration('SwitchboardIntegration', this.switchboardFn);
    props.api.addRoutes({ path: '/mcp/{service}/{proxy+}', methods: [apigatewayv2.HttpMethod.ANY], integration, authorizer: props.authorizer });
    props.api.addRoutes({ path: '/mcp/{service}', methods: [apigatewayv2.HttpMethod.ANY], integration, authorizer: props.authorizer });

    new cdk.CfnOutput(this, 'SwitchboardFunctionArn', { value: this.switchboardFn.functionArn, description: 'MCP Switchboard Lambda ARN', exportName: 'McpGateway-SwitchboardFunctionArn' });
    new cdk.CfnOutput(this, 'SwitchboardEndpoint', { value: `${props.api.apiEndpoint}/mcp/{service}`, description: 'MCP Switchboard endpoint pattern', exportName: 'McpGateway-SwitchboardEndpoint' });
  }
}
