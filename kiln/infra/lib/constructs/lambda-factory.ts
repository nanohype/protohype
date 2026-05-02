// Shared Lambda factory — bundles src/handlers/<name>.ts via esbuild.
// Every kiln Lambda flows through this so timeout/memory/arch stay consistent.

import { Duration } from "aws-cdk-lib";
import type { IRole } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import path from "node:path";

export interface LambdaFactoryProps {
  handlerId: string; // id used in CloudFormation logical id
  entrypoint: "api" | "poller" | "upgrader"; // src/handlers/<entrypoint>.ts
  role: IRole;
  env: Record<string, string>;
  memoryMb: number;
  timeout: Duration;
  logRetention?: RetentionDays;
}

export function createKilnLambda(scope: Construct, props: LambdaFactoryProps): LambdaFunction {
  const projectRoot = path.resolve(import.meta.dirname, "../../..");
  const logGroup = new LogGroup(scope, `${props.handlerId}Logs`, {
    logGroupName: `/aws/lambda/kiln-${props.entrypoint}`,
    retention: props.logRetention ?? RetentionDays.ONE_MONTH,
  });

  return new LambdaFunction(scope, props.handlerId, {
    functionName: `kiln-${props.entrypoint}`,
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    handler: "index.handler",
    code: Code.fromAsset(projectRoot, {
      bundling: {
        image: Runtime.NODEJS_22_X.bundlingImage,
        command: [
          "bash",
          "-c",
          [
            "npm ci --omit=dev --no-audit --no-fund",
            `npx esbuild src/handlers/${props.entrypoint}.ts --bundle --platform=node --target=node22 --format=esm --outfile=/asset-output/index.mjs --banner:js='import{createRequire}from"module";const require=createRequire(import.meta.url);' --external:@aws-sdk/*`,
            "mv /asset-output/index.mjs /asset-output/index.js",
          ].join(" && "),
        ],
      },
    }),
    role: props.role,
    timeout: props.timeout,
    memorySize: props.memoryMb,
    environment: props.env,
    logGroup,
  });
}
