import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { IHttpRouteAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export interface DashboardConstructProps {
  readonly api: apigatewayv2.HttpApi;
  readonly authorizer: IHttpRouteAuthorizer;
}

export class DashboardConstruct extends Construct {
  public readonly costDataBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: DashboardConstructProps) {
    super(scope, id);

    this.costDataBucket = new s3.Bucket(this, 'CostDataBucket', {
      bucketName: `mcp-gateway-cost-data-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ id: 'expire-old-cost-events', enabled: true, expiration: cdk.Duration.days(365) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [{ allowedMethods: [s3.HttpMethods.GET], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3000 }],
    });

    const dashboardApiFn = new nodejs.NodejsFunction(this, 'DashboardApiFn', {
      entry: path.join(__dirname, '../../lambda/dashboard/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: { COST_DATA_BUCKET: this.costDataBucket.bucketName, POWERTOOLS_SERVICE_NAME: 'dashboard-api', LOG_LEVEL: 'INFO' },
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    dashboardApiFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'],
      resources: [this.costDataBucket.bucketArn, `${this.costDataBucket.bucketArn}/*`],
    }));

    const dashboardIntegration = new integrations.HttpLambdaIntegration('DashboardApiIntegration', dashboardApiFn);
    props.api.addRoutes({ path: '/dashboard/api/{proxy+}', methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST], integration: dashboardIntegration, authorizer: props.authorizer });

    const staticBucket = new s3.Bucket(this, 'StaticBucket', {
      bucketName: `mcp-gateway-dashboard-static-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: { name: 'mcp-gateway-dashboard-oac', originAccessControlOriginType: 's3', signingBehavior: 'always', signingProtocol: 'sigv4' },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(staticBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(10) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(10) },
      ],
      comment: 'MCP Gateway Cost Dashboard',
    });

    const cfnDist = this.distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDist.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.getAtt('Id'));
    cfnDist.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');

    staticBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [`${staticBucket.bucketArn}/*`],
      conditions: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${this.distribution.distributionId}` } },
    }));

    new s3deploy.BucketDeployment(this, 'StaticDeployment', {
      sources: [s3deploy.Source.jsonData('config.json', { apiEndpoint: props.api.apiEndpoint, region: cdk.Stack.of(this).region })],
      destinationBucket: staticBucket,
      distribution: this.distribution,
      distributionPaths: ['/config.json'],
    });

    new cdk.CfnOutput(this, 'CostDataBucketName', { value: this.costDataBucket.bucketName, description: 'S3 bucket where perf-logger writes cost events', exportName: 'McpGateway-CostDataBucketName' });
    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${this.distribution.distributionDomainName}`, description: 'Cost Dashboard URL', exportName: 'McpGateway-DashboardUrl' });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId, description: 'CloudFront distribution ID for cache invalidation', exportName: 'McpGateway-DistributionId' });
    new cdk.CfnOutput(this, 'StaticBucketName', { value: staticBucket.bucketName, description: 'S3 bucket for dashboard static assets', exportName: 'McpGateway-StaticBucketName' });
  }
}
