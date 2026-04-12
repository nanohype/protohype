import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { McpGatewayStack } from '../lib/mcp-gateway-stack';

describe('McpGatewayStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: { 'aws:cdk:disable-asset-staging-context': true },
    });
    const stack = new McpGatewayStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    template = Template.fromStack(stack);
  });

  test('synthesizes without errors', () => { expect(template).toBeDefined(); });
  test('creates HTTP API Gateway', () => { template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' }); });
  test('creates Lambda authorizer', () => { template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'REQUEST', EnableSimpleResponses: true }); });
  test('creates DynamoDB table with correct keys', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'mcp-gateway-memory',
      KeySchema: Match.arrayWith([
        { AttributeName: 'agentId', KeyType: 'HASH' },
        { AttributeName: 'memoryId', KeyType: 'RANGE' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
  test('creates S3 bucket for cost data', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
  });
  test('creates CloudFront distribution', () => { template.resourceCountIs('AWS::CloudFront::Distribution', 1); });
  test('creates gateway secret', () => { template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: '/mcp-gateway/gateway-bearer-token' }); });
  test('creates per-service secrets', () => {
    for (const svc of ['hubspot','google-drive','google-calendar','google-analytics','google-custom-search','stripe']) {
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: `/mcp-gateway/mcp-switchboard/${svc}` });
    }
  });
  test('authorizer Lambda has correct memory and timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { MemorySize: 128, Timeout: 5 });
  });
  test('embedding Lambda has high memory allocation', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { MemorySize: 3008, Timeout: 60 });
  });
  test('memory Lambda can invoke embedding Lambda', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:InvokeFunction', Effect: 'Allow' })]) }),
    });
  });
  test('no public S3 bucket policies', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      const props = bucket.Properties as Record<string, unknown>;
      const blockConfig = props['PublicAccessBlockConfiguration'] as Record<string, boolean> | undefined;
      if (blockConfig) {
        expect(blockConfig['BlockPublicAcls']).toBe(true);
        expect(blockConfig['RestrictPublicBuckets']).toBe(true);
      }
    }
  });
});
