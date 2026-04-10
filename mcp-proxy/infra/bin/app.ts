#!/usr/bin/env node
/**
 * CDK App entry point.
 * Usage:
 *   cd infra && npx cdk synth
 *   cd infra && npx cdk deploy
 *   cd infra && npx cdk deploy --context secretPrefix=my-prefix --context lambdaMemoryMb=1024
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { McpProxyStack } from '../lib/mcp-proxy-stack.js';

const app = new cdk.App();

new McpProxyStack(app, 'McpProxyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  secretPrefix: app.node.tryGetContext('secretPrefix') ?? 'mcp-proxy',
  lambdaMemoryMb: parseInt(app.node.tryGetContext('lambdaMemoryMb') ?? '512', 10),
  lambdaTimeoutSec: parseInt(app.node.tryGetContext('lambdaTimeoutSec') ?? '30', 10),
  stackName: 'McpProxyStack',
  description: 'Self-hosted MCP proxy — 6 services behind one API Gateway + Lambda',
});
