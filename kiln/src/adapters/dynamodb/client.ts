// Shared DynamoDB Document client. Honors AWS_ENDPOINT_URL_DYNAMODB so tests
// can point at DynamoDB Local without touching adapter code.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

let cached: DynamoDBDocumentClient | undefined;

export function getDocClient(region: string): DynamoDBDocumentClient {
  if (cached) return cached;
  const endpoint = process.env["AWS_ENDPOINT_URL_DYNAMODB"];
  const base = new DynamoDBClient(endpoint ? { region, endpoint } : { region });
  cached = DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });
  return cached;
}

// Used by tests to reset between cases.
export function resetDocClient(): void {
  cached = undefined;
}
