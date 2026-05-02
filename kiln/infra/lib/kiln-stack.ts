// KilnStack — composes the seven single-responsibility constructs.
// Any change larger than "tune a parameter" should land in the relevant
// construct, not here.

import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiConstruct } from "./constructs/api-construct.js";
import { BedrockConstruct } from "./constructs/bedrock-construct.js";
import { ObservabilityConstruct } from "./constructs/observability-construct.js";
import { PollerConstruct } from "./constructs/poller-construct.js";
import { SecretsConstruct } from "./constructs/secrets-construct.js";
import { StorageConstruct } from "./constructs/storage-construct.js";
import { WorkerConstruct } from "./constructs/worker-construct.js";

export class KilnStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const region = this.region;
    const envName = process.env["KILN_ENV"] ?? "prod";

    // WorkOS AuthKit — JWT auth at the API gateway.
    const workosIssuer = process.env["KILN_WORKOS_ISSUER"] ?? "https://api.workos.com";
    const workosClientId = process.env["KILN_WORKOS_CLIENT_ID"] ?? "client_REPLACE_ME";
    const workosTeamClaim = process.env["KILN_WORKOS_TEAM_CLAIM"] ?? "kiln_team_id";

    const intervalMinutes = Number(process.env["KILN_POLLER_INTERVAL_MINUTES"] ?? "15");

    const classifierModel =
      process.env["KILN_BEDROCK_CLASSIFIER_MODEL"] ?? "anthropic.claude-haiku-4-5";
    const synthesizerModel =
      process.env["KILN_BEDROCK_SYNTHESIZER_MODEL"] ?? "anthropic.claude-sonnet-4-6";
    const synthesizerEscalationModel =
      process.env["KILN_BEDROCK_SYNTHESIZER_ESCALATION_MODEL"] ??
      "anthropic.claude-opus-4-6";

    // Grafana Cloud telemetry. Opt-in via KILN_TELEMETRY_ENABLED=true.
    const telemetryEnabled = process.env["KILN_TELEMETRY_ENABLED"] ?? "false";
    const otlpEndpoint =
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
      "https://otlp-gateway-prod-us-west-0.grafana.net/otlp";
    const otelServiceName = process.env["OTEL_SERVICE_NAME"] ?? "kiln";
    const otelResourceAttrs =
      process.env["OTEL_RESOURCE_ATTRIBUTES"] ??
      `deployment.environment=${envName},service.version=0.1.0`;

    const storage = new StorageConstruct(this, "Storage");
    const secrets = new SecretsConstruct(this, "Secrets");
    new BedrockConstruct(this, "Bedrock");

    const sharedEnv: Record<string, string> = {
      ...storage.sharedEnv(),
      KILN_ENV: envName,
      KILN_LOG_LEVEL: process.env["KILN_LOG_LEVEL"] ?? "info",
      KILN_REGION: region,
      KILN_WORKOS_ISSUER: workosIssuer,
      KILN_WORKOS_CLIENT_ID: workosClientId,
      KILN_WORKOS_TEAM_CLAIM: workosTeamClaim,
      KILN_GITHUB_APP_ID: process.env["KILN_GITHUB_APP_ID"] ?? "0",
      KILN_GITHUB_APP_SECRET_ARN: secrets.githubAppSecret.secretArn,
      KILN_BEDROCK_REGION: region,
      KILN_BEDROCK_CLASSIFIER_MODEL: classifierModel,
      KILN_BEDROCK_SYNTHESIZER_MODEL: synthesizerModel,
      KILN_BEDROCK_SYNTHESIZER_ESCALATION_MODEL: synthesizerEscalationModel,
      KILN_TELEMETRY_ENABLED: telemetryEnabled,
      KILN_GRAFANA_CLOUD_OTLP_SECRET_ARN: secrets.grafanaCloudOtlpSecret.secretArn,
      OTEL_SERVICE_NAME: otelServiceName,
      OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
      OTEL_RESOURCE_ATTRIBUTES: otelResourceAttrs,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
    };

    new ApiConstruct(this, "Api", {
      storage,
      secrets,
      workosIssuer,
      workosClientId,
      sharedEnv,
    });

    new PollerConstruct(this, "Poller", {
      storage,
      secrets,
      sharedEnv,
      intervalMinutes,
    });

    new WorkerConstruct(this, "Worker", {
      storage,
      secrets,
      sharedEnv,
      bedrockModelArns: [
        `arn:aws:bedrock:${region}::foundation-model/${classifierModel}`,
        `arn:aws:bedrock:${region}::foundation-model/${synthesizerModel}`,
        `arn:aws:bedrock:${region}::foundation-model/${synthesizerEscalationModel}`,
        // Cross-region inference profile for Sonnet/Opus availability.
        `arn:aws:bedrock:us-east-1::foundation-model/${synthesizerModel}`,
        `arn:aws:bedrock:us-east-1::foundation-model/${synthesizerEscalationModel}`,
      ],
    });

    new ObservabilityConstruct(this, "Observability", { storage });
  }
}
