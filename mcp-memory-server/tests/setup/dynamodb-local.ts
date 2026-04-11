/**
 * Shared test helpers for DynamoDB Local integration tests.
 * The @shelf/jest-dynamodb preset handles starting/stopping DynamoDB Local.
 * This module provides client setup and table name constants.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TEST_TABLE = "mcp-memory-test";
export const TEST_ENDPOINT = "http://localhost:8000";

/** Creates a DynamoDB Document client pointed at DynamoDB Local */
export function createTestClient(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    endpoint: TEST_ENDPOINT,
    region: "us-east-1",
    credentials: {
      accessKeyId: "fakeMyKeyId",
      secretAccessKey: "fakeSecretAccessKey",
    },
  });

  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Patch env vars so the module-level singletons in src/ point to local DDB */
export function patchEnv(): void {
  process.env.DYNAMODB_ENDPOINT = TEST_ENDPOINT;
  process.env.TABLE_NAME = TEST_TABLE;
  process.env.EMBEDDING_FUNCTION_ARN = ""; // disable embeddings in tests
  process.env.AWS_DEFAULT_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "fakeMyKeyId";
  process.env.AWS_SECRET_ACCESS_KEY = "fakeSecretAccessKey";
}
