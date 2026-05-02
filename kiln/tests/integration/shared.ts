// Helpers for integration tests: build a real DDB doc client and the real
// DDB-backed adapters against DynamoDB Local.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe } from "vitest";

import { makePrLedgerAdapter } from "../../src/adapters/dynamodb/pr-ledger.js";
import { makeRateLimiterAdapter } from "../../src/adapters/dynamodb/rate-limiter.js";
import { makeTeamConfigAdapter } from "../../src/adapters/dynamodb/team-config.js";

export const shouldRunIntegration = process.env["KILN_INTEGRATION_SKIP"] !== "1";
export const integrationDescribe = shouldRunIntegration ? describe : describe.skip;

export function buildDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: "us-west-2",
      endpoint: process.env["AWS_ENDPOINT_URL_DYNAMODB"],
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

export function adaptersAgainstLocal(doc: DynamoDBDocumentClient): {
  teamConfig: ReturnType<typeof makeTeamConfigAdapter>;
  prLedger: ReturnType<typeof makePrLedgerAdapter>;
  rateLimiter: ReturnType<typeof makeRateLimiterAdapter>;
} {
  return {
    teamConfig: makeTeamConfigAdapter(doc, "kiln-team-config"),
    prLedger: makePrLedgerAdapter(doc, "kiln-pr-ledger"),
    rateLimiter: makeRateLimiterAdapter(doc, "kiln-rate-limiter"),
  };
}
