import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface MemoryTableProps {
  /**
   * Optional removal policy override. Defaults to RETAIN in production-like
   * environments. Pass DESTROY only for dev/test stacks.
   */
  removalPolicy?: cdk.RemovalPolicy;
  /** SSM parameter path prefix, e.g. "/mcp-memory/prod" */
  ssmPrefix?: string;
}

/**
 * CDK L2 construct for the MCP Memory DynamoDB table.
 *
 * Schema
 * ──────
 * PK  agentId  (String)   – partition by agent
 * SK  memoryId (String)   – ULID, time-sortable within agent
 *
 * GSI1 (agentId-createdAt-index)
 *   PK  agentId   (String)
 *   SK  createdAt (String, ISO-8601) – enables paginated listing newest-first
 *
 * TTL attribute: expiresAt (Number, Unix epoch seconds)
 */
export class MemoryTable extends Construct {
  public readonly table: dynamodb.Table;
  public readonly tableNameParam: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: MemoryTableProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.RETAIN;
    const ssmPrefix = props.ssmPrefix ?? "/mcp-memory";

    this.table = new dynamodb.Table(this, "Table", {
      tableName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "memoryId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      removalPolicy,
    });

    // GSI for listing memories sorted by creation time
    this.table.addGlobalSecondaryIndex({
      indexName: "agentId-createdAt-index",
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Export table name as CloudFormation output
    new cdk.CfnOutput(this, "TableName", {
      value: this.table.tableName,
      exportName: `${cdk.Stack.of(this).stackName}-MemoryTableName`,
      description: "MCP Memory DynamoDB table name",
    });

    // Publish to SSM for cross-stack / cross-service consumption
    this.tableNameParam = new ssm.StringParameter(this, "TableNameParam", {
      parameterName: `${ssmPrefix}/table-name`,
      stringValue: this.table.tableName,
      description: "MCP Memory Server DynamoDB table name",
    });
  }
}
