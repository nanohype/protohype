#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { KilnStack } from '../lib/kiln-stack';

const app = new cdk.App();

new KilnStack(app, 'KilnStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  description: 'Kiln — dependency upgrade automation. Reads changelogs, patches breaking changes, opens PRs.',
  tags: {
    project: 'kiln',
    managed_by: 'cdk',
  },
});
