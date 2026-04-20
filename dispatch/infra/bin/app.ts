#!/usr/bin/env node
/**
 * Dispatch CDK App Entry Point
 *
 * When CDK_DEFAULT_ACCOUNT is set (deploy from a developer machine or a CI
 * job with AWS credentials), the stacks are environment-specific and use
 * real AZ lookups. When it is absent (e.g. the protohype CI `cdk synth`
 * smoke test), the stacks are environment-agnostic so synth completes
 * without AWS API calls.
 */
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { DispatchStack } from '../lib/dispatch-stack.js';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const env = account ? { account, region } : undefined;

// Deploy-specific values. Override via context (`cdk deploy -c workosClientId=...`)
// or edit this file for your deployment. Placeholders let `cdk synth` pass
// in CI without real values.
const ctx = (key: string, fallback: string): string =>
  (app.node.tryGetContext(key) as string | undefined) ?? fallback;

new DispatchStack(app, 'DispatchStaging', {
  environment: 'staging',
  domainName: ctx('stagingDomain', 'dispatch-staging.internal.company.com'),
  workosClientId: ctx('workosClientId', 'client_01PLACEHOLDER'),
  env,
});

new DispatchStack(app, 'DispatchProduction', {
  environment: 'production',
  domainName: ctx('productionDomain', 'dispatch.internal.company.com'),
  workosClientId: ctx('workosClientId', 'client_01PLACEHOLDER'),
  env,
});

app.synth();
