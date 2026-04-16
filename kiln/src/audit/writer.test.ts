import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AuditWriter } from "./writer.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function makeWriter(onDlq?: (event: never, err: Error) => Promise<void>) {
  const client = DynamoDBDocumentClient.from({} as never);
  return new AuditWriter({
    tableName: "kiln-audit",
    client,
    onDlq: onDlq as never,
  });
}

describe("AuditWriter.write", () => {
  it("writes an audit event to DynamoDB (blocking)", async () => {
    ddbMock.on(PutCommand).resolves({});

    const writer = makeWriter();
    await expect(
      writer.write({
        eventType: "PR_OPENED",
        teamId: "team-platform",
        orgId: "nanocorp",
        correlationId: "corr-001",
        payload: { prNumber: 42, packageName: "react" },
      })
    ).resolves.toBeUndefined();

    const calls = ddbMock.calls();
    expect(calls).toHaveLength(1);
    const putCall = calls[0];
    expect(putCall.args[0].input).toMatchObject({
      TableName: "kiln-audit",
      Item: expect.objectContaining({
        eventType: "PR_OPENED",
        teamId: "team-platform",
        correlationId: "corr-001",
      }),
    });
  });

  it("includes eventId, timestamp, and expiresAt in the stored item", async () => {
    ddbMock.on(PutCommand).resolves({});

    const writer = makeWriter();
    await writer.write({
      eventType: "CONFIG_READ",
      teamId: "team-a",
      orgId: "nanocorp",
      correlationId: "corr-002",
      payload: {},
    });

    const item = ddbMock.calls()[0].args[0].input.Item as Record<string, unknown>;
    expect(item["eventId"]).toBeTypeOf("string");
    expect(item["timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item["expiresAt"]).toBeTypeOf("number");
    // 1-year TTL
    const now = Math.floor(Date.now() / 1000);
    expect(item["expiresAt"] as number).toBeGreaterThan(now + 364 * 24 * 3600);
  });

  it("calls onDlq and rethrows when DynamoDB fails", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    const dlqSpy = vi.fn().mockResolvedValue(undefined);
    const writer = makeWriter(dlqSpy as never);

    await expect(
      writer.write({
        eventType: "PATCH_APPLIED",
        teamId: "team-a",
        orgId: "nanocorp",
        correlationId: "corr-003",
        payload: { filePath: "src/db.ts", line: 42 },
      })
    ).rejects.toThrow("ProvisionedThroughputExceededException");

    expect(dlqSpy).toHaveBeenCalledOnce();
  });

  it("write is awaited — not fire-and-forget (verified via mock call count)", async () => {
    let resolved = false;
    ddbMock.on(PutCommand).callsFake(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolved = true;
      return {};
    });

    const writer = makeWriter();
    const promise = writer.write({
      eventType: "CHANGELOG_FETCHED",
      teamId: "team-a",
      orgId: "nanocorp",
      correlationId: "corr-004",
      payload: { url: "https://github.com/..." },
    });

    expect(resolved).toBe(false); // not yet resolved before await
    await promise;
    expect(resolved).toBe(true); // now resolved after await
  });
});

describe("AuditWriter.prOpenedEvent", () => {
  it("returns a well-formed PR_OPENED event payload", () => {
    const event = AuditWriter.prOpenedEvent({
      teamId: "team-a",
      orgId: "nanocorp",
      correlationId: "corr-005",
      prNumber: 101,
      prUrl: "https://github.com/nanocorp/api/pull/101",
      packageName: "next",
      fromVersion: "14.0.0",
      toVersion: "15.0.0",
      patchCount: 3,
      flaggedCount: 1,
    });

    expect(event.eventType).toBe("PR_OPENED");
    expect(event.payload["prNumber"]).toBe(101);
    expect(event.payload["packageName"]).toBe("next");
    expect(event.payload["patchCount"]).toBe(3);
    expect(event.payload["flaggedCount"]).toBe(1);
  });
});

describe("AuditWriter.configReadEvent", () => {
  it("returns a well-formed CONFIG_READ event payload", () => {
    const event = AuditWriter.configReadEvent({
      teamId: "team-a",
      orgId: "nanocorp",
      correlationId: "corr-006",
      readByTeamId: "platform",
      isPlatformTeam: true,
    });

    expect(event.eventType).toBe("CONFIG_READ");
    expect(event.payload["readByTeamId"]).toBe("platform");
    expect(event.payload["isPlatformTeam"]).toBe(true);
  });
});
