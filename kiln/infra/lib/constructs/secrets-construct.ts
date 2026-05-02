// Secrets Manager entries. Operator-seeded via scripts/seed-secrets.sh before
// the first cdk deploy; CDK references them by name so values never transit
// CloudFormation.

import { RemovalPolicy } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class SecretsConstruct extends Construct {
  public readonly githubAppSecret: Secret;
  public readonly grafanaCloudOtlpSecret: Secret;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.githubAppSecret = new Secret(this, "GithubAppSecret", {
      secretName: "kiln/github-app-private-key",
      description: "GitHub App private key PEM for kiln — rotate quarterly",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Grafana Cloud OTLP basic_auth. JSON payload: { instance_id, api_token, basic_auth }.
    // basic_auth is the value of the Authorization header the Lambda attaches
    // at cold start. Rotate annually (matches Grafana Cloud API token cadence).
    this.grafanaCloudOtlpSecret = new Secret(this, "GrafanaCloudOtlpSecret", {
      secretName: "kiln/grafana-cloud/otlp-auth",
      description: "Grafana Cloud OTLP auth payload — rotate annually",
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
