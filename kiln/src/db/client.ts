import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";

let _client: DynamoDBDocumentClient | null = null;

export function getDocumentClient(): DynamoDBDocumentClient {
  if (!_client) {
    const raw = new DynamoDBClient({
      region: config.aws.region,
      requestHandler: {
        requestTimeout: 5_000, // explicit per-call timeout — no default-infinity
      },
    });
    _client = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}
