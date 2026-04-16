import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { GitHubTokenBucket } from "./token-bucket.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function makeBucket(capacity = 100, windowSizeSeconds = 3600) {
  const client = DynamoDBDocumentClient.from({} as never);
  return new GitHubTokenBucket({
    tableName: "kiln-rate-limiter",
    client,
    capacity,
    windowSizeSeconds,
  });
}

describe("GitHubTokenBucket.consume", () => {
  it("allows consumption when tokens are available", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { tokens: 99, windowStart: 0, capacity: 100, windowSizeSeconds: 3600 },
    });

    const bucket = makeBucket();
    const result = await bucket.consume("installation-1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);
  });

  it("denies consumption when ConditionalCheckFailedException is thrown", async () => {
    const conditionalError = Object.assign(new Error("ConditionalCheckFailedException"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(UpdateCommand).rejects(conditionalError);
    ddbMock.on(GetCommand).resolves({
      Item: { tokens: 0, windowStart: 0, capacity: 100 },
    });

    const bucket = makeBucket();
    const result = await bucket.consume("installation-1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeTypeOf("number");
  });

  it("rethrows non-conditional errors", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    const bucket = makeBucket();
    await expect(bucket.consume("installation-1")).rejects.toThrow(
      "ProvisionedThroughputExceededException"
    );
  });

  it("allows consuming multiple tokens at once", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { tokens: 95, windowStart: 0, capacity: 100, windowSizeSeconds: 3600 },
    });

    const bucket = makeBucket();
    const result = await bucket.consume("installation-1", 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(95);
  });
});

describe("GitHubTokenBucket.peek", () => {
  it("returns current bucket state", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { tokens: 4500, windowStart: 1710000000, capacity: 5000 },
    });

    const bucket = makeBucket(5000);
    const state = await bucket.peek("installation-1");
    expect(state).not.toBeNull();
    expect(state?.tokens).toBe(4500);
    expect(state?.capacity).toBe(5000);
  });

  it("returns null when item does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const bucket = makeBucket();
    const state = await bucket.peek("nonexistent");
    expect(state).toBeNull();
  });
});
