import { describe, it, expect, vi } from "vitest";
import { createSlackChannel } from "./slack.js";
import { createEmailChannel } from "./email.js";
import { createNotifier } from "./notifier.js";
import { createFakeAudit } from "../audit/fake.js";
import { createLogger } from "../logger.js";
import type { Alert } from "./types.js";
import type { ClientConfig } from "../clients/types.js";

const silent = createLogger("error", "notify-test");

const client: ClientConfig = {
  clientId: "acme",
  name: "Acme",
  products: ["broker-dealer"],
  jurisdictions: ["US-federal"],
  frameworks: ["SEC-rule-15c3-1"],
  active: true,
  notifications: {
    slackWebhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC",
    emailRecipients: ["ops@acme.example"],
  },
};

const alert: Alert = {
  clientId: "acme",
  clientName: "Acme",
  sourceId: "sec-edgar",
  ruleChangeTitle: "Rule 15c3-1 amendment",
  ruleChangeUrl: "https://www.sec.gov/news/release",
  disposition: "alert",
  score: 90,
  rationale: "Direct hit on broker-dealer capital.",
  memoId: "m-1",
  publishedPageUrl: "https://notion.so/page-1",
};

function okFetch(): typeof fetch {
  return (async () => new Response("{}", { status: 200 })) as typeof fetch;
}

function badFetch(status = 500): typeof fetch {
  return (async () => new Response("fail", { status })) as typeof fetch;
}

describe("createSlackChannel", () => {
  it("posts a Block Kit payload to the webhook URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const slack = createSlackChannel({ fetchImpl: fetchImpl as typeof fetch, logger: silent });
    await slack.post(client.notifications!.slackWebhookUrl!, alert);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(client.notifications!.slackWebhookUrl);
    const body = JSON.parse((opts as { body: string }).body) as { blocks: unknown[] };
    expect(Array.isArray(body.blocks)).toBe(true);
  });

  it("throws on non-2xx", async () => {
    const slack = createSlackChannel({ fetchImpl: badFetch(500), logger: silent });
    await expect(slack.post("https://hooks.slack.com/x", alert)).rejects.toThrow(/slack HTTP 500/);
  });
});

describe("createEmailChannel", () => {
  it("posts to Resend with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const email = createEmailChannel({
      apiKey: "re_test_xxx",
      fromAddress: "watchtower@example.com",
      fetchImpl: fetchImpl as typeof fetch,
      logger: silent,
    });
    await email.send(["ops@acme.example"], alert);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, opts] = fetchImpl.mock.calls[0]!;
    expect((opts as { headers: Record<string, string> }).headers["Authorization"]).toBe(
      "Bearer re_test_xxx",
    );
  });

  it("no-ops on empty recipient list", async () => {
    const fetchImpl = vi.fn();
    const email = createEmailChannel({
      apiKey: "x",
      fromAddress: "x@y",
      fetchImpl: fetchImpl as typeof fetch,
      logger: silent,
    });
    await email.send([], alert);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createNotifier", () => {
  it("dispatches to both channels and emits ALERT_SENT per success", async () => {
    const slack = createSlackChannel({ fetchImpl: okFetch(), logger: silent });
    const email = createEmailChannel({
      apiKey: "x",
      fromAddress: "w@x",
      fetchImpl: okFetch(),
      logger: silent,
    });
    const audit = createFakeAudit();
    const notifier = createNotifier({ slack, email, audit, client, logger: silent });
    const results = await notifier.send(alert);

    expect(results.map((r) => r.channel).sort()).toEqual(["email", "slack"]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(audit.events.map((e) => e.type)).toEqual(["ALERT_SENT", "ALERT_SENT"]);
  });

  it("continues to the next channel when one fails", async () => {
    const slack = createSlackChannel({ fetchImpl: badFetch(502), logger: silent });
    const email = createEmailChannel({
      apiKey: "x",
      fromAddress: "w@x",
      fetchImpl: okFetch(),
      logger: silent,
    });
    const audit = createFakeAudit();
    const notifier = createNotifier({ slack, email, audit, client, logger: silent });
    const results = await notifier.send(alert);

    const slackResult = results.find((r) => r.channel === "slack");
    const emailResult = results.find((r) => r.channel === "email");
    expect(slackResult?.success).toBe(false);
    expect(emailResult?.success).toBe(true);
    // Only the successful channel is audited.
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.type).toBe("ALERT_SENT");
  });

  it("falls back to a global Slack webhook when the client has none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const slack = createSlackChannel({ fetchImpl: fetchImpl as typeof fetch, logger: silent });
    const audit = createFakeAudit();
    const clientNoSlack: ClientConfig = { ...client, notifications: undefined as never };
    delete (clientNoSlack as { notifications?: unknown }).notifications;
    const notifier = createNotifier({
      slack,
      audit,
      client: clientNoSlack,
      fallbackSlackWebhookUrl: "https://hooks.slack.com/fallback",
      logger: silent,
    });
    const results = await notifier.send(alert);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://hooks.slack.com/fallback");
  });

  it("does not fail the send if audit emit throws", async () => {
    const slack = createSlackChannel({ fetchImpl: okFetch(), logger: silent });
    const audit = createFakeAudit();
    audit.failNext(new Error("sqs down"));
    const notifier = createNotifier({ slack, audit, client, logger: silent });
    const results = await notifier.send(alert);
    expect(results[0]!.success).toBe(true);
  });
});
