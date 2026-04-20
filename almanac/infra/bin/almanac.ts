#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AlmanacStack } from "../lib/almanac-stack";

const app = new cdk.App();

// HTTPS config — three shapes, env-driven so client forks flip deploys
// without source changes:
//
//   1. CDK-managed cert + Route 53 alias (preferred when you own the zone):
//        ALMANAC_<ENV>_DOMAIN          fully-qualified host (e.g.
//                                      "almanac-staging.example.com")
//        ALMANAC_<ENV>_HOSTED_ZONE_ID  Route 53 hosted zone id for the
//                                      apex (e.g. "Z01234ABCDEF")
//      → CDK provisions the ACM cert, adds the DNS validation record,
//        wires the HTTPS listener, and creates an alias A record pointing
//        the domain at the ALB. One `cdk deploy` and the domain works.
//
//   2. BYO cert ARN (escape hatch for orgs whose platform team owns ACM):
//        ALMANAC_<ENV>_CERT_ARN        existing ACM cert ARN
//        ALMANAC_<ENV>_DOMAIN          domain the cert covers (used for
//                                      APP_BASE_URL only — you own the
//                                      Route 53 alias yourself)
//
//   3. HTTP-only smoke mode (no env vars set): tasks come up behind an
//      HTTP-only ALB with `APP_BASE_URL` pointing at the AWS-assigned DNS
//      name. Real OAuth callbacks reject non-HTTPS, so this is dev/smoke
//      only.
//
// Region is env-first too — `CDK_DEFAULT_REGION` overrides the
// us-west-2 fallback. No source change needed for either.

const region = process.env.CDK_DEFAULT_REGION ?? "us-west-2";

new AlmanacStack(app, "AlmanacStaging", {
  environment: "staging",
  certArn: process.env.ALMANAC_STAGING_CERT_ARN,
  domainName: process.env.ALMANAC_STAGING_DOMAIN,
  hostedZoneId: process.env.ALMANAC_STAGING_HOSTED_ZONE_ID,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  tags: { Project: "Almanac", Environment: "staging", ManagedBy: "CDK" },
});

new AlmanacStack(app, "AlmanacProduction", {
  environment: "production",
  certArn: process.env.ALMANAC_PRODUCTION_CERT_ARN,
  domainName: process.env.ALMANAC_PRODUCTION_DOMAIN,
  hostedZoneId: process.env.ALMANAC_PRODUCTION_HOSTED_ZONE_ID,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  tags: { Project: "Almanac", Environment: "production", ManagedBy: "CDK" },
});
