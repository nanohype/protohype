#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MemoryServerStack } from "../lib/memory-server.stack";

const app = new cdk.App();

new MemoryServerStack(app, "McpMemoryServer", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // Wire in your existing API:
  //   existingApi: RestApi.fromRestApiAttributes(this, 'ExistingApi', {
  //     restApiId: 'abc123',
  //     rootResourceId: 'xyz789',
  //   }),
  embeddingFunctionArn: process.env.EMBEDDING_FUNCTION_ARN,
  ssmPrefix: "/mcp-memory/prod",
});
