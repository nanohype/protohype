#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { KilnStack } from "../lib/kiln-stack.js";

const account = process.env["CDK_DEFAULT_ACCOUNT"];
const region = process.env["CDK_DEFAULT_REGION"] ?? process.env["AWS_REGION"] ?? "us-west-2";

const app = new App();

new KilnStack(app, "KilnStack", {
  env: account ? { account, region } : { region },
  description: "kiln — dependency-upgrade automation service",
  // Stack tags propagate to most resources; handy for cost allocation.
  tags: {
    service: "kiln",
    "managed-by": "cdk",
  },
});
