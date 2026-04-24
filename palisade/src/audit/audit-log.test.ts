import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createDdbAuditLog, scrubDetails } from "./audit-log.js";
import { CorpusWriteNotPermittedError } from "../types/errors.js";
import { createLogger } from "../logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

function newAuditLog() {
  // aws-sdk-client-mock intercepts outgoing commands on the DocumentClient,
  // but DocumentClient.from() still requires a properly-constructed inner
  // client so the marshaller has a config.
  const base = new DynamoDBClient({ region: "us-west-2" });
  const docClient = DynamoDBDocumentClient.from(base);
  const logger = createLogger("silent");
  return createDdbAuditLog({ docClient, tableName: "palisade-audit", logger });
}

beforeEach(() => ddbMock.reset());

describe("scrubDetails", () => {
  it("redacts credential-shaped keys across nested objects", () => {
    const input = {
      safe: "keep",
      apiKey: "secret-value",
      nested: { authorization: "Bearer xyz", fine: 1 },
      list: [{ password: "p", keep: 2 }],
    };
    const scrubbed = scrubDetails(input);
    expect(scrubbed).toEqual({
      safe: "keep",
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", fine: 1 },
      list: [{ password: "[REDACTED]", keep: 2 }],
    });
  });

  it("passes through primitives, arrays, null, undefined unchanged", () => {
    expect(scrubDetails(null)).toBeNull();
    expect(scrubDetails(undefined)).toBeUndefined();
    expect(scrubDetails(42)).toBe(42);
    expect(scrubDetails("plain")).toBe("plain");
    expect(scrubDetails([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("catches bare credential words (auth, key, cookie) via exact match", () => {
    const scrubbed = scrubDetails({ auth: "a", key: "k", cookie: "c", code: "safe", keep: "safe" });
    expect(scrubbed).toEqual({ auth: "[REDACTED]", key: "[REDACTED]", cookie: "[REDACTED]", code: "safe", keep: "safe" });
  });
});

describe("createDdbAuditLog.write", () => {
  it("sends a PutCommand with ConditionExpression attribute_not_exists(SK)", async () => {
    ddbMock.on(PutCommand).resolves({});
    const log = newAuditLog();
    await log.write("att-1", "user-1", "LABEL_APPROVED", { draftId: "d", attemptId: "att-1", bodySha256: "abc", approvedAt: "t" });
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("attribute_not_exists(SK)");
    expect(input?.Item?.PK).toBe("ATTEMPT#att-1");
    expect(input?.Item?.action_type).toBe("LABEL_APPROVED");
  });

  it("swallows ConditionalCheckFailedException (idempotent write)", async () => {
    class ConditionalError extends Error {
      override readonly name = "ConditionalCheckFailedException";
    }
    ddbMock.on(PutCommand).rejects(new ConditionalError("exists"));
    const log = newAuditLog();
    await expect(log.write("att-2", "u", "LABEL_REJECTED", { draftId: "d", attemptId: "att-2" })).resolves.toBeUndefined();
  });

  it("rethrows other write errors", async () => {
    ddbMock.on(PutCommand).rejects(new Error("throttled"));
    const log = newAuditLog();
    await expect(
      log.write("att-3", "u", "LABEL_APPROVED", { draftId: "d", attemptId: "att-3", bodySha256: "x", approvedAt: "t" }),
    ).rejects.toThrow("throttled");
  });
});

describe("createDdbAuditLog.verifyApproval", () => {
  it("resolves when LABEL_APPROVED exists with ConsistentRead:true", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ action_type: "LABEL_APPROVED", attempt_id: "att-4" }] });
    const log = newAuditLog();
    await expect(log.verifyApproval("att-4")).resolves.toBeUndefined();
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call?.args[0].input.ConsistentRead).toBe(true);
    // Critically: no Limit — marshal footgun avoidance.
    expect(call?.args[0].input.Limit).toBeUndefined();
  });

  it("throws CorpusWriteNotPermittedError on empty result", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const log = newAuditLog();
    await expect(log.verifyApproval("att-5")).rejects.toBeInstanceOf(CorpusWriteNotPermittedError);
  });

  it("throws CorpusWriteNotPermittedError on undefined Items", async () => {
    ddbMock.on(QueryCommand).resolves({});
    const log = newAuditLog();
    await expect(log.verifyApproval("att-6")).rejects.toBeInstanceOf(CorpusWriteNotPermittedError);
  });
});

describe("createDdbAuditLog.query", () => {
  it("returns the full attempt audit trail without a filter", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ action_type: "LABEL_PROPOSED" }, { action_type: "LABEL_APPROVED" }] });
    const log = newAuditLog();
    const events = await log.query("att-7");
    expect(events.map((e) => e.action_type)).toEqual(["LABEL_PROPOSED", "LABEL_APPROVED"]);
  });

  it("returns [] when the query returns no Items key", async () => {
    ddbMock.on(QueryCommand).resolves({});
    const log = newAuditLog();
    expect(await log.query("att-8")).toEqual([]);
  });
});
