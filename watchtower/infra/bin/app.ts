#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { WatchtowerStack } from "../lib/watchtower-stack.js";

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-west-2";
const account = process.env.CDK_DEFAULT_ACCOUNT;

new WatchtowerStack(app, "WatchtowerStaging", {
  environment: "staging",
  env: { region, account },
});

new WatchtowerStack(app, "WatchtowerProduction", {
  environment: "production",
  env: { region, account },
});
