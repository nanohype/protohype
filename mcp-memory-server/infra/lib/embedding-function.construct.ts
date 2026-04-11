import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";

export interface EmbeddingFunctionProps {
  /** Lambda memory in MB. Recommend 2048+ for sentence-transformers. Default: 3008 */
  memoryMb?: number;
  /** Timeout. Default: 60s (model load on cold start can take 10–15s) */
  timeoutSec?: number;
  logRetention?: logs.RetentionDays;
}

/**
 * Lambda container image that computes sentence embeddings.
 * Uses all-MiniLM-L6-v2 (384-dim) baked into the image at build time.
 *
 * This function is invoked synchronously by the memory handler.
 * Provisioned concurrency is recommended for latency-sensitive workloads.
 */
export class EmbeddingFunction extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: EmbeddingFunctionProps = {}) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: props.logRetention ?? logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.function = new lambda.DockerImageFunction(this, "Fn", {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "../../embedding-lambda")
      ),
      memorySize: props.memoryMb ?? 3008,
      timeout: cdk.Duration.seconds(props.timeoutSec ?? 60),
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      description: "MCP Memory — sentence-transformers embedding function",
      environment: {
        MODEL_NAME: "all-MiniLM-L6-v2",
        MODEL_PATH: "/opt/ml/model",
      },
    });

    new cdk.CfnOutput(this, "FunctionArn", {
      value: this.function.functionArn,
      description: "Embedding Lambda ARN — pass to MemoryServerStack",
    });
  }
}
