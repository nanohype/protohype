#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PalisadeStack } from "../lib/palisade-stack";

const app = new cdk.App();

// Region env-first — CDK_DEFAULT_REGION overrides the us-west-2 fallback.
const region = process.env.CDK_DEFAULT_REGION ?? "us-west-2";

new PalisadeStack(app, "PalisadeStaging", {
  environment: "staging",
  certArn: process.env.PALISADE_STAGING_CERT_ARN,
  domainName: process.env.PALISADE_STAGING_DOMAIN,
  hostedZoneId: process.env.PALISADE_STAGING_HOSTED_ZONE_ID,
  hostedZoneName: process.env.PALISADE_STAGING_HOSTED_ZONE_NAME,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  tags: { Project: "Palisade", Environment: "staging", ManagedBy: "CDK" },
});

new PalisadeStack(app, "PalisadeProduction", {
  environment: "production",
  certArn: process.env.PALISADE_PRODUCTION_CERT_ARN,
  domainName: process.env.PALISADE_PRODUCTION_DOMAIN,
  hostedZoneId: process.env.PALISADE_PRODUCTION_HOSTED_ZONE_ID,
  hostedZoneName: process.env.PALISADE_PRODUCTION_HOSTED_ZONE_NAME,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  tags: { Project: "Palisade", Environment: "production", ManagedBy: "CDK" },
});
