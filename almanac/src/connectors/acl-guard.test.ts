import { describe, it, expect, vi } from "vitest";
import { createAclGuard } from "./acl-guard.js";
import type { RetrievalHit } from "./types.js";

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    docId: "notion:page:p1",
    source: "notion",
    title: "Onboarding",
    url: "https://notion.so/p1",
    chunkText: "welcome",
    lastModified: "2026-03-01",
    score: 0.9,
    accessVerified: false,
    wasRedacted: false,
    ...overrides,
  };
}

function stubResponse(init: ResponseInit = { status: 200 }): Response {
  return new Response("{}", {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const tokens = async () => "access-token";

describe("createAclGuard", () => {
  it("marks a hit as accessVerified when the probe returns 200", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 200 }));
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], tokens);
    expect(verified.accessVerified).toBe(true);
    expect(verified.wasRedacted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.notion.com/v1/pages/p1");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });

  it("redacts on 403 (fail-secure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 403 }));
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], tokens);
    expect(verified.accessVerified).toBe(false);
    expect(verified.wasRedacted).toBe(true);
  });

  it("redacts on 404 (fail-secure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 404 }));
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify(
      [hit({ source: "drive", docId: "drive:file:f1" })],
      tokens,
    );
    expect(verified.wasRedacted).toBe(true);
  });

  it("redacts when getAccessToken returns null (no token, no call)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], async () => null);
    expect(verified.wasRedacted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts on network error / non-HTTP failure (fail-secure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ETIMEDOUT");
    });
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], tokens);
    expect(verified.wasRedacted).toBe(true);
  });

  it("routes by source — a Confluence hit hits the Confluence probe URL with cloudId", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 200 }));
    const guard = createAclGuard({ fetchImpl });
    const cloudId = "00000000-0000-0000-0000-000000000000";
    await guard.verify([hit({ source: "confluence", docId: `confluence:${cloudId}:123` })], tokens);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/rest/api/content/123`,
    );
  });

  it("isolates per-hit outcomes — a 403 on one source doesn't poison another", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("api.notion.com")) return stubResponse({ status: 200 });
      return stubResponse({ status: 403 });
    });
    const guard = createAclGuard({ fetchImpl });
    const results = await guard.verify(
      [
        hit({ source: "notion", docId: "notion:page:ok" }),
        hit({ source: "drive", docId: "drive:file:denied" }),
      ],
      tokens,
    );
    expect(results[0].accessVerified).toBe(true);
    expect(results[1].wasRedacted).toBe(true);
  });
});
