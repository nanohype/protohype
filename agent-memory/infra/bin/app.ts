#!/usr/bin/env node
/**
 * CDK App entry point.
 * Usage:
 *   cd infra && npm install && npx cdk deploy
 *   cd infra && npx cdk deploy --context instanceType=t3.small
 *   cd infra && npx cdk deploy --context sshKeyName=my-key --context sshAllowCidr=203.0.113.0/32
 */

import * as cdk from 'aws-cdk-lib';
import { AgentMemoryStack } from '../lib/agent-memory-stack.js';

const app = new cdk.App();

new AgentMemoryStack(app, 'AgentMemoryStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  instanceType: app.node.tryGetContext('instanceType') ?? 't3.micro',
  sshKeyName: app.node.tryGetContext('sshKeyName'),
  sshAllowCidr: app.node.tryGetContext('sshAllowCidr') ?? '0.0.0.0/0',
  stackName: 'AgentMemoryStack',
  description: 'agent-memory — persistent memory service for multi-agent systems',
});
