#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MarshalStack } from '../lib/marshal-stack';

const app = new cdk.App();

const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';
const account = app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT;

if (!account) {
  throw new Error(
    'CDK_DEFAULT_ACCOUNT must be set. Run: export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)',
  );
}

// Validate that we are in a region that supports Bedrock claude-sonnet-4-6 and claude-haiku-4-5
const supportedRegions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1'];
if (!supportedRegions.includes(region)) {
  throw new Error(
    `Region ${region} may not support claude-sonnet-4-6 / claude-haiku-4-5 on Bedrock. ` +
      `Supported regions: ${supportedRegions.join(', ')}. ` +
      `Override with: cdk deploy -c region=us-west-2`,
  );
}

// Two stacks — one per logical environment. Resource names + secret paths +
// CFN export names are env-scoped inside MarshalStack so both can coexist in a
// single AWS account/region without collision.
//
// Deploy a specific one:  npx cdk deploy MarshalStaging  |  npx cdk deploy MarshalProduction
// Deploy both in order:   npx cdk deploy --all

new MarshalStack(app, 'MarshalStaging', {
  env: { account, region },
  environment: 'staging',
  description: 'Marshal (staging) — Incident Commander Ceremonial Assistant (v0.1.0)',
  tags: {
    Product: 'Marshal',
    Environment: 'staging',
    ManagedBy: 'CDK',
  },
});

new MarshalStack(app, 'MarshalProduction', {
  env: { account, region },
  environment: 'production',
  description: 'Marshal (production) — Incident Commander Ceremonial Assistant (v0.1.0)',
  tags: {
    Product: 'Marshal',
    Environment: 'production',
    ManagedBy: 'CDK',
  },
});
