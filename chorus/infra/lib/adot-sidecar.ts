import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Add an ADOT (AWS Distro for OpenTelemetry) collector sidecar to a
 * Fargate task definition. One container per task, listening on
 * localhost:4318 OTLP-HTTP, exporting to Grafana Cloud.
 *
 * Callers pass in:
 *   - `taskDefinition`: the task the app container already lives on.
 *   - `grafanaAuthSecret`: Secrets Manager secret whose value is the
 *     full Authorization header string `Basic <base64(instance:token)>`
 *     that the Grafana Cloud OTLP endpoint expects. Storing the
 *     pre-encoded header skips runtime base64 and keeps the collector
 *     config substitution trivial.
 *   - `grafanaOtlpEndpoint`: e.g. `https://otlp-gateway-prod-us-east-0.grafana.net/otlp`.
 *
 * The app container is expected to set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
 * so its SDK exports to this sidecar, not directly to Grafana.
 */
export interface AdotSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
  grafanaAuthSecret: secretsmanager.ISecret;
  grafanaOtlpEndpoint: string;
  /** CPU units reserved for the sidecar. Default 128 (~1/8 vCPU). */
  cpu?: number;
  /** Memory (MiB) reserved for the sidecar. Default 256. */
  memoryReservationMiB?: number;
}

export function addAdotSidecar(props: AdotSidecarProps): ecs.ContainerDefinition {
  const configYaml = fs.readFileSync(path.join(import.meta.dirname, 'adot-config.yaml'), 'utf-8');

  const container = props.taskDefinition.addContainer('otel-collector', {
    image: ecs.ContainerImage.fromRegistry(
      'public.ecr.aws/aws-observability/aws-otel-collector:v0.40.0',
    ),
    essential: false,
    cpu: props.cpu ?? 128,
    memoryReservationMiB: props.memoryReservationMiB ?? 256,
    environment: {
      AOT_CONFIG_CONTENT: configYaml,
      GRAFANA_OTLP_ENDPOINT: props.grafanaOtlpEndpoint,
    },
    secrets: {
      GRAFANA_OTLP_AUTH: ecs.Secret.fromSecretsManager(props.grafanaAuthSecret),
    },
    logging: ecs.LogDrivers.awsLogs({
      streamPrefix: 'otel-collector',
      logGroup: props.logGroup,
    }),
    healthCheck: {
      command: [
        'CMD-SHELL',
        // The collector exposes a health_check extension on :13133.
        // wget is not in the ADOT image; curl is.
        'curl -fsS http://127.0.0.1:13133/ || exit 1',
      ],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.seconds(20),
    },
  });

  return container;
}
