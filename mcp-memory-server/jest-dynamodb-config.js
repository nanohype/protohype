/**
 * @shelf/jest-dynamodb configuration.
 * Spins up DynamoDB Local before the test suite and tears it down after.
 * Requires Java 8+ or Docker. Uses the DynamoDB Local JAR by default.
 *
 * To use Docker instead, set DYNAMODB_LOCAL_DOCKER=true in the environment
 * and ensure the docker daemon is running.
 */

/** @type {import('@shelf/jest-dynamodb/lib').Config} */
module.exports = {
  tables: [
    {
      TableName: "mcp-memory-test",
      KeySchema: [
        { AttributeName: "agentId", KeyType: "HASH" },
        { AttributeName: "memoryId", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "agentId", AttributeType: "S" },
        { AttributeName: "memoryId", AttributeType: "S" },
        { AttributeName: "createdAt", AttributeType: "S" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "agentId-createdAt-index",
          KeySchema: [
            { AttributeName: "agentId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: {
        AttributeName: "expiresAt",
        Enabled: true,
      },
    },
  ],
  installerConfig: {
    installPath: "./dynamodb-local",
    downloadUrl:
      "https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.tar.gz",
  },
};
