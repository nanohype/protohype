#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { McpGatewayStack } from '../lib/mcp-gateway-stack';

const app = new cdk.App();

new McpGatewayStack(app, 'McpGateway', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  description: 'MCP Gateway — MCP Switchboard, MCP Memory Server, Cost Dashboard',
  tags: {
    Project: 'mcp-gateway',
    ManagedBy: 'CDK',
    Environment: process.env.DEPLOY_ENV ?? 'production',
  },
});
