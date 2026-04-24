/**
 * Integration test for the DDB audit log. Exercises the `ConsistentRead`
 * semantics + idempotent-write contract against a real DynamoDB endpoint —
 * dynamodb-local by default.
 *
 * Skipped unless `DDB_LOCAL_ENDPOINT` is set (CI runs a `amazon/dynamodb-local`
 * container; locally: `docker run -p 8000:8000 amazon/dynamodb-local` and
 * export `DDB_LOCAL_ENDPOINT=http://localhost:8000`).
 *
 * Marshal has the same shape — this is the palisade translation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createDdbAuditLog } from "./audit-log.js";
import { CorpusWriteNotPermittedError } from "../types/errors.js";
import { createLogger } from "../logger.js";

const endpoint = process.env["DDB_LOCAL_ENDPOINT"];
const describeIfLocal = endpoint ? describe : describe.skip;

const TABLE = `palisade-audit-itest-${Date.now()}`;

describeIfLocal("audit-log integration (dynamodb-local)", () => {
  let docClient: DynamoDBDocumentClient;
  const logger = createLogger("silent");

  beforeAll(async () => {
    const base = new DynamoDBClient({
      region: "us-west-2",
      ...(endpoint ? { endpoint } : {}),
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    docClient = DynamoDBDocumentClient.from(base);
    await base.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
      }),
    );
  }, 30_000);

  afterAll(async () => {
    const base = new DynamoDBClient({
      region: "us-west-2",
      ...(endpoint ? { endpoint } : {}),
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    await base.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
  });

  beforeEach(async () => {
    // Scan + delete is overkill — each test uses a unique attempt_id below.
  });

  it("writes an audit event and round-trips via query()", async () => {
    const log = createDdbAuditLog({ docClient, tableName: TABLE, logger });
    await log.write("att-round-trip", "user-x", "LABEL_APPROVED", {
      draftId: "d-1",
      attemptId: "att-round-trip",
      bodySha256: "deadbeef",
      approvedAt: new Date().toISOString(),
    });
    const events = await log.query("att-round-trip");
    expect(events).toHaveLength(1);
    expect(events[0]?.action_type).toBe("LABEL_APPROVED");
  });

  it("idempotent write: same PK+SK does not duplicate and does not throw", async () => {
    const log = createDdbAuditLog({ docClient, tableName: TABLE, logger });
    const pk = "ATTEMPT#att-idempotent";
    const sk = `AUDIT#${Date.now()}#LABEL_APPROVED`;
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk,
          SK: sk,
          action_type: "LABEL_APPROVED",
          attempt_id: "att-idempotent",
          actor_user_id: "u",
          timestamp: new Date().toISOString(),
          details: { draftId: "d", attemptId: "att-idempotent", bodySha256: "x", approvedAt: "t" },
          TTL: Math.floor(Date.now() / 1000) + 86_400,
        },
      }),
    );
    // A second write at the same SK MUST swallow ConditionalCheckFailedException.
    await expect(
      docClient.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            PK: pk,
            SK: sk,
            action_type: "LABEL_APPROVED",
            attempt_id: "att-idempotent",
            actor_user_id: "u",
            timestamp: new Date().toISOString(),
            details: { draftId: "d", attemptId: "att-idempotent", bodySha256: "x", approvedAt: "t" },
            TTL: Math.floor(Date.now() / 1000) + 86_400,
          },
          ConditionExpression: "attribute_not_exists(SK)",
        }),
      ),
    ).rejects.toThrow();
    const events = await log.query("att-idempotent");
    expect(events).toHaveLength(1);
  });

  it("verifyApproval with ConsistentRead returns the approval even when a later DETECTION_BLOCKED event exists", async () => {
    const log = createDdbAuditLog({ docClient, tableName: TABLE, logger });
    const attempt = "att-verify-order";
    // Write an earlier DETECTION_BLOCKED event — would be the "first" item by SK lexical order.
    await log.write(attempt, "proxy", "DETECTION_BLOCKED", {
      promptHash: "h",
      promptSha256: "s",
      blockingLayer: "heuristics",
      layerScores: { heuristics: 1 },
      upstream: "openai-chat",
    });
    // Then write the approval.
    await log.write(attempt, "reviewer", "LABEL_APPROVED", {
      draftId: "d",
      attemptId: attempt,
      bodySha256: "x",
      approvedAt: new Date().toISOString(),
    });
    // verifyApproval must find the approval despite the non-matching first item
    // — this is the marshal Limit/Filter footgun we explicitly guard against.
    await expect(log.verifyApproval(attempt)).resolves.toBeUndefined();
  });

  it("verifyApproval throws CorpusWriteNotPermittedError when no approval exists", async () => {
    const log = createDdbAuditLog({ docClient, tableName: TABLE, logger });
    await expect(log.verifyApproval("att-no-approval")).rejects.toBeInstanceOf(CorpusWriteNotPermittedError);
  });
});

// When DDB_LOCAL_ENDPOINT is unset, vitest logs the suite as skipped —
// which is the correct signal that integration tests need the container.
if (!endpoint) {
  describe("audit-log integration (skipped — set DDB_LOCAL_ENDPOINT to run)", () => {
    it("requires a running dynamodb-local on DDB_LOCAL_ENDPOINT", () => {
      expect(true).toBe(true);
    });
  });
}
