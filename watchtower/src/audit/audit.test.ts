import { describe, it, expect, vi } from "vitest";
import { createSqsAuditLogger } from "./sqs.js";
import { createFakeAudit } from "./fake.js";
import { AuditEventSchema, type AuditEvent } from "./types.js";
import { createLogger } from "../logger.js";

const silentLogger = createLogger("error", "audit-test");

function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    type: "APPLICABILITY_SCORED",
    eventId: "evt-1",
    timestamp: new Date().toISOString(),
    clientId: "client-a",
    ruleChangeId: "rc-1",
    score: 72,
    confidence: "medium",
    rationale: "change touches GLBA consumer-banking products",
    disposition: "review",
    ...overrides,
  } as AuditEvent;
}

describe("AuditEventSchema", () => {
  it("accepts a well-formed APPLICABILITY_SCORED event", () => {
    expect(AuditEventSchema.safeParse(sampleEvent()).success).toBe(true);
  });

  it("rejects an event missing required discriminant", () => {
    const bad = { ...sampleEvent(), type: undefined } as unknown;
    expect(AuditEventSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects scores outside [0,100]", () => {
    const bad = sampleEvent({ score: 150 } as Partial<AuditEvent>);
    expect(AuditEventSchema.safeParse(bad).success).toBe(false);
  });
});

describe("createSqsAuditLogger", () => {
  it("emits with MessageGroupId=clientId and MessageDeduplicationId=eventId", async () => {
    const send = vi.fn().mockResolvedValue({});
    const logger = createSqsAuditLogger({
      sqs: { send } as unknown as Parameters<typeof createSqsAuditLogger>[0]["sqs"],
      queueUrl: "https://sqs.us-west-2.amazonaws.com/1/audit.fifo",
      logger: silentLogger,
    });
    await logger.emit(sampleEvent());
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as {
      input: { MessageGroupId: string; MessageDeduplicationId: string };
    };
    expect(cmd.input.MessageGroupId).toBe("client-a");
    expect(cmd.input.MessageDeduplicationId).toBe("evt-1");
  });

  it("rejects an invalid event at the boundary without hitting SQS", async () => {
    const send = vi.fn();
    const logger = createSqsAuditLogger({
      sqs: { send } as unknown as Parameters<typeof createSqsAuditLogger>[0]["sqs"],
      queueUrl: "https://sqs.us-west-2.amazonaws.com/1/audit.fifo",
      logger: silentLogger,
    });
    const bad = { ...sampleEvent(), score: 999 } as AuditEvent;
    await expect(logger.emit(bad)).rejects.toThrow(/schema validation/);
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates SQS errors to the caller (compliance: never silent)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("sqs down"));
    const logger = createSqsAuditLogger({
      sqs: { send } as unknown as Parameters<typeof createSqsAuditLogger>[0]["sqs"],
      queueUrl: "https://sqs.us-west-2.amazonaws.com/1/audit.fifo",
      logger: silentLogger,
    });
    await expect(logger.emit(sampleEvent())).rejects.toThrow("sqs down");
  });
});

describe("createFakeAudit", () => {
  it("records emitted events in order", async () => {
    const audit = createFakeAudit();
    await audit.emit(sampleEvent({ eventId: "e1" }));
    await audit.emit(sampleEvent({ eventId: "e2" }));
    expect(audit.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
  });

  it("simulates a single failure, then resumes", async () => {
    const audit = createFakeAudit();
    audit.failNext(new Error("simulated"));
    await expect(audit.emit(sampleEvent())).rejects.toThrow("simulated");
    await audit.emit(sampleEvent({ eventId: "e2" }));
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.eventId).toBe("e2");
  });
});
