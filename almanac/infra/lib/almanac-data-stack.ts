import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface AlmanacDataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
}

export class AlmanacDataStack extends cdk.Stack {
  public readonly tokenTable: dynamodb.Table;
  public readonly auditLogTable: dynamodb.Table;
  public readonly aclCacheTable: dynamodb.Table;
  public readonly auditDlq: sqs.Queue;
  public readonly redisCluster: elasticache.CfnReplicationGroup;
  public readonly redisSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AlmanacDataStackProps) {
    super(scope, id, props);

    // Token store: per-user OAuth tokens (AES-256-GCM at application layer)
    // PAY_PER_REQUEST scales to 10k+ users at ~$40/mo vs $4k/mo for Secrets Manager per-user
    this.tokenTable = new dynamodb.Table(this, "TokenTable", {
      tableName: "almanac-tokens",
      partitionKey: { name: "oktaUserId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Audit log: every query logged; 1-year TTL; DLQ for write failures
    this.auditLogTable = new dynamodb.Table(this, "AuditLogTable", {
      tableName: "almanac-audit-log",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.auditLogTable.addGlobalSecondaryIndex({
      indexName: "oktaUserId-timestamp-index",
      partitionKey: { name: "oktaUserId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
    });

    // ACL cache: 15-min TTL matches connector polling interval
    this.aclCacheTable = new dynamodb.Table(this, "AclCacheTable", {
      tableName: "almanac-acl-cache",
      partitionKey: { name: "docId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sourceSystem", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SQS DLQ: captures audit events that fail DynamoDB after 3 retries
    this.auditDlq = new sqs.Queue(this, "AuditDlq", {
      queueName: "almanac-audit-dlq",
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    // Redis: SHARED rate-limit state across all ECS bot-service instances
    // NOT in-memory -- multi-instance deployment requires shared state
    this.redisSecurityGroup = new ec2.SecurityGroup(this, "RedisSG", {
      vpc: props.vpc,
      description: "Almanac Redis SG",
      allowAllOutbound: false,
    });
    const subnetGroup = new elasticache.CfnSubnetGroup(this, "RedisSubnetGroup", {
      description: "Almanac Redis subnet group",
      subnetIds: props.privateSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: "almanac-redis-subnet-group",
    });
    this.redisCluster = new elasticache.CfnReplicationGroup(this, "RedisCluster", {
      replicationGroupDescription: "Almanac rate-limit Redis",
      replicationGroupId: "almanac-cache",
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      numCacheClusters: 2,
      cacheNodeType: "cache.t3.small",
      engine: "redis",
      engineVersion: "7.0",
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [this.redisSecurityGroup.securityGroupId],
    });

    new cdk.CfnOutput(this, "TokenTableArn", { value: this.tokenTable.tableArn });
    new cdk.CfnOutput(this, "AuditLogTableArn", { value: this.auditLogTable.tableArn });
    new cdk.CfnOutput(this, "AuditDlqUrl", { value: this.auditDlq.queueUrl });
    new cdk.CfnOutput(this, "RedisEndpoint", { value: this.redisCluster.attrPrimaryEndPointAddress });
  }
}
