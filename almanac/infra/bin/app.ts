#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AlmanacStack } from '../lib/almanac-stack.js';

const app = new cdk.App();

new AlmanacStack(app, 'AlmanacProduction', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  environment: 'production',
});

new AlmanacStack(app, 'AlmanacStaging', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  environment: 'staging',
});
