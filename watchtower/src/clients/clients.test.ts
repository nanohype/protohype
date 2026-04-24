import { describe, it, expect, vi } from "vitest";
import { createDdbClientsRepo } from "./ddb.js";
import { createFakeClients } from "./fake.js";
import { ClientConfigSchema, type ClientConfig } from "./types.js";
import { createLogger } from "../logger.js";

const silent = createLogger("error", "clients-test");

const clientA: ClientConfig = {
  clientId: "a",
  name: "Acme Bank",
  products: ["consumer-checking", "commercial-lending"],
  jurisdictions: ["US-federal", "US-CA"],
  frameworks: ["GLBA", "FCRA"],
  active: true,
};

const clientB: ClientConfig = {
  clientId: "b",
  name: "Beta Broker",
  products: ["broker-dealer"],
  jurisdictions: ["US-federal"],
  frameworks: ["SEC-rule-15c3-1"],
  active: false,
};

describe("ClientConfigSchema", () => {
  it("requires at least one product, jurisdiction, and framework", () => {
    const bad = { ...clientA, products: [] };
    expect(ClientConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts optional notifications + publish targets", () => {
    const full: ClientConfig = {
      ...clientA,
      notifications: { slackWebhookUrl: "https://hooks.slack.com/x" },
      publish: { notionDatabaseId: "xxx" },
    };
    expect(ClientConfigSchema.safeParse(full).success).toBe(true);
  });
});

describe("createFakeClients", () => {
  it("listActive filters on active flag", async () => {
    const store = createFakeClients([clientA, clientB]);
    const active = await store.listActive();
    expect(active.map((c) => c.clientId)).toEqual(["a"]);
  });

  it("get returns inactive clients as null", async () => {
    const store = createFakeClients([clientA, clientB]);
    expect(await store.get("a")).toMatchObject({ clientId: "a" });
    expect(await store.get("b")).toBeNull();
  });

  it("put replaces existing config", async () => {
    const store = createFakeClients([clientA]);
    store.put({ ...clientA, name: "Acme Bank (rev 2)" });
    expect((await store.get("a"))?.name).toBe("Acme Bank (rev 2)");
  });
});

describe("createDdbClientsRepo", () => {
  it("listActive filters inactive rows and caches scans", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [clientA, clientB] })
      .mockResolvedValueOnce({ Items: [] });
    const repo = createDdbClientsRepo({
      ddb: { send } as unknown as Parameters<typeof createDdbClientsRepo>[0]["ddb"],
      tableName: "clients",
      logger: silent,
      cacheTtlMs: 60_000,
    });
    const first = await repo.listActive();
    expect(first.map((c) => c.clientId)).toEqual(["a"]);
    // Second call should hit cache — ScanCommand not invoked twice.
    await repo.listActive();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("skips malformed rows with a warn, doesn't throw", async () => {
    const warnings: unknown[] = [];
    const warn = (msg: string, data?: Record<string, unknown>) => {
      warnings.push({ msg, data });
    };
    const logger = { ...silent, warn };
    const send = vi.fn().mockResolvedValueOnce({
      Items: [clientA, { clientId: "bad", name: "x" /* missing arrays */ }],
    });
    const repo = createDdbClientsRepo({
      ddb: { send } as unknown as Parameters<typeof createDdbClientsRepo>[0]["ddb"],
      tableName: "clients",
      logger,
    });
    const active = await repo.listActive();
    expect(active.map((c) => c.clientId)).toEqual(["a"]);
    expect(warnings).toHaveLength(1);
  });

  it("get returns null for inactive direct hits", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: clientB });
    const repo = createDdbClientsRepo({
      ddb: { send } as unknown as Parameters<typeof createDdbClientsRepo>[0]["ddb"],
      tableName: "clients",
      logger: silent,
    });
    expect(await repo.get("b")).toBeNull();
  });

  it("get returns null for malformed rows", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: { clientId: "x" } });
    const repo = createDdbClientsRepo({
      ddb: { send } as unknown as Parameters<typeof createDdbClientsRepo>[0]["ddb"],
      tableName: "clients",
      logger: silent,
    });
    expect(await repo.get("x")).toBeNull();
  });
});
