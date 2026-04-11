#!/usr/bin/env node
/**
 * CDK App entry point.
 * Usage:
 *   cd infra && npx cdk synth
 *   cd infra && npx cdk deploy
 *   cd infra && npx cdk deploy --context secretPrefix=my-prefix --context lambdaMemoryMb=1024
 */

import * as cdk from 'aws-cdk-lib';
import { McpSwitchboardStack } from '../lib/mcp-switchboard-stack.js';

const app = new cdk.App();

new McpSwitchboardStack(app, 'McpSwitchboardStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  secretPrefix: app.node.tryGetContext('secretPrefix') ?? 'mcp-switchboard',
  lambdaMemoryMb: parseInt(app.node.tryGetContext('lambdaMemoryMb') ?? '512', 10),
  lambdaTimeoutSec: parseInt(app.node.tryGetContext('lambdaTimeoutSec') ?? '30', 10),
  stackName: 'McpSwitchboardStack',
  description: 'Self-hosted MCP gateway — 6 services behind one API Gateway + Lambda',
});
