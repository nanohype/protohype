#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChorusStack } from '../lib/chorus-stack.js';

const app = new cdk.App();

const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';

new ChorusStack(app, 'ChorusStack', {
  env: { account, region },
  description: 'chorus — feedback intelligence pipeline (RDS+pgvector, ECS Fargate, ALB, SQS DLQ)',
  /**
   * Container images are built and pushed externally (e.g. by CI to
   * ECR). The stack reads their URIs from context so we don't bake
   * a Dockerfile into infra and don't accidentally deploy stale code:
   *
   *   cdk deploy -c apiImageUri=... -c workerImageUri=... -c digestImageUri=...
   */
  apiImageUri: app.node.tryGetContext('apiImageUri') as string | undefined,
  workerImageUri: app.node.tryGetContext('workerImageUri') as string | undefined,
  digestImageUri: app.node.tryGetContext('digestImageUri') as string | undefined,

  /** Domain the API will be reachable on (CNAME or alias to the ALB). */
  apiDomainName: app.node.tryGetContext('apiDomainName') as string | undefined,

  /**
   * WorkOS AuthKit + Directory Sync config for the runtime tasks.
   * Secrets themselves come from Secrets Manager — these are
   * non-secret config values:
   *
   *   workosClientId       AuthKit client id (API task verifies tokens)
   *   workosIssuer         optional override of `https://api.workos.com`
   *   workosDirectoryId    Directory Sync directory id (digest task)
   *   workosPmGroupId      Directory Sync group id whose members are PMs
   */
  workosClientId: app.node.tryGetContext('workosClientId') as string | undefined,
  workosIssuer: app.node.tryGetContext('workosIssuer') as string | undefined,
  workosDirectoryId: app.node.tryGetContext('workosDirectoryId') as string | undefined,
  workosPmGroupId: app.node.tryGetContext('workosPmGroupId') as string | undefined,

  /**
   * Linear team id (for NEW-proposal issue creation) and Slack
   * channel → squad mapping (for the /slack/events ingestion route).
   */
  linearTeamId: app.node.tryGetContext('linearTeamId') as string | undefined,
  slackFeedbackChannels: app.node.tryGetContext('slackFeedbackChannels') as string | undefined,
});
