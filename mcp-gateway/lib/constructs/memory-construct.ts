import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { IHttpRouteAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export interface MemoryConstructProps {
  readonly api: apigatewayv2.HttpApi;
  readonly authorizer: IHttpRouteAuthorizer;
}

export class MemoryConstruct extends Construct {
  public readonly memoryTable: dynamodb.Table;
  public readonly embeddingFn: lambda.DockerImageFunction;
  public readonly memoryFn: lambda.Function;

  constructor(scope: Construct, id: string, props: MemoryConstructProps) {
    super(scope, id);

    this.memoryTable = new dynamodb.Table(this, 'MemoryTable', {
      tableName: 'mcp-gateway-memory',
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'memoryId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    this.memoryTable.addGlobalSecondaryIndex({
      indexName: 'agentId-createdAt-index',
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.embeddingFn = new lambda.DockerImageFunction(this, 'EmbeddingFn', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../lambda/memory-embeddings')),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(60),
      memorySize: 3008,
      environment: { MODEL_NAME: 'all-MiniLM-L6-v2', POWERTOOLS_SERVICE_NAME: 'memory-embeddings', LOG_LEVEL: 'INFO' },
    });

    this.memoryFn = new nodejs.NodejsFunction(this, 'MemoryFn', {
      entry: path.join(__dirname, '../../lambda/memory/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // 90s covers embedding Lambda cold start (~30s model load) + actual
      // embedding call + DynamoDB writes with headroom. 30s was tight and
      // produced 503s on first call when the embedding container was cold.
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      environment: { MEMORY_TABLE_NAME: this.memoryTable.tableName, EMBEDDING_FUNCTION_NAME: this.embeddingFn.functionName, POWERTOOLS_SERVICE_NAME: 'mcp-memory', LOG_LEVEL: 'INFO' },
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    this.memoryFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem','dynamodb:GetItem','dynamodb:DeleteItem','dynamodb:Query'],
      resources: [this.memoryTable.tableArn, `${this.memoryTable.tableArn}/index/*`],
      conditions: { StringEquals: { 'aws:ResourceAccount': cdk.Stack.of(this).account } },
    }));

    this.embeddingFn.grantInvoke(this.memoryFn);
    this.memoryFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [this.embeddingFn.functionArn],
    }));

    const integration = new integrations.HttpLambdaIntegration('MemoryIntegration', this.memoryFn);
    props.api.addRoutes({ path: '/memory', methods: [apigatewayv2.HttpMethod.POST], integration, authorizer: props.authorizer });
    props.api.addRoutes({ path: '/memory/{proxy+}', methods: [apigatewayv2.HttpMethod.ANY], integration, authorizer: props.authorizer });

    new cdk.CfnOutput(this, 'MemoryTableName', { value: this.memoryTable.tableName, description: 'DynamoDB table for agent memory', exportName: 'McpGateway-MemoryTableName' });
    new cdk.CfnOutput(this, 'MemoryEndpoint', { value: `${props.api.apiEndpoint}/memory`, description: 'MCP Memory Server endpoint', exportName: 'McpGateway-MemoryEndpoint' });
  }
}
