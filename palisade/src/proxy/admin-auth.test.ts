import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createAdminAuth } from "./admin-auth.js";

function appWith(apiKey: string | undefined) {
  const app = new Hono();
  app.use("/admin/*", createAdminAuth({ apiKey }));
  app.post("/admin/ping", (c) => c.json({ ok: true }));
  return app;
}

async function postJson(app: Hono, path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  return app.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("admin auth — fail-closed behavior", () => {
  it("rejects every request when ADMIN_API_KEY is not configured", async () => {
    const res = await postJson(appWith(undefined), "/admin/ping");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; trace_id?: string };
    expect(body.code).toBe("REQUEST_REJECTED");
    expect(body.trace_id).toBeTruthy();
  });

  it("rejects when no key header is supplied", async () => {
    const res = await postJson(appWith("real-key"), "/admin/ping");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer key", async () => {
    const res = await postJson(appWith("real-key"), "/admin/ping", { authorization: "Bearer wrong-key" });
    expect(res.status).toBe(401);
  });

  it("rejects an x-palisade-admin-key mismatch", async () => {
    const res = await postJson(appWith("real-key"), "/admin/ping", { "x-palisade-admin-key": "nope" });
    expect(res.status).toBe(401);
  });
});

describe("admin auth — accepts valid credentials", () => {
  it("accepts Authorization: Bearer <key>", async () => {
    const res = await postJson(appWith("real-key"), "/admin/ping", { authorization: "Bearer real-key" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts X-Palisade-Admin-Key <key>", async () => {
    const res = await postJson(appWith("real-key"), "/admin/ping", { "x-palisade-admin-key": "real-key" });
    expect(res.status).toBe(200);
  });

  it("error body leaks no internal detail beyond { code, trace_id }", async () => {
    const res = await postJson(appWith("real-key"), "/admin/ping");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "trace_id"]);
  });
});
