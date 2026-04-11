import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

export class CostDashStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for perf data
    const perfBucket = new s3.Bucket(this, "PerfBucket", {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Docker image from the cost-dash directory
    const imageAsset = new ecr_assets.DockerImageAsset(this, "CostDashImage", {
      directory: path.join(__dirname, ".."),
    });

    // IAM role for App Runner to pull from ECR
    const accessRole = new iam.Role(this, "AppRunnerAccessRole", {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
    });
    imageAsset.repository.grantPull(accessRole);

    // IAM role for the running App Runner instance
    const instanceRole = new iam.Role(this, "AppRunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
    });
    perfBucket.grantReadWrite(instanceRole);

    // App Runner service
    const service = new apprunner.CfnService(this, "CostDashService", {
      serviceName: "cost-dash",
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        imageRepository: {
          imageIdentifier: imageAsset.imageUri,
          imageRepositoryType: "ECR",
          imageConfiguration: {
            port: "3000",
            runtimeEnvironmentVariables: [
              { name: "PERF_BUCKET", value: perfBucket.bucketName },
              { name: "PERF_KEY", value: "perf.json" },
              { name: "DAILY_BUDGET_USD", value: "10" },
              { name: "NODE_ENV", value: "production" },
            ],
          },
        },
      },
      instanceConfiguration: {
        cpu: "0.25 vCPU",
        memory: "0.5 GB",
        instanceRoleArn: instanceRole.roleArn,
      },
      healthCheckConfiguration: {
        protocol: "HTTP",
        path: "/api/summary",
        interval: 20,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 3,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, "ServiceUrl", {
      value: `https://${service.attrServiceUrl}`,
      description: "cost-dash URL",
    });

    new cdk.CfnOutput(this, "PerfBucketName", {
      value: perfBucket.bucketName,
      description: "S3 bucket for perf data",
    });
  }
}
