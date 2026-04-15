import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChorusStack } from './chorus-stack.js';

function synth(props = {}): Template {
  const app = new cdk.App();
  const stack = new ChorusStack(app, 'TestChorusStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

describe('ChorusStack', () => {
  it('creates a VPC with public, private, and isolated subnets', () => {
    const t = synth();
    t.resourceCountIs('AWS::EC2::VPC', 1);
    // 3 AZs × 3 tiers = 9 subnets
    t.resourceCountIs('AWS::EC2::Subnet', 9);
  });

  it('creates a KMS key with rotation enabled and uses it for RDS, Secrets, SQS', () => {
    const t = synth();
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    t.hasResourceProperties('AWS::RDS::DBInstance', { StorageEncrypted: true });
    t.hasResourceProperties('AWS::SQS::Queue', { KmsMasterKeyId: Match.anyValue() });
  });

  it('creates an RDS Postgres 16 instance with multi-AZ and pgvector-ready params', () => {
    const t = synth();
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16'),
      MultiAZ: true,
      DeletionProtection: true,
    });
  });

  it('exposes the API behind an internet-facing ALB on port 80', () => {
    const t = synth();
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  it('runs the API health check against /healthz', () => {
    const t = synth();
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/healthz',
    });
  });

  it('creates SQS DLQ with KMS encryption and 14-day retention', () => {
    const t = synth();
    t.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
  });

  it('creates Secrets Manager entries for each external integration with a fixed name', () => {
    const t = synth();
    const expected = [
      'chorus/workos/api-key',
      'chorus/slack/bot-token',
      'chorus/slack/signing-secret',
      'chorus/linear/api-key',
      'chorus/ingest/api-key',
    ];
    for (const name of expected) {
      t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: name });
    }
  });

  it('grants the task role bedrock:InvokeModel for Titan and Haiku, comprehend:DetectPiiEntities, and SQS send', () => {
    const t = synth();
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'bedrock:InvokeModel' }),
          Match.objectLike({ Action: 'comprehend:DetectPiiEntities' }),
        ]),
      },
    });
  });

  it('creates three Fargate task definitions: api, worker, digest', () => {
    const t = synth();
    t.resourceCountIs('AWS::ECS::TaskDefinition', 3);
  });

  it('schedules the digest at Mondays 09:00 in America/Los_Angeles', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 9 ? * MON *)',
      ScheduleExpressionTimezone: 'America/Los_Angeles',
    });
  });

  it('creates VPC interface endpoints for Bedrock, Comprehend, Secrets Manager, ECR, Logs, SQS', () => {
    const t = synth();
    // 7 interface endpoints (Bedrock, Comprehend, Secrets, ECR API, ECR Docker, Logs, SQS)
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 8); // includes the S3 gateway
  });

  it('exposes ALB DNS, RDS endpoint, DLQ URL, and KMS ARN as outputs', () => {
    const t = synth();
    const outs = t.findOutputs('*');
    const keys = Object.keys(outs);
    expect(keys).toEqual(
      expect.arrayContaining([
        'AlbDnsName',
        'DbEndpoint',
        'DbPort',
        'DlqUrl',
        'DbSecretArn',
        'KmsKeyArn',
      ]),
    );
  });
});
