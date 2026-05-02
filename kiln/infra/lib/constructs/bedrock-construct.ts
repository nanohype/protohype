// Bedrock inference-logging guardrail.
//
// CfnModelInvocationLoggingConfiguration is ACCOUNT-WIDE, not model-wide.
// Because kiln deploys to a dedicated sub-account (see ADR 0003), we can set
// loggingEnabled = false without fighting other workloads. The AWS Config rule
// below asserts nothing flips this back — drift alarms fire within minutes.
//
// If kiln is ever deployed to a shared account, this construct needs to be
// replaced with a service-control-policy approach at the Org level.

import { CfnResource } from "aws-cdk-lib";
import { CfnConfigRule } from "aws-cdk-lib/aws-config";
import { Construct } from "constructs";

export class BedrockConstruct extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new CfnResource(this, "InvocationLoggingOff", {
      type: "AWS::Bedrock::ModelInvocationLoggingConfiguration",
      properties: {
        LoggingConfig: {
          CloudWatchConfig: undefined,
          S3Config: undefined,
          EmbeddingDataDeliveryEnabled: false,
          ImageDataDeliveryEnabled: false,
          TextDataDeliveryEnabled: false,
          VideoDataDeliveryEnabled: false,
        },
      },
    });

    // Custom AWS Config rule that asserts bedrock model invocation logging
    // stays disabled in this account. If someone turns it on, Config marks
    // NON_COMPLIANT and the observability alarm fires.
    new CfnConfigRule(this, "BedrockLoggingDisabledRule", {
      configRuleName: "kiln-bedrock-inference-logging-disabled",
      description: "Asserts Bedrock model invocation logging is disabled — customer code flows through prompts",
      source: {
        owner: "AWS",
        sourceIdentifier: "BEDROCK_MODEL_INVOCATION_LOGGING_ENABLED",
      },
      inputParameters: JSON.stringify({
        expectedLoggingValue: "false",
      }),
    });
  }
}
